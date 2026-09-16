import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatGptConversationHost } from '../src/chatgpt.mjs'
import { ConversationStore } from '../src/store.mjs'

const target = 'https://chatgpt.com/c/00000000-0000-0000-0000-000000000031'

async function fixture(t, observation) {
  const root = await mkdtemp(join(tmpdir(), 'conversation-state-host-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ConversationStore(root)
  const conversation = await store.create({ backend: 'test', externalUrl: target })
  await store.append(conversation.id, { type: 'send_intent', turnId: 'turn-1', requestId: 'request-1', text: 'audit' })
  await store.append(conversation.id, { type: 'generation_started', turnId: 'turn-1', externalUrl: target })
  const bridge = new EventEmitter()
  bridge.calls = []
  bridge.request = async (method, params) => {
    bridge.calls.push({ method, params })
    if (method === 'conversation_effect_receipt') return { found: true, receipt: {
      requestId: 'request-1', conversationId: conversation.id, turnId: 'turn-1', userMessageId: 'user-1', externalUrl: target
    } }
    if (method === 'conversation_state_observe') {
      const value = typeof observation === 'function' ? await observation(params) : observation
      return { ...value, conversationId: conversation.id }
    }
    throw new Error(`unexpected ${method}`)
  }
  return { store, conversation, bridge, host: new ChatGptConversationHost({ bridge, store }) }
}

const browser = (over = {}) => ({
  contractVersion: 1, source: 'browser', conversationId: 'placeholder', target,
  observedAt: '2026-09-16T03:00:00.000Z', turnId: 'turn-1', userMessageId: 'user-1',
  assistantMessageId: 'assistant-1', assistantText: 'partial', readable: true,
  generating: false, terminal: true, body: 'incomplete', humanGate: false,
  delivery: 'unknown', requestId: null, ...over
})

test('host state persists one authoritative projection and repeated reads are idempotent', async t => {
  const { host, store, conversation, bridge } = await fixture(t, browser())
  assert.equal(typeof host.state, 'function')
  const first = await host.state(conversation.id)
  const second = await host.state(conversation.id)
  assert.deepEqual([first.progress, first.body, first.delivery], ['blocked', 'incomplete', 'delivered'])
  assert.equal(second.stateVersion, first.stateVersion)
  const stored = await store.read(conversation.id)
  assert.equal(stored.events.filter(e => e.type === 'conversation_state').length, 1)
  assert.equal(bridge.calls.some(call => call.method === 'conversation_send'), false)
})

test('host state durably repairs stale generating ledger when exact terminal body is substantive', async t => {
  const { host, store, conversation } = await fixture(t, browser({ body: 'substantive', assistantText: 'FINAL RESULT' }))
  const state = await host.state(conversation.id)
  assert.equal(state.progress, 'terminal')
  const stored = await store.read(conversation.id)
  assert.equal(stored.status, 'completed')
  assert.equal(stored.latestResponse, 'FINAL RESULT')
  assert.equal(stored.events.some(e => e.type === 'response_completed' && e.reconciled === true), true)
})

test('ordinary read reconciles stale generating ledger through authoritative state', async t => {
  const { host, conversation } = await fixture(t, browser({ body: 'substantive', assistantText: 'READ RESULT' }))
  const result = await host.read(conversation.id)
  assert.equal(result.status, 'completed')
  assert.equal(result.latestResponse, 'READ RESULT')
})

test('ordinary read durably exposes blocked incomplete state as need_continue', async t => {
  const { host, conversation } = await fixture(t, browser())
  const result = await host.read(conversation.id)
  assert.equal(result.status, 'need_continue')
  assert.equal(result.latestResponse, 'partial')
})

test('human gate vetoes legacy completion even when terminal body is substantive', async t => {
  const { host, store, conversation } = await fixture(t, browser({
    body: 'substantive', assistantText: 'Need approval\n[SUPERVISOR_STATE: NEED_INPUT]', humanGate: true
  }))
  const state = await host.state(conversation.id)
  assert.deepEqual([state.progress, state.body, state.gate], ['terminal', 'substantive', 'human_required'])
  const stored = await store.read(conversation.id)
  assert.equal(stored.status, 'need_continue')
  assert.equal(stored.events.some(event => event.type === 'response_completed' && event.turnId === 'turn-1'), false)
  assert.equal(stored.events.some(event => event.type === 'need_continue' && event.reason === 'human_required'), true)
})

test('unreadable exact browser state projects unknown without fabricating completion', async t => {
  const { host, store, conversation } = await fixture(t, browser({ readable: false, userMessageId: null, assistantMessageId: null, assistantText: null, generating: null, terminal: null, body: 'unknown', humanGate: null }))
  const state = await host.state(conversation.id)
  assert.equal(state.progress, 'unknown')
  assert.equal((await store.read(conversation.id)).status, 'generating')
})

test('compatibility terminal event cannot consume browser text rejected by the authoritative reducer', async t => {
  const wrong = browser({
    observedAt: '2026-09-16T03:00:10.000Z',
    userMessageId: 'user-2',
    assistantText: 'wrong-turn final',
    body: 'substantive'
  })
  const { host, store, conversation } = await fixture(t, wrong)
  await store.append(conversation.id, {
    type: 'conversation_state',
    state: {
      contractVersion: 1,
      conversationId: conversation.id,
      target,
      stateVersion: 4,
      turn: { turnId: 'turn-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' },
      progress: 'terminal',
      body: 'substantive',
      delivery: 'delivered',
      gate: 'none',
      writer: { mode: 'managed', epoch: 0 }
    }
  })
  const state = await host.state(conversation.id)
  assert.deepEqual([state.stateVersion, state.progress, state.turn.userMessageId], [4, 'terminal', 'user-1'])
  const stored = await store.read(conversation.id)
  assert.equal(stored.events.some(event => event.type === 'response_completed'), false)
})

test('stateByTarget resolves exactly one local binding and fails closed on ambiguity or non-exact targets', async t => {
  const { host, store, conversation } = await fixture(t, browser())
  const found = await host.stateByTarget(target)
  assert.equal(found.found, true)
  assert.equal(found.state.conversationId, conversation.id)
  assert.equal(found.state.target, target)

  await store.create({ backend: 'test', externalUrl: target })
  assert.deepEqual(await host.stateByTarget(target), { found: false, reason: 'ambiguous_local_binding' })
  await assert.rejects(host.stateByTarget('https://chatgpt.com/'), /exact conversation target/i)
})

test('concurrent state reconciliation serializes one authoritative version sequence', async t => {
  let active = 0, peak = 0, sequence = 0
  const observation = async () => {
    const index = ++sequence
    active += 1
    peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 20))
    active -= 1
    return index === 1
      ? browser({ observedAt: new Date(Date.now() + 1000).toISOString(), body: 'incomplete', assistantText: 'partial' })
      : browser({ observedAt: new Date(Date.now() + 2000).toISOString(), body: 'substantive', assistantText: 'FINAL' })
  }
  const { host, store, conversation } = await fixture(t, observation)
  await Promise.all([host.state(conversation.id), host.state(conversation.id)])
  const states = (await store.read(conversation.id)).events.filter(event => event.type === 'conversation_state').map(event => event.state)
  assert.equal(peak, 1)
  assert.deepEqual(states.map(state => state.stateVersion), [1, 2])
  assert.deepEqual(states.map(state => state.progress), ['blocked', 'terminal'])
})
