import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatGptConversationHost } from '../src/chatgpt.mjs'
import { ConversationStore } from '../src/store.mjs'
import { parseConversationState, parseObservation } from '../src/conversation-contract.mjs'
import { createSidecarServer } from '../src/server.mjs'

const target = 'https://chatgpt.com/c/00000000-0000-0000-0000-000000000031'

async function fixture(t, over = {}) {
  const root = await mkdtemp(join(tmpdir(), 'conversation-observation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ConversationStore(root)
  const conversation = await store.create({ backend: 'test', externalUrl: target })
  await store.append(conversation.id, { type: 'send_intent', turnId: 'turn-1', requestId: 'request-1', text: 'audit' })
  await store.append(conversation.id, { type: 'generation_started', turnId: 'turn-1', externalUrl: target })
  const bridge = new EventEmitter()
  const calls = []
  bridge.request = async (method, params) => {
    calls.push(method)
    if (method === 'conversation_effect_receipt') return { found: true, receipt: {
      requestId: 'request-1', conversationId: conversation.id, turnId: 'turn-1', userMessageId: '10000000-0000-4000-8000-000000000031', externalUrl: target
    } }
    if (method === 'conversation_state_observe') {
      if (over.throwObservation) throw new Error('disconnected')
      return {
        contractVersion: 1, source: 'browser', conversationId: conversation.id, target,
        observedAt: new Date().toISOString(), turnId: 'turn-1',
        userMessageId: '10000000-0000-4000-8000-000000000031', assistantMessageId: 'assistant-1',
        assistantText: 'REVIEW {"verdict":"continue"}', readable: true,
        generating: false, terminal: true, body: 'substantive', humanGate: false,
        delivery: 'unknown', requestId: null, ...over.observation
      }
    }
    throw new Error('unexpected mutation: ' + method)
  }
  return { store, conversation, calls, bridge, host: new ChatGptConversationHost({ bridge, store, writerEpoch: 7 }) }
}

for (const active of [true, false]) {
  test('fresh observation returns exact raw text and its same-pass ' + (active ? 'active' : 'terminal') + ' state', async t => {
    const { host, conversation, calls } = await fixture(t, { observation: { generating: active, terminal: !active } })
    const reply = await host.observationByTarget(target)
    assert.equal(reply.found, true)
    assert.equal(reply.state.conversationId, conversation.id)
    assert.equal(reply.state.progress, active ? 'active' : 'terminal')
    assert.equal(reply.state.writer.epoch, 7)
    assert.equal(reply.observation.assistantText, 'REVIEW {"verdict":"continue"}')
    assert.equal(reply.observation.generating, active)
    assert.equal(reply.observation.delivery, 'delivered')
    assert.equal(reply.observation.turnId, reply.state.turn.turnId)
    assert.equal(reply.observation.userMessageId, reply.state.turn.userMessageId)
    assert.equal(reply.observation.assistantMessageId, reply.state.turn.assistantMessageId)
    assert.deepEqual(parseConversationState(reply.state), reply.state)
    assert.deepEqual(parseObservation(reply.observation), reply.observation)
    assert.equal(calls.filter(method => method === 'conversation_state_observe').length, 1)
    assert.deepEqual(Object.keys(await host.state(conversation.id)).sort(), Object.keys(reply.state).sort())
  })
}

test('cached terminal projection cannot stand in for a missing current observation', async t => {
  const { host, store, conversation } = await fixture(t, { throwObservation: true })
  await store.append(conversation.id, { type: 'response_completed', turnId: 'turn-1', text: 'old final', externalUrl: target })
  assert.equal((await host.state(conversation.id)).progress, 'terminal')
  assert.deepEqual(await host.observationByTarget(target), { found: false, reason: 'observation_unavailable' })
})

test('old observedAt and wrong exact target cannot be presented as fresh observations', async t => {
  for (const observation of [
    { observedAt: '2026-01-01T00:00:00.000Z' },
    { target: 'https://chatgpt.com/c/00000000-0000-0000-0000-000000000032' },
    { userMessageId: 'wrong-user' },
    { readable: false }
  ]) {
    const { host } = await fixture(t, { observation })
    assert.deepEqual(await host.observationByTarget(target), { found: false, reason: 'observation_unavailable' })
  }
})

test('explicit raw pending and uncertain delivery cannot be overwritten by a cached delivered projection', async t => {
  for (const delivery of ['pending', 'uncertain']) {
    const { host } = await fixture(t, { observation: { delivery } })
    const reply = await host.observationByTarget(target)
    assert.equal(reply.found, true)
    assert.equal(reply.state.delivery, 'delivered')
    assert.equal(reply.observation.delivery, delivery)
  }
})

test('fresh NEED_INPUT retains the exact human gate and assistant marker text', async t => {
  const { host } = await fixture(t, { observation: {
    assistantText: 'Please approve\n[SUPERVISOR_STATE: NEED_INPUT]', humanGate: true
  } })
  const reply = await host.observationByTarget(target)
  assert.equal(reply.found, true)
  assert.equal(reply.state.gate, 'human_required')
  assert.equal(reply.observation.humanGate, true)
  assert.match(reply.observation.assistantText, /NEED_INPUT/)
})

test('observation endpoint requires one exact local binding and cannot adopt or register implicitly', async t => {
  const { host, store } = await fixture(t)
  await store.create({ backend: 'test', externalUrl: target })
  assert.deepEqual(await host.observationByTarget(target), { found: false, reason: 'ambiguous_local_binding' })
  await assert.rejects(host.observationByTarget('https://chatgpt.com/'), /exact conversation target/)
})

test('local observation HTTP returns fresh normalized evidence and rejects browser-origin and extra fields', async t => {
  const { host } = await fixture(t)
  const app = createSidecarServer({ conversationHost: host })
  const address = await app.listen({ port: 0 })
  t.after(() => app.close())
  const url = 'http://127.0.0.1:' + address.port + '/internal/conversation-observation'
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target }) })
  assert.equal(response.status, 200)
  const reply = await response.json()
  assert.equal(reply.found, true)
  assert.equal(reply.observation.assistantText, 'REVIEW {"verdict":"continue"}')
  const browser = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://chatgpt.com' }, body: JSON.stringify({ target }) })
  assert.equal(browser.status, 403)
  const extra = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target, conversationId: 'other' }) })
  assert.equal(extra.status, 400)
})

test('observation owner failure returns unknown without exposing stale state', async t => {
  const app = createSidecarServer({ conversationHost: { observationByTarget: async () => { throw new Error('owner unavailable') } } })
  const address = await app.listen({ port: 0 })
  t.after(() => app.close())
  const response = await fetch('http://127.0.0.1:' + address.port + '/internal/conversation-observation', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target })
  })
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { found: false, reason: 'observation_unavailable' })
})
