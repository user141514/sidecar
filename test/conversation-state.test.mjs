import test from 'node:test'
import assert from 'node:assert/strict'

const mod = await import('../src/conversation-state.mjs').catch(() => ({}))
const id = 'conv_state'
const target = 'https://chatgpt.com/c/00000000-0000-0000-0000-000000000021'
const writer = { mode: 'managed', epoch: 7 }

const ledger = (status = 'generating', extra = []) => ({
  id, externalUrl: target, status, latestTurnId: 'turn-1', latestResponse: null, error: null,
  events: [
    { at: '2026-09-16T02:00:00.000Z', type: 'conversation_created', externalUrl: target },
    { at: '2026-09-16T02:00:01.000Z', type: 'send_intent', turnId: 'turn-1', requestId: 'request-1', text: 'audit' },
    ...(status === 'sending' ? [] : [{ at: '2026-09-16T02:00:02.000Z', type: 'generation_started', turnId: 'turn-1', externalUrl: target }]),
    ...extra
  ]
})

const obs = (source = 'browser', over = {}) => ({
  contractVersion: 1, source, conversationId: id, target,
  observedAt: source === 'receipt' ? '2026-09-16T02:00:30.000Z' : '2026-09-16T02:01:00.000Z',
  turnId: 'turn-1', userMessageId: 'user-1', assistantMessageId: source === 'receipt' ? null : 'assistant-1',
  assistantText: source === 'receipt' ? null : 'partial response', readable: true,
  generating: source === 'receipt' ? null : false, terminal: source === 'receipt' ? null : true,
  body: source === 'receipt' ? 'unknown' : 'incomplete', humanGate: source === 'receipt' ? null : false,
  delivery: source === 'receipt' ? 'delivered' : 'unknown', requestId: source === 'receipt' ? 'request-1' : null,
  ...over
})

function reduce(ledgerValue, observations) {
  assert.equal(typeof mod.reduceConversationState, 'function')
  return mod.reduceConversationState({ ledger: ledgerValue, observations, writer })
}

test('stopped shell-only exact turn becomes blocked/incomplete', () => {
  const state = reduce(ledger(), [obs()])
  assert.deepEqual([state.progress, state.body, state.delivery], ['blocked', 'incomplete', 'delivered'])
  assert.deepEqual(state.turn, { turnId: 'turn-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' })
})

test('exact substantive terminal evidence becomes terminal', () => {
  const state = reduce(ledger(), [obs('browser', { body: 'substantive', assistantText: 'complete result' })])
  assert.deepEqual([state.progress, state.body], ['terminal', 'substantive'])
})

test('substantive body without terminal evidence remains blocked', () => {
  const state = reduce(ledger(), [obs('browser', { terminal: false, body: 'substantive', assistantText: 'truncated but substantial' })])
  assert.deepEqual([state.progress, state.body], ['blocked', 'substantive'])
})

test('missing or unreadable exact live evidence is unknown', () => {
  for (const observations of [[], [obs('browser', { readable: false, userMessageId: null, assistantMessageId: null, assistantText: null, terminal: null, body: 'unknown' })]]) {
    assert.equal(reduce(ledger(), observations).progress, 'unknown')
  }
})

test('browser observation alone cannot upgrade an unproven pending effect to delivered', () => {
  const state = reduce(ledger('sending'), [obs('browser', { generating: false, terminal: false })])
  assert.equal(state.delivery, 'pending')
})

test('EffectReceipt proves delivery only, never completion', () => {
  const l = ledger('delivery_uncertain', [{ at: '2026-09-16T02:00:03.000Z', type: 'delivery_uncertain', turnId: 'turn-1', message: 'ack lost' }])
  const state = reduce(l, [obs('receipt')])
  assert.deepEqual([state.delivery, state.progress, state.body], ['delivered', 'unknown', 'unknown'])
  assert.equal(state.turn.userMessageId, 'user-1')
})

test('newer observation wins over older terminal observation', () => {
  const oldFinal = obs('browser', { body: 'substantive', assistantText: 'old final' })
  const newerActive = obs('browser', { observedAt: '2026-09-16T02:01:05.000Z', generating: true, terminal: false, body: 'incomplete', assistantText: 'streaming' })
  assert.equal(reduce(ledger(), [newerActive, oldFinal]).progress, 'active')
})

test('terminal evidence from another turn cannot complete current turn', () => {
  const state = reduce(ledger(), [obs('browser', { turnId: 'turn-old', body: 'substantive', assistantText: 'stale final' })])
  assert.deepEqual([state.progress, state.turn.turnId], ['unknown', 'turn-1'])
})

test('browser evidence with the wrong exact user identity cannot complete the current turn', () => {
  const l = ledger('delivery_uncertain', [{ at: '2026-09-16T02:00:03.000Z', type: 'delivery_uncertain', turnId: 'turn-1', message: 'ack lost' }])
  const receipt = obs('receipt', { userMessageId: 'user-1' })
  const wrongBrowser = obs('browser', {
    observedAt: '2026-09-16T02:01:05.000Z',
    userMessageId: 'user-2',
    terminal: true,
    body: 'substantive',
    assistantText: 'wrong-turn final'
  })
  const state = reduce(l, [receipt, wrongBrowser])
  assert.deepEqual([state.delivery, state.progress, state.turn.userMessageId], ['delivered', 'unknown', 'user-1'])
})

test('human-required gate is sticky until explicit control-plane provenance clears it', () => {
  const previous = { contractVersion: 1, conversationId: id, target, stateVersion: 4,
    turn: { turnId: 'turn-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' },
    progress: 'terminal', body: 'substantive', delivery: 'delivered', gate: 'human_required', writer }
  const l = ledger('generating', [{ at: '2026-09-16T02:00:50.000Z', type: 'conversation_state', state: previous }])
  const state = reduce(l, [obs('browser', { body: 'substantive', assistantText: 'done', humanGate: false })])
  assert.equal(state.gate, 'human_required')
})

test('stateVersion is stable for same semantics and increments on change', () => {
  const previous = { contractVersion: 1, conversationId: id, target, stateVersion: 4,
    turn: { turnId: 'turn-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' },
    progress: 'blocked', body: 'incomplete', delivery: 'delivered', gate: 'none', writer }
  const l = ledger('generating', [{ at: '2026-09-16T02:00:50.000Z', type: 'conversation_state', state: previous }])
  assert.equal(reduce(l, [obs()]).stateVersion, 4)
  const changed = reduce(l, [obs('browser', { observedAt: '2026-09-16T02:01:10.000Z', body: 'substantive', assistantText: 'complete result' })])
  assert.deepEqual([changed.stateVersion, changed.progress], [5, 'terminal'])
})

test('an observation older than the last durable projection cannot roll authoritative state backward', () => {
  const previous = { contractVersion: 1, conversationId: id, target, stateVersion: 4,
    turn: { turnId: 'turn-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' },
    progress: 'terminal', body: 'substantive', delivery: 'delivered', gate: 'none', writer }
  const l = ledger('generating', [{ at: '2026-09-16T02:01:06.000Z', type: 'conversation_state', state: previous }])
  const stale = obs('browser', {
    observedAt: '2026-09-16T02:01:00.000Z',
    generating: false,
    terminal: false,
    body: 'incomplete',
    assistantText: 'older partial body'
  })
  const state = reduce(l, [stale])
  assert.deepEqual([state.stateVersion, state.progress, state.body], [4, 'terminal', 'substantive'])
})
