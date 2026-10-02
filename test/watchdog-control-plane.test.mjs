import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ChatGptConversationHost } from '../src/chatgpt.mjs'
import { ConversationStore } from '../src/store.mjs'
import { createSidecarServer } from '../src/server.mjs'

const uuid = '00000000-0000-4000-8000-000000000081'
const target = 'https://chatgpt.com/c/' + uuid
const projectTarget = 'https://chatgpt.com/g/g-p-example/c/' + uuid
const registrationId = '30000000-0000-4000-8000-000000000081'
const userId = '10000000-0000-4000-8000-000000000081'
const assistantId = '20000000-0000-4000-8000-000000000081'
const identity = { registrationId, target }
const effects = new Set(['conversation_send', 'conversation_stop', 'conversation_refresh', 'conversation_adopt'])
const deferred = () => {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

async function fixture(t, { existing = true, active = false, url = target } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-control-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ConversationStore(root)
  let conversation = null
  if (existing) {
    conversation = await store.create({ backend: 'test', externalUrl: url })
    await store.append(conversation.id, { type: 'send_intent', turnId: 'turn-1', requestId: 'root-1', text: 'audit' })
    await store.append(conversation.id, { type: 'generation_started', turnId: 'turn-1', externalUrl: url })
  }
  const bridge = new EventEmitter()
  bridge.calls = []
  bridge.phase = active ? 'active' : 'blocked'
  bridge.gate = false
  bridge.observationFailure = false
  bridge.attached = true
  bridge.nextUser = false
  bridge.currentUser = userId
  bridge.currentAssistant = assistantId
  bridge.receipts = new Map()
  bridge.quiesce = null
  bridge.hold = null
  bridge.arrived = null
  bridge.request = async (method, params) => {
    bridge.calls.push({ method, params })
    if (effects.has(method) && bridge.hold) {
      bridge.arrived?.resolve()
      await bridge.hold.promise
    }
    if (method === 'conversation_effect_receipt') {
      if (bridge.receipts.has(params.requestId)) return { found: true, receipt: bridge.receipts.get(params.requestId) }
      if (params.requestId !== 'root-1' || !conversation) return { found: false }
      return { found: true, receipt: {
        requestId: 'root-1', conversationId: conversation.id, turnId: 'turn-1',
        userMessageId: userId, externalUrl: url
      } }
    }
    if (method === 'conversation_state_observe') {
      if (bridge.observationFailure) throw new Error('observer unavailable')
      if (!bridge.attached) return { contractVersion: 1, source: 'browser', conversationId: params.conversationId, target: url,
        observedAt: new Date().toISOString(), turnId: params.turnId, userMessageId: null, assistantMessageId: null,
        assistantText: null, readable: false, generating: null, terminal: null, body: 'unknown', humanGate: null,
        delivery: 'unknown', requestId: null }
      // A current capture must be newer than the last persisted projection.
      await delay(3)
      return {
        contractVersion: 1, source: 'browser', conversationId: params.conversationId, target: url,
        observedAt: new Date().toISOString(), turnId: params.turnId,
        userMessageId: bridge.nextUser ? 'new-human-user' : bridge.currentUser,
        assistantMessageId: bridge.nextUser ? null : bridge.currentAssistant,
        assistantText: bridge.nextUser ? '' : 'partial body', readable: true,
        generating: bridge.phase === 'active', terminal: false, body: bridge.nextUser ? 'empty' : 'incomplete',
        humanGate: bridge.gate, delivery: 'unknown', requestId: null
      }
    }
    if (method === 'conversation_observe') return {
      found: true, allowed: true, url, userMessageId: userId, assistantMessageId: assistantId
    }
    if (method === 'conversation_send') {
      bridge.currentUser = '10000000-0000-4000-8000-000000000083'
      bridge.currentAssistant = '20000000-0000-4000-8000-000000000083'
      bridge.phase = 'active'
      bridge.receipts.set(params.requestId, { requestId: params.requestId, conversationId: params.conversationId,
        turnId: params.turnId, userMessageId: bridge.currentUser, externalUrl: url })
      return { accepted: true, url, userMessageId: bridge.currentUser }
    }
    if (method === 'conversation_stop') return { accepted: true, assistantText: 'partial body' }
    if (method === 'conversation_refresh') return { accepted: true, refreshed: true }
    if (method === 'writer_quiesce') {
      if (bridge.quiesce) return bridge.quiesce(params)
      return { quiescent: true, registrationId: params.registrationId, currentWriterEpoch: params.writerEpoch }
    }
    if (method === 'conversation_supervision_inspect' || method === 'conversation_adoption_inspect') {
      return { found: true, url, userMessageId: userId, assistantMessageId: assistantId, readable: true,
        generating: false, terminal: false, body: 'incomplete', humanGate: false, tabId: 81, windowId: 8 }
    }
    if (method === 'conversation_adopt') {
      const receipt = { action: 'adopt', requestId: params.requestId, conversationId: params.conversationId,
        turnId: params.turnId, externalUrl: url, userMessageId: userId, assistantMessageId: assistantId,
        expectedWriterEpoch: params.writerEpoch, generating: false, tabId: 81, windowId: 8 }
      bridge.receipts.set(params.requestId, receipt)
      bridge.attached = true
      return { accepted: true, receipt }
    }
    assert.fail('unexpected browser request: ' + method)
  }
  const host = new ChatGptConversationHost({ bridge, store, writerEpoch: 7 })
  return { root, host, store, bridge, conversation }
}

function intent(state, action = 'continue', id = 'intent-1') {
  return { contractVersion: 1, intentId: id, source: 'watchdog',
    conversationId: state.conversationId, target: state.target,
    expectedStateVersion: state.stateVersion, expectedWriterEpoch: state.writer.epoch,
    expected: { userMessageId: state.turn.userMessageId, assistantMessageId: state.turn.assistantMessageId },
    action, allocation: null, text: action === 'stop' ? null : 'continue' }
}

function refresh(state, id = 'refresh-1') {
  return { registrationId, requestId: id, kind: 'refresh', conversationId: state.conversationId,
    target: state.target, expectedStateVersion: state.stateVersion, expectedWriterEpoch: state.writer.epoch,
    expected: { userMessageId: state.turn.userMessageId, assistantMessageId: state.turn.assistantMessageId } }
}

async function http(t, host) {
  const app = createSidecarServer({ conversationHost: host })
  const address = await app.listen({ port: 0 })
  t.after(() => app.close())
  return async (path, payload, extra = {}) => {
    const response = await fetch('http://127.0.0.1:' + address.port + path, {
      method: 'POST', headers: { 'content-type': 'application/json', ...extra.headers }, body: JSON.stringify(payload),
      ...extra
    })
    return { status: response.status, body: await response.json() }
  }
}

test('accepted owner grant reaches real send, stop, refresh and withdrawal wire messages', async t => {
  for (const action of ['continue', 'stop', 'refresh']) {
    await t.test(action, async t => {
      const { host, bridge } = await fixture(t, { active: action === 'stop' })
      assert.equal((await host.bindWatchdog(identity)).accepted, true)
      const { state } = await host.observationByTarget(target)
      const reply = action === 'refresh'
        ? await host.recoverWatchdog(refresh(state))
        : await host.proposeWatchdogIntent({ registrationId, intent: intent(state, action) })
      assert.equal(reply.accepted, true)
      const method = action === 'continue' ? 'conversation_send' : 'conversation_' + action
      const call = bridge.calls.find(call => call.method === method)
      assert.equal(call.params.registrationId, registrationId)
      assert.equal(call.params.writerEpoch, 7)
      if (action === 'continue') {
        const sent = await host.observationByTarget(target)
        assert.equal(sent.found, true)
        assert.deepEqual(sent.lineage, { registrationId, intentId: 'intent-1' })
        assert.equal(sent.observation.delivery, 'delivered')
        assert.equal(sent.state.turn.turnId, reply.turnId)
        assert.equal(sent.state.turn.userMessageId, bridge.currentUser)
      }
      assert.equal((await host.withdrawWatchdog(identity)).quiescent, true)
      assert.deepEqual(bridge.calls.find(call => call.method === 'writer_quiesce').params, { writerEpoch: 7, registrationId })
    })
  }
})

test('explicit Registry grant adopts only the exact existing target and preserves project-route receipt', async t => {
  const { host, store, bridge } = await fixture(t, { existing: false, url: projectTarget })
  assert.equal((await host.observationByTarget(projectTarget)).found, false)
  assert.equal(bridge.calls.length, 0)
  const result = await host.bindWatchdog({ registrationId, target: projectTarget })
  assert.equal(result.accepted, true)
  assert.equal(result.target, projectTarget)
  assert.equal((await store.findByExternalUrl(projectTarget)).length, 1)
  for (const method of ['conversation_supervision_inspect', 'conversation_adoption_inspect', 'conversation_adopt']) {
    const call = bridge.calls.find(call => call.method === method)
    assert.equal(call.params.registrationId, registrationId, method)
    assert.equal(call.params.writerEpoch, 7)
  }
  assert.equal(bridge.calls.some(call => ['conversation_create', 'conversation_send', 'conversation_stop', 'conversation_refresh'].includes(call.method)), false)
  assert.equal((await host.observationByTarget(projectTarget)).found, true)
})

test('restored membership repairs a missing extension attachment without changing the owned ledger turn', async t => {
  const { host, bridge, store, conversation } = await fixture(t)
  bridge.attached = false
  assert.equal((await host.observationByTarget(target)).found, false)
  assert.equal((await host.bindWatchdog(identity)).accepted, true)
  assert.equal((await host.observationByTarget(target)).found, true)
  const ledger = await store.read(conversation.id)
  assert.equal(ledger.latestTurnId, 'turn-1')
  assert.equal(ledger.events.some(event => event.type === 'conversation_adopted'), false)
  assert.equal(bridge.calls.filter(call => call.method === 'conversation_adopt').length, 1)
  assert.equal(bridge.calls.some(call => ['conversation_send', 'conversation_create', 'conversation_stop', 'conversation_refresh'].includes(call.method)), false)
})

test('restored attachment lost ACK reconciles its exact durable receipt without another binding effect', async t => {
  const { host, bridge } = await fixture(t)
  const original = bridge.request
  bridge.request = async (method, params) => {
    const result = await original(method, params)
    if (method === 'conversation_adopt') throw new Error('binding ACK lost')
    return result
  }
  const uncertain = await host.bindWatchdog(identity)
  assert.equal(uncertain.accepted, false)
  assert.equal(uncertain.reason, 'delivery_uncertain')
  assert.equal((await host.bindWatchdog(identity)).accepted, true)
  assert.equal(bridge.calls.filter(call => call.method === 'conversation_adopt').length, 1)
})

test('HTTP ACK loss does not release actual owner effect before withdrawal quiescence', async t => {
  const { host, bridge } = await fixture(t, { active: true })
  const post = await http(t, host)
  assert.equal((await post('/internal/watchdog-bind', identity)).body.accepted, true)
  const { state } = await host.observationByTarget(target)
  bridge.hold = deferred()
  bridge.arrived = deferred()
  t.after(() => bridge.hold.resolve())
  const controller = new AbortController()
  const lostAck = post('/internal/watchdog-intents', { registrationId, intent: intent(state, 'stop') }, { signal: controller.signal })
  const lostAckResult = lostAck.catch(error => error)
  await bridge.arrived.promise
  controller.abort()
  assert.equal((await lostAckResult).name, 'AbortError')
  let acknowledged = false
  const withdrawal = post('/internal/watchdog-withdraw', identity).then(result => { acknowledged = true; return result })
  await delay(20)
  assert.equal(acknowledged, false)
  const late = await post('/internal/watchdog-intents', { registrationId, intent: intent(state, 'stop', 'late-stop') })
  assert.equal(late.body.accepted, false)
  assert.equal(late.body.reason, 'registration_revoked')
  bridge.hold.resolve()
  const finished = await withdrawal
  assert.equal(finished.status, 200)
  assert.equal(finished.body.quiescent, true)
  assert.equal(bridge.calls.filter(call => call.method === 'conversation_stop').length, 1)
})

test('revocation while an admitted intent waits before dispatch prevents the browser effect', async t => {
  const { host, bridge } = await fixture(t)
  await host.bindWatchdog(identity)
  const { state } = await host.observationByTarget(target)
  const admitted = deferred(), release = deferred()
  t.after(() => release.resolve())
  host.sendAdmission = { async admit() { admitted.resolve(); await release.promise; return { admitted: true } } }
  const pending = host.proposeWatchdogIntent({ registrationId, intent: intent(state) })
  await admitted.promise
  const withdrawal = host.withdrawWatchdog(identity)
  await delay(5)
  release.resolve()
  const result = await pending
  assert.equal(result.accepted, false)
  assert.equal((await withdrawal).quiescent, true)
  assert.equal(bridge.calls.some(call => call.method === 'conversation_send'), false)
})

test('generic intent HTTP cannot bypass the registration wrapper even with a claimed generation', async t => {
  const { host, bridge } = await fixture(t)
  const post = await http(t, host)
  const { state } = await host.observationByTarget(target)
  for (const payload of [intent(state), { ...intent(state), registrationId },
    { kind: 'continue', target, expected: intent(state).expected, text: 'legacy anonymous' }]) {
    const result = await post('/internal/conversation-intents', payload)
    assert.equal(result.status, 400)
    assert.equal(result.body.reason, 'watchdog_registration_required')
  }
  assert.equal(bridge.calls.some(call => effects.has(call.method)), false)
})

test('withdrawal refuses missing, wrong-generation or wrong-epoch extension acknowledgements', async t => {
  for (const receipt of [
    { quiescent: true },
    { quiescent: true, registrationId: 'wrong', currentWriterEpoch: 7 },
    { quiescent: true, registrationId, currentWriterEpoch: 6 }
  ]) {
    await t.test(JSON.stringify(receipt), async t => {
      const { host } = await fixture(t)
      await host.bindWatchdog(identity)
      host.bridge.quiesce = async () => receipt
      const result = await (await http(t, host))('/internal/watchdog-withdraw', identity)
      assert.equal(result.status, 503)
      assert.equal(result.body.quiescent, false)
      assert.equal((await host.bindWatchdog(identity)).accepted, false)
    })
  }
})

test('a fresh state CAS cannot renew a previous owner-epoch grant without explicit Registry rebind', async t => {
  const { host, store, bridge } = await fixture(t)
  await host.bindWatchdog(identity)
  const restarted = new ChatGptConversationHost({ bridge, store: new ConversationStore(store.rootDir), writerEpoch: 8 })
  const { state } = await restarted.observationByTarget(target)
  const denied = await restarted.recoverWatchdog(refresh(state))
  assert.equal(denied.reason, 'watchdog_binding_required')
  assert.equal(bridge.calls.some(call => call.method === 'conversation_refresh'), false)
  assert.equal((await restarted.bindWatchdog(identity)).accepted, true)
  assert.equal((await restarted.recoverWatchdog(refresh(state))).accepted, true)
  assert.equal(bridge.calls.find(call => call.method === 'conversation_refresh').params.writerEpoch, 8)
})

test('refresh request ID deduplicates actual effect and unknown outcome cannot replay after owner restart', async t => {
  const { host, store, bridge } = await fixture(t)
  await host.bindWatchdog(identity)
  const { state } = await host.observationByTarget(target)
  const request = refresh(state)
  const results = await Promise.all([host.recoverWatchdog(request), host.recoverWatchdog(request)])
  assert.ok(results.every(result => result.accepted === true))
  assert.equal(bridge.calls.filter(call => call.method === 'conversation_refresh').length, 1)
  const original = bridge.request
  bridge.request = async (method, params) => {
    if (method === 'conversation_refresh') {
      bridge.calls.push({ method, params })
      throw new Error('refresh acknowledgement lost')
    }
    return original(method, params)
  }
  const uncertainRequest = refresh(state, 'refresh-unknown')
  const uncertain = await host.recoverWatchdog(uncertainRequest)
  assert.equal(uncertain.accepted, false)
  assert.equal(uncertain.reason, 'delivery_uncertain')
  const restarted = new ChatGptConversationHost({ bridge, store: new ConversationStore(store.rootDir), writerEpoch: 7 })
  const retry = await restarted.recoverWatchdog(uncertainRequest)
  assert.equal(retry.reason, 'delivery_uncertain')
  assert.equal(bridge.calls.filter(call => call.method === 'conversation_refresh').length, 2)
})

test('refresh fails closed for stale CAS, active generation, human gate or missing fresh capture', async t => {
  for (const fault of ['stale', 'active', 'human', 'unknown']) {
    await t.test(fault, async t => {
      const { host, bridge } = await fixture(t)
      await host.bindWatchdog(identity)
      const { state } = await host.observationByTarget(target)
      const request = refresh(state)
      if (fault === 'stale') request.expectedStateVersion += 1
      if (fault === 'active') bridge.phase = 'active'
      if (fault === 'human') bridge.gate = true
      if (fault === 'unknown') bridge.observationFailure = true
      assert.equal((await host.recoverWatchdog(request)).accepted, false)
      assert.equal(bridge.calls.some(call => call.method === 'conversation_refresh'), false)
    })
  }
})

test('fresh newer human user cannot inherit an old assistant terminal marker or raw body', async t => {
  const { host, bridge, store, conversation } = await fixture(t)
  await store.append(conversation.id, { type: 'response_completed', turnId: 'turn-1',
    text: 'old REVIEW {"verdict":"complete"}', externalUrl: target })
  assert.equal((await host.observationByTarget(target)).found, true)
  bridge.nextUser = true
  assert.deepEqual(await host.observationByTarget(target), { found: false, reason: 'observation_unavailable' })
})

test('Watchdog permission cannot bind to an unleased legacy owner epoch', async t => {
  const { store, bridge } = await fixture(t)
  const host = new ChatGptConversationHost({ bridge, store, writerEpoch: 0 })
  assert.deepEqual(await host.bindWatchdog(identity), { accepted: false, reason: 'writer_epoch_unavailable' })
  assert.equal(bridge.calls.length, 0)
})

test('wire provenance cannot be injected by an unaccepted caller', async t => {
  const { host, bridge } = await fixture(t)
  await host.writerRequest('conversation_stop', { writerEpoch: 7, registrationId, requestId: 'human-operation' })
  assert.equal(Object.hasOwn(bridge.calls.at(-1).params, 'registrationId'), false)
})
