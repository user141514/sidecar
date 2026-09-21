import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ChatGptConversationHost } from '../src/chatgpt.mjs'
import { ConversationStore } from '../src/store.mjs'
import { createSidecarServer } from '../src/server.mjs'

const uuid = '00000000-0000-4000-8000-000000000051'
const target = `https://chatgpt.com/g/g-p-example/c/${uuid}`
const userId = '10000000-0000-4000-8000-000000000051'
const assistantId = '20000000-0000-4000-8000-000000000051'
const project = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946-subagents/project'
const request = (over = {}) => ({ target, expectedUserMessageId: userId, expectedWriterEpoch: 3, source: 'human', ...over })

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-adoption-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ConversationStore(root)
  await store.setDefaultProjectUrl(project)
  const bridge = new EventEmitter()
  bridge.calls = []
  bridge.available = true
  bridge.ambiguous = false
  bridge.loseAck = false
  bridge.effects = 0
  bridge.receipts = new Map()
  bridge.snapshot = { found: true, url: target, tabId: 51, windowId: 5, userMessageId: userId,
    assistantMessageId: assistantId, readable: true, generating: false, terminal: false,
    body: 'incomplete', humanGate: false }
  bridge.request = async (method, params) => {
    bridge.calls.push({ method, params })
    if (method === 'conversation_adoption_inspect') {
      if (!bridge.available) return { found: false, reason: 'exact_tab_unavailable' }
      if (bridge.ambiguous) return { found: false, reason: 'ambiguous_target_tabs' }
      return { ...bridge.snapshot }
    }
    if (method === 'conversation_adopt') {
      bridge.effects += 1
      const receipt = { requestId: params.requestId, action: 'adopt', conversationId: params.conversationId,
        turnId: params.turnId, externalUrl: target, userMessageId: userId,
        assistantMessageId: bridge.snapshot.assistantMessageId, tabId: 51, windowId: 5,
        generating: bridge.snapshot.generating, expectedWriterEpoch: params.writerEpoch }
      bridge.receipts.set(params.requestId, receipt)
      if (bridge.loseAck) throw Object.assign(new Error('adoption acknowledgement lost'), { code: 'DELIVERY_UNCERTAIN' })
      return { accepted: true, receipt }
    }
    if (method === 'conversation_effect_receipt') {
      const receipt = bridge.receipts.get(params.requestId)
      return receipt ? { found: true, receipt } : { found: false }
    }
    if (method === 'conversation_state_observe') return {
      contractVersion: 1, source: 'browser', conversationId: params.conversationId, target,
      observedAt: new Date(Date.now() + 1).toISOString(), turnId: params.turnId,
      userMessageId: userId, assistantMessageId: bridge.snapshot.assistantMessageId,
      assistantText: '', readable: bridge.available, generating: bridge.snapshot.generating,
      terminal: bridge.snapshot.terminal, body: bridge.snapshot.body,
      humanGate: bridge.snapshot.humanGate, delivery: 'unknown', requestId: null
    }
    assert.fail(`unexpected browser mutation: ${method}`)
  }
  const host = new ChatGptConversationHost({ bridge, store, writerMode: 'managed', writerEpoch: 3, managedProjectUrl: project })
  return { root, store, bridge, host }
}

test('explicit adoption makes an existing exact target authoritative without creating or sending a conversation', async t => {
  const { host, store, bridge } = await fixture(t)
  assert.deepEqual(await host.stateByTarget(target), { found: false, reason: 'target_unavailable' })
  const result = await host.adoptExistingConversation(request())
  assert.equal(result.accepted, true)
  assert.equal(result.conversationUuid, uuid)
  const found = await host.stateByTarget(target)
  assert.equal(found.found, true)
  assert.equal(found.state.writer.mode, 'managed')
  assert.equal(found.state.writer.epoch, 3)
  assert.equal(found.state.turn.userMessageId, userId)
  assert.equal(found.state.delivery, 'delivered')
  assert.equal(found.state.progress, 'blocked')
  const records = await store.findByExternalUrl(target)
  assert.equal(records.length, 1)
  assert.equal(records[0].events.filter(e => e.type === 'conversation_adopted').length, 1)
  assert.equal(records[0].events.some(e => ['send_intent', 'prompt_sent', 'generation_started'].includes(e.type)), false)
  assert.equal(bridge.calls.some(c => ['conversation_create', 'conversation_send', 'conversation_stop'].includes(c.method)), false)
  assert.equal(await store.getDefaultProjectUrl(), project)
})

