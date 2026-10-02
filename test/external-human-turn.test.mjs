import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ChatGptConversationHost } from '../src/chatgpt.mjs'
import { ConversationStore } from '../src/store.mjs'

const target = 'https://chatgpt.com/c/00000000-0000-4000-8000-000000000091'
const oldUser = '10000000-0000-4000-8000-000000000091'
const newUser = '10000000-0000-4000-8000-000000000092'
const assistant = '20000000-0000-4000-8000-000000000091'
const newAssistant = '20000000-0000-4000-8000-000000000092'
const registrationId = '30000000-0000-4000-8000-000000000091'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'external-human-turn-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ConversationStore(root)
  const record = await store.create({ backend: 'test', externalUrl: target })
  await store.append(record.id, { type: 'send_intent', turnId: 'old-review-turn',
    requestId: 'old-review-intent', source: 'watchdog', registrationId, text: 'review the old action' })
  await store.append(record.id, { type: 'generation_started', turnId: 'old-review-turn', externalUrl: target })
  const bridge = new EventEmitter()
  bridge.calls = []
  bridge.current = { userMessageId: oldUser, assistantMessageId: assistant,
    assistantText: '[SUPERVISOR_STATE: NEED_INPUT] old REVIEW {"status":"DONE"}',
    readable: true, generating: false, terminal: true, body: 'substantive', humanGate: true }
  bridge.request = async (method, params) => {
    bridge.calls.push({ method, params })
    if (method === 'conversation_effect_receipt') return { found: true, receipt: {
      requestId: 'old-review-intent', conversationId: record.id, turnId: 'old-review-turn',
      userMessageId: oldUser, externalUrl: target
    } }
    if (method === 'conversation_state_observe') {
      await delay(3)
      return { contractVersion: 1, source: 'browser', conversationId: record.id, target,
        observedAt: new Date().toISOString(), turnId: params.turnId,
        delivery: 'delivered', requestId: null, ...bridge.current }
    }
    assert.fail('observation must not mutate the browser: ' + method)
  }
  return { store, record, bridge, host: new ChatGptConversationHost({ bridge, store, writerEpoch: 7 }) }
}

test('fresh external human pending, active and terminal advance owner state without old REVIEW or gate', async t => {
  const { host, bridge, store, record } = await fixture(t)
  const old = await host.observationByTarget(target)
  assert.equal(old.state.gate, 'human_required')
  assert.deepEqual(old.lineage, { registrationId, intentId: 'old-review-intent' })
  bridge.current = { userMessageId: newUser, assistantMessageId: null, assistantText: '',
    readable: true, generating: false, terminal: false, body: 'empty', humanGate: false }
  const pending = await host.observationByTarget(target)
  assert.equal(pending.found, true)
  assert.match(pending.state.turn.turnId, /^human_/)
  assert.equal(pending.state.turn.userMessageId, newUser)
  assert.equal(pending.state.turn.assistantMessageId, null)
  assert.equal(pending.state.progress, 'unknown')
  assert.equal(pending.state.body, 'empty')
  assert.equal(pending.state.delivery, 'delivered')
  assert.equal(pending.state.gate, 'none')
  assert.equal(pending.observation.assistantText, '')
  assert.equal(pending.observation.delivery, 'delivered')
  assert.deepEqual(pending.lineage, { registrationId: null, intentId: null })
  assert.ok(pending.state.stateVersion > old.state.stateVersion)
  assert.equal(bridge.calls.at(-1).params.allowLatestUser, true)
  const turnId = pending.state.turn.turnId
  bridge.current = { userMessageId: newUser, assistantMessageId: newAssistant, assistantText: 'new partial',
    readable: true, generating: true, terminal: false, body: 'incomplete', humanGate: false }
  const active = await host.observationByTarget(target)
  assert.equal(active.state.turn.turnId, turnId)
  assert.equal(active.state.progress, 'active')
  assert.equal(active.state.turn.assistantMessageId, newAssistant)
  bridge.current.generating = false
  bridge.current.terminal = true
  bridge.current.body = 'substantive'
  bridge.current.assistantText = 'new human result {"status":"DONE"}'
  const terminal = await host.observationByTarget(target)
  assert.equal(terminal.state.turn.turnId, turnId)
  assert.equal(terminal.state.progress, 'terminal')
  assert.equal(terminal.state.gate, 'none')
  assert.equal(terminal.observation.assistantText, 'new human result {"status":"DONE"}')
  assert.deepEqual(terminal.lineage, { registrationId: null, intentId: null })
  const ledger = await store.read(record.id)
  assert.equal(ledger.latestTurnId, turnId)
  assert.equal(ledger.events.filter(event => event.type === 'human_turn_observed').length, 1)
  assert.equal(ledger.events.filter(event => event.type === 'send_intent').length, 1)
  assert.equal(ledger.latestResponse, 'new human result {"status":"DONE"}')
})

