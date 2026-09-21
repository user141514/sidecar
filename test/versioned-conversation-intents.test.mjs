import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ChatGptConversationHost } from '../src/chatgpt.mjs'
import { createRuntimeComponents, createSidecarServer } from '../src/server.mjs'
import { parseConversationState } from '../src/conversation-contract.mjs'
import { ConversationStore } from '../src/store.mjs'

const target = 'https://chatgpt.com/c/00000000-0000-0000-0000-000000000041'
const managedProjectUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946-subagents/project'
const newThreadUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946-subagents/c/new-thread'
const expected = { userMessageId: 'user-1', assistantMessageId: 'assistant-1' }

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'versioned-intents-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ConversationStore(root)
  const conversation = await store.create({ backend: 'chatgpt-web-extension', externalUrl: target })
  await store.append(conversation.id, { type: 'send_intent', turnId: 'root-turn', requestId: 'root-request', text: 'root task' })
  await store.append(conversation.id, { type: 'response_completed', turnId: 'root-turn', text: 'root result', externalUrl: target })

  const bridge = new EventEmitter()
  bridge.calls = []
  bridge.request = async (method, params) => {
    bridge.calls.push({ method, params })
    if (method === 'conversation_observe') return { found: true, allowed: true, ...expected, url: target }
    if (method === 'conversation_send') return { accepted: true, url: target }
    assert.fail(`unexpected browser effect: ${method}`)
  }
  const admission = { calls: 0, async admit() { this.calls += 1; return { admitted: true } } }
  const host = new ChatGptConversationHost({ bridge, store, sendAdmission: admission, writerMode: 'managed', writerEpoch: 3 })
  return { store, conversation, bridge, admission, host }
}