test('concurrent and alias adoption reuse one logical record, one binding effect and the same writer', async t => {
  const { host, store, bridge } = await fixture(t)
  const results = await Promise.all([host.adoptExistingConversation(request()), host.adoptExistingConversation(request()),
    host.adoptExistingConversation(request({ target: `https://chatgpt.com/c/${uuid}` }))])
  assert.ok(results.every(r => r.accepted === true))
  assert.equal(new Set(results.map(r => r.conversationId)).size, 1)
  assert.equal((await store.findByExternalUrl(target)).length, 1)
  assert.equal(bridge.effects, 1)
})

test('adoption survives host restart and re-reads current writer epoch without creating another record', async t => {
  const { host, store, bridge } = await fixture(t)
  const first = await host.adoptExistingConversation(request())
  const restarted = new ChatGptConversationHost({ bridge, store: new ConversationStore(store.rootDir), writerMode: 'managed', writerEpoch: 4, managedProjectUrl: project })
  const second = await restarted.adoptExistingConversation(request({ expectedWriterEpoch: 4 }))
  assert.equal(second.accepted, true)
  assert.equal(second.conversationId, first.conversationId)
  const found = await restarted.stateByTarget(target)
  assert.equal(found.found, true)
  assert.equal(found.state.writer.epoch, 4)
  assert.equal(bridge.effects, 1)
})

test('lost adoption acknowledgement is reconciled from its receipt, never by repeating the browser mutation', async t => {
  const { host, store, bridge } = await fixture(t)
  bridge.loseAck = true
  const first = await host.adoptExistingConversation(request())
  assert.equal(first.accepted, false)
  assert.equal(first.reason, 'delivery_uncertain')
  const unresolved = await host.stateByTarget(target)
  assert.equal(unresolved.found, false)
  const second = await host.adoptExistingConversation(request())
  assert.equal(second.accepted, true)
  assert.equal(bridge.effects, 1)
  const records = await store.findByExternalUrl(target)
  assert.equal(records.length, 1)
  assert.equal(records[0].events.filter(e => e.type === 'conversation_adopted').length, 1)
})

test('unresolved acknowledgement without a receipt does not automatically replay or grant managed state', async t => {
  const { host, bridge } = await fixture(t)
  bridge.loseAck = true
  await host.adoptExistingConversation(request())
  bridge.receipts.clear()
  const second = await host.adoptExistingConversation(request())
  assert.equal(second.accepted, false)
  assert.equal(second.reason, 'delivery_uncertain')
  assert.equal(bridge.effects, 1)
  assert.equal((await host.stateByTarget(target)).found, false)
})

test('closed, navigated-away, ambiguous tabs, stale epoch and wrong message anchor fail before allocating a ledger', async t => {
  for (const fault of ['closed', 'navigated', 'ambiguous', 'epoch', 'anchor']) {
    await t.test(fault, async t => {
      const { host, store, bridge } = await fixture(t)
      if (fault === 'closed') bridge.available = false
      if (fault === 'ambiguous') bridge.ambiguous = true
      if (fault === 'navigated') bridge.snapshot.url = 'https://chatgpt.com/c/00000000-0000-4000-8000-000000000052'
      if (fault === 'anchor') bridge.snapshot.userMessageId = 'some-other-id'
      const result = await host.adoptExistingConversation(request(fault === 'epoch' ? { expectedWriterEpoch: 2 } : {}))
      assert.equal(result.accepted, false)
      assert.equal((await store.findByExternalUrl(target)).length, 0)
      assert.equal(bridge.effects, 0)
    })
  }
})

test('duplicate ledger binding is rejected, and an existing owned ledger is not replaced', async t => {
  const { host, store, bridge } = await fixture(t)
  await store.create({ backend: 'chatgpt-web-extension', externalUrl: target })
  await store.create({ backend: 'chatgpt-web-extension', externalUrl: target })
  const result = await host.adoptExistingConversation(request())
  assert.equal(result.accepted, false)
  assert.equal(result.reason, 'ambiguous_local_binding')
  assert.equal((await store.findByExternalUrl(target)).length, 2)
  assert.equal(bridge.effects, 0)
})

test('adoption is explicit, local control-plane only, not an implicit state-read side effect', async t => {
  const { host } = await fixture(t)
  const app = createSidecarServer({ conversationHost: host })
  const addr = await app.listen({ port: 0 })
  t.after(() => app.close())
  const url = `http://127.0.0.1:${addr.port}/internal/conversation-adoption`
  const browser = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://chatgpt.com' }, body: JSON.stringify(request()) })
  assert.equal(browser.status, 403)
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request()) })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).accepted, true)
  await assert.rejects(host.adoptExistingConversation(request({ source: 'watchdog' })), /human|explicit/i)
  await assert.rejects(host.adoptExistingConversation(request({ target: 'https://chatgpt.com/g/g-p-test/project' })), /exact|UUID/i)
})
