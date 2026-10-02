import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ChatGptConversationHost } from '../src/chatgpt.mjs'
import { ConversationStore } from '../src/store.mjs'

const workerSource = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8')
const lifecycleSource = await readFile(new URL('../extension/lifecycle.js', import.meta.url), 'utf8')
const target = 'https://chatgpt.com/c/00000000-0000-4000-8000-000000000101'
const userMessageId = '10000000-0000-4000-8000-000000000101'
const assistantMessageId = '20000000-0000-4000-8000-000000000101'
const registrationId = '30000000-0000-4000-8000-000000000101'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'native-observation-join-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ConversationStore(root)
  const conversation = await store.create({ backend: 'test', externalUrl: target })
  await store.append(conversation.id, { type: 'send_intent', turnId: 'review-turn', requestId: 'review-intent',
    source: 'watchdog', registrationId, text: 'review action' })
  await store.append(conversation.id, { type: 'generation_started', turnId: 'review-turn', externalUrl: target })
  const tab = { id: 101, windowId: 10, url: target }
  const storage = { ['conversation:' + conversation.id]: { ...tab, tabId: tab.id, adopted: true },
    'writer:authority': { version: 1, epoch: 7 },
    'effect-receipt:review-intent': { requestId: 'review-intent', conversationId: conversation.id,
      turnId: 'review-turn', userMessageId, externalUrl: target } }
  const snapshot = { ready: true, url: target, readable: true, userMessageId, assistantMessageId,
    assistantText: '{"decision":"DONE","terminal":"SUPERVISOR_DONE"}', generating: false, terminal: true, body: 'substantive', humanGate: false }
  const port = { onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} }
  const chrome = {
    runtime: { id: 'test-sidecar', connectNative: () => port, getManifest: () => ({ version: 'test' }),
      getURL: path => 'chrome-extension://test-sidecar/' + path,
      onMessage: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
    tabs: { onUpdated: { addListener() {} }, get: async () => ({ ...tab }), query: async () => [{ ...tab }],
      sendMessage: async (_, message) => {
        assert.equal(message.type, 'conversation_state_observe')
        assert.equal(message.allowLatestUser, true)
        await delay(3)
        return { ...snapshot }
      } },
    storage: { local: { get: async key => key === null ? { ...storage } : Object.hasOwn(storage, key) ? { [key]: storage[key] } : {},
      set: async values => { Object.assign(storage, values) }, remove: async key => { delete storage[key] } } }
  }
  const context = vm.createContext({ chrome, console, URL, structuredClone, crypto: { randomUUID: () => '40000000-0000-4000-8000-000000000101' },
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer }, clearTimeout })
  context.importScripts = (...paths) => {
    for (const path of paths) {
      if (path === 'build-info.js') context.__sidecarBuildId = 'a'.repeat(64)
      else if (path === 'lifecycle.js') vm.runInContext(lifecycleSource, context)
      else assert.fail('unexpected import: ' + path)
    }
  }
  vm.runInContext(workerSource, context)
  const bridge = new EventEmitter()
  bridge.raw = []
  bridge.request = async (method, params) => {
    context.message = { method, params }
    const result = structuredClone(await vm.runInContext('executeRequest(message)', context))
    if (method === 'conversation_state_observe') bridge.raw.push(result)
    return result
  }
  return { host: new ChatGptConversationHost({ bridge, store, writerEpoch: 7 }), bridge, snapshot, storage }
}

test('actual native observation delivery unknown joins exact current owner receipt into delivered fresh REVIEW', async t => {
  const { host, bridge } = await fixture(t)
  const reply = await host.observationByTarget(target)
  assert.equal(bridge.raw.at(-1).delivery, 'unknown')
  assert.equal(reply.found, true)
  assert.equal(reply.state.delivery, 'delivered')
  assert.equal(reply.observation.delivery, 'delivered')
  assert.equal(reply.state.turn.userMessageId, userMessageId)
  assert.equal(reply.observation.userMessageId, userMessageId)
  assert.equal(reply.state.turn.assistantMessageId, assistantMessageId)
  assert.equal(reply.state.progress, 'terminal')
  assert.deepEqual(reply.lineage, { registrationId, intentId: 'review-intent' })
  if (process.env.SIDECAR_EMIT_JOIN_FIXTURE === '1') console.log('SIDECAR_NATIVE_JOIN_FIXTURE=' + JSON.stringify(reply))
})

test('actual native unreadable, wrong-target and unpersisted user facts cannot produce an actionable fresh wrapper', async t => {
  for (const fault of ['unreadable', 'target', 'synthetic']) {
    await t.test(fault, async t => {
      const { host, snapshot } = await fixture(t)
      if (fault === 'unreadable') snapshot.readable = false
      if (fault === 'target') snapshot.url = 'https://chatgpt.com/c/00000000-0000-4000-8000-000000000102'
      if (fault === 'synthetic') snapshot.userMessageId = 'dom-index-2'
      assert.equal((await host.observationByTarget(target)).found, false)
    })
  }
})

test('actual native browser shape cannot prove an unknown pending owner send without receipt or a known user anchor', async t => {
  const { host, storage } = await fixture(t)
  delete storage['effect-receipt:review-intent']
  // The generation event alone proves historical delivery but supplies no
  // persistent user identity; no DOM request may guess an anchor.
  const reply = await host.observationByTarget(target)
  assert.equal(reply.found, false)
})