async function setupNew(t, { admitted = true, sendUncertain = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'versioned-new-intents-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ConversationStore(root)
  const bridge = new EventEmitter()
  bridge.calls = []
  let submitted = null
  bridge.request = async (method, params) => {
    bridge.calls.push({ method, params })
    if (method === 'conversation_create') return { windowId: 10, tabId: 20, url: managedProjectUrl }
    if (method === 'conversation_send') {
      submitted = params
      if (sendUncertain) {
        const error = new Error('browser acceptance ack lost')
        error.code = 'DELIVERY_UNCERTAIN'
        throw error
      }
      return { accepted: true, url: newThreadUrl, userMessageId: 'user-new' }
    }
    if (method === 'conversation_effect_receipt' && submitted) {
      return { found: true, receipt: {
        requestId: submitted.requestId,
        conversationId: submitted.conversationId,
        turnId: submitted.turnId,
        userMessageId: 'user-new',
        externalUrl: newThreadUrl
      } }
    }
    assert.fail(`unexpected browser effect: ${method}`)
  }
  const admission = {
    calls: 0,
    async admit() {
      this.calls += 1
      return admitted ? { admitted: true } : { admitted: false, retryAfterMs: 1234 }
    }
  }
  const host = new ChatGptConversationHost({
    bridge,
    store,
    sendAdmission: admission,
    writerMode: 'managed',
    writerEpoch: 3,
    managedProjectUrl
  })
  return { root, store, bridge, admission, host }
}

function state(conversationId, over = {}) {
  const value = {
    contractVersion: 1,
    conversationId,
    target,
    stateVersion: 9,
    turn: { turnId: 'root-turn', ...expected },
    progress: 'blocked',
    body: 'incomplete',
    delivery: 'delivered',
    gate: 'none',
    writer: { mode: 'managed', epoch: 3 },
    ...over
  }
  if (over.turn) value.turn = { turnId: 'root-turn', ...expected, ...over.turn }
  if (over.writer) value.writer = { mode: 'managed', epoch: 3, ...over.writer }
  return parseConversationState(value)
}

function intent(conversationId, over = {}) {
  return {
    contractVersion: 1,
    intentId: 'intent-v1-continue',
    source: 'watchdog',
    conversationId,
    target,
    expectedStateVersion: 9,
    expectedWriterEpoch: 3,
    action: 'continue',
    allocation: null,
    text: 'continue bounded task',
    expected: { ...expected },
    ...over
  }
}

function reuseIntent(conversationId, over = {}) {
  return intent(conversationId, {
    intentId: 'intent-v1-reuse',
    source: 'human',
    action: 'open_child',
    allocation: 'REUSE',
    text: 'start a new bounded task in this child',
    ...over
  })
}

function newIntent(over = {}) {
  return {
    contractVersion: 1,
    intentId: 'intent-v1-new',
    source: 'human',
    conversationId: null,
    target: null,
    expectedStateVersion: null,
    expectedWriterEpoch: null,
    action: 'open_child',
    allocation: 'NEW',
    text: 'create a fresh bounded child',
    expected: { userMessageId: null, assistantMessageId: null },
    ...over
  }
}

function stopIntent(conversationId, over = {}) {
  return {
    contractVersion: 1,
    intentId: 'intent-v1-stop',
    source: 'watchdog',
    conversationId,
    target,
    expectedStateVersion: 9,
    expectedWriterEpoch: 3,
    action: 'stop',
    allocation: null,
    text: null,
    expected: { userMessageId: 'user-1', assistantMessageId: null },
    ...over
  }
}

test('v1 stale state and writer epoch reject before any browser effect', async t => {
  const { host, conversation, bridge, admission } = await setup(t)
  const current = state(conversation.id)
  host.stateByTarget = async () => ({ found: true, state: current })

  const stale = await host.proposeContinuation(intent(conversation.id, { expectedStateVersion: 8 }))
  assert.deepEqual(stale, { accepted: false, reason: 'stale_state', currentStateVersion: 9, currentWriterEpoch: 3 })

  const epoch = await host.proposeContinuation(intent(conversation.id, { intentId: 'intent-v1-epoch', expectedWriterEpoch: 2 }))
  assert.deepEqual(epoch, { accepted: false, reason: 'writer_epoch_mismatch', currentStateVersion: 9, currentWriterEpoch: 3 })

  assert.equal(bridge.calls.some(call => call.method === 'conversation_send'), false)
  assert.equal(admission.calls, 0)
})

test('v1 gate delivery and progress preconditions fail closed', async t => {
  const { host, conversation, bridge, admission } = await setup(t)
  const cases = [
    [state(conversation.id, { gate: 'human_required' }), 'need_input'],
    [state(conversation.id, { delivery: 'uncertain', progress: 'unknown', body: 'unknown' }), 'state_delivery_uncertain'],
    [state(conversation.id, { progress: 'active' }), 'state_not_continuable'],
    [state(conversation.id, { progress: 'blocked', body: 'substantive' }), 'state_not_continuable'],
    [state(conversation.id, { writer: { mode: 'legacy' } }), 'writer_mode_mismatch']
  ]

  let index = 0
  for (const [current, reason] of cases) {
    host.stateByTarget = async () => ({ found: true, state: current })
    const result = await host.proposeContinuation(intent(conversation.id, { intentId: `intent-v1-deny-${index++}` }))
    assert.equal(result.accepted, false)
    assert.equal(result.reason, reason)
  }
  assert.equal(bridge.calls.some(call => call.method === 'conversation_send'), false)
  assert.equal(admission.calls, 0)
})

test('v1 stop interrupts exactly one active generation and records recoverable need_continue', async t => {
  const root = await mkdtemp(join(tmpdir(), 'versioned-stop-intents-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ConversationStore(root)
  const conversation = await store.create({ backend: 'chatgpt-web-extension', externalUrl: target })
  await store.append(conversation.id, { type: 'send_intent', turnId: 'root-turn', requestId: 'root-request', text: 'root task' })
  await store.append(conversation.id, { type: 'generation_started', turnId: 'root-turn', externalUrl: target })

  const bridge = new EventEmitter()
  bridge.calls = []
  bridge.request = async (method, params) => {
    bridge.calls.push({ method, params })
    if (method === 'conversation_stop') {
      return { accepted: true, url: target, userMessageId: 'user-1', assistantMessageId: null }
    }
    assert.fail(`unexpected browser effect: ${method}`)
  }
  const admission = { calls: 0, async admit() { this.calls += 1; return { admitted: true } } }
  const host = new ChatGptConversationHost({ bridge, store, sendAdmission: admission, writerMode: 'managed', writerEpoch: 3 })
  host.stateByTarget = async () => ({ found: true, state: state(conversation.id, {
    progress: 'active', body: 'empty',
    turn: { assistantMessageId: null }
  }) })

  const payload = stopIntent(conversation.id)
  const first = await host.proposeContinuation(payload)
  const replay = await host.proposeContinuation(payload)

  assert.equal(first.accepted, true)
  assert.equal(replay.accepted, true)
  assert.equal(bridge.calls.filter(call => call.method === 'conversation_stop').length, 1)
  assert.equal(bridge.calls.some(call => call.method === 'conversation_send'), false)
  assert.equal(admission.calls, 0)

  const stored = await store.read(conversation.id)
  assert.equal(stored.status, 'need_continue')
  const blocked = stored.events.find(event => event.type === 'need_continue' && event.turnId === 'root-turn')
  assert.equal(blocked.reason, 'watchdog_stall')
})

test('v1 stop converges to blocked state with stable assistant identity for the next continuation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'versioned-stop-state-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ConversationStore(root)
  const conversation = await store.create({ backend: 'chatgpt-web-extension', externalUrl: target })
  await store.append(conversation.id, { type: 'send_intent', turnId: 'root-turn', requestId: 'root-request', text: 'root task' })
  await store.append(conversation.id, { type: 'generation_started', turnId: 'root-turn', externalUrl: target })

  const bridge = new EventEmitter()
  let stopped = false
  bridge.request = async (method, params) => {
    if (method === 'conversation_effect_receipt') {
      if (params.requestId === 'root-request') return { found: true, receipt: {
        requestId: 'root-request', conversationId: conversation.id, turnId: 'root-turn',
        userMessageId: 'user-1', externalUrl: target
      } }
      return { found: false }
    }
    if (method === 'conversation_state_observe') return {
      contractVersion: 1, source: 'browser', conversationId: conversation.id, target,
      observedAt: '2099-09-21T03:00:00.000Z', turnId: 'root-turn', userMessageId: 'user-1',
      assistantMessageId: stopped ? 'assistant-stopped' : null,
      assistantText: stopped ? 'partial after stop' : '', readable: true,
      generating: !stopped, terminal: false, body: stopped ? 'incomplete' : 'empty',
      humanGate: false, delivery: 'unknown', requestId: null
    }
    if (method === 'conversation_stop') {
      stopped = true
      return { accepted: true, url: target, userMessageId: 'user-1', assistantMessageId: 'assistant-stopped', assistantText: 'partial after stop' }
    }
    assert.fail(`unexpected browser effect: ${method}`)
  }
  const host = new ChatGptConversationHost({ bridge, store, writerMode: 'managed', writerEpoch: 3 })

  const before = await host.state(conversation.id)
  assert.equal(before.stateVersion, 1, JSON.stringify(before))
  assert.equal(before.progress, 'active')
  assert.equal(before.turn.assistantMessageId, null)
  const stableBeforeStop = await host.state(conversation.id)
  assert.equal(stableBeforeStop.stateVersion, before.stateVersion, JSON.stringify(stableBeforeStop))

  const result = await host.proposeContinuation(stopIntent(conversation.id, {
    expectedStateVersion: before.stateVersion,
    expectedWriterEpoch: before.writer.epoch,
    expected: { userMessageId: 'user-1', assistantMessageId: null }
  }))
  assert.equal(result.accepted, true, JSON.stringify(result))

  const after = await host.state(conversation.id)
  assert.equal(after.progress, 'blocked')
  assert.equal(after.body, 'incomplete')
  assert.equal(after.turn.userMessageId, 'user-1')
  assert.equal(after.turn.assistantMessageId, 'assistant-stopped')
})

test('v1 stop reconciles lost acknowledgement from durable browser effect receipt without stopping twice', async t => {
  const root = await mkdtemp(join(tmpdir(), 'versioned-stop-reconcile-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ConversationStore(root)
  const conversation = await store.create({ backend: 'chatgpt-web-extension', externalUrl: target })
  await store.append(conversation.id, { type: 'send_intent', turnId: 'root-turn', requestId: 'root-request', text: 'root task' })
  await store.append(conversation.id, { type: 'generation_started', turnId: 'root-turn', externalUrl: target })

  const bridge = new EventEmitter()
  bridge.calls = []
  let stopEffects = 0
  bridge.request = async (method, params) => {
    bridge.calls.push({ method, params })
    if (method === 'conversation_stop') {
      stopEffects += 1
      const error = new Error('native acknowledgement lost after stop')
      error.code = 'DELIVERY_UNCERTAIN'
      throw error
    }
    if (method === 'conversation_effect_receipt') {
      if (stopEffects === 0) return { found: false }
      return {
        found: true,
        receipt: {
          requestId: 'intent-v1-stop',
          action: 'stop',
          conversationId: conversation.id,
          turnId: 'root-turn',
          userMessageId: 'user-1',
          assistantMessageId: null,
          expectedStateVersion: 9,
          expectedWriterEpoch: 3,
          externalUrl: target
        }
      }
    }
    assert.fail(`unexpected browser effect: ${method}`)
  }
  const host = new ChatGptConversationHost({ bridge, store, writerMode: 'managed', writerEpoch: 3 })
  host.stateByTarget = async () => ({ found: true, state: state(conversation.id, {
    progress: 'active', body: 'empty', turn: { assistantMessageId: null }
  }) })

  const payload = stopIntent(conversation.id)
  const first = await host.proposeContinuation(payload)
  assert.equal(first.accepted, false)
  assert.equal(first.reason, 'delivery_uncertain')

  const reconciled = await host.proposeContinuation(payload)
  assert.equal(reconciled.accepted, true)
  assert.equal(reconciled.reconciled, true)
  assert.equal(stopEffects, 1)

  const stored = await store.read(conversation.id)
  assert.equal(stored.status, 'need_continue')
  assert.equal(stored.events.filter(event => event.type === 'need_continue' && event.turnId === 'root-turn').length, 1)
})

test('later blocked state reconciles an older uncertain stop before one new continuation effect', async t => {
  const root = await mkdtemp(join(tmpdir(), 'versioned-stop-postcondition-reconcile-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ConversationStore(root)
  const conversation = await store.create({ backend: 'chatgpt-web-extension', externalUrl: target })
  await store.append(conversation.id, { type: 'send_intent', turnId: 'root-turn', requestId: 'root-request', text: 'root task' })
  await store.append(conversation.id, { type: 'generation_started', turnId: 'root-turn', externalUrl: target })

  const bridge = new EventEmitter()
  bridge.calls = []
  let stopEffects = 0
  let sendEffects = 0
  bridge.request = async (method, params) => {
    bridge.calls.push({ method, params })
    if (method === 'conversation_effect_receipt') return { found: false }
    if (method === 'conversation_stop') {
      stopEffects += 1
      throw new Error('Stop effect could not be confirmed')
    }
    if (method === 'conversation_observe') {
      return {
        found: true,
        allowed: true,
        url: target,
        userMessageId: 'user-1',
        assistantMessageId: 'assistant-stopped'
      }
    }
    if (method === 'conversation_send') {
      sendEffects += 1
      return { accepted: true, url: target, userMessageId: 'user-continue' }
    }
    assert.fail(`unexpected browser effect: ${method}`)
  }
  const admission = { calls: 0, async admit() { this.calls += 1; return { admitted: true } } }
  const host = new ChatGptConversationHost({ bridge, store, sendAdmission: admission, writerMode: 'managed', writerEpoch: 3 })

  let current = state(conversation.id, {
    progress: 'active', body: 'empty', turn: { assistantMessageId: null }
  })
  host.stateByTarget = async () => ({ found: true, state: current })

  const first = await host.proposeContinuation(stopIntent(conversation.id))
  assert.equal(first.accepted, false)
  assert.equal(first.reason, 'delivery_uncertain')
  assert.equal(stopEffects, 1)

  current = state(conversation.id, {
    stateVersion: 10,
    progress: 'blocked',
    body: 'incomplete',
    turn: { assistantMessageId: 'assistant-stopped' }
  })
  const continued = await host.proposeContinuation(intent(conversation.id, {
    intentId: 'intent-after-uncertain-stop',
    expectedStateVersion: 10,
    expected: { userMessageId: 'user-1', assistantMessageId: 'assistant-stopped' }
  }))

  assert.equal(continued.accepted, true)
  assert.equal(stopEffects, 1)
  assert.equal(sendEffects, 1)
  assert.equal(admission.calls, 1)
  assert.equal(await host.mailbox.pendingEffect(target), null)
  const stored = await store.read(conversation.id)
  assert.equal(stored.events.filter(event => event.type === 'need_continue' && event.turnId === 'root-turn').length, 1)
})

test('later active state cannot settle or replay an older uncertain stop', async t => {
  const root = await mkdtemp(join(tmpdir(), 'versioned-stop-active-uncertain-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ConversationStore(root)
  const conversation = await store.create({ backend: 'chatgpt-web-extension', externalUrl: target })
  await store.append(conversation.id, { type: 'send_intent', turnId: 'root-turn', requestId: 'root-request', text: 'root task' })
  await store.append(conversation.id, { type: 'generation_started', turnId: 'root-turn', externalUrl: target })

  const bridge = new EventEmitter()
  let stopEffects = 0
  bridge.request = async method => {
    if (method === 'conversation_effect_receipt') return { found: false }
    if (method === 'conversation_stop') {
      stopEffects += 1
      throw new Error('Stop effect could not be confirmed')
    }
    assert.fail(`unexpected browser effect: ${method}`)
  }
  const host = new ChatGptConversationHost({ bridge, store, writerMode: 'managed', writerEpoch: 3 })
  const active = state(conversation.id, {
    progress: 'active', body: 'empty', turn: { assistantMessageId: null }
  })
  host.stateByTarget = async () => ({ found: true, state: active })

  const first = await host.proposeContinuation(stopIntent(conversation.id))
  const second = await host.proposeContinuation(stopIntent(conversation.id, { intentId: 'new-stop-after-uncertain' }))

  assert.equal(first.reason, 'delivery_uncertain')
  assert.equal(second.reason, 'delivery_uncertain')
  assert.equal(stopEffects, 1)
})

test('v1 stop fails closed unless the exact authoritative turn is active and delivered', async t => {
  const { host, conversation, bridge, admission } = await setup(t)
  const cases = [
    [state(conversation.id, { progress: 'terminal', body: 'substantive', turn: { assistantMessageId: null } }), 'state_not_stoppable'],
    [state(conversation.id, { progress: 'active', body: 'empty', delivery: 'uncertain', turn: { assistantMessageId: null } }), 'state_delivery_uncertain'],
    [state(conversation.id, { progress: 'active', body: 'empty', gate: 'human_required', turn: { assistantMessageId: null } }), 'need_input']
  ]
  let index = 0
  for (const [current, reason] of cases) {
    host.stateByTarget = async () => ({ found: true, state: current })
    const result = await host.proposeContinuation(stopIntent(conversation.id, { intentId: `intent-v1-stop-deny-${index++}` }))
    assert.equal(result.accepted, false)
    assert.equal(result.reason, reason)
  }
  assert.equal(bridge.calls.some(call => call.method === 'conversation_stop'), false)
  assert.equal(admission.calls, 0)
})

test('v1 exact identity mismatch rejects as stale state', async t => {
  const { host, conversation, bridge } = await setup(t)
  host.stateByTarget = async () => ({ found: true, state: state(conversation.id) })
  const result = await host.proposeContinuation(intent(conversation.id, {
    expected: { userMessageId: 'user-other', assistantMessageId: 'assistant-1' }
  }))
  assert.equal(result.accepted, false)
  assert.equal(result.reason, 'stale_state')
  assert.equal(bridge.calls.some(call => call.method === 'conversation_send'), false)
})

test('v1 revalidates authoritative state after pacing before browser effect', async t => {
  const { host, conversation, bridge, admission } = await setup(t)
  const first = state(conversation.id)
  const changed = state(conversation.id, { stateVersion: 10, progress: 'terminal', body: 'substantive' })
  let reads = 0
  host.stateByTarget = async () => ({ found: true, state: ++reads === 1 ? first : changed })

  const result = await host.proposeContinuation(intent(conversation.id, { intentId: 'intent-v1-race' }))
  assert.equal(result.accepted, false)
  assert.equal(result.reason, 'stale_state')
  assert.equal(result.currentStateVersion, 10)
  assert.equal(admission.calls, 1)
  assert.equal(bridge.calls.some(call => call.method === 'conversation_send'), false)
})

test('v1 valid continuation uses intentId as durable effect identity and deduplicates', async t => {
  const { host, conversation, bridge } = await setup(t)
  host.stateByTarget = async () => ({ found: true, state: state(conversation.id) })
  const payload = intent(conversation.id)

  const first = await host.proposeContinuation(payload)
  const second = await host.proposeContinuation(payload)
  assert.equal(first.accepted, true)
  assert.equal(second.turnId, first.turnId)

  const observes = bridge.calls.filter(call => call.method === 'conversation_observe')
  assert.equal(observes.length >= 1, true)
  assert.equal(observes.at(-1).params.authoritativeState, true)

  const sends = bridge.calls.filter(call => call.method === 'conversation_send')
  assert.equal(sends.length, 1)
  assert.equal(sends[0].params.requestId, payload.intentId)
  assert.deepEqual(sends[0].params.expected, expected)
  assert.equal(sends[0].params.existingOnly, true)
  assert.equal(sends[0].params.authoritativeState, true)
})

test('v1 explicit REUSE creates a new turn in the exact existing child without allocating another conversation', async t => {
  const { host, store, conversation, bridge } = await setup(t)
  const reusable = state(conversation.id, { progress: 'terminal', body: 'substantive' })
  host.stateByTarget = async () => ({ found: true, state: reusable })
  const payload = reuseIntent(conversation.id)

  const first = await host.proposeContinuation(payload)
  const duplicate = await host.proposeContinuation(payload)
  assert.equal(first.accepted, true)
  assert.equal(duplicate.turnId, first.turnId)

  const sends = bridge.calls.filter(call => call.method === 'conversation_send')
  assert.equal(sends.length, 1)
  assert.equal(bridge.calls.some(call => call.method === 'conversation_create'), false)
  assert.equal(sends[0].params.conversationId, conversation.id)
  assert.equal(sends[0].params.existingOnly, true)
  assert.equal(sends[0].params.authoritativeState, true)
  assert.equal(sends[0].params.requestId, payload.intentId)

  const stored = await store.read(conversation.id)
  const newIntent = stored.events.find(event => event.type === 'send_intent' && event.turnId === first.turnId)
  assert.equal(newIntent.source, 'human')
  assert.equal(newIntent.continuationOf, 'root-turn')
})

test('v1 REUSE requires a fully terminal reusable child and fails closed for unresolved state', async t => {
  const { host, conversation, bridge, admission } = await setup(t)
  const cases = [
    [state(conversation.id, { progress: 'blocked', body: 'incomplete' }), 'state_not_reusable'],
    [state(conversation.id, { progress: 'active', body: 'incomplete' }), 'state_not_reusable'],
    [state(conversation.id, { progress: 'unknown', body: 'unknown' }), 'state_not_reusable'],
    [state(conversation.id, { gate: 'human_required', progress: 'terminal', body: 'substantive' }), 'need_input'],
    [state(conversation.id, { delivery: 'uncertain', progress: 'unknown', body: 'unknown' }), 'state_delivery_uncertain']
  ]
  let index = 0
  for (const [current, reason] of cases) {
    host.stateByTarget = async () => ({ found: true, state: current })
    const result = await host.proposeContinuation(reuseIntent(conversation.id, { intentId: `intent-v1-reuse-deny-${index++}` }))
    assert.equal(result.accepted, false)
    assert.equal(result.reason, reason)
  }
  assert.equal(bridge.calls.some(call => call.method === 'conversation_send'), false)
  assert.equal(admission.calls, 0)
})

test('v1 NEW requires an explicit managed Project and never falls back to root chat', async t => {
  const { host, bridge, admission } = await setup(t)
  const result = await host.proposeContinuation(newIntent({ intentId: 'intent-v1-new-no-project' }))
  assert.deepEqual(result, { accepted: false, reason: 'managed_project_unresolved' })
  assert.equal(bridge.calls.some(call => ['conversation_create', 'conversation_send'].includes(call.method)), false)
  assert.equal(admission.calls, 0)
})

test('v1 NEW pacing denial allocates no browser tab and no prompt effect', async t => {
  const { host, bridge, admission } = await setupNew(t, { admitted: false })
  const result = await host.proposeContinuation(newIntent({ intentId: 'intent-v1-new-paced' }))
  assert.equal(result.accepted, false)
  assert.equal(result.reason, 'pacing')
  assert.equal(result.retryAfterMs, 1234)
  assert.equal(admission.calls, 1)
  assert.equal(bridge.calls.some(call => ['conversation_create', 'conversation_send'].includes(call.method)), false)
})

test('v1 NEW binds payload identity before pacing so the same intentId cannot change task semantics', async t => {
  const { host, bridge, admission } = await setupNew(t, { admitted: false })
  const first = await host.proposeContinuation(newIntent({
    intentId: 'intent-v1-new-bound-before-pacing',
    text: 'TASK_A'
  }))
  assert.equal(first.reason, 'pacing')

  const changed = await host.proposeContinuation(newIntent({
    intentId: 'intent-v1-new-bound-before-pacing',
    text: 'TASK_B'
  }))
  assert.equal(changed.accepted, false)
  assert.equal(changed.reason, 'request_identity_conflict')
  assert.equal(admission.calls, 1)
  assert.equal(bridge.calls.some(call => ['conversation_create', 'conversation_send'].includes(call.method)), false)
})

test('legacy NEW allocation already bound by send identity rejects changed payload before browser effect', async t => {
  const { store, bridge, host } = await setupNew(t)
  const payload = newIntent({ intentId: 'intent-v1-new-legacy-bound', text: 'TASK_B' })
  const legacy = await store.allocate({
    backend: 'chatgpt-web-extension',
    externalUrl: managedProjectUrl,
    intentId: payload.intentId
  })
  await store.append(legacy.id, {
    type: 'send_intent',
    turnId: 'turn-legacy-bound',
    requestId: payload.intentId,
    text: 'TASK_A',
    source: 'human'
  })

  await assert.rejects(host.proposeContinuation(payload), /request identity conflict/i)
  assert.equal(bridge.calls.some(call => ['conversation_create', 'conversation_send'].includes(call.method)), false)
})

test('v1 NEW replays and restarts to the same logical child with one browser allocation and one send', async t => {
  const { store, bridge, admission, host } = await setupNew(t)
  const payload = newIntent()

  const first = await host.proposeContinuation(payload)
  assert.equal(first.accepted, true)
  assert.match(first.conversationId, /^conv_[a-f0-9]{64}$/)

  const duplicate = await host.proposeContinuation(payload)
  assert.equal(duplicate.conversationId, first.conversationId)
  assert.equal(duplicate.turnId, first.turnId)

  const restarted = new ChatGptConversationHost({
    bridge,
    store,
    sendAdmission: admission,
    writerMode: 'managed',
    writerEpoch: 3,
    managedProjectUrl
  })
  const afterRestart = await restarted.proposeContinuation(payload)
  assert.equal(afterRestart.conversationId, first.conversationId)
  assert.equal(afterRestart.turnId, first.turnId)

  assert.equal(bridge.calls.filter(call => call.method === 'conversation_create').length, 1)
  assert.equal(bridge.calls.filter(call => call.method === 'conversation_send').length, 1)
  assert.equal(admission.calls, 1)

  const stored = await store.read(first.conversationId)
  const sent = stored.events.find(event => event.type === 'send_intent' && event.turnId === first.turnId)
  assert.equal(sent.source, 'human')
  assert.equal(sent.requestId, payload.intentId)
})

test('v1 NEW reconciles uncertain browser delivery from EffectReceipt without allocating or sending twice', async t => {
  const { bridge, admission, host } = await setupNew(t, { sendUncertain: true })
  const payload = newIntent({ intentId: 'intent-v1-new-uncertain' })

  const first = await host.proposeContinuation(payload)
  assert.equal(first.accepted, false)
  assert.equal(first.reason, 'delivery_uncertain')
  assert.match(first.conversationId, /^conv_[a-f0-9]{64}$/)
  assert.ok(first.turnId)

  const replay = await host.proposeContinuation(payload)
  assert.equal(replay.accepted, true)
  assert.equal(replay.conversationId, first.conversationId)
  assert.equal(replay.turnId, first.turnId)

  assert.equal(bridge.calls.filter(call => call.method === 'conversation_create').length, 1)
  assert.equal(bridge.calls.filter(call => call.method === 'conversation_send').length, 1)
  assert.equal(bridge.calls.filter(call => call.method === 'conversation_effect_receipt').length, 1)
  assert.equal(admission.calls, 1)
})

test('runtime wiring gives the conversation host the canonical managed Project used by NEW', () => {
  const bridge = new EventEmitter()
  bridge.on = bridge.on.bind(bridge)
  const components = createRuntimeComponents({
    bridge,
    dataRoot: null,
    legacyConversationRoot: join(tmpdir(), 'unused-conversation-root'),
    managedProjectUrl
  })
  assert.equal(components.conversationHost.managedProjectUrl, managedProjectUrl)
})

test('localhost intent endpoint accepts v1 and rejects future contract versions', async t => {
  const { host, conversation, bridge } = await setup(t)
  host.stateByTarget = async () => ({ found: true, state: state(conversation.id) })
  const app = createSidecarServer({ conversationHost: host })
  const address = await app.listen({ port: 0 })
  t.after(() => app.close())
  const endpoint = `http://127.0.0.1:${address.port}/internal/conversation-intents`
  const post = body => fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })

  const accepted = await post(intent(conversation.id, { intentId: 'intent-v1-http' }))
  assert.equal(accepted.status, 200)
  assert.equal((await accepted.json()).accepted, true)

  const future = await post(intent(conversation.id, { contractVersion: 2, intentId: 'intent-v2-http' }))
  assert.equal(future.status, 400)
  assert.equal(bridge.calls.filter(call => call.method === 'conversation_send').length, 1)
})

test('legacy watchdog intent remains supported during v1 rollout', async t => {
  const { host, bridge } = await setup(t)
  const legacy = { kind: 'continue', target, expected, text: 'legacy continue' }
  const result = await host.proposeContinuation(legacy)
  assert.equal(result.accepted, true)
  assert.equal(bridge.calls.filter(call => call.method === 'conversation_send').length, 1)
})