test('external human fact and null Watchdog lineage survive owner restart', async t => {
  const { host, bridge, store } = await fixture(t)
  await host.observationByTarget(target)
  bridge.current = { userMessageId: newUser, assistantMessageId: newAssistant, assistantText: 'new result',
    readable: true, generating: false, terminal: true, body: 'substantive', humanGate: false }
  const first = await host.observationByTarget(target)
  const restarted = new ChatGptConversationHost({ bridge, store: new ConversationStore(store.rootDir), writerEpoch: 8 })
  const next = await restarted.observationByTarget(target)
  assert.equal(next.found, true)
  assert.equal(next.state.turn.turnId, first.state.turn.turnId)
  assert.equal(next.state.turn.userMessageId, newUser)
  assert.equal(next.observation.assistantText, 'new result')
  assert.deepEqual(next.lineage, { registrationId: null, intentId: null })
})

test('stale, unreadable, wrong-target or unpersisted identity cannot create a new human turn', async t => {
  for (const fault of ['stale', 'unreadable', 'wrong-target', 'ephemeral']) {
    await t.test(fault, async t => {
      const { host, bridge, store, record } = await fixture(t)
      await host.observationByTarget(target)
      bridge.current = { userMessageId: newUser, assistantMessageId: null, assistantText: '',
        readable: true, generating: false, terminal: false, body: 'empty', humanGate: false }
      if (fault === 'stale') bridge.current.observedAt = '2026-01-01T00:00:00Z'
      if (fault === 'unreadable') bridge.current.readable = false
      if (fault === 'wrong-target') bridge.current.target = 'https://chatgpt.com/c/00000000-0000-4000-8000-000000000099'
      if (fault === 'ephemeral') bridge.current.userMessageId = 'dom-index-3'
      assert.equal((await host.observationByTarget(target)).found, false)
      assert.equal((await store.read(record.id)).events.some(event => event.type === 'human_turn_observed'), false)
    })
  }
})

test('a late known old user cannot rewind the new external human turn', async t => {
  const { host, bridge, store, record } = await fixture(t)
  const old = { ...bridge.current }
  await host.observationByTarget(target)
  bridge.current = { userMessageId: newUser, assistantMessageId: newAssistant, assistantText: 'new result',
    readable: true, generating: false, terminal: true, body: 'substantive', humanGate: false }
  const current = await host.observationByTarget(target)
  bridge.current = old
  assert.equal((await host.observationByTarget(target)).found, false)
  assert.equal((await store.read(record.id)).latestTurnId, current.state.turn.turnId)
})

test('simultaneous fresh observers record one external human fact and one generation', async t => {
  const { host, bridge, store, record } = await fixture(t)
  await host.observationByTarget(target)
  bridge.current = { userMessageId: newUser, assistantMessageId: newAssistant, assistantText: 'new partial',
    readable: true, generating: true, terminal: false, body: 'incomplete', humanGate: false }
  const snapshots = await Promise.all([host.observationByTarget(target), host.observationByTarget(target), host.observationByTarget(target)])
  assert.ok(snapshots.every(snapshot => snapshot.found))
  assert.equal(new Set(snapshots.map(snapshot => snapshot.state.turn.turnId)).size, 1)
  assert.equal((await store.read(record.id)).events.filter(event => event.type === 'human_turn_observed').length, 1)
})
