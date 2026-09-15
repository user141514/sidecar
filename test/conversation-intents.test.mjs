import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ChatGptConversationHost } from '../src/chatgpt.mjs'
import { ConversationStore } from '../src/store.mjs'
import { createSidecarServer } from '../src/server.mjs'
import { dispatchConversationTool } from '../src/conversation-tools.mjs'
import { WorkController } from '../src/work-controller.mjs'
import { WorkLedger } from '../src/work-ledger.mjs'

const target = 'https://chatgpt.com/c/00000000-0000-0000-0000-000000000011'
const expected = { userMessageId: 'user-1', assistantMessageId: 'assistant-1' }
const intent = { kind: 'continue', target, expected, text: 'continue bounded task' }
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'conversation-intents-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ConversationStore(root)
  const bridge = new EventEmitter()
  bridge.calls = []
  bridge.observation = { found: true, allowed: true, ...expected, url: target }
  bridge.request = async (method, params) => {
    bridge.calls.push({ method, params })
    if (method === 'conversation_observe') return bridge.observation
    if (method === 'conversation_send') return { accepted: true, url: target }
    assert.fail(`unexpected browser effect: ${method}`)
  }
  const admission = { calls: 0, async admit() { this.calls++; return { admitted: true } } }
  const host = new ChatGptConversationHost({ bridge, store, sendAdmission: admission })
  return { store, bridge, admission, host }
}

test('watchdog proposal is routed through one durable host send and duplicate receipt', async t => {
  const { host, bridge } = await setup(t)
  assert.equal(typeof host.proposeContinuation, 'function')
  const first = await host.proposeContinuation(intent)
  const duplicate = await host.proposeContinuation(intent)
  assert.equal(first.accepted, true)
  assert.equal(duplicate.turnId, first.turnId)
  const sends = bridge.calls.filter(x => x.method === 'conversation_send')
  assert.equal(sends.length, 1)
  assert.deepEqual(sends[0].params.expected, expected)
  assert.equal(sends[0].params.existingOnly, true)
})

test('coordinator wins first: watchdog cannot send behind its in-flight turn', async t => {
  const { host, store, bridge } = await setup(t)
  const conversation = await store.create({ backend: 'chatgpt-web-extension', externalUrl: target })
  await host.send(conversation.id, 'coordinator task', { requestId: 'coordinator-1' })
  assert.equal(typeof host.proposeContinuation, 'function')
  const next = await host.proposeContinuation(intent)
  assert.equal(next.accepted, false)
  assert.equal(bridge.calls.filter(x => x.method === 'conversation_send').length, 1)
})

test('watchdog wins first: coordinator cannot write through its separate legacy queue', async t => {
  const { host, store, bridge } = await setup(t)
  const conversation = await store.create({ backend: 'chatgpt-web-extension', externalUrl: target })
  assert.equal(typeof host.proposeContinuation, 'function')
  await host.proposeContinuation(intent)
  await assert.rejects(host.send(conversation.id, 'coordinator task'), /in flight/)
  assert.equal(bridge.calls.filter(x => x.method === 'conversation_send').length, 1)
})

test('stale user identity or blocked live lifecycle rejects before pacing or adoption', async t => {
  const { host, bridge, admission } = await setup(t)
  assert.equal(typeof host.proposeContinuation, 'function')
  bridge.observation = { ...bridge.observation, userMessageId: 'user-2' }
  const stale = await host.proposeContinuation(intent)
  assert.equal(stale.reason, 'stale_intent')
  assert.equal(admission.calls, 0)
  const fresh = { ...intent, expected: { ...expected, userMessageId: 'user-2' } }
  bridge.observation = { ...bridge.observation, allowed: false, reason: 'user_turn_pending' }
  assert.equal((await host.proposeContinuation(fresh)).accepted, false)
  assert.equal(admission.calls, 0)
})

test('MCP coordinator request ID survives response-loss retry', async t => {
  const { host, store, bridge } = await setup(t)
  const c = await store.create({ backend: 'chatgpt-web-extension', externalUrl: target })
  const args = { conversation_id: c.id, text: 'once', request_id: 'stable-id' }
  const first = await dispatchConversationTool(host, 'conversation_send', args)
  const repeat = await dispatchConversationTool(host, 'conversation_send', args)
  assert.equal(repeat.turnId, first.turnId)
  assert.equal(bridge.calls.filter(x => x.method === 'conversation_send').length, 1)
})

test('coordinator request deduplicates across the initial Project-to-thread URL transition', async t => {
  const { host, store, bridge } = await setup(t)
  const c = await store.create({ backend: 'chatgpt-web-extension', externalUrl: 'https://chatgpt.com/g/g-p-test/project' })
  const first = await host.send(c.id, 'once', { requestId: 'first-submit' })
  const repeat = await host.send(c.id, 'once', { requestId: 'first-submit' })
  assert.equal(repeat.turnId, first.turnId)
  assert.equal(bridge.calls.filter(x => x.method === 'conversation_send').length, 1)
})

test('collector follows only explicit watchdog continuation ancestry', async t => {
  const { store } = await setup(t)
  const ledger = new WorkLedger(join(store.rootDir, 'works'))
  for (const source of ['watchdog', 'coordinator']) {
    const work = await ledger.create('bounded goal')
    await ledger.append(work.id, 'decision', { action: 'SPLIT', reason: 'test', frontiers: [{ id: 'f1', task: 'one', watchdog: true, depends_on: [] }] })
    await ledger.append(work.id, 'worker_dispatched', { frontierId: 'f1', conversationId: 'conv_test', turnId: 'root' })
    const conversation = { status: 'completed', latestTurnId: 'child', externalUrl: target, latestResponse: 'done', events: [{ type: 'send_intent', source, turnId: 'child', continuationOf: 'root' }] }
    const controller = new WorkController({ ledger, conversationHost: { read: async () => conversation }, watchdog: { completion: async () => ({ completed: true, result: 'done' }), ackCompletion: async () => true } })
    assert.equal((await controller.collect(work.id)).collected, source === 'watchdog' ? 1 : 0)
  }
})

test('malformed browser receipt after dispatch is unknown, never a retryable rejection', async t => {
  const { host, store, bridge } = await setup(t)
  const c = await store.create({ backend: 'chatgpt-web-extension', externalUrl: target })
  bridge.request = async () => ({})
  await assert.rejects(host.send(c.id, 'once'), { code: 'DELIVERY_UNCERTAIN' })
  assert.equal((await store.read(c.id)).status, 'delivery_uncertain')
})

test('old Watchdog pacing-only admission cannot retain direct write authority', async t => {
  const { host, admission } = await setup(t)
  const result = await host.admitSend({ source: 'watchdog', target })
  assert.equal(result.admitted, false)
  assert.equal(result.reason, 'mailbox_required')
  assert.equal(admission.calls, 0)
})

test('localhost intent endpoint executes proposal, rejects browser Origin, and validates input', async t => {
  const { host } = await setup(t)
  const app = createSidecarServer({ conversationHost: host })
  const addr = await app.listen({ port: 0 })
  t.after(() => app.close())
  const url = `http://127.0.0.1:${addr.port}/internal/conversation-intents`
  const post = (body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  assert.equal((await post(intent, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await post({ ...intent, target: 'https://chatgpt.com/' })).status, 400)
  const result = await post(intent)
  assert.equal(result.status, 200)
  assert.equal((await result.json()).accepted, true)
})
