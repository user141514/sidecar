import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatGptConversationHost } from '../src/chatgpt.mjs'
import { ConversationStore } from '../src/store.mjs'
import vm from 'node:vm'
import { webcrypto } from 'node:crypto'
import { nativeContentFixture, MODERN_USER_ID, MODERN_ASSISTANT_ID, MODERN_THREAD_URL } from './helpers/native-content-fixture.mjs'

const workerSource = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8')
const lifecycleSource = await readFile(new URL('../extension/lifecycle.js', import.meta.url), 'utf8')
const retirementTargetSource = await readFile(new URL('../extension/pending-retirement-target.js', import.meta.url), 'utf8')
const contentSource = await readFile(new URL('../extension/content-script.js', import.meta.url), 'utf8')

test('actual modern content ACK and snapshots pass native send inspect state and stop with canonical receipt', async t => {
  const fixture = nativeContentFixture({ submitted: false }); t.after(() => fixture.dispose())
  const draft = 'https://chatgpt.com/g/g-p-test-subagents/project'
  const local = 'https://chatgpt.com/c/local-chatgpt%3A7611e69c-88dd-4b54-99ab-56258c3c6643'
  const rawReplies = []
  fixture.location.href = draft
  fixture.configureOnSubmit(() => { fixture.location.href = local })
  const h = makeHarness({
    storage: { 'writer:authority': { version: 1, epoch: 3 }, 'conversation:conv_actual_modern': { tabId: 20, windowId: 10, url: draft } },
    tabs: [{ id: 20, windowId: 10, url: draft }], windows: [{ id: 10 }],
    async contentMessageProvider(tab, message, runtime) {
      fixture.configureRuntimeTransport(runtime)
      const raw = await fixture.call(message)
      rawReplies.push({ type: message.type, raw })
      if (message.type === 'conversation_submit' && raw.accepted === true) {
        assert.equal(raw.url, local)
        assert.equal(h.storageState['effect-receipt:actual-modern-send'], undefined)
        tab.url = MODERN_THREAD_URL; fixture.location.href = MODERN_THREAD_URL
      }
      return raw
    }
  })
  const sent = await h.request('conversation_send', { conversationId: 'conv_actual_modern', turnId: 'actual-turn',
    requestId: 'actual-modern-send', externalUrl: draft, existingOnly: true, writerEpoch: 3, text: 'fixture prompt', authoritativeState: true })
  assert.equal(sent.ok, true, sent.error)
  assert.equal(sent.result.url, MODERN_THREAD_URL)
  const ack = rawReplies.find(reply => reply.type === 'conversation_submit').raw
  assert.equal(ack.userMessageId, MODERN_USER_ID)
  assert.equal(ack.accepted, true)
  assert.equal(h.storageState['effect-receipt:actual-modern-send'].userMessageId, MODERN_USER_ID)
  assert.equal(h.storageState['effect-receipt:actual-modern-send'].externalUrl, MODERN_THREAD_URL)
  assert.equal(h.storageState['conversation:conv_actual_modern'].url, MODERN_THREAD_URL)
  const inspected = await h.request('conversation_supervision_inspect', { externalUrl: MODERN_THREAD_URL, writerEpoch: 3 })
  assert.equal(inspected.result.found, true)
  assert.equal(inspected.result.readable, true)
  assert.equal(inspected.result.userMessageId, MODERN_USER_ID)
  assert.equal(inspected.result.assistantMessageId, MODERN_ASSISTANT_ID)
  const state = await h.request('conversation_state_observe', { conversationId: 'conv_actual_modern', turnId: 'actual-turn',
    externalUrl: MODERN_THREAD_URL, expectedUserMessageId: MODERN_USER_ID })
  assert.equal(state.result.readable, true)
  assert.equal(state.result.assistantMessageId, MODERN_ASSISTANT_ID)
  assert.equal(state.result.assistantText, 'ACTION_OK')
  assert.equal(state.result.terminal, true)
  fixture.setGenerating(true)
  const stopped = await h.request('conversation_stop', { conversationId: 'conv_actual_modern', turnId: 'actual-turn',
    requestId: 'actual-modern-stop', externalUrl: MODERN_THREAD_URL, expectedStateVersion: 9, writerEpoch: 3,
    expected: { userMessageId: MODERN_USER_ID, assistantMessageId: MODERN_ASSISTANT_ID } })
  assert.equal(stopped.ok, true, stopped.error)
  assert.equal(stopped.result.userMessageId, MODERN_USER_ID)
  assert.equal(stopped.result.assistantMessageId, MODERN_ASSISTANT_ID)
  assert.equal(fixture.clicks, 2)
  assert.equal(h.sentToTabs.filter(entry => entry.message.type === 'conversation_submit').length, 1)
  assert.equal(h.createdTabs.length + h.createdWindows.length + h.reloadedTabs.length, 0)
})

test('actual modern unowned content supports explicit exact adoption and fresh native observation', async t => {
  const fixture = nativeContentFixture({ generating: true }); t.after(() => fixture.dispose())
  const h = makeHarness({ storage: { 'writer:authority': { version: 1, epoch: 3 } },
    tabs: [{ id: 61, windowId: 6, url: MODERN_THREAD_URL }], windows: [{ id: 6 }],
    contentMessageProvider(tab, message, runtime) { fixture.configureRuntimeTransport(runtime); return fixture.call(message) }
  })
  const params = { conversationId: 'conv_actual_adopt', turnId: 'actual-adopt-turn', requestId: 'actual-adopt-request',
    externalUrl: MODERN_THREAD_URL, expectedUserMessageId: MODERN_USER_ID, writerEpoch: 3 }
  const inspected = await h.request('conversation_adoption_inspect', params)
  assert.equal(inspected.result.found, true)
  assert.equal(inspected.result.userMessageId, MODERN_USER_ID)
  assert.equal(inspected.result.assistantMessageId, MODERN_ASSISTANT_ID)
  const adopted = await h.request('conversation_adopt', params)
  assert.equal(adopted.result.accepted, true)
  assert.equal(adopted.result.receipt.userMessageId, MODERN_USER_ID)
  assert.equal(adopted.result.receipt.assistantMessageId, MODERN_ASSISTANT_ID)
  const state = await h.request('conversation_state_observe', { conversationId: params.conversationId, turnId: params.turnId,
    externalUrl: MODERN_THREAD_URL, expectedUserMessageId: MODERN_USER_ID })
  assert.equal(state.result.readable, true)
  assert.equal(state.result.assistantText, 'ACTION_OK')
  assert.equal(state.result.generating, true)
  assert.equal(fixture.clicks, 0)
  assert.equal(h.createdTabs.length + h.createdWindows.length + h.reloadedTabs.length, 0)
})

test('actual malformed modern submission cannot create a native receipt or replay the seed', async t => {
  for (const options of [{ submissionId: 'local-user:temporary' }, { ids: MODERN_ASSISTANT_ID + ' ' + MODERN_USER_ID }]) {
    const fixture = nativeContentFixture({ submitted: false, ...options }); t.after(() => fixture.dispose())
    const draft = 'https://chatgpt.com/g/g-p-test-subagents/project'
    fixture.location.href = draft
    const h = makeHarness({ storage: { 'writer:authority': { version: 1, epoch: 3 },
      'conversation:conv_actual_unknown': { tabId: 20, windowId: 10, url: draft } },
      tabs: [{ id: 20, windowId: 10, url: draft }], windows: [{ id: 10 }],
      contentMessageProvider(tab, message, runtime) { fixture.configureRuntimeTransport(runtime); return fixture.call(message) }
    })
    const params = { conversationId: 'conv_actual_unknown', turnId: 'actual-unknown-turn', requestId: 'actual-unknown-send',
      externalUrl: draft, existingOnly: true, writerEpoch: 3, text: 'fixture prompt', authoritativeState: true }
    const sent = await h.request('conversation_send', params)
    assert.equal(sent.errorCode, 'DELIVERY_UNCERTAIN')
    assert.equal(h.storageState['effect-receipt:actual-unknown-send'], undefined)
    assert.equal(h.storageState['conversation:conv_actual_unknown'].url, draft)
    assert.equal(h.storageState['pending:conv_actual_unknown'].phase, 'submitting')
    assert.equal(h.sentToTabs.filter(entry => entry.message.type === 'conversation_monitor_start').length, 0)
    assert.equal((await h.request('conversation_send', params)).errorCode, 'DELIVERY_UNCERTAIN')
    assert.equal(fixture.clicks, 1)
  }
})

test('startup durably settles only pre-submit turns whose tabs are gone', async () => {
  const storage = {}
  for (const [id, phase, tabId] of [
    ['preparing', 'preparing', 11], ['prepared', 'prepared', 12],
    ['submitting', 'submitting', 13], ['submitted', 'submitted', 14],
    ['live', 'preparing', 15], ['legacy', undefined, 16]
  ]) storage['pending:' + id] = { conversationId: id, turnId: 'turn-' + id, phase, tabId }
  const harness = makeHarness({ storage, tabs: [{ id: 15, windowId: 1, url: 'https://chatgpt.com/' }] })
  await harness.request('extension_status', {})
  for (const id of ['preparing', 'prepared']) {
    assert.equal(harness.storageState['pending:' + id], undefined)
    const eventId = 'terminal:' + id + ':turn-' + id + ':error'
    const record = harness.storageState['outbox:' + eventId]
    assert.equal(record.event.turnId, 'turn-' + id)
    assert.match(record.event.message, /not submitted/)
    assert.ok(harness.nativeMessages.some(message => message.eventId === eventId))
    await harness.sendNativeMessage({ kind: 'event_ack', eventId })
    assert.equal(harness.storageState['outbox:' + eventId], undefined)
  }
  for (const id of ['submitting', 'submitted', 'live', 'legacy']) {
    assert.deepEqual(harness.storageState['pending:' + id], storage['pending:' + id])
  }
  assert.equal(harness.createdTabs.length, 0)
  assert.equal(harness.createdWindows.length, 0)
  assert.equal(harness.sentToTabs.length, 0)
})


test('create selects the requested composer mode before publishing the draft binding', async () => {
  const h = makeHarness({ storage: { 'writer:authority': { version: 1, epoch: 3 } } })
  const created = await h.request('conversation_create', { conversationId: 'mode-create', url: 'https://chatgpt.com/g/g-p-test-subagents/project', mode: 'work', writerEpoch: 3 })
  assert.equal(created.ok, true, created.error)
  assert.equal(created.result.mode, 'work')
  const selection = h.sentToTabs.find(entry => entry.message.type === 'conversation_mode_select')
  assert.equal(selection.message.mode, 'work')
  assert.equal(selection.storageSnapshot['conversation:mode-create'], undefined)
  assert.ok(selection.message.contentEffect)
  assert.equal(h.storageState['conversation:mode-create'].mode, 'work')
  const reused = await h.request('conversation_create', { conversationId: 'mode-create', url: 'https://chatgpt.com/g/g-p-test-subagents/project', mode: 'chat', writerEpoch: 3 })
  assert.equal(reused.result.mode, 'chat')
  assert.equal(h.createdTabs.length, 1)
  assert.equal(h.storageState['conversation:mode-create'].mode, 'chat')
})

test('draft send retains its created mode and forwards exact expectedMode through prepare and submit', async () => {
  const project = 'https://chatgpt.com/g/g-p-test-subagents/project'
  for (const mode of ['chat', 'work']) {
    const h = makeHarness({ storage: { 'writer:authority': { version: 1, epoch: 3 },
      'conversation:mode-send': { tabId: 20, windowId: 10, url: project, mode } },
      tabs: [{ id: 20, windowId: 10, url: project }], windows: [{ id: 10 }], submitNavigatesTo: MODERN_THREAD_URL })
    const sent = await h.request('conversation_send', { conversationId: 'mode-send', turnId: 'mode-turn', requestId: 'mode-request',
      externalUrl: project, existingOnly: true, writerEpoch: 3, text: 'one seed' })
    assert.equal(sent.ok, true, sent.error)
    const prepare = h.sentToTabs.find(item => item.message.type === 'conversation_prepare')
    const submit = h.sentToTabs.find(item => item.message.type === 'conversation_submit')
    assert.equal(prepare.storageSnapshot['conversation:mode-send'].mode, mode)
    assert.equal(prepare.message.expectedMode, mode)
    assert.equal(submit.message.expectedMode, mode)
    assert.equal(h.storageState['conversation:mode-send'].mode, mode)
    assert.equal(h.sentToTabs.some(item => item.message.type === 'conversation_mode_select'), false)
  }
})

test('draft send mode drift reaches actual content guard and cannot write or submit a prompt', async t => {
  const fixture = nativeContentFixture({ submitted: false }); t.after(() => fixture.dispose())
  const project = 'https://chatgpt.com/g/g-p-test-subagents/project'
  fixture.location.href = project
  const group = fixture.addNode('div', { role: 'group', 'aria-label': '撰写器模式' }, fixture.main)
  const chat = fixture.addNode('button', { type: 'button', 'aria-pressed': 'false' }, group, '聊天')
  const work = fixture.addNode('button', { type: 'button', 'aria-pressed': 'true' }, group, '工作')
  chat.click = work.click = () => assert.fail('send must not change the user-selected mode or strength')
  fixture.configureOnSubmit(() => { fixture.location.href = MODERN_THREAD_URL })
  const h = makeHarness({ storage: { 'writer:authority': { version: 1, epoch: 3 },
    'conversation:actual-mode-drift': { tabId: 20, windowId: 10, url: project, mode: 'chat' } },
    tabs: [{ id: 20, windowId: 10, url: project }], windows: [{ id: 10 }], fastConversationUrlClock: true,
    async contentMessageProvider(tab, message, runtime) {
      fixture.configureRuntimeTransport(runtime)
      const response = await fixture.call(message)
      if (message.type === 'conversation_submit' && response.accepted) tab.url = MODERN_THREAD_URL
      return response
    } })
  const sent = await h.request('conversation_send', { conversationId: 'actual-mode-drift', turnId: 'mode-drift-turn',
    requestId: 'mode-drift-request', externalUrl: project, existingOnly: true, writerEpoch: 3, text: 'never dispatch this prompt' })
  assert.equal(sent.ok, false)
  assert.match(sent.error, /mode/i)
  assert.equal(fixture.editor.textContent, '')
  assert.equal(fixture.clicks, 0)
  assert.equal(h.sentToTabs.some(item => item.message.type === 'conversation_submit'), false)
  assert.equal(h.storageState['pending:actual-mode-drift'], undefined)
  assert.equal(h.storageState['effect-receipt:mode-drift-request'], undefined)
  assert.equal(h.storageState['conversation:actual-mode-drift'].mode, 'chat')
})

test('canonical conversation send keeps declared mode without requiring a draft toggle', async () => {
  const h = makeHarness({ storage: { 'writer:authority': { version: 1, epoch: 3 },
    'conversation:canonical-mode': { tabId: 20, windowId: 10, url: MODERN_THREAD_URL, mode: 'chat' } },
    tabs: [{ id: 20, windowId: 10, url: MODERN_THREAD_URL }], windows: [{ id: 10 }] })
  const sent = await h.request('conversation_send', { conversationId: 'canonical-mode', turnId: 'canonical-turn', requestId: 'canonical-request',
    externalUrl: MODERN_THREAD_URL, existingOnly: true, writerEpoch: 3, text: 'one canonical seed' })
  assert.equal(sent.ok, true, sent.error)
  const prepare = h.sentToTabs.find(item => item.message.type === 'conversation_prepare')
  const submit = h.sentToTabs.find(item => item.message.type === 'conversation_submit')
  assert.equal(Object.hasOwn(prepare.message, 'expectedMode'), false)
  assert.equal(Object.hasOwn(submit.message, 'expectedMode'), false)
  assert.equal(h.storageState['conversation:canonical-mode'].mode, 'chat')
})

test('invalid composer mode cannot allocate a browser tab', async () => {
  const h = makeHarness({ storage: { 'writer:authority': { version: 1, epoch: 3 } } })
  const created = await h.request('conversation_create', { conversationId: 'invalid-mode', mode: 'worker', writerEpoch: 3 })
  assert.equal(created.ok, false)
  assert.match(created.error, /mode/)
  assert.equal(h.createdTabs.length + h.createdWindows.length, 0)
})

test('submit follows a newly opened tab with the exact opener and committed user UUID', async () => {
  const h = makeHarness({ storage: { 'writer:authority': { version: 1, epoch: 3 },
    'conversation:handoff': { tabId: 20, windowId: 10, url: 'https://chatgpt.com/g/g-p-test-subagents/project' } },
    tabs: [{ id: 20, windowId: 10, url: 'https://chatgpt.com/g/g-p-test-subagents/project' }], windows: [{ id: 10 }, { id: 12 }],
    fastConversationUrlClock: true, submitNavigatesTo: 'https://chatgpt.com/c/local-chatgpt%3Atemporary',
    submitNewTabs: [{ id: 21, windowId: 12, openerTabId: 20, url: 'https://chatgpt.com/g/g-p-test-subagents/c/00000000-0000-4000-8000-000000000007', userMessageId: '00000000-0000-4000-8000-000000000001' }] })
  const sent = await h.request('conversation_send', { conversationId: 'handoff', turnId: 'handoff-turn', requestId: 'handoff-send',
    externalUrl: 'https://chatgpt.com/g/g-p-test-subagents/project', existingOnly: true, writerEpoch: 3, text: 'one seed' })
  assert.equal(sent.ok, true, sent.error)
  assert.equal(sent.result.tabId, 21)
  assert.equal(sent.result.windowId, 12)
  assert.equal(h.storageState['conversation:handoff'].tabId, 21)
  assert.equal(h.storageState['pending:handoff'].tabId, 21)
  assert.equal(h.storageState['effect-receipt:handoff-send'].externalUrl, 'https://chatgpt.com/g/g-p-test-subagents/c/00000000-0000-4000-8000-000000000007')
  assert.equal(h.sentToTabs.filter(entry => entry.message.type === 'conversation_submit').length, 1)
  assert.equal(h.sentToTabs.find(entry => entry.message.type === 'conversation_monitor_start').tabId, 21)
})

test('new tab without unambiguous opener and exact identity cannot be adopted after submit', async t => {
  const exact = { id: 21, windowId: 12, openerTabId: 20, url: 'https://chatgpt.com/g/g-p-test-subagents/c/00000000-0000-4000-8000-000000000007', userMessageId: '00000000-0000-4000-8000-000000000001' }
  for (const [name, submitNewTabs] of [
    ['no opener', [{ ...exact, openerTabId: undefined }]],
    ['wrong opener', [{ ...exact, openerTabId: 99 }]],
    ['ambiguous', [exact, { ...exact, id: 22 }]],
    ['wrong user', [{ ...exact, userMessageId: '00000000-0000-4000-8000-000000000099' }]]
  ]) await t.test(name, async () => {
    const h = makeHarness({ storage: { 'writer:authority': { version: 1, epoch: 3 },
      'conversation:handoff': { tabId: 20, windowId: 10, url: 'https://chatgpt.com/g/g-p-test-subagents/project' } },
      tabs: [{ id: 20, windowId: 10, url: 'https://chatgpt.com/g/g-p-test-subagents/project' }], windows: [{ id: 10 }, { id: 12 }],
      fastConversationUrlClock: true, submitNavigatesTo: 'https://chatgpt.com/c/local-chatgpt%3Atemporary', submitNewTabs })
    const sent = await h.request('conversation_send', { conversationId: 'handoff', turnId: 'handoff-turn', requestId: 'handoff-send',
      externalUrl: 'https://chatgpt.com/g/g-p-test-subagents/project', existingOnly: true, writerEpoch: 3, text: 'one seed' })
    assert.equal(sent.errorCode, 'DELIVERY_UNCERTAIN')
    assert.equal(h.storageState['effect-receipt:handoff-send'], undefined)
    assert.equal(h.storageState['conversation:handoff'].tabId, 20)
    assert.equal(h.storageState['pending:handoff'].phase, 'submitting')
    assert.equal(h.sentToTabs.filter(entry => entry.message.type === 'conversation_submit').length, 1)
  })
})


test('handoff cannot duplicate a canonical conversation binding, including a late owner', async t => {
  for (const late of [false, true]) await t.test(late ? 'owner added during observation' : 'closed-tab owner', async () => {
    const thread = 'https://chatgpt.com/g/g-p-test-subagents/c/00000000-0000-4000-8000-000000000007'
    const foreign = { tabId: 99, windowId: 10, url: thread }
    const h = makeHarness({ storage: { 'writer:authority': { version: 1, epoch: 3 },
      'conversation:handoff': { tabId: 20, windowId: 10, url: 'https://chatgpt.com/g/g-p-test-subagents/project' },
      ...(!late ? { 'conversation:another': foreign } : {}) },
      tabs: [{ id: 20, windowId: 10, url: 'https://chatgpt.com/g/g-p-test-subagents/project' }],
      windows: [{ id: 10 }, { id: 12 }], fastConversationUrlClock: true,
      submitNavigatesTo: 'https://chatgpt.com/c/local-chatgpt%3Atemporary',
      submitNewTabs: [{ id: 21, windowId: 12, openerTabId: 20, url: thread, userMessageId: '00000000-0000-4000-8000-000000000001' }],
      onStateObservation: late ? storage => { storage['conversation:another'] = foreign } : null })
    const sent = await h.request('conversation_send', { conversationId: 'handoff', turnId: 'handoff-turn', requestId: 'handoff-send',
      externalUrl: 'https://chatgpt.com/g/g-p-test-subagents/project', existingOnly: true, writerEpoch: 3, text: 'one seed' })
    assert.equal(sent.errorCode, 'DELIVERY_UNCERTAIN')
    assert.equal(h.storageState['effect-receipt:handoff-send'], undefined)
    assert.equal(h.storageState['conversation:handoff'].tabId, 20)
    assert.equal(h.storageState['pending:handoff'].phase, 'submitting')
    assert.equal(h.sentToTabs.filter(entry => entry.message.type === 'conversation_submit').length, 1)
  })
})

let harnessEffectToken = 0

const retirementIdentity = { conversationId: 'retire-conv', turnId: 'retire-turn', requestId: 'retire-send',
  registrationId: '81000000-0000-4000-8000-000000000001', target: 'https://chatgpt.com/c/82000000-0000-4000-8000-000000000001', writerEpoch: 3 }
function retirementStorage() {
  return { 'writer:authority': { version: 1, epoch: 3 },
    ['writer:revoked-registration:' + retirementIdentity.registrationId]: { version: 1, registrationId: retirementIdentity.registrationId, writerEpoch: 3, target: retirementIdentity.target },
    'conversation:retire-conv': { tabId: 88, windowId: 10, url: retirementIdentity.target },
    'pending:retire-conv': { conversationId: 'retire-conv', turnId: 'retire-turn', requestId: 'retire-send', tabId: 88, phase: 'submitting', monitorVersion: 1, promptText: 'private original prompt' } }
}
async function retirementRequest(h, operationId = 'retirement-op') {
  const inspected = await h.request('pending_retirement_inspect', retirementIdentity)
  assert.equal(inspected.ok, true, inspected.error)
  assert.equal(inspected.result.retirable, true, inspected.result.reason)
  assert.equal(JSON.stringify(inspected.result).includes('private original prompt'), false)
  return { ...retirementIdentity, operationId, expectedPendingDigest: inspected.result.pendingDigest,
    expectedInstanceId: inspected.result.instanceId, expectedBuildId: inspected.result.buildId, reason: 'closed_target_after_quiesce' }
}

const manualRetirementIdentity = { conversationId: 'manual-retire', turnId: 'manual-turn', requestId: 'manual-send',
  owner: 'manual', target: 'https://chatgpt.com/g/g-p-test-subagents/project', writerEpoch: 3 }
function manualRetirementStorage(target = manualRetirementIdentity.target) {
  return { 'writer:authority': { version: 1, epoch: 3 },
    'conversation:manual-retire': { tabId: 88, windowId: 10, url: target },
    'pending:manual-retire': { conversationId: 'manual-retire', turnId: 'manual-turn', requestId: 'manual-send',
      tabId: 88, phase: 'submitting', monitorVersion: 1, promptText: 'original manual private prompt' } }
}
async function manualRetirementRequest(h, identity = manualRetirementIdentity) {
  const inspected = await h.request('pending_retirement_inspect', identity)
  assert.equal(inspected.ok, true, inspected.error)
  assert.equal(inspected.result.retirable, true, inspected.result.reason)
  assert.equal(JSON.stringify(inspected.result).includes('original manual private prompt'), false)
  return { ...identity, operationId: 'manual-retirement-op', reason: 'closed_manual_owner_after_quiesce',
    expectedPendingDigest: inspected.result.pendingDigest, expectedInstanceId: inspected.result.instanceId,
    expectedBuildId: inspected.result.buildId }
}

test('manual owner retirement preserves unknown project submit without claiming project closure or Watchdog revocation', async () => {
  const storage = manualRetirementStorage()
  const original = structuredClone(storage['pending:manual-retire'])
  const h = makeHarness({ storage, tabs: [{ id: 99, windowId: 10, url: manualRetirementIdentity.target }], windows: [{ id: 10 }] })
  const params = await manualRetirementRequest(h)
  const retired = await h.request('pending_retire', params)
  assert.equal(retired.ok, true, retired.error)
  const receipt = retired.result.receipt
  assert.equal(retired.result.delivery, 'unknown')
  assert.equal(receipt.owner, 'manual')
  assert.equal(receipt.reason, 'closed_manual_owner_after_quiesce')
  assert.equal(receipt.proof.generationSource, 'manual_owner')
  assert.equal(receipt.proof.originalTabAbsent, true)
  assert.equal(receipt.proof.writerDrained, true)
  assert.equal(receipt.proof.contentDrained, true)
  assert.equal(Object.hasOwn(receipt.proof, 'targetAbsent'), false)
  assert.equal(Object.hasOwn(receipt.proof, 'revokedRegistration'), false)
  assert.equal(Object.hasOwn(receipt, 'registrationId'), false)
  assert.deepEqual(h.storageState['pending:manual-retire'], original)
  assert.equal(h.storageState['effect-receipt:manual-send'], undefined)
  assert.equal(Object.keys(h.storageState).some(key => key.startsWith('writer:revoked-registration:')), false)
  assert.equal(h.createdTabs.length + h.createdWindows.length + h.reloadedTabs.length + h.sentToTabs.length, 0)
  const status = (await h.request('extension_status', {})).result
  assert.deepEqual([status.pendingCount, status.retiredPendingCount, status.recoverablePendingCount, status.blockingPendingCount], [1, 1, 0, 0])
  assert.equal((await h.request('pending_retire', params)).result.receipt.operationId, params.operationId)
  assert.equal((await h.request('pending_retire', { ...params, operationId: 'different-operation' })).ok, false)
  const restarted = makeHarness({ storage: structuredClone(h.storageState), extensionInstance: 'new-instance', extensionBuild: 'b'.repeat(64) })
  assert.equal((await restarted.request('writer_epoch_claim', { writerEpoch: 4 })).ok, true)
  assert.equal((await restarted.request('pending_retire', { ...params, writerEpoch: 4 })).ok, true)
  assert.equal((await restarted.request('extension_status', {})).result.retiredPendingCount, 1)
  for (const method of ['conversation_send', 'conversation_create', 'conversation_adopt']) {
    assert.equal((await restarted.request(method, { conversationId: 'manual-retire', requestId: 'manual-send', writerEpoch: 4 })).ok, false, method)
  }
  for (const type of ['response_completed', 'response_delta']) {
    const result = await restarted.emitRuntimeMessage({ kind: 'conversation_event', event: { type,
      conversationId: 'manual-retire', turnId: 'manual-turn', monitorVersion: 1, externalUrl: manualRetirementIdentity.target } },
      { tab: { id: 88, windowId: 10, url: manualRetirementIdentity.target } })
    assert.notEqual(result?.durable, true, type)
  }
  assert.deepEqual(restarted.storageState['pending:manual-retire'], original)
  assert.equal(Object.keys(restarted.storageState).some(key => key.startsWith('outbox:')), false)
})

test('manual owner retirement shares exact project identity normalization with the host without widening target matches', async () => {
  const { manualRetirementTarget } = await import('../extension/pending-retirement-target.js')
  const canonical = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946/project'
  const slugged = canonical.replace('/project', '-subagents/project/?model=anything#composer')
  assert.equal(manualRetirementTarget(slugged), canonical)
  for (const invalid of ['https://user@chatgpt.com/', 'http://chatgpt.com/', 'https://chatgpt.com:444/',
    canonical + '/extra', 'https://chatgpt.com/c/local-chatgpt%3Atemporary']) assert.equal(manualRetirementTarget(invalid), null)
  assert.equal(manualRetirementTarget(MODERN_THREAD_URL), 'https://chatgpt.com/c/' + MODERN_THREAD_URL.split('/').at(-1))
  const identity = { ...manualRetirementIdentity, target: slugged }
  const h = makeHarness({ storage: manualRetirementStorage(canonical) })
  const retired = await h.request('pending_retire', await manualRetirementRequest(h, identity))
  assert.equal(retired.ok, true, retired.error)
  assert.equal(retired.result.receipt.target, canonical)
  assert.equal((await h.request('extension_status', {})).result.blockingPendingCount, 0)
})

test('manual owner retirement requires canonical target absence when the exact conversation is known', async () => {
  const target = retirementIdentity.target
  const identity = { ...manualRetirementIdentity, target }
  const h = makeHarness({ storage: manualRetirementStorage(target), tabs: [{ id: 99, windowId: 10,
    url: target.replace('/c/', '/g/g-p-other/c/') }], windows: [{ id: 10 }] })
  const denied = await h.request('pending_retirement_inspect', identity)
  assert.equal(denied.ok, true, denied.error)
  assert.equal(denied.result.retirable, false)
  assert.equal(denied.result.reason, 'target_open')
  const closed = makeHarness({ storage: manualRetirementStorage(target) })
  const result = await closed.request('pending_retire', await manualRetirementRequest(closed, identity))
  assert.equal(result.ok, true, result.error)
  assert.equal(result.result.receipt.proof.targetAbsent, true)
})

test('manual owner retirement fails closed for changed identity ownership drain closure and snapshot', async t => {
  for (const change of ['binding', 'turn', 'registration', 'prepared', 'known', 'outbox', 'effect', 'digest', 'instance', 'build', 'epoch', 'original-tab', 'tabs-lookup']) {
    await t.test(change, async () => {
      const h = makeHarness({ storage: manualRetirementStorage() })
      const params = await manualRetirementRequest(h)
      if (change === 'binding') h.storageState['conversation:manual-retire'].url = 'https://chatgpt.com/g/g-p-other/project'
      if (change === 'turn') h.storageState['pending:manual-retire'].turnId = 'changed-turn'
      if (change === 'registration') h.storageState['pending:manual-retire'].registrationId = retirementIdentity.registrationId
      if (change === 'prepared') h.storageState['pending:manual-retire'].phase = 'prepared'
      if (change === 'known') h.storageState['effect-receipt:manual-send'] = { requestId: 'manual-send', userMessageId: MODERN_USER_ID }
      if (change === 'outbox') h.storageState['outbox:blocked'] = { eventId: 'blocked' }
      if (change === 'effect') h.storageState['content-effect:blocked'] = { token: 'blocked' }
      if (change === 'digest') h.storageState['pending:manual-retire'].promptText = 'changed prompt'
      if (change === 'instance') params.expectedInstanceId = 'changed-instance'
      if (change === 'build') params.expectedBuildId = 'b'.repeat(64)
      if (change === 'epoch') params.writerEpoch = 2
      const target = change === 'original-tab'
        ? makeHarness({ storage: structuredClone(h.storageState), tabs: [{ id: 88, windowId: 10, url: 'https://example.com/' }] })
        : change === 'tabs-lookup' ? makeHarness({ storage: structuredClone(h.storageState), tabsQueryFailure: () => true }) : h
      assert.equal((await target.request('pending_retire', params)).ok, false, change)
      assert.equal(target.storageState['pending-retirement:manual-retire'], undefined)
      if (change !== 'prepared') {
        const restarted = makeHarness({ storage: structuredClone(target.storageState) })
        assert.equal((await restarted.request('extension_status', {})).result.blockingPendingCount, 1)
      } else assert.equal(target.storageState['pending:manual-retire'].phase, 'prepared')
    })
  }
})

test('manual owner retirement cannot manufacture Watchdog identity or accept an unrecognized owner', async () => {
  for (const extra of [{ registrationId: retirementIdentity.registrationId }, { owner: 'operator' }, { owner: undefined }]) {
    const h = makeHarness({ storage: manualRetirementStorage() })
    assert.equal((await h.request('pending_retirement_inspect', { ...manualRetirementIdentity, ...extra })).ok, false)
    assert.equal(h.storageState['pending-retirement:manual-retire'], undefined)
  }
})

test('manual owner retirement rejects an explicit nonmanual pending source even without a registration', async () => {
  for (const source of ['watchdog', 'human', 'managed-worker']) {
    const storage = manualRetirementStorage()
    storage['pending:manual-retire'].source = source
    const h = makeHarness({ storage })
    const inspected = await h.request('pending_retirement_inspect', manualRetirementIdentity)
    assert.equal(inspected.ok, true, inspected.error)
    assert.equal(inspected.result.retirable, false, source)
    assert.equal(inspected.result.reason, 'pending_identity_mismatch')
    assert.equal(h.storageState['pending-retirement:manual-retire'], undefined)
  }
})

test('manual owner retirement verifies durable staged contents before releasing the reload blocker', async t => {
  for (const fault of ['write', 'read', 'changed-proof']) await t.test(fault, async () => {
    const h = makeHarness({ storage: manualRetirementStorage(), sortStorageKeys: true,
      failRetirementWrite: fault === 'write', failRetirementRead: fault === 'read',
      beforeRetirementWrite: values => {
        const candidate = values['pending-retirement-staged:manual-retire']
        if (fault === 'changed-proof' && candidate) candidate.proof.contentDrained = false
      } })
    const params = await manualRetirementRequest(h)
    assert.equal((await h.request('pending_retire', params)).ok, false)
    assert.equal(h.storageState['pending-retirement:manual-retire'], undefined)
    const restarted = makeHarness({ storage: structuredClone(h.storageState) })
    assert.equal((await restarted.request('extension_status', {})).result.blockingPendingCount, 1)
    assert.equal(h.storageState['pending:manual-retire'].phase, 'submitting')
  })
})

test('manual owner retirement is available after a maintenance reload but never reports the old failed receipt as upgraded', async () => {
  const storage = manualRetirementStorage()
  storage['reload:receipt'] = { requestId: 'uncorrelated-old-reload', previousInstanceId: 'old-instance', expectedBuildId: 'b'.repeat(64) }
  const original = structuredClone(storage['pending:manual-retire'])
  const h = makeHarness({ storage, deferReloadTimer: true })
  assert.equal((await h.request('extension_status', {})).result.restoration.state, 'failed')
  assert.equal((await h.request('conversation_send', { conversationId: 'manual-retire', writerEpoch: 3 })).ok, false)
  assert.equal((await h.request('pending_retire', await manualRetirementRequest(h))).ok, true)
  const retiredStatus = (await h.request('extension_status', {})).result
  assert.equal(retiredStatus.restoration.state, 'failed')
  assert.equal(retiredStatus.lastReload.requestId, 'uncorrelated-old-reload')
  assert.equal(retiredStatus.blockingPendingCount, 0)
  assert.equal((await h.request('extension_reload', { requestId: 'new-manual-standard-reload', expectedInstanceId: 'test-instance',
    expectedBuildId: 'a'.repeat(64) })).ok, true)
  const restarted = makeHarness({ storage: structuredClone(h.storageState), extensionInstance: 'fresh-standard-instance' })
  const status = (await restarted.request('extension_status', {})).result
  assert.equal(status.restoration.state, 'ready')
  assert.equal(status.lastReload.requestId, 'new-manual-standard-reload')
  assert.equal(status.retiredPendingCount, 1)
  assert.deepEqual(restarted.storageState['pending:manual-retire'], original)
  assert.equal(restarted.storageState['effect-receipt:manual-send'], undefined)
})

test('manual owner retirement ignores forged receipt and preserves its original blocker', async t => {
  for (const change of ['owner', 'target', 'epoch', 'revocation', 'project-closure', 'generation', 'digest']) await t.test(change, async () => {
    const h = makeHarness({ storage: manualRetirementStorage() })
    assert.equal((await h.request('pending_retire', await manualRetirementRequest(h))).ok, true)
    const receipt = h.storageState['pending-retirement:manual-retire']
    if (change === 'owner') receipt.owner = 'watchdog'
    if (change === 'target') receipt.target = 'https://chatgpt.com/g/g-p-other/project'
    if (change === 'epoch') h.storageState['writer:authority'].epoch = receipt.writerEpoch - 1
    if (change === 'revocation') receipt.proof.revokedRegistration = true
    if (change === 'project-closure') receipt.proof.targetAbsent = true
    if (change === 'generation') receipt.proof.generationSource = 'host_ledger'
    if (change === 'digest') receipt.pendingDigest = 'b'.repeat(64)
    const status = (await h.request('extension_status', {})).result
    assert.deepEqual([status.retiredPendingCount, status.recoverablePendingCount, status.blockingPendingCount], [0, 0, 1])
  })
})

test('closed uncertain retirement retains exact pending, releases only its blocker, and fences late events across restart', async () => {
  const storage = retirementStorage()
  const original = JSON.stringify(storage['pending:retire-conv'])
  const h = makeHarness({ storage })
  const params = await retirementRequest(h)
  assert.match(params.expectedPendingDigest, /^[a-f0-9]{64}$/)
  const retired = await h.request('pending_retire', params)
  assert.equal(retired.ok, true, retired.error)
  assert.equal(retired.result.delivery, 'unknown')
  assert.equal(JSON.stringify(h.storageState['pending:retire-conv']), original)
  assert.equal(h.storageState['effect-receipt:retire-send'], undefined)
  const status = (await h.request('extension_status', {})).result
  assert.deepEqual([status.pendingCount, status.retiredPendingCount, status.recoverablePendingCount, status.blockingPendingCount], [1, 1, 0, 0])
  h.storageState['pending:another-key'] = structuredClone(h.storageState['pending:retire-conv'])
  assert.equal((await h.request('extension_status', {})).result.blockingPendingCount, 1)
  delete h.storageState['pending:another-key']
  assert.equal((await h.request('pending_retire', params)).result.receipt.operationId, params.operationId)
  assert.equal((await h.request('pending_retire', { ...params, operationId: 'conflict' })).ok, false)
  for (const type of ['response_completed', 'response_delta']) {
    await h.emitRuntimeMessage({ kind: 'conversation_event', event: { type, conversationId: 'retire-conv', turnId: 'retire-turn', monitorVersion: 1, externalUrl: retirementIdentity.target } },
      { tab: { id: 88, windowId: 10, url: retirementIdentity.target } })
  }
  assert.equal(JSON.stringify(h.storageState['pending:retire-conv']), original)
  assert.equal(Object.keys(h.storageState).filter(key => key.startsWith('outbox:')).length, 0)
  assert.equal(h.nativeMessages.filter(message => message.kind === 'event').length, 0)
  const restarted = makeHarness({ storage: structuredClone(h.storageState) })
  assert.equal((await restarted.request('extension_status', {})).result.retiredPendingCount, 1)
  restarted.storageState['pending:retire-conv'] = { ...restarted.storageState['pending:retire-conv'], promptText: 'changed' }
  assert.equal((await restarted.request('extension_status', {})).result.blockingPendingCount, 1)
})

test('retirement publishes on the first attempt after Chrome storage reorders nested object keys', async () => {
  const storage = retirementStorage()
  const originalPending = structuredClone(storage['pending:retire-conv'])
  const h = makeHarness({ storage, sortStorageKeys: true })
  const params = await retirementRequest(h)

  const retired = await h.request('pending_retire', params)

  assert.equal(retired.ok, true, retired.error)
  assert.equal(retired.result.retired, true)
  assert.equal(retired.result.delivery, 'unknown')
  const receipt = h.storageState['pending-retirement:retire-conv']
  assert.equal(receipt.operationId, 'retirement-op')
  assert.equal(receipt.requestId, 'retire-send')
  assert.equal(receipt.proof.writerDrained, true)
  assert.deepEqual(Object.keys(receipt), Object.keys(receipt).sort())
  assert.deepEqual(Object.keys(receipt.proof), Object.keys(receipt.proof).sort())
  assert.deepEqual(h.storageState['pending:retire-conv'], originalPending)
  assert.equal(h.storageState['effect-receipt:retire-send'], undefined)
  const status = (await h.request('extension_status', {})).result
  assert.deepEqual([status.pendingCount, status.retiredPendingCount, status.blockingPendingCount], [1, 1, 0])
  assert.equal(h.createdTabs.length + h.createdWindows.length + h.reloadedTabs.length + h.sentToTabs.length, 0)
})

test('retirement rejects changed staged contents after Chrome storage serialization', async t => {
  for (const changed of ['timestamp', 'proof']) await t.test(changed, async () => {
    const storage = retirementStorage()
    const originalPending = structuredClone(storage['pending:retire-conv'])
    const h = makeHarness({ storage, sortStorageKeys: true, beforeRetirementWrite: values => {
      const key = 'pending-retirement-staged:retire-conv'
      const candidate = values[key]
      if (!candidate) return
      values[key] = changed === 'timestamp'
        ? { ...candidate, retiredAt: candidate.retiredAt + 1 }
        : { ...candidate, proof: { ...candidate.proof, outboxCount: 1 } }
    } })
    const params = await retirementRequest(h)

    const retired = await h.request('pending_retire', params)

    assert.equal(retired.ok, false)
    assert.match(retired.error, /Retirement persistence verification failed/)
    assert.equal(h.storageState['pending-retirement:retire-conv'], undefined)
    assert.deepEqual(h.storageState['pending:retire-conv'], originalPending)
    assert.equal(h.storageState['effect-receipt:retire-send'], undefined)
    const status = (await h.request('extension_status', {})).result
    assert.deepEqual([status.pendingCount, status.retiredPendingCount, status.blockingPendingCount], [1, 0, 1])
  })
})

test('an incomplete durable retirement candidate blocks fresh adoption and late events while preserving reload blocker', async () => {
  const h = makeHarness({ storage: retirementStorage() })
  const params = await retirementRequest(h)
  const result = await h.request('pending_retire', params)
  assert.equal(result.ok, true)
  const storage = structuredClone(h.storageState)
  delete storage['pending-retirement:retire-conv']
  const reopened = makeHarness({ storage, tabs: [{ id: 99, windowId: 10, url: retirementIdentity.target }], windows: [{ id: 10 }] })
  assert.equal((await reopened.request('extension_status', {})).result.blockingPendingCount, 1)
  const adopted = await reopened.request('conversation_adopt', { conversationId: 'retire-conv', turnId: 'new-turn',
    requestId: 'fresh-adopt', externalUrl: retirementIdentity.target, expectedUserMessageId: MODERN_USER_ID, writerEpoch: 3 })
  assert.equal(adopted.ok, false)
  const event = await reopened.emitRuntimeMessage({ kind: 'conversation_event', event: { type: 'response_completed',
    conversationId: 'retire-conv', turnId: 'retire-turn', externalUrl: retirementIdentity.target } }, { tab: { id: 88, url: retirementIdentity.target } })
  assert.equal(event?.durable, false)
  assert.equal(JSON.stringify(reopened.storageState['pending:retire-conv']), JSON.stringify(storage['pending:retire-conv']))
  assert.equal(reopened.storageState['effect-receipt:fresh-adopt'], undefined)
  assert.equal(reopened.sentToTabs.filter(x => x.message.type !== 'sidecar_ping').length, 0)
})

test('retirement fails closed for missing authority, wrong binding, open target and stale CAS', async () => {
  for (const change of ['revocation', 'binding', 'open', 'digest', 'instance', 'build', 'outbox', 'effect', 'generation', 'epoch', 'original-tab', 'pending-url']) {
    const storage = retirementStorage()
    const h = makeHarness({ storage })
    const params = await retirementRequest(h)
    if (change === 'revocation') delete h.storageState['writer:revoked-registration:' + retirementIdentity.registrationId]
    if (change === 'binding') h.storageState['conversation:retire-conv'] = { ...storage['conversation:retire-conv'], url: 'https://chatgpt.com/c/83000000-0000-4000-8000-000000000001' }
    if (change === 'digest') h.storageState['pending:retire-conv'] = { ...storage['pending:retire-conv'], monitorVersion: 2 }
    if (change === 'instance') params.expectedInstanceId = 'old-instance'
    if (change === 'build') params.expectedBuildId = 'b'.repeat(64)
    if (change === 'outbox') h.storageState['outbox:blocked'] = { eventId: 'blocked' }
    if (change === 'effect') h.storageState['content-effect:blocked'] = { token: 'blocked' }
    if (change === 'generation') h.storageState['pending:retire-conv'] = { ...storage['pending:retire-conv'], registrationId: '83000000-0000-4000-8000-000000000001' }
    if (change === 'epoch') params.writerEpoch = 2
    const target = change === 'open' ? makeHarness({ storage, tabs: [{ id: 99, windowId: 1, url: retirementIdentity.target.replace('/c/', '/g/g-p-other/c/') }] }) :
      change === 'original-tab' ? makeHarness({ storage, tabs: [{ id: 88, windowId: 1, url: 'https://example.com/' }] }) :
      change === 'pending-url' ? makeHarness({ storage, tabs: [{ id: 99, windowId: 1, url: 'https://example.com/', pendingUrl: retirementIdentity.target }] }) : h
    const result = await target.request('pending_retire', params)
    assert.equal(result.ok, false, change)
    assert.equal(Object.keys(target.storageState).some(key => key.startsWith('pending-retirement:')), false, change)
  }
})

test('retirement keeps the blocker on tabs lookup, persistence and readback failure', async () => {
  for (const fault of ['tabs', 'write', 'read']) {
    let failTabs = false
    const h = makeHarness({ storage: retirementStorage(), tabsQueryFailure: () => failTabs,
      failRetirementWrite: fault === 'write', failRetirementRead: fault === 'read' })
    const params = await retirementRequest(h)
    failTabs = fault === 'tabs'
    const result = await h.request('pending_retire', params)
    assert.equal(result.ok, false, fault)
    assert.equal(h.storageState['pending-retirement:retire-conv'], undefined)
    const restarted = makeHarness({ storage: structuredClone(h.storageState) })
    assert.equal((await restarted.request('extension_status', {})).result.blockingPendingCount, 1)
    assert.equal(restarted.storageState['pending:retire-conv'].phase, 'submitting')
  }
})

test('failed build restoration allows retirement control but blocks browser writers and replay until canonical reload', async () => {
  const storage = retirementStorage()
  storage['reload:receipt'] = { requestId: 'old-reload', previousInstanceId: 'old-instance', expectedBuildId: 'b'.repeat(64) }
  const h = makeHarness({ storage, deferReloadTimer: true })
  assert.equal((await h.request('extension_status', {})).result.restoration.state, 'failed')
  assert.equal((await h.request('writer_epoch_claim', { writerEpoch: 3 })).ok, true)
  assert.equal((await h.request('writer_quiesce', retirementIdentity)).result.target, retirementIdentity.target)
  for (const method of ['conversation_create', 'conversation_send', 'conversation_stop', 'conversation_refresh', 'conversation_adopt', 'webgpt_shift_test', 'project_create']) {
    assert.equal((await h.request(method, { conversationId: 'fresh', writerEpoch: 3 })).ok, false, method)
  }
  await h.emitRuntimeMessage({ kind: 'conversation_event', event: { type: 'response_delta', conversationId: 'retire-conv', turnId: 'retire-turn' } }, { tab: { id: 88, url: 'https://example.com/' } })
  assert.equal(h.storageState['conversation:retire-conv'].url, retirementIdentity.target)
  const params = await retirementRequest(h)
  assert.equal((await h.request('pending_retire', params)).ok, true)
  assert.equal((await h.request('extension_status', {})).result.restoration.state, 'failed')
  assert.equal((await h.request('extension_reload', { requestId: 'fresh-reload', expectedInstanceId: 'test-instance', expectedBuildId: 'a'.repeat(64) })).ok, true)
  const restarted = makeHarness({ storage: structuredClone(h.storageState), extensionInstance: 'fresh-instance' })
  const ready = (await restarted.request('extension_status', {})).result
  assert.equal(ready.restoration.state, 'ready')
  assert.equal(ready.retiredPendingCount, 1)
  assert.equal(restarted.storageState['pending:retire-conv'].phase, 'submitting')
})

test('retirement survives changed instance build and epoch, reconciles same operation and denies fresh target writers', async () => {
  const h = makeHarness({ storage: retirementStorage() })
  const params = await retirementRequest(h)
  const result = await h.request('pending_retire', params)
  const restarted = makeHarness({ storage: structuredClone(h.storageState), extensionInstance: 'replacement', extensionBuild: 'b'.repeat(64),
    tabs: [{ id: 99, windowId: 10, url: retirementIdentity.target }], windows: [{ id: 10 }] })
  assert.equal((await restarted.request('writer_epoch_claim', { writerEpoch: 4 })).ok, true)
  assert.equal((await restarted.request('writer_quiesce', { ...retirementIdentity, writerEpoch: 4 })).ok, true)
  const retry = await restarted.request('pending_retire', { ...params, writerEpoch: 4 })
  assert.equal(retry.ok, true, retry.error)
  assert.deepEqual(JSON.parse(JSON.stringify(retry.result.receipt)), JSON.parse(JSON.stringify(result.result.receipt)))
  assert.equal((await restarted.request('extension_status', {})).result.retiredPendingCount, 1)
  for (const [method, extra] of [
    ['conversation_send', { externalUrl: retirementIdentity.target }], ['conversation_create', { url: retirementIdentity.target }],
    ['conversation_adopt', { externalUrl: retirementIdentity.target }], ['webgpt_shift_test', { target: 'Medium', target_tab_id: 99 }]
  ]) assert.equal((await restarted.request(method, { conversationId: 'new-logical-id', writerEpoch: 4, ...extra })).ok, false, method)
  assert.equal(restarted.sentToTabs.filter(entry => entry.message.type !== 'sidecar_ping').length, 0)
  assert.equal(restarted.createdTabs.length + restarted.createdWindows.length, 0)
  assert.equal(await restarted.emitRuntimeMessage({ kind: 'pending_turn_lookup' }, { tab: { id: 99, url: retirementIdentity.target } }), null)
})

test('retirement exclusive barrier prevents events or reload interleaving with durable publication', async () => {
  let releaseWrite, enteredWrite
  const entered = new Promise(resolve => { enteredWrite = resolve })
  const gate = new Promise(resolve => { releaseWrite = resolve })
  const h = makeHarness({ storage: retirementStorage(), beforeRetirementWrite: async () => { enteredWrite(); await gate } })
  const params = await retirementRequest(h)
  const retiring = h.request('pending_retire', params)
  await entered
  assert.equal((await h.request('extension_reload', { requestId: 'blocked', expectedInstanceId: 'test-instance', expectedBuildId: 'a'.repeat(64) })).ok, false)
  const event = { type: 'response_completed', conversationId: 'retire-conv', turnId: 'retire-turn', monitorVersion: 1, externalUrl: retirementIdentity.target }
  assert.equal((await h.emitRuntimeMessage({ kind: 'conversation_event', event }, { tab: { id: 88, url: retirementIdentity.target } })).durable, false)
  assert.equal(h.storageState['pending:retire-conv'].phase, 'submitting')
  assert.equal(Object.keys(h.storageState).some(key => key.startsWith('outbox:')), false)
  releaseWrite()
  assert.equal((await retiring).ok, true)
})

test('retirement receipt corruption cannot downgrade an altered pending into recoverable work', async () => {
  const h = makeHarness({ storage: retirementStorage() })
  assert.equal((await h.request('pending_retire', await retirementRequest(h))).ok, true)
  h.storageState['pending:retire-conv'] = { ...h.storageState['pending:retire-conv'], phase: 'submitted' }
  h.storageState['effect-receipt:retire-send'] = { requestId: 'retire-send', conversationId: 'retire-conv', turnId: 'retire-turn', userMessageId: 'fake-user' }
  const status = (await h.request('extension_status', {})).result
  assert.deepEqual([status.retiredPendingCount, status.recoverablePendingCount, status.blockingPendingCount], [0, 0, 1])
})

test('retirement resumes a verified candidate after final commit failure and a changed runtime', async () => {
  const h = makeHarness({ storage: retirementStorage(), beforeRetirementWrite: async values => {
    if (Object.hasOwn(values, 'pending-retirement:retire-conv')) throw new Error('Final commit unavailable')
  } })
  const params = await retirementRequest(h)
  assert.equal((await h.request('pending_retire', params)).ok, false)
  assert.equal(h.storageState['pending-retirement:retire-conv'], undefined)
  const candidate = structuredClone(h.storageState['pending-retirement-staged:retire-conv'])
  assert.equal((await h.request('extension_status', {})).result.blockingPendingCount, 1)
  const restarted = makeHarness({ storage: structuredClone(h.storageState), extensionInstance: 'new-instance', extensionBuild: 'b'.repeat(64) })
  assert.equal((await restarted.request('writer_epoch_claim', { writerEpoch: 4 })).ok, true)
  assert.equal((await restarted.request('writer_quiesce', { ...retirementIdentity, writerEpoch: 4 })).ok, true)
  const result = await restarted.request('pending_retire', { ...params, writerEpoch: 4 })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(JSON.parse(JSON.stringify(result.result.receipt)), candidate)
  assert.equal((await restarted.request('extension_status', {})).result.retiredPendingCount, 1)
})

test('actual uncertain native content submit can retire after exact close without changing its native generation or effect history', async t => {
  const fixture = nativeContentFixture({ submitted: false, submissionId: 'local-user:temporary' })
  t.after(() => fixture.dispose())
  const h = makeHarness({ storage: { 'writer:authority': { version: 1, epoch: 3 },
    'conversation:actual-retire': { tabId: 88, windowId: 10, url: MODERN_THREAD_URL } },
    tabs: [{ id: 88, windowId: 10, url: MODERN_THREAD_URL }], windows: [{ id: 10 }],
    contentMessageProvider(tab, message, runtime) { fixture.configureRuntimeTransport(runtime); return fixture.call(message) } })
  const identity = { ...retirementIdentity, conversationId: 'actual-retire', turnId: 'actual-retire-turn', requestId: 'actual-retire-send', target: MODERN_THREAD_URL }
  const send = await h.request('conversation_send', { ...identity, externalUrl: MODERN_THREAD_URL, existingOnly: true, text: 'uncertain fixture', authoritativeState: true })
  assert.equal(send.errorCode, 'DELIVERY_UNCERTAIN')
  const original = JSON.stringify(h.storageState['pending:actual-retire'])
  assert.equal(h.storageState['pending:actual-retire'].registrationId, identity.registrationId)
  h.closeTab(88)
  assert.equal((await h.request('writer_quiesce', identity)).ok, true)
  const inspected = (await h.request('pending_retirement_inspect', identity)).result
  assert.equal(inspected.retirable, true, inspected.reason)
  const retired = await h.request('pending_retire', { ...identity, operationId: 'actual-retirement', reason: 'closed_target_after_quiesce',
    expectedPendingDigest: inspected.pendingDigest, expectedInstanceId: inspected.instanceId, expectedBuildId: inspected.buildId })
  assert.equal(retired.ok, true, retired.error)
  assert.equal(retired.result.receipt.proof.generationSource, 'native_pending')
  assert.equal(JSON.stringify(h.storageState['pending:actual-retire']), original)
  assert.equal(h.storageState['effect-receipt:actual-retire-send'], undefined)
  assert.equal(fixture.clicks, 1)
})

test('retirement drain includes late prepare callback persistence after the original content promise resolves', async () => {
  let releasePrepare, releaseOutbox, enteredOutbox
  const prepare = new Promise(resolve => { releasePrepare = resolve })
  const outbox = new Promise(resolve => { releaseOutbox = resolve })
  const entered = new Promise(resolve => { enteredOutbox = resolve })
  const otherUrl = 'https://chatgpt.com/c/84000000-0000-4000-8000-000000000001'
  const storage = { ...retirementStorage(), 'conversation:late-prepare': { tabId: 20, windowId: 10, url: otherUrl } }
  const h = makeHarness({ storage, tabs: [{ id: 20, windowId: 10, url: otherUrl }], windows: [{ id: 10 }],
    prepareGate: prepare, expirePrepare: true, beforeOutboxWrite: async () => { enteredOutbox(); await outbox } })
  const params = await retirementRequest(h)
  const failed = await h.request('conversation_send', { conversationId: 'late-prepare', turnId: 'late-turn', requestId: 'late-request',
    writerEpoch: 3, externalUrl: otherUrl, existingOnly: true, text: 'late prompt' })
  assert.equal(failed.errorCode, 'DELIVERY_UNCERTAIN')
  releasePrepare()
  await entered
  await h.sendNativeMessage({ kind: 'request', requestId: 'drain-held-retirement', method: 'pending_retire', params })
  assert.equal(h.nativeMessages.some(message => message.requestId === 'drain-held-retirement'), false)
  assert.equal(h.storageState['pending-retirement:retire-conv'], undefined)
  releaseOutbox()
  for (let attempt = 0; attempt < 20; attempt++) await new Promise(resolve => setTimeout(resolve, 1))
  const result = h.nativeMessages.find(message => message.requestId === 'drain-held-retirement')
  assert.equal(result?.ok, false)
  assert.match(result.error, /outbox_not_empty/)
  assert.equal(h.storageState['pending-retirement:retire-conv'], undefined)
})

test('real host ledger and native manual owner retirement compose without Watchdog quiesce or known delivery', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-manual-retirement-composition-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ConversationStore(root)
  const canonical = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946/project'
  const externalUrl = canonical.replace('/project', '-subagents/project')
  const record = await store.create({ backend: 'test', externalUrl })
  await store.append(record.id, { type: 'send_intent', turnId: 'manual-turn', requestId: 'manual-send', text: 'original manual private prompt' })
  await store.append(record.id, { type: 'delivery_uncertain', turnId: 'manual-turn', message: 'unknown manual submit outcome' })
  const storage = manualRetirementStorage(canonical)
  storage[`pending:${record.id}`] = { ...storage['pending:manual-retire'], conversationId: record.id }
  storage[`conversation:${record.id}`] = storage['conversation:manual-retire']
  delete storage['pending:manual-retire']; delete storage['conversation:manual-retire']
  const original = structuredClone(storage[`pending:${record.id}`])
  const h = makeHarness({ storage, extensionInstance: '87000000-0000-4000-8000-000000000001',
    tabs: [{ id: 99, windowId: 10, url: canonical }], windows: [{ id: 10 }] })
  const bridge = new EventEmitter()
  const methods = []
  bridge.request = async (method, params) => {
    methods.push(method)
    assert.notEqual(method, 'writer_quiesce')
    const result = await h.request(method, params)
    if (!result.ok) throw new Error(result.error)
    return JSON.parse(JSON.stringify(result.result))
  }
  const host = new ChatGptConversationHost({ bridge, store, writerEpoch: 3 })
  const request = { conversationId: record.id, requestId: 'manual-send' }
  const inspected = await host.inspectPendingRetirement(request)
  assert.equal(inspected.retirable, true, inspected.reason)
  assert.equal(inspected.owner, 'manual')
  assert.equal(inspected.target, canonical)
  const params = { ...request, operationId: '88000000-0000-4000-8000-000000000001', reason: 'closed_manual_owner_after_quiesce',
    expectedPendingDigest: inspected.pendingDigest, expectedInstanceId: inspected.instanceId, expectedBuildId: inspected.buildId }
  const retired = await host.retirePendingAttempt(params)
  assert.equal(retired.delivery, 'unknown')
  assert.equal(retired.receipt.owner, 'manual')
  assert.equal(retired.receipt.proof.writerDrained, true)
  assert.equal(retired.receipt.proof.contentDrained, true)
  assert.equal(retired.receipt.proof.generationSource, 'manual_owner')
  assert.equal(Object.hasOwn(retired.receipt, 'registrationId'), false)
  assert.equal(Object.hasOwn(retired.receipt.proof, 'revokedRegistration'), false)
  assert.equal(Object.hasOwn(retired.receipt.proof, 'targetAbsent'), false)
  assert.equal((await host.retirePendingAttempt(params)).retired, true)
  assert.deepEqual(h.storageState[`pending:${record.id}`], original)
  assert.equal(h.storageState['effect-receipt:manual-send'], undefined)
  assert.ok(methods.every(method => ['pending_retirement_inspect', 'pending_retire'].includes(method)))
  assert.equal(h.createdTabs.length + h.createdWindows.length + h.reloadedTabs.length + h.sentToTabs.length, 0)
  assert.equal(Object.keys(h.storageState).some(key => key.startsWith('writer:revoked-registration:')), false)
  const status = (await h.request('extension_status', {})).result
  assert.deepEqual([status.pendingCount, status.retiredPendingCount, status.blockingPendingCount], [1, 1, 0])
  const after = await store.read(record.id)
  assert.equal(after.status, 'delivery_uncertain')
  assert.equal(after.latestTurnId, 'manual-turn')
  assert.equal(after.externalUrl, externalUrl)
  assert.equal(after.events.filter(event => event.type === 'pending_retired').length, 1)
  assert.equal(after.events.filter(event => event.type === 'send_intent').length, 1)
  assert.equal(after.events.filter(event => event.type === 'delivery_uncertain').length, 1)
})

test('real host ledger and native retirement compose for legacy pending without fabricating known delivery', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-retirement-composition-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ConversationStore(root)
  const record = await store.create({ backend: 'test', externalUrl: retirementIdentity.target })
  await store.append(record.id, { type: 'send_intent', turnId: retirementIdentity.turnId, requestId: retirementIdentity.requestId,
    source: 'watchdog', registrationId: retirementIdentity.registrationId, text: 'original private prompt' })
  await store.append(record.id, { type: 'delivery_uncertain', turnId: retirementIdentity.turnId, message: 'unknown submit outcome' })
  const storage = retirementStorage()
  const pending = { ...storage['pending:retire-conv'], conversationId: record.id }
  storage[`pending:${record.id}`] = pending
  storage[`conversation:${record.id}`] = storage['conversation:retire-conv']
  delete storage['pending:retire-conv']; delete storage['conversation:retire-conv']
  delete storage['writer:revoked-registration:' + retirementIdentity.registrationId].target
  const h = makeHarness({ storage, extensionInstance: '85000000-0000-4000-8000-000000000001' })
  const bridge = new EventEmitter()
  const methods = []
  bridge.request = async (method, params) => {
    methods.push(method)
    const result = await h.request(method, params)
    if (!result.ok) throw new Error(result.error)
    // Native messaging crosses a JSON boundary; do not leak VM prototypes.
    return JSON.parse(JSON.stringify(result.result))
  }
  const host = new ChatGptConversationHost({ bridge, store, writerEpoch: 3 })
  await host.watchdogAuthority.bind({ registrationId: retirementIdentity.registrationId, target: retirementIdentity.target })
  await host.watchdogAuthority.withdraw({ registrationId: retirementIdentity.registrationId, target: retirementIdentity.target }, async () => ({ quiescent: true }))
  const request = { conversationId: record.id, requestId: retirementIdentity.requestId }
  const inspected = await host.inspectPendingRetirement(request)
  assert.equal(inspected.found, true)
  assert.equal(inspected.retirable, false)
  assert.equal(inspected.reason, 'registration_not_revoked_for_target')
  const original = JSON.stringify(h.storageState[`pending:${record.id}`])
  const params = { ...request, operationId: '86000000-0000-4000-8000-000000000001', reason: 'closed_target_after_quiesce',
    expectedPendingDigest: inspected.pendingDigest, expectedInstanceId: inspected.instanceId, expectedBuildId: inspected.buildId }
  const retired = await host.retirePendingAttempt(params)
  assert.equal(retired.retired, true)
  assert.equal(retired.delivery, 'unknown')
  assert.equal(retired.receipt.proof.generationSource, 'host_ledger')
  assert.equal((await host.retirePendingAttempt(params)).retired, true)
  assert.equal(JSON.stringify(h.storageState[`pending:${record.id}`]), original)
  assert.equal(h.storageState['effect-receipt:' + retirementIdentity.requestId], undefined)
  const status = (await h.request('extension_status', {})).result
  assert.deepEqual([status.pendingCount, status.retiredPendingCount, status.blockingPendingCount], [1, 1, 0])
  const after = await store.read(record.id)
  assert.equal(after.status, 'delivery_uncertain')
  assert.equal(after.events.filter(event => event.type === 'pending_retired').length, 1)
  assert.ok(methods.every(method => ['pending_retirement_inspect', 'writer_quiesce', 'pending_retire'].includes(method)))
  assert.equal(h.createdTabs.length + h.createdWindows.length + h.reloadedTabs.length + h.sentToTabs.length, 0)
})

function makeHarness({ storage = {}, windows = [], tabs = [], staleContentScriptTabIds = [], projectOpenChannelClosesAfterNavigation = false, projectOpenRejectOnRoot = false, projectDraftRequiresReload = false, submitTransportFailure = false, submitNavigatesTo = null, prepareTransportFailure = false, prepareRejected = false, expirePrepare = false, prepareGate = null, deferReloadTimer = false, failAcceptedResponsePostOnce = false, hangWebGptShift = false, fastWebGptShiftTimeout = false, webGptDiagnostic = null, reloadTransportFailure = false, refreshAdmissionTabChanges = null, failRevocationStorage = false, stopGate = null, fastStopTimeout = false, loseContentCompletion = false, failContentEffectStorage = false, failContentEffectClear = false, onContentDocumentProbe = null, onStateObservation = null, completedEffectOnPing = null, projectOpenInvalidatesContent = false, onContentScriptInjection = null, onMissingContentPing = null, fastProjectDraftClock = false, contentPingProvider = null, fastConversationUrlClock = false, onSubmittedTabGet = null, submitPendingUrl = null, submitUserMessageId = '00000000-0000-4000-8000-000000000001', contentMessageProvider = null, submitResponseUrl = null, submitNewTabs = [], ...retirementFaults } = {}) {
  // Chrome's storage dictionary roundtrip does not preserve object insertion order.
  const storageRoundTrip = value => retirementFaults.sortStorageKeys
    ? JSON.parse(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item))
    : value
  const storageState = { ...storageRoundTrip(storage) }
  const staleContentScriptTabs = new Set(staleContentScriptTabIds)
  const windowMap = new Map(windows.map((window) => [window.id, { ...window }]))
  const tabMap = new Map(tabs.map((tab) => [tab.id, { ...tab }]))
  const nativeMessages = []
  const submittedTabs = new Set()
  let draftClock = Date.now()
  const runtimeMessageListeners = []
  let tabUpdatedListener = null
  const sentToTabs = []
  const createdTabs = []
  const createdWindows = []
  const reloadedTabs = []
  const scriptingCalls = []
  let nativeRequestListener = null
  let nativeDisconnectListener = null
  let failNativeEventPosts = false
  let nextTabId = 1000
  let nextWindowId = 2000
  const deferredReloadTimers = []
  let runtimeReloadCount = 0
  let requestSequence = 0

  const nativePort = {
    onMessage: {
      addListener(listener) {
        nativeRequestListener = listener
      }
    },
    onDisconnect: {
      addListener(listener) {
        nativeDisconnectListener = listener
      }
    },
    postMessage(message) {
      if (failAcceptedResponsePostOnce && message?.kind === 'response' && message.ok === true) {
        failAcceptedResponsePostOnce = false
        throw new Error('Native response transport lost')
      }
      if (failNativeEventPosts && message?.kind === 'event') {
        throw new Error('Native host disconnected during event delivery')
      }
      nativeMessages.push(message)
    }
  }

  const chrome = {
    runtime: {
      id: 'cfifihieaffhniimpimnfmignbbdaalb',
      reload() {
        runtimeReloadCount += 1
      },
      connectNative() {
        return nativePort
      },
      getManifest() {
        return { version: 'test' }
      },
      getURL(path) {
        return `chrome-extension://cfifihieaffhniimpimnfmignbbdaalb/${path}`
      },
      onMessage: {
        addListener(listener) {
          runtimeMessageListeners.push(listener)
        }
      },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} }
    },
    scripting: {
      async executeScript(options) {
        scriptingCalls.push(options)
        if (Array.isArray(options?.files) && options.files.includes('content-script.js')) {
          const tabId = options?.target?.tabId
          if (Number.isInteger(tabId)) {
            staleContentScriptTabs.delete(tabId)
            onContentScriptInjection?.(tabMap.get(tabId), staleContentScriptTabs)
          }
        }
        return [{ result: webGptDiagnostic }]
      }
    },
    storage: {
      local: {
        async get(key) {
          if (retirementFaults.failRetirementRead && Object.keys(storageState).some(key => key.startsWith('pending-retirement-staged:'))) throw new Error('Retirement readback failed')
          if (key === null) return storageRoundTrip({ ...storageState })
          if (typeof key === 'string') {
            return storageRoundTrip(Object.hasOwn(storageState, key) ? { [key]: storageState[key] } : {})
          }
          throw new Error(`Unsupported storage.get key: ${String(key)}`)
        },
        async set(values) {
          if (Object.keys(values).some(key => key.startsWith('outbox:'))) await retirementFaults.beforeOutboxWrite?.(values)
          if (Object.keys(values).some(key => key.startsWith('pending-retirement'))) {
            if (retirementFaults.failRetirementWrite) throw new Error('Retirement storage unavailable')
            await retirementFaults.beforeRetirementWrite?.(values)
          }
          if (failRevocationStorage && Object.keys(values).some(key => key.startsWith('writer:revoked-registration:'))) throw new Error('Revocation storage unavailable')
          if (failContentEffectStorage && Object.keys(values).some(key => key.startsWith('content-effect:'))) throw new Error('Content effect storage unavailable')
          Object.assign(storageState, storageRoundTrip(values))
          for (const receipt of Object.values(values)) {
            if (receipt?.action === 'refresh' && receipt.phase === 'issued' && refreshAdmissionTabChanges) {
              Object.assign(tabMap.get(receipt.tabId), refreshAdmissionTabChanges)
            }
          }
        },
        async remove(key) {
          if (failContentEffectClear && (Array.isArray(key) ? key : [key]).some(item => item.startsWith('content-effect:'))) throw new Error('Content effect clear unavailable')
          for (const item of Array.isArray(key) ? key : [key]) delete storageState[item]
        }
      }
    },
    windows: {
      async get(windowId) {
        const window = windowMap.get(windowId)
        if (!window) throw new Error(`No window ${windowId}`)
        return { ...window }
      },
      async create({ url, type, focused, state }) {
        const windowId = nextWindowId++
        const tab = { id: nextTabId++, windowId, url }
        const window = { id: windowId, type, focused, state, tabs: [tab] }
        windowMap.set(windowId, window)
        tabMap.set(tab.id, tab)
        createdWindows.push(window)
        return { ...window, tabs: [{ ...tab }] }
      }
    },
    tabs: {
      onUpdated: {
        addListener(listener) {
          tabUpdatedListener = listener
        }
      },
      async get(tabId) {
        const tab = tabMap.get(tabId)
        if (!tab) throw new Error(`No tab ${tabId}`)
        if (submittedTabs.has(tabId)) onSubmittedTabGet?.(tab, storageState)
        return { ...tab }
      },
      async query({ windowId } = {}) {
        if (retirementFaults.tabsQueryFailure?.()) throw new Error('Tabs lookup failed')
        return [...tabMap.values()]
          .filter((tab) => windowId === undefined || tab.windowId === windowId)
          .map((tab) => ({ ...tab }))
      },
      async create({ windowId, url, active }) {
        if (!windowMap.has(windowId)) throw new Error(`No window ${windowId}`)
        const tab = { id: nextTabId++, windowId, url, active }
        tabMap.set(tab.id, tab)
        createdTabs.push({ ...tab })
        return { ...tab }
      },
      async reload(tabId) {
        const tab = tabMap.get(tabId)
        if (!tab) throw new Error(`No tab ${tabId}`)
        reloadedTabs.push(tabId)
        if (reloadTransportFailure) throw new Error('Reload acknowledgement lost')
        staleContentScriptTabs.delete(tabId)
        if (projectDraftRequiresReload) tab.composerPresent = true
      },
      async sendMessage(tabId, message, options = {}) {
        const tab = tabMap.get(tabId)
        if (!tab) throw new Error(`No tab ${tabId}`)
        sentToTabs.push({ tabId, message, options, storageSnapshot: structuredClone(storageState) })
        const sender = {
          id: chrome.runtime.id, tab: { ...tab }, frameId: 0,
          documentId: tab.documentId ?? '30000000000040008000' + String(tabId).padStart(12, '0')
        }
        if (options.documentId !== undefined && (typeof options.documentId !== 'string' || !/^[0-9a-f]{32}$/i.test(options.documentId))) throw new Error('Invalid Chromium documentId')
        if (options.documentId && options.documentId !== sender.documentId) throw new Error('Exact target document is unavailable')
        const runtime = async notification => {
          let response
          for (const listener of runtimeMessageListeners) listener(notification, sender, value => { response = value })
          for (let attempt = 0; attempt < 8 && response === undefined; attempt += 1) await new Promise(resolve => setImmediate(resolve))
          return response
        }
        if (contentMessageProvider) return contentMessageProvider(tab, message, runtime)
        if (message.type === 'sidecar_effect_document') {
          const result = await runtime({ kind: 'content_effect_document', token: message.token })
          onContentDocumentProbe?.(storageState)
          return result
        }
        try {
        const result = await (async () => {
        if (message.type === 'sidecar_ping') {
          if (staleContentScriptTabs.has(tabId)) {
            onMissingContentPing?.(tab)
            throw new Error('Could not establish connection. Receiving end does not exist.')
          }
          if (completedEffectOnPing) await runtime({ kind: 'content_effect_complete', effect: completedEffectOnPing })
          if (contentPingProvider) return contentPingProvider(tab)
          return { ready: tab.pingReady !== false, url: tab.pingUrl ?? tab.url, buildId: tab.pingBuildId ?? 'a'.repeat(64), composerPresent: tab.composerPresent === true }
        }
        if (message.type === 'conversation_observe') {
          if (staleContentScriptTabs.has(tabId)) throw new Error('Could not establish connection. Receiving end does not exist.')
          return {
            ready: tab.observationReady !== false, url: tab.observedUrl ?? tab.url,
            readable: Object.hasOwn(tab, 'observationReadable') ? tab.observationReadable : /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(tab.userMessageId ?? ''),
            allowed: tab.generating !== true, reason: tab.generating === true ? 'assistant_active' : null,
            userMessageId: tab.userMessageId ?? '', assistantMessageId: tab.assistantMessageId ?? ''
          }
        }
        if (message.type === 'conversation_state_observe') {
          if (staleContentScriptTabs.has(tabId)) throw new Error('Could not establish connection. Receiving end does not exist.')
          const readable = tab.stateReadable !== false && (message.allowLatestUser === true || tab.userMessageId === message.expectedUserMessageId)
          const observation = {
            ready: true,
            url: tab.stateObservedUrl ?? tab.url,
            readable,
            ...(tab.stateReason ? { reason: tab.stateReason } : {}),
            userMessageId: readable ? tab.userMessageId : null,
            assistantMessageId: readable ? (tab.assistantMessageId ?? null) : null,
            assistantText: readable ? (tab.assistantText ?? '') : null,
            generating: readable ? tab.generating === true : null,
            terminal: readable ? tab.terminal === true : null,
            body: readable ? (tab.body ?? 'unknown') : 'unknown',
            humanGate: readable ? tab.humanGate === true : null
          }
          onStateObservation?.(storageState)
          return observation
        }
        if (message.type === 'conversation_snapshot') {
          return {
            ready: true,
            url: tab.url,
            generating: tab.generating === true,
            assistantText: typeof tab.assistantText === 'string' ? tab.assistantText : ''
          }
        }
        if (message.type === 'project_open') {
          if (projectOpenRejectOnRoot && tab.url === 'https://chatgpt.com/') {
            return { accepted: false, error: 'ChatGPT Project anchor was not found' }
          }
          tab.url = message.projectUrl
          tab.composerPresent = !projectDraftRequiresReload
          if (projectOpenInvalidatesContent) staleContentScriptTabs.add(tabId)
          if (projectOpenChannelClosesAfterNavigation) {
            throw new Error('A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received')
          }
          return {
            accepted: true,
            projectUrl: message.projectUrl,
            control: { kind: 'project-link', tag: 'a', role: null, className: 'project-anchor', text: 'Open project' }
          }
        }
        if (message.type === 'project_create') {
          tab.url = 'https://chatgpt.com/g/g-p-created-test/project'
          return { accepted: true, name: message.name }
        }
        if (message.type === 'project_find') {
          if (tab.projectName === message.name && tab.projectUrl) {
            return { found: true, name: message.name, projectUrl: tab.projectUrl }
          }
          return { found: false, name: message.name }
        }
        if (message.type === 'conversation_mode_select') {
          tab.mode = message.mode
          return { selected: true, mode: tab.mode, url: tab.url }
        }
        if (message.type === 'conversation_prepare') {
          if (prepareGate) await prepareGate
          if (prepareTransportFailure) throw new Error('prepare response lost')
          if (prepareRejected) return { prepared: false, error: 'editor missing' }
          return { prepared: true, url: tab.url, baselineAssistantCount: 0 }
        }
        if (message.type === 'conversation_submit') {
          if (submitTransportFailure) throw new Error('submit response lost during navigation')
          const responseUrl = submitResponseUrl ?? tab.url
          if (submitNavigatesTo) tab.url = submitNavigatesTo
          if (submitPendingUrl) tab.pendingUrl = submitPendingUrl
          submittedTabs.add(tabId)
          for (const opened of submitNewTabs) tabMap.set(opened.id, { ...opened })
          tab.userMessageId = submitUserMessageId
          return { accepted: true, userMessageId: submitUserMessageId, url: responseUrl }
        }
        if (message.type === 'conversation_stop') {
          if (stopGate) await stopGate
          if (tab.generating !== true) return { accepted: false, error: 'generation is not stoppable' }
          tab.generating = false
          return {
            accepted: true,
            url: tab.url,
            userMessageId: tab.userMessageId ?? message.expected?.userMessageId ?? null,
            assistantMessageId: tab.assistantMessageId ?? null,
            assistantText: tab.assistantText ?? ''
          }
        }
        if (message.type === 'conversation_send') {
          return { accepted: true, url: tab.url, baselineAssistantCount: 0 }
        }
        if (message.type === 'webgpt_shift_test') {
          if (hangWebGptShift) return await new Promise(() => {})
          return { switched: true, before: 'High', after: message.target }
        }
        if (message.type === 'conversation_monitor_start') return { started: true }
        throw new Error(`Unexpected tab message ${message.type}`)
        })()
        if (message.contentEffect && !loseContentCompletion) await runtime({ kind: 'content_effect_complete', effect: message.contentEffect })
        return message.contentEffect && !loseContentCompletion ? { ...result, contentEffectSettled: message.contentEffect } : result
        } catch (error) {
          if (message.contentEffect && !loseContentCompletion) await runtime({ kind: 'content_effect_complete', effect: message.contentEffect })
          throw error
        }
      }
    }
  }

  const fastSetTimeout = (callback) => {
    queueMicrotask(callback)
    return 1
  }

  let uuidCalls = 0
  const context = vm.createContext({
    chrome,
    crypto: { subtle: webcrypto.subtle, randomUUID: () => ++uuidCalls === 1 ? (retirementFaults.extensionInstance || 'test-instance') : `test-effect-${++harnessEffectToken}` },
    TextEncoder,
    importScripts(...files) {
      for (const file of files) {
        if (file === 'build-info.js') vm.runInContext(`globalThis.__sidecarBuildId = ${JSON.stringify(retirementFaults.extensionBuild || 'a'.repeat(64))}`, context)
        else if (file === 'pending-retirement-target.js') vm.runInContext(retirementTargetSource, context)
        else if (file === 'lifecycle.js') vm.runInContext(lifecycleSource, context)
        else throw new Error(`Unexpected import: ${file}`)
      }
    },
    console,
    URL,
    Date: (fastProjectDraftClock || fastConversationUrlClock) ? class extends Date { static now() { draftClock += 1000; return draftClock } } : Date,
    Promise,
    Object,
    setTimeout(callback, ms) {
      if (deferReloadTimer && ms === 250) {
        deferredReloadTimers.push(callback)
        return deferredReloadTimers.length
      }
      if (expirePrepare && ms === 60_000) return fastSetTimeout(callback)
      if (fastWebGptShiftTimeout && ms === 10_000) return fastSetTimeout(callback)
      if (fastStopTimeout && ms === 5_000) return fastSetTimeout(callback)
      if (ms >= 2000) return setTimeout(callback, ms)
      return fastSetTimeout(callback)
    },
    clearTimeout(timer) { clearTimeout(timer) }
  })
  vm.runInContext(workerSource, context, { filename: 'extension/service-worker.js' })

  async function request(method, params) {
    if (!nativeRequestListener) throw new Error('Native request listener was not registered')
    const requestId = `req-${++requestSequence}`
    nativeRequestListener({ kind: 'request', requestId, method, params })
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const response = nativeMessages.find((message) => message.kind === 'response' && message.requestId === requestId)
      if (response) return response
      await new Promise((resolve) => attempt % 10 === 9 ? setTimeout(resolve, 1) : setImmediate(resolve))
    }
    throw new Error(`Timed out waiting for ${requestId}`)
  }

  async function emitRuntimeMessage(message, sender) {
    let response
    for (const listener of runtimeMessageListeners) {
      listener(message, sender, (value) => {
        response = value
      })
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    return response
  }

  async function sendNativeMessage(message) {
    if (!nativeRequestListener) throw new Error('Native request listener was not registered')
    nativeRequestListener(message)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  async function updateTab(tabId, changes) {
    const tab = tabMap.get(tabId)
    if (!tab) throw new Error(`No tab ${tabId}`)
    Object.assign(tab, changes)
    if (tabUpdatedListener) tabUpdatedListener(tabId, { ...changes }, { ...tab })
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  async function reconnectNative() {
    failNativeEventPosts = false
    if (!nativeDisconnectListener) throw new Error('Native disconnect listener was not registered')
    nativeDisconnectListener()
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  return {
    closeTab(tabId) { tabMap.delete(tabId) },
    storageState,
    sentToTabs,
    createdTabs,
    createdWindows,
    reloadedTabs,
    scriptingCalls,
    nativeMessages,
    request,
    emitRuntimeMessage,
    sendNativeMessage,
    updateTab,
    reconnectNative,
    runDeferredReload() {
      const callback = deferredReloadTimers.shift()
      if (!callback) throw new Error('No deferred reload timer')
      callback()
    },
    get runtimeReloadCount() {
      return runtimeReloadCount
    },
    setFailNativeEventPosts(value) {
      failNativeEventPosts = value
    }
  }
}

const adoptionTarget = 'https://chatgpt.com/c/00000000-0000-4000-8000-000000000061'
const adoptionUser = '10000000-0000-4000-8000-000000000061'
const adoptionParams = { conversationId: 'conv_adopt', turnId: 'adopted-turn', requestId: 'adopt-request',
  externalUrl: adoptionTarget, expectedUserMessageId: adoptionUser, writerEpoch: 3 }
const adoptionTab = { id: 61, windowId: 6, url: adoptionTarget, userMessageId: adoptionUser,
  generating: true, body: 'empty' }

test('conversation_supervision_inspect discovers current persistent anchors on one exact active tab without binding or navigation', async () => {
  const h = makeHarness({
    storage: { 'writer:authority': { version: 1, epoch: 3 } },
    tabs: [adoptionTab], windows: [{ id: 6 }], staleContentScriptTabIds: [61]
  })

  const inspected = await h.request('conversation_supervision_inspect', { externalUrl: adoptionTarget, writerEpoch: 3 })

  assert.equal(inspected.ok, true)
  assert.equal(inspected.result.found, true)
  assert.equal(inspected.result.readable, true)
  assert.equal(inspected.result.userMessageId, adoptionUser)
  assert.equal(inspected.result.assistantMessageId, null)
  assert.equal(inspected.result.url, adoptionTarget)
  assert.deepEqual(h.sentToTabs.filter(({ message }) => message.type === 'conversation_observe').map(({ tabId }) => tabId), [61])
  assert.equal(h.sentToTabs.find(({ message }) => message.type === 'conversation_observe').message.authoritativeState, true)
  assert.equal(Object.keys(h.storageState).some(key => key.startsWith('conversation:')), false)
  assert.equal(h.createdTabs.length + h.createdWindows.length + h.reloadedTabs.length, 0)
  assert.deepEqual(JSON.parse(JSON.stringify(h.scriptingCalls[0].target)), { tabId: 61, frameIds: [0] })
})

test('conversation_supervision_inspect fails closed for missing, ambiguous, unreadable, and nonpersistent observations', async () => {
  for (const tabs of [
    [], [adoptionTab, { ...adoptionTab, id: 62 }],
    [{ ...adoptionTab, observationReady: false }],
    [{ ...adoptionTab, observationReadable: false }],
    [{ ...adoptionTab, observationReadable: undefined }],
    [{ ...adoptionTab, userMessageId: '' }],
    [{ ...adoptionTab, userMessageId: 'synthetic-user' }],
    [{ ...adoptionTab, assistantMessageId: 'synthetic-assistant' }],
    [{ ...adoptionTab, observedUrl: adoptionTarget.replace('0061', '0062') }]
  ]) {
    const h = makeHarness({ storage: { 'writer:authority': { version: 1, epoch: 3 } }, tabs, windows: [{ id: 6 }] })
    const inspected = await h.request('conversation_supervision_inspect', { externalUrl: adoptionTarget, writerEpoch: 3 })
    assert.equal(inspected.ok, true)
    assert.equal(inspected.result.found, false, JSON.stringify(tabs))
    if (tabs.length === 1 && tabs[0].observationReady !== false && !tabs[0].observedUrl) {
      assert.equal(inspected.result.reason, 'persistent_turn_identity_unavailable')
    }
    if (tabs.length === 1 && tabs[0].observedUrl) assert.equal(inspected.result.reason, 'supervision_identity_mismatch')
    assert.equal(h.createdTabs.length + h.createdWindows.length + h.reloadedTabs.length, 0)
  }
})

test('conversation_supervision_inspect requires an exact UUID URL and current writer epoch before inspection', async () => {
  const h = makeHarness({ storage: { 'writer:authority': { version: 1, epoch: 3 } }, tabs: [adoptionTab], windows: [{ id: 6 }] })
  for (const params of [
    { externalUrl: 'https://chatgpt.com/', writerEpoch: 3 },
    { externalUrl: adoptionTarget + '?other=1', writerEpoch: 3 },
    { externalUrl: adoptionTarget, writerEpoch: 2 },
    { externalUrl: adoptionTarget }
  ]) {
    const inspected = await h.request('conversation_supervision_inspect', params)
    assert.equal(inspected.ok, false)
  }
  assert.equal(h.sentToTabs.length, 0)
})

test('explicit adoption reinjects a stale content script into only the exact target without reload or navigation', async () => {
  const h = makeHarness({ tabs: [adoptionTab], windows: [{ id: 6 }], staleContentScriptTabIds: [61] })
  await h.request('writer_epoch_claim', { writerEpoch: 3 })

  const adopted = await h.request('conversation_adopt', adoptionParams)

  assert.equal(adopted.ok, true)
  assert.equal(adopted.result.accepted, true)
  assert.equal(h.scriptingCalls.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(h.scriptingCalls[0].target)), { tabId: 61, frameIds: [0] })
  assert.deepEqual(JSON.parse(JSON.stringify(h.scriptingCalls[0].files)), ['build-info.js', 'content-script.js'])
  assert.deepEqual(h.reloadedTabs, [])
  assert.equal(h.createdTabs.length + h.createdWindows.length, 0)
})

test('existing-tab inspection is read-only and explicit adoption binds without creation, navigation, or send', async () => {
  const h = makeHarness({ tabs: [adoptionTab], windows: [{ id: 6 }] })
  await h.request('writer_epoch_claim', { writerEpoch: 3 })
  const inspected = await h.request('conversation_adoption_inspect', adoptionParams)
  assert.equal(inspected.ok, true)
  assert.equal(inspected.result.found, true)
  assert.equal(h.storageState['conversation:conv_adopt'], undefined)
  const adopted = await h.request('conversation_adopt', adoptionParams)
  assert.equal(adopted.ok, true)
  assert.equal(adopted.result.accepted, true)
  assert.equal(h.storageState['conversation:conv_adopt'].tabId, 61)
  assert.equal(h.storageState['conversation:conv_adopt'].adopted, true)
  assert.equal(h.storageState['effect-receipt:adopt-request'].action, 'adopt')
  assert.equal(h.createdTabs.length + h.createdWindows.length + h.reloadedTabs.length, 0)
  assert.equal(h.sentToTabs.some(c => ['conversation_prepare', 'conversation_submit', 'conversation_stop'].includes(c.message.type)), false)
  const replay = await h.request('conversation_adopt', adoptionParams)
  assert.equal(replay.result.accepted, true)
  assert.equal(replay.result.reconciled, true)
  assert.equal(Object.keys(h.storageState).filter(k => k.startsWith('conversation:')).length, 1)
  const aliased = await h.request('conversation_state_observe', {
    conversationId: 'conv_adopt', turnId: 'adopted-turn',
    externalUrl: adoptionTarget.replace('/c/', '/g/g-p-example/c/'), expectedUserMessageId: adoptionUser
  })
  assert.equal(aliased.result.readable, true)
})

test('explicit adoption preflight re-injects only the exact unowned tab observer after extension reload', async () => {
  const h = makeHarness({ tabs: [adoptionTab], windows: [{ id: 6 }], staleContentScriptTabIds: [61] })
  await h.request('writer_epoch_claim', { writerEpoch: 3 })
  const stale = await h.request('conversation_adoption_inspect', { ...adoptionParams, writerEpoch: 2 })
  assert.equal(stale.ok, false)
  assert.equal(h.scriptingCalls.length, 0)
  const inspected = await h.request('conversation_adoption_inspect', adoptionParams)
  assert.equal(inspected.ok, true)
  assert.equal(inspected.result.found, true)
  assert.deepEqual(JSON.parse(JSON.stringify(h.scriptingCalls)), [
    { target: { tabId: 61, frameIds: [0] }, files: ['build-info.js', 'content-script.js'] }
  ])
  assert.equal(h.storageState['conversation:conv_adopt'], undefined)
  assert.equal(h.createdTabs.length + h.createdWindows.length + h.reloadedTabs.length, 0)
})

test('adoption fails closed on missing target, ambiguous exact tabs, wrong UUID and stale user anchor', async () => {
  for (const tabs of [[], [adoptionTab, { ...adoptionTab, id: 62 }],
    [{ ...adoptionTab, url: adoptionTarget.replace('0061', '0062') }],
    [{ ...adoptionTab, userMessageId: 'another-message' }]]) {
    const h = makeHarness({ tabs, windows: [{ id: 6 }] })
    await h.request('writer_epoch_claim', { writerEpoch: 3 })
    const r = await h.request('conversation_adopt', adoptionParams)
    assert.equal(r.ok === true && r.result?.accepted === true, false)
    assert.equal(h.storageState['conversation:conv_adopt'], undefined)
    assert.equal(h.createdTabs.length, 0)
  }
})

test('adoption rejects another persisted browser owner and stale writer epoch', async () => {
  const h = makeHarness({ tabs: [adoptionTab], windows: [{ id: 6 }], storage: {
    'conversation:conv_other': { tabId: 61, windowId: 6, url: adoptionTarget }
  } })
  await h.request('writer_epoch_claim', { writerEpoch: 3 })
  const conflict = await h.request('conversation_adopt', adoptionParams)
  assert.equal(conflict.ok === true && conflict.result?.accepted === true, false)
  const stale = await h.request('conversation_adopt', { ...adoptionParams, writerEpoch: 2 })
  assert.equal(stale.ok, false)
  assert.equal(h.storageState['conversation:conv_adopt'], undefined)
})

test('adopted binding survives extension restart and closed/navigated target is never reopened', async () => {
  const first = makeHarness({ tabs: [adoptionTab], windows: [{ id: 6 }] })
  await first.request('writer_epoch_claim', { writerEpoch: 3 })
  assert.equal((await first.request('conversation_adopt', adoptionParams)).result.accepted, true)
  const restarted = makeHarness({ storage: structuredClone(first.storageState), tabs: [adoptionTab], windows: [{ id: 6 }] })
  const read = await restarted.request('conversation_state_observe', { conversationId: 'conv_adopt', turnId: 'adopted-turn',
    externalUrl: adoptionTarget, expectedUserMessageId: adoptionUser })
  assert.equal(read.result.readable, true)
  await restarted.updateTab(61, { url: 'https://example.com/' })
  const unavailable = await restarted.request('conversation_state_observe', { conversationId: 'conv_adopt', turnId: 'adopted-turn',
    externalUrl: adoptionTarget, expectedUserMessageId: adoptionUser })
  assert.equal(unavailable.result.readable, false)
  const replay = await restarted.request('conversation_adopt', adoptionParams)
  assert.equal(replay.ok === true && replay.result?.accepted === true, false)
  assert.equal(restarted.createdTabs.length, 0)
})

test('concurrent adoption cannot create two owners of an exact tab', async () => {
  const h = makeHarness({ tabs: [adoptionTab], windows: [{ id: 6 }] })
  await h.request('writer_epoch_claim', { writerEpoch: 3 })
  await Promise.all([h.request('conversation_adopt', adoptionParams), h.request('conversation_adopt', {
    ...adoptionParams, conversationId: 'conv_contender', requestId: 'adopt-contender'
  })])
  assert.equal(Object.keys(h.storageState).filter(k => k.startsWith('conversation:')).length, 1)
  assert.equal(h.createdTabs.length, 0)
})

test('Project slug redirect preserves the existing tab', async () => {
  const home = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946/project'
  const alias = home.replace('/project', '-subagents/project')
  const thread = alias.replace('/project', '/c/00000000-0000-4000-8000-000000000002')
  const harness = makeHarness({
    submitNavigatesTo: thread,
    storage: { window0: { windowId: 10, sentinelTabId: 19 }, 'conversation:conv_alias': { windowId: 10, tabId: 20, url: home } },
    windows: [{ id: 10 }],
    tabs: [
      { id: 19, windowId: 10, url: 'chrome-extension://cfifihieaffhniimpimnfmignbbdaalb/automation-window.html', active: true },
      { id: 20, windowId: 10, url: alias }
    ]
  })
  const result = await harness.request('conversation_send', { conversationId: 'conv_alias', turnId: 'turn_alias', text: 'hello', externalUrl: home })
  assert.equal(result.ok, true)
  assert.equal(result.result.tabId, 20)
  assert.equal(harness.createdTabs.length, 0)
  const status = await harness.request('extension_status', {})
  assert.equal(status.result.managedTabs[0].tabId, 20)
  assert.equal(status.result.managedTabs[0].url, thread)
  assert.equal(harness.storageState['conversation:conv_alias'].url, thread)
  assert.equal(result.result.url, thread)
})

test('accepted browser effect persists a request-to-user-turn receipt before native acknowledgement', async () => {
  const externalUrl = 'https://chatgpt.com/c/00000000-0000-0000-0000-000000000099'
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10 },
      'conversation:conv_receipt': { windowId: 10, tabId: 20, url: externalUrl }
    },
    windows: [{ id: 10 }],
    tabs: [{ id: 20, windowId: 10, url: externalUrl }]
  })

  const result = await harness.request('conversation_send', {
    conversationId: 'conv_receipt',
    turnId: 'turn_receipt',
    requestId: 'request-receipt',
    text: 'hello',
    externalUrl
  })

  assert.equal(result.ok, true)
  const receipt = JSON.parse(JSON.stringify(harness.storageState['effect-receipt:request-receipt']))
  assert.deepEqual(receipt, {
    requestId: 'request-receipt',
    conversationId: 'conv_receipt',
    turnId: 'turn_receipt',
    userMessageId: '00000000-0000-4000-8000-000000000001',
    externalUrl
  })
  const lookup = await harness.request('conversation_effect_receipt', { requestId: 'request-receipt' })
  assert.equal(lookup.ok, true)
  assert.deepEqual(JSON.parse(JSON.stringify(lookup.result)), { found: true, receipt })
})

test('conversation_stop persists an effect receipt and duplicate request never clicks Stop twice', async () => {
  const externalUrl = 'https://chatgpt.com/c/00000000-0000-0000-0000-000000000096'
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10 },
      'conversation:conv_stop': { windowId: 10, tabId: 20, url: externalUrl }
    },
    windows: [{ id: 10 }],
    tabs: [{
      id: 20, windowId: 10, url: externalUrl, generating: true,
      userMessageId: 'user-stop', assistantMessageId: null, assistantText: ''
    }]
  })
  assert.equal((await harness.request('writer_epoch_claim', { writerEpoch: 3 })).ok, true)
  const params = {
    conversationId: 'conv_stop',
    turnId: 'turn_stop',
    requestId: 'request-stop',
    externalUrl,
    expectedStateVersion: 9,
    writerEpoch: 3,
    expected: { userMessageId: 'user-stop', assistantMessageId: null },
    authoritativeState: true
  }

  const first = await harness.request('conversation_stop', params)
  assert.equal(first.ok, true)
  assert.equal(first.result.accepted, true)
  assert.equal(harness.sentToTabs.filter(entry => entry.message.type === 'conversation_stop').length, 1)
  const receipt = JSON.parse(JSON.stringify(harness.storageState['effect-receipt:request-stop']))
  assert.deepEqual(receipt, {
    requestId: 'request-stop',
    action: 'stop',
    conversationId: 'conv_stop',
    turnId: 'turn_stop',
    userMessageId: 'user-stop',
    assistantMessageId: null,
    expectedStateVersion: 9,
    expectedWriterEpoch: 3,
    externalUrl
  })

  const duplicate = await harness.request('conversation_stop', params)
  assert.equal(duplicate.ok, true)
  assert.equal(duplicate.result.reconciled, true)
  assert.equal(harness.sentToTabs.filter(entry => entry.message.type === 'conversation_stop').length, 1)

  const conflict = await harness.request('conversation_stop', { ...params, turnId: 'turn-other' })
  assert.equal(conflict.ok, false)
  assert.match(conflict.error, /receipt.*conflict|identity.*conflict/i)
  assert.equal(harness.sentToTabs.filter(entry => entry.message.type === 'conversation_stop').length, 1)
})

const refreshUrl = 'https://chatgpt.com/c/00000000-0000-4000-8000-000000000095'
const refreshParams = {
  requestId: 'request-refresh', conversationId: 'conv_refresh', externalUrl: refreshUrl,
  expectedUserMessageId: 'user-refresh', expectedAssistantMessageId: 'assistant-refresh', writerEpoch: 3
}

function refreshHarness({ storage = {}, tab = {}, ...options } = {}) {
  return makeHarness({
    storage: {
      'writer:authority': { version: 1, epoch: 3 },
      'conversation:conv_refresh': { windowId: 10, tabId: 20, url: refreshUrl },
      ...storage
    },
    windows: [{ id: 10 }],
    tabs: [{
      id: 20, windowId: 10, url: refreshUrl, userMessageId: 'user-refresh',
      assistantMessageId: 'assistant-refresh', generating: false, terminal: false,
      body: 'incomplete', humanGate: false, ...tab
    }],
    ...options
  })
}

test('conversation_refresh reloads only the exact bound inactive tab and persists a replayable receipt', async () => {
  const harness = refreshHarness()

  const response = await harness.request('conversation_refresh', refreshParams)

  assert.equal(response.ok, true)
  assert.equal(response.result.accepted, true)
  assert.equal(response.result.refreshed, true)
  assert.deepEqual(harness.reloadedTabs, [20])
  assert.equal(harness.createdTabs.length, 0)
  assert.equal(harness.createdWindows.length, 0)
  const receipt = harness.storageState['effect-receipt:request-refresh']
  assert.equal(receipt.action, 'refresh')
  assert.equal(receipt.phase, 'applied')
  assert.equal(receipt.userMessageId, refreshParams.expectedUserMessageId)
  assert.equal(receipt.assistantMessageId, refreshParams.expectedAssistantMessageId)
  assert.equal(receipt.externalUrl, refreshUrl)
  assert.equal(receipt.expectedWriterEpoch, 3)

  const duplicate = await harness.request('conversation_refresh', refreshParams)
  assert.equal(duplicate.ok, true)
  assert.equal(duplicate.result.reconciled, true)
  assert.deepEqual(harness.reloadedTabs, [20])

  const restarted = refreshHarness({ storage: structuredClone(harness.storageState) })
  const replay = await restarted.request('conversation_refresh', refreshParams)
  assert.equal(replay.ok, true)
  assert.equal(replay.result.refreshed, true)
  assert.deepEqual(restarted.reloadedTabs, [])
})

test('conversation_refresh concurrent duplicate requests share one effect and reject conflicting targets', async () => {
  const same = refreshHarness()
  const [first, duplicate] = await Promise.all([
    same.request('conversation_refresh', refreshParams),
    same.request('conversation_refresh', refreshParams)
  ])
  assert.equal(first.result?.accepted, true)
  assert.equal(duplicate.result?.accepted, true)
  assert.deepEqual(same.reloadedTabs, [20])

  const otherUrl = 'https://chatgpt.com/c/00000000-0000-4000-8000-000000000094'
  const conflicting = makeHarness({
    storage: {
      'writer:authority': { version: 1, epoch: 3 },
      'conversation:conv_refresh': { windowId: 10, tabId: 20, url: refreshUrl },
      'conversation:conv_other': { windowId: 10, tabId: 21, url: otherUrl }
    },
    windows: [{ id: 10 }],
    tabs: [20, 21].map(id => ({
      id, windowId: 10, url: id === 20 ? refreshUrl : otherUrl,
      userMessageId: 'user-refresh', assistantMessageId: 'assistant-refresh',
      generating: false, terminal: false, body: 'incomplete', humanGate: false
    }))
  })
  const [accepted, denied] = await Promise.all([
    conflicting.request('conversation_refresh', refreshParams),
    conflicting.request('conversation_refresh', { ...refreshParams, conversationId: 'conv_other', externalUrl: otherUrl })
  ])
  assert.equal(accepted.result?.accepted, true)
  assert.equal(denied.ok, false)
  assert.match(denied.error, /identity conflict/)
  assert.deepEqual(conflicting.reloadedTabs, [20])
})

test('conversation_refresh rejects active, human-gated, unreadable, or mismatched fresh DOM evidence', async () => {
  for (const tab of [
    { generating: true, terminal: false },
    { humanGate: true },
    { stateReadable: false },
    { userMessageId: 'other-user' },
    { assistantMessageId: 'other-assistant' },
    { body: 'unknown', terminal: false }
  ]) {
    const harness = refreshHarness({ tab })
    const response = await harness.request('conversation_refresh', refreshParams)
    assert.equal(response.ok, true)
    assert.equal(response.result.accepted, false, JSON.stringify(tab))
    assert.deepEqual(harness.reloadedTabs, [])
    assert.equal(harness.createdTabs.length, 0)
  }
})

test('conversation_refresh rechecks fresh DOM after durable admission and denies a newly active turn', async () => {
  const harness = refreshHarness({ refreshAdmissionTabChanges: { generating: true } })

  const response = await harness.request('conversation_refresh', refreshParams)

  assert.equal(response.ok, true)
  assert.equal(response.result.accepted, false)
  assert.deepEqual(harness.reloadedTabs, [])
  assert.equal(harness.storageState['effect-receipt:request-refresh'].phase, 'denied')
})

test('conversation_refresh never reattaches a missing or changed registered tab', async () => {
  for (const options of [
    { storage: { 'conversation:conv_refresh': { windowId: 10, tabId: 99, url: refreshUrl } } },
    { tab: { url: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000001' } },
    { storage: { 'conversation:conv_refresh': { windowId: 10, tabId: 20, url: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000001' } } }
  ]) {
    const harness = refreshHarness(options)
    const response = await harness.request('conversation_refresh', refreshParams)
    assert.equal(response.ok, true)
    assert.equal(response.result.accepted, false)
    assert.deepEqual(harness.reloadedTabs, [])
    assert.equal(harness.createdTabs.length, 0)
  }
})

test('conversation_refresh binds receipt replay to every caller identity and writer epoch', async () => {
  const harness = refreshHarness()
  assert.equal((await harness.request('conversation_refresh', refreshParams)).ok, true)
  for (const changed of [
    { conversationId: 'other-conversation' },
    { externalUrl: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000002' },
    { expectedUserMessageId: 'other-user' },
    { expectedAssistantMessageId: null },
    { writerEpoch: 2 }
  ]) {
    const response = await harness.request('conversation_refresh', { ...refreshParams, ...changed })
    assert.equal(response.ok, false, JSON.stringify(changed))
  }
  assert.deepEqual(harness.reloadedTabs, [20])
})

test('conversation_refresh preserves unknown reload effects and never retries after restart', async () => {
  const harness = refreshHarness({ reloadTransportFailure: true })
  const first = await harness.request('conversation_refresh', refreshParams)
  assert.equal(first.ok, true)
  assert.equal(first.result.deliveryUncertain, true)
  assert.equal(first.result.refreshed, null)
  assert.deepEqual(harness.reloadedTabs, [20])

  const replay = await harness.request('conversation_refresh', refreshParams)
  assert.equal(replay.ok, true)
  assert.equal(replay.result.deliveryUncertain, true)
  assert.deepEqual(harness.reloadedTabs, [20])

  const restarted = refreshHarness({ storage: structuredClone(harness.storageState) })
  const restored = await restarted.request('conversation_refresh', refreshParams)
  assert.equal(restored.ok, true)
  assert.equal(restored.result.deliveryUncertain, true)
  assert.deepEqual(restarted.reloadedTabs, [])
})

test('conversation_refresh treats an interrupted durable intent as unknown without issuing reload', async () => {
  const harness = refreshHarness({
    storage: { 'effect-receipt:request-refresh': {
      requestId: refreshParams.requestId, action: 'refresh', phase: 'issued',
      conversationId: refreshParams.conversationId, externalUrl: refreshUrl,
      userMessageId: refreshParams.expectedUserMessageId,
      assistantMessageId: refreshParams.expectedAssistantMessageId,
      expectedWriterEpoch: 3, tabId: 20
    } }
  })

  const response = await harness.request('conversation_refresh', refreshParams)

  assert.equal(response.ok, true)
  assert.equal(response.result.deliveryUncertain, true)
  assert.deepEqual(harness.reloadedTabs, [])
})

test('conversation_refresh rejects malformed exact identity and unsafe pre-submit work', async () => {
  for (const changed of [
    { requestId: '' }, { conversationId: '' }, { externalUrl: 'https://chatgpt.com/' },
    { expectedUserMessageId: '' }, { expectedAssistantMessageId: undefined }, { writerEpoch: undefined }
  ]) {
    const harness = refreshHarness()
    const response = await harness.request('conversation_refresh', { ...refreshParams, ...changed })
    assert.equal(response.ok, false, JSON.stringify(changed))
    assert.deepEqual(harness.reloadedTabs, [])
  }
  const harness = refreshHarness({
    storage: { 'pending:conv_refresh': { conversationId: 'conv_refresh', tabId: 20, phase: 'preparing' } }
  })
  const response = await harness.request('conversation_refresh', refreshParams)
  assert.equal(response.ok, true)
  assert.equal(response.result.accepted, false)
  assert.deepEqual(harness.reloadedTabs, [])
})

test('duplicate request identity is deduplicated at the Extension before a second browser mutation', async () => {
  const externalUrl = 'https://chatgpt.com/c/00000000-0000-0000-0000-000000000097'
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10 },
      'conversation:conv_dedupe': { windowId: 10, tabId: 20, url: externalUrl }
    },
    windows: [{ id: 10 }],
    tabs: [{ id: 20, windowId: 10, url: externalUrl }]
  })
  const params = {
    conversationId: 'conv_dedupe',
    turnId: 'turn_dedupe',
    requestId: 'request-dedupe',
    text: 'hello',
    externalUrl
  }

  const first = await harness.request('conversation_send', params)
  assert.equal(first.ok, true)
  const prepareCount = harness.sentToTabs.filter(entry => entry.message.type === 'conversation_prepare').length
  const submitCount = harness.sentToTabs.filter(entry => entry.message.type === 'conversation_submit').length

  const duplicate = await harness.request('conversation_send', params)
  assert.equal(duplicate.ok, true)
  assert.equal(duplicate.result.userMessageId, '00000000-0000-4000-8000-000000000001')
  assert.equal(harness.sentToTabs.filter(entry => entry.message.type === 'conversation_prepare').length, prepareCount)
  assert.equal(harness.sentToTabs.filter(entry => entry.message.type === 'conversation_submit').length, submitCount)

  const conflict = await harness.request('conversation_send', { ...params, turnId: 'turn_other' })
  assert.equal(conflict.ok, false)
  assert.match(conflict.error, /receipt.*conflict|identity.*conflict/i)
  assert.equal(harness.sentToTabs.filter(entry => entry.message.type === 'conversation_submit').length, submitCount)
})

test('lost native acceptance after browser effect keeps receipt and never synthesizes a definite rejection', async () => {
  const externalUrl = 'https://chatgpt.com/c/00000000-0000-0000-0000-000000000098'
  const harness = makeHarness({
    failAcceptedResponsePostOnce: true,
    storage: {
      window0: { windowId: 10 },
      'conversation:conv_ack_lost': { windowId: 10, tabId: 20, url: externalUrl }
    },
    windows: [{ id: 10 }],
    tabs: [{ id: 20, windowId: 10, url: externalUrl }]
  })

  await harness.sendNativeMessage({
    kind: 'request',
    requestId: 'native-ack-lost',
    method: 'conversation_send',
    params: {
      conversationId: 'conv_ack_lost',
      turnId: 'turn_ack_lost',
      requestId: 'effect-ack-lost',
      text: 'hello',
      externalUrl
    }
  })

  assert.equal(harness.storageState['effect-receipt:effect-ack-lost']?.userMessageId, '00000000-0000-4000-8000-000000000001')
  assert.equal(harness.nativeMessages.filter(message => message.requestId === 'native-ack-lost').length, 0)
})

test('pending intent precedes prepare and survives loss of its response', async () => {
  const harness = makeHarness({ prepareTransportFailure: true })
  const result = await harness.request('conversation_send', { conversationId: 'conv_lost', turnId: 'turn_lost', requestId: 'request-lost', text: 'hello' })
  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'DELIVERY_UNCERTAIN')
  const prepare = harness.sentToTabs.find(x => x.message.type === 'conversation_prepare')
  assert.equal(prepare.storageSnapshot['pending:conv_lost'].phase, 'preparing')
  assert.equal(prepare.storageSnapshot['pending:conv_lost'].requestId, 'request-lost')
  assert.equal(harness.storageState['pending:conv_lost'].turnId, 'turn_lost')
  assert.equal(harness.sentToTabs.filter(x => x.message.type === 'conversation_submit').length, 0)
  const retry = await harness.request('conversation_send', { conversationId: 'conv_lost', turnId: 'turn_retry', text: 'again' })
  assert.equal(retry.ok, false)
  assert.equal(harness.sentToTabs.filter(x => x.message.type === 'conversation_prepare').length, 1)
})

test('overlapping browser sends are rejected before touching a busy conversation', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const harness = makeHarness({ prepareGate: gate })
  await harness.sendNativeMessage({ kind: 'request', requestId: 'first', method: 'conversation_send', params: { conversationId: 'conv_busy', turnId: 'turn_first', text: 'first' } })
  const retry = await harness.request('conversation_send', { conversationId: 'conv_busy', turnId: 'turn_retry', text: 'retry' })
  release()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(retry.ok, false)
  assert.equal(harness.createdWindows.length, 1)
  assert.equal(harness.createdTabs.length, 1)
  assert.equal(harness.sentToTabs.filter(x => x.message.type === 'conversation_prepare').length, 1)
})

test('definite pre-submit failure emits durable terminal evidence and releases pending', async () => {
  const harness = makeHarness({ prepareRejected: true })
  const result = await harness.request('conversation_send', { conversationId: 'conv_reject', turnId: 'turn_reject', text: 'hello' })
  assert.equal(result.ok, false)
  assert.equal(result.errorCode, undefined)
  assert.equal(harness.storageState['pending:conv_reject'], undefined)
  const event = harness.storageState['outbox:terminal:conv_reject:turn_reject:error'].event
  assert.equal(event.message, 'editor missing')
  assert.equal(harness.sentToTabs.filter(x => x.message.type === 'conversation_submit').length, 0)
})

test('two local conversation IDs cannot mutate the same active browser tab', async () => {
  let release
  const externalUrl = 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000003'
  const harness = makeHarness({
    prepareGate: new Promise(resolve => { release = resolve }),
    storage: {
      window0: { windowId: 10 },
      'conversation:conv_one': { windowId: 10, tabId: 20, url: externalUrl },
      'conversation:conv_two': { windowId: 10, tabId: 20, url: externalUrl }
    },
    windows: [{ id: 10 }], tabs: [{ id: 20, windowId: 10, url: externalUrl }]
  })
  await harness.sendNativeMessage({ kind: 'request', requestId: 'owner', method: 'conversation_send', params: { conversationId: 'conv_one', turnId: 'turn_one', text: 'first', externalUrl } })
  const status = await harness.request('extension_status', {})
  assert.equal(status.result.operations[0].phase, 'preparing')
  const result = await harness.request('conversation_send', { conversationId: 'conv_two', turnId: 'turn_two', text: 'second', externalUrl })
  release()
  assert.equal(result.ok, false)
  assert.equal(harness.sentToTabs.filter(x => x.message.type === 'conversation_prepare').length, 1)
})

test('a late prepare receipt closes the unsubmitted turn after timeout', async (t) => {
  let release
  const harness = makeHarness({ expirePrepare: true, prepareGate: new Promise(resolve => { release = resolve }) })
  t.after(() => release())
  const result = await harness.request('conversation_send', { conversationId: 'conv_late_prepare', turnId: 'turn_late', text: 'hello' })
  assert.equal(result.errorCode, 'DELIVERY_UNCERTAIN')
  assert.ok(harness.storageState['pending:conv_late_prepare'])
  release()
  for (let attempt = 0; attempt < 40 && harness.storageState['pending:conv_late_prepare']; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.equal(harness.storageState['pending:conv_late_prepare'], undefined)
  assert.equal(harness.sentToTabs.filter(x => x.message.type === 'conversation_submit').length, 0)
  assert.equal(harness.storageState['outbox:terminal:conv_late_prepare:turn_late:error'].event.turnId, 'turn_late')
})

test('project_find scans existing ChatGPT tabs and returns a canonical matching Project URL without creating browser state', async () => {
  const projectUrl = 'https://chatgpt.com/g/g-p-subagents-test/project'
  const harness = makeHarness({
    windows: [{ id: 10 }, { id: 11 }],
    tabs: [
      { id: 20, windowId: 10, url: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000002', projectName: 'agent', projectUrl: 'https://chatgpt.com/g/g-p-agent-test/project' },
      { id: 21, windowId: 11, url: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000004', projectName: 'subagents', projectUrl }
    ]
  })

  const response = await harness.request('project_find', { name: 'subagents' })

  assert.equal(response.ok, true)
  assert.equal(response.result.found, true)
  assert.equal(response.result.name, 'subagents')
  assert.equal(response.result.projectUrl, projectUrl)
  assert.equal(harness.createdTabs.length, 0)
  assert.equal(harness.createdWindows.length, 0)
})

test('conversation_create rejects a legacy bare window0 and creates a new owned automation window', async () => {
  const projectUrl = 'https://chatgpt.com/g/g-p-isolated-test/project'
  const harness = makeHarness({
    storage: { window0: { windowId: 10 } },
    windows: [{ id: 10, focused: true, state: 'normal' }],
    tabs: [{ id: 20, windowId: 10, url: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000005', active: true }]
  })

  const response = await harness.request('conversation_create', {
    conversationId: 'conv_isolated',
    url: projectUrl
  })

  assert.equal(response.ok, true)
  assert.equal(harness.createdWindows.length, 1)
  assert.equal(harness.createdWindows[0].focused, false)
  assert.equal(harness.createdWindows[0].state, 'minimized')
  assert.equal(
    harness.createdWindows[0].tabs[0].url,
    'chrome-extension://cfifihieaffhniimpimnfmignbbdaalb/automation-window.html'
  )
  assert.equal(harness.createdTabs.length, 1)
  assert.equal(harness.createdTabs[0].windowId, harness.createdWindows[0].id)
  assert.notEqual(harness.createdTabs[0].windowId, 10)
  assert.equal(harness.createdTabs[0].active, true)
  assert.equal(harness.storageState.window0.windowId, harness.createdWindows[0].id)
  assert.equal(harness.storageState.window0.sentinelTabId, harness.createdWindows[0].tabs[0].id)
})

test('conversation_create reuses only a window0 with a valid Sidecar sentinel', async () => {
  const projectUrl = 'https://chatgpt.com/g/g-p-owned-test/project'
  const sentinelUrl = 'chrome-extension://cfifihieaffhniimpimnfmignbbdaalb/automation-window.html'
  const harness = makeHarness({
    storage: { window0: { windowId: 10, sentinelTabId: 19 } },
    windows: [{ id: 10, focused: false, state: 'minimized' }],
    tabs: [{ id: 19, windowId: 10, url: sentinelUrl, active: true }]
  })

  const response = await harness.request('conversation_create', {
    conversationId: 'conv_owned',
    url: projectUrl
  })

  assert.equal(response.ok, true)
  assert.equal(harness.createdWindows.length, 0)
  assert.equal(harness.createdTabs.length, 1)
  assert.equal(harness.createdTabs[0].windowId, 10)
  assert.equal(harness.createdTabs[0].active, true)
  assert.equal(harness.storageState.window0.windowId, 10)
  assert.equal(harness.storageState.window0.sentinelTabId, 19)
})

test('project_create opens one root tab in window0 and returns its canonical Project URL', async () => {
  const harness = makeHarness({
    storage: { window0: { windowId: 10, sentinelTabId: 19 } },
    windows: [{ id: 10 }],
    tabs: [{ id: 19, windowId: 10, url: 'chrome-extension://cfifihieaffhniimpimnfmignbbdaalb/automation-window.html', active: true }]
  })

  const response = await harness.request('project_create', { name: 'subagents' })

  assert.equal(response.ok, true)
  assert.equal(response.result.name, 'subagents')
  assert.equal(response.result.projectUrl, 'https://chatgpt.com/g/g-p-created-test/project')
  assert.equal(response.result.windowId, 10)
  assert.equal(harness.createdWindows.length, 0)
  assert.equal(harness.createdTabs.length, 1)
  assert.equal(harness.createdTabs[0].url, 'https://chatgpt.com/')
  assert.equal(
    harness.sentToTabs.some(({ message }) => message.type === 'project_create' && message.name === 'subagents'),
    true
  )
})

test('conversation_create prefers an existing same-Project conversation as the healthy bootstrap seed', async () => {
  const projectUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946-subagents/project'
  const seedThreadUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946/c/10000000-0000-4000-8000-000000000006'
  const harness = makeHarness({
    storage: { window0: { windowId: 10, sentinelTabId: 19 } },
    windows: [{ id: 10 }],
    tabs: [
      { id: 19, windowId: 10, url: 'chrome-extension://cfifihieaffhniimpimnfmignbbdaalb/automation-window.html', active: true },
      { id: 20, windowId: 10, url: seedThreadUrl }
    ]
  })

  const response = await harness.request('conversation_create', {
    conversationId: 'conv_project_from_seed',
    url: projectUrl
  })

  assert.equal(response.ok, true)
  assert.equal(harness.createdTabs.length, 1)
  assert.equal(harness.createdTabs[0].url, seedThreadUrl)
  assert.equal(harness.createdTabs[0].active, true)
  assert.equal(
    harness.sentToTabs.some(({ tabId, message }) => tabId === harness.createdTabs[0].id && message.type === 'project_open'),
    true
  )
  assert.equal(response.result.url, projectUrl)
})

test('conversation_create is idempotent for the same logical conversation attachment', async () => {
  const projectUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946-subagents/project'
  const seedThreadUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946/c/10000000-0000-4000-8000-000000000006'
  const harness = makeHarness({
    storage: { window0: { windowId: 10, sentinelTabId: 19 } },
    windows: [{ id: 10 }],
    tabs: [
      { id: 19, windowId: 10, url: 'chrome-extension://cfifihieaffhniimpimnfmignbbdaalb/automation-window.html', active: true },
      { id: 20, windowId: 10, url: seedThreadUrl }
    ]
  })
  const request = { conversationId: 'conv_idempotent_create', url: projectUrl }

  const first = await harness.request('conversation_create', request)
  assert.equal(first.ok, true)
  const createdAfterFirst = harness.createdTabs.length
  const second = await harness.request('conversation_create', request)

  assert.equal(second.ok, true)
  assert.equal(second.result.tabId, first.result.tabId)
  assert.equal(second.result.windowId, first.result.windowId)
  assert.equal(second.result.url, first.result.url)
  assert.equal(harness.createdTabs.length, createdAfterFirst)
})

test('conversation_create replay rehomes a legacy human-window binding into the owned automation window', async () => {
  const externalUrl = 'https://chatgpt.com/g/g-p-rehome-test/c/10000000-0000-4000-8000-000000000006'
  const sentinelUrl = 'chrome-extension://cfifihieaffhniimpimnfmignbbdaalb/automation-window.html'
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10, sentinelTabId: 19 },
      'conversation:conv_replay_rehome': { windowId: 11, tabId: 30, url: externalUrl }
    },
    windows: [{ id: 10 }, { id: 11, focused: true }],
    tabs: [
      { id: 19, windowId: 10, url: sentinelUrl, active: true },
      { id: 30, windowId: 11, url: externalUrl, active: true }
    ]
  })

  const response = await harness.request('conversation_create', {
    conversationId: 'conv_replay_rehome',
    url: 'https://chatgpt.com/g/g-p-rehome-test/project'
  })

  assert.equal(response.ok, true)
  assert.equal(harness.createdTabs.length, 1)
  assert.equal(harness.createdTabs[0].windowId, 10)
  assert.equal(harness.createdTabs[0].url, externalUrl)
  assert.equal(response.result.windowId, 10)
  assert.equal(response.result.tabId, harness.createdTabs[0].id)
})

test('conversation_create replay reopens its materialized exact thread instead of allocating a new Project draft', async () => {
  const projectUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946-subagents/project'
  const threadUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946-subagents/c/10000000-0000-4000-8000-000000000007'
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10 },
      'conversation:conv_materialized_replay': { windowId: 10, tabId: 999, url: threadUrl }
    },
    windows: [{ id: 10 }]
  })

  const response = await harness.request('conversation_create', {
    conversationId: 'conv_materialized_replay',
    url: projectUrl
  })

  assert.equal(response.ok, true)
  assert.equal(response.result.url, threadUrl)
  assert.equal(harness.createdTabs.length, 1)
  assert.equal(harness.createdTabs[0].url, threadUrl)
  assert.equal(
    harness.sentToTabs.some(({ message }) => message.type === 'project_open'),
    false
  )
})

test('conversation_create reuses a persisted same-Project conversation when no matching tab is live', async () => {
  const projectUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946-subagents/project'
  const seedThreadUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946-subagents/c/10000000-0000-4000-8000-000000000008'
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10 },
      'conversation:conv_old': { windowId: 10, tabId: 999, url: seedThreadUrl }
    },
    windows: [{ id: 10 }],
    projectOpenRejectOnRoot: true
  })

  const response = await harness.request('conversation_create', {
    conversationId: 'conv_project_from_persisted_seed',
    url: projectUrl
  })

  assert.equal(response.ok, true)
  assert.equal(harness.createdTabs.length, 1)
  assert.equal(harness.createdTabs[0].url, seedThreadUrl)
  assert.equal(response.result.url, projectUrl)
})

test('conversation_create accepts Project navigation when the message channel closes after link click', async () => {
  const projectUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946-subagents/project'
  const seedThreadUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946-subagents/c/10000000-0000-4000-8000-000000000006'
  const harness = makeHarness({
    storage: { window0: { windowId: 10 } },
    windows: [{ id: 10 }],
    tabs: [{ id: 20, windowId: 10, url: seedThreadUrl }],
    projectOpenChannelClosesAfterNavigation: true
  })

  const response = await harness.request('conversation_create', {
    conversationId: 'conv_project_navigation_race',
    url: projectUrl
  })

  assert.equal(response.ok, true)
  assert.equal(response.result.url, projectUrl)
})

function capturedProjectComposerPing(tab) {
  let listener
  const form = { tagName: 'FORM', attrs: {}, parentElement: null }
  const body = { tagName: 'DIV', attrs: { 'data-composer-body': '' }, parentElement: form }
  const input = { tagName: 'DIV', attrs: { 'data-composer-input': '' }, parentElement: body }
  const editor = { tagName: 'DIV', attrs: { id: '', contenteditable: 'true', role: 'textbox', 'aria-label': '在“subagents”中新建聊天' }, parentElement: input }
  for (const node of [form, body, input, editor]) {
    node.getAttribute = name => Object.hasOwn(node.attrs, name) ? node.attrs[name] : null
    node.getClientRects = () => [{ width: 500, height: 24 }]
    node.closest = selector => {
      for (let current = node; current; current = current.parentElement) {
        if (selector === 'form' && current.tagName === 'FORM') return current
        if (/^\[[a-z-]+\]$/.test(selector) && current.getAttribute(selector.slice(1, -1)) !== null) return current
      }
      return null
    }
  }
  const document = { title: 'subagents', querySelector() { return null },
    querySelectorAll(selector) { return selector === '[contenteditable="true"]' ? [editor] : [] } }
  const context = vm.createContext({ document, location: { href: tab.url }, __sidecarBuildId: 'a'.repeat(64),
    getComputedStyle() { return { display: 'block', visibility: 'visible', opacity: '1' } },
    chrome: { runtime: { sendMessage: async () => null, onMessage: { addListener(fn) { listener = fn }, removeListener() {} } } },
    HTMLTextAreaElement: class {}, HTMLInputElement: class {}, InputEvent: class {}, console, setTimeout, clearTimeout })
  vm.runInContext(contentSource, context)
  let response
  listener({ type: 'sidecar_ping' }, {}, value => { response = value })
  return response
}

test('native Project creation consumes actual content VM composer readiness for the captured Chinese structural DIV', async () => {
  const projectUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946-subagents/project'
  const captured = capturedProjectComposerPing({ url: projectUrl })
  const harness = makeHarness({ fastProjectDraftClock: true, contentPingProvider: capturedProjectComposerPing })
  const created = await harness.request('conversation_create', { conversationId: 'conv_structural_composer', url: projectUrl })
  assert.equal(created.ok, true)
  assert.equal(captured.composerPresent, true)
  assert.equal(created.result.url, projectUrl)
  assert.equal(harness.reloadedTabs.length, 0)
  assert.equal(harness.createdTabs.length, 1)
  assert.equal(harness.sentToTabs.filter(({ message }) => message.type === 'project_open').length, 1)
})

test('conversation_create recovers one missing Project draft listener by exact-tab read-only reinjection', async () => {
  const projectUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946-subagents/project'
  const harness = makeHarness({ fastProjectDraftClock: true, projectOpenInvalidatesContent: true })
  const response = await harness.request('conversation_create', { conversationId: 'conv_project_reinject', url: projectUrl })
  assert.equal(response.ok, true)
  assert.equal(response.result.url, projectUrl)
  assert.equal(harness.createdTabs.length, 1)
  assert.equal(harness.reloadedTabs.length, 0)
  assert.equal(harness.sentToTabs.filter(({ message }) => message.type === 'project_open').length, 1)
  assert.equal(harness.scriptingCalls.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(harness.scriptingCalls[0])), {
    target: { tabId: harness.createdTabs[0].id, frameIds: [0] }, files: ['build-info.js', 'content-script.js']
  })
})

test('Project listener recovery is bounded once and denies changed target or stale fresh evidence without further effects', async () => {
  for (const options of [
    { onMissingContentPing(tab) { tab.url = 'https://chatgpt.com/g/g-p-other/project' } },
    { onContentScriptInjection(tab) { tab.url = 'https://chatgpt.com/g/g-p-other/project' } },
    { onContentScriptInjection(tab) { tab.pingBuildId = 'old-build' } },
    { onContentScriptInjection(tab) { tab.pingUrl = 'https://chatgpt.com/g/g-p-other/project' } },
    { onContentScriptInjection(tab) { tab.pingReady = false } },
    { onContentScriptInjection(tab) { tab.composerPresent = false } },
    { onContentScriptInjection(tab, stale) { stale.add(tab.id) } }
  ]) {
    const harness = makeHarness({ fastProjectDraftClock: true, projectOpenInvalidatesContent: true, ...options })
    const response = await harness.request('conversation_create', { conversationId: 'conv_project_reinject_deny',
      url: 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946-subagents/project' })
    assert.equal(response.ok, false)
    assert.equal(harness.storageState['conversation:conv_project_reinject_deny'], undefined)
    assert.equal(harness.createdTabs.length, 1)
    assert.equal(harness.reloadedTabs.length, 0)
    assert.equal(harness.sentToTabs.filter(({ message }) => message.type === 'project_open').length, 1)
    assert.ok(harness.scriptingCalls.length <= 1)
    assert.equal(harness.scriptingCalls.some(call => call.target.tabId !== harness.createdTabs[0].id), false)
  }
})

test('conversation_create reloads an incomplete Project draft surface once', async () => {
  const projectUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946-subagents/project'
  const seedThreadUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946-subagents/c/10000000-0000-4000-8000-000000000006'
  const harness = makeHarness({
    storage: { window0: { windowId: 10 } },
    windows: [{ id: 10 }],
    tabs: [{ id: 20, windowId: 10, url: seedThreadUrl }],
    projectDraftRequiresReload: true
  })

  const response = await harness.request('conversation_create', {
    conversationId: 'conv_project_reload',
    url: projectUrl
  })

  assert.equal(response.ok, true)
  assert.equal(response.result.url, projectUrl)
  assert.deepEqual(harness.reloadedTabs, [harness.createdTabs[0].id])
})

const persistentSendUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946-subagents/c/6abfe3a7-9f60-83e8-880b-58a25b1901f9'
const provisionalSendUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946-subagents/c/local-chatgpt%3A7611e69c-88dd-4b54-99ab-56258c3c6643'
const sendDraftUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946-subagents/project'

function persistentSendHarness(options = {}) {
  return makeHarness({
    storage: { 'conversation:conv_persistent_send': { windowId: 10, tabId: 20, url: sendDraftUrl } },
    windows: [{ id: 10 }],
    tabs: [{ id: 20, windowId: 10, url: sendDraftUrl }],
    fastConversationUrlClock: true,
    ...options
  })
}

const persistentSendParams = {
  conversationId: 'conv_persistent_send', turnId: 'turn_persistent_send',
  requestId: 'request-persistent-send', text: 'seed once', externalUrl: sendDraftUrl, existingOnly: true
}

test('send binds receipt only after committed persistent UUID URL replaces the optimistic local thread', async () => {
  let observations = 0
  const harness = persistentSendHarness({
    submitNavigatesTo: provisionalSendUrl,
    submitPendingUrl: persistentSendUrl,
    onSubmittedTabGet(tab, storage) {
      observations += 1
      assert.equal(storage['effect-receipt:request-persistent-send'], undefined)
      assert.equal(storage['conversation:conv_persistent_send'].url, sendDraftUrl)
      if (observations >= 2) {
        tab.url = persistentSendUrl
        delete tab.pendingUrl
      }
    }
  })
  const response = await harness.request('conversation_send', persistentSendParams)
  assert.equal(response.ok, true)
  assert.equal(observations, 3)
  assert.equal(response.result.url, persistentSendUrl)
  assert.equal(harness.storageState['effect-receipt:request-persistent-send'].externalUrl, persistentSendUrl)
  assert.equal(harness.storageState['conversation:conv_persistent_send'].url, persistentSendUrl)
  assert.equal(harness.sentToTabs.filter(item => item.message.type === 'conversation_submit').length, 1)
  assert.equal(harness.sentToTabs.filter(item => item.message.type === 'conversation_monitor_start').length, 1)
})

test('send without a committed persistent URL stays uncertain with pending state and no receipt or monitor', async () => {
  for (const unresolvedUrl of [sendDraftUrl, provisionalSendUrl, provisionalSendUrl.replace('%3A', ':'), persistentSendUrl + '/unexpected']) {
    const harness = persistentSendHarness({
      submitNavigatesTo: unresolvedUrl,
      submitPendingUrl: persistentSendUrl
    })
    const response = await harness.request('conversation_send', persistentSendParams)
    assert.equal(response.ok, false, unresolvedUrl)
    assert.equal(response.errorCode, 'DELIVERY_UNCERTAIN', unresolvedUrl)
    assert.equal(harness.storageState['pending:conv_persistent_send'].phase, 'submitting')
    assert.equal(harness.storageState['conversation:conv_persistent_send'].url, sendDraftUrl)
    assert.equal(harness.storageState['effect-receipt:request-persistent-send'], undefined)
    assert.equal(harness.sentToTabs.filter(item => item.message.type === 'conversation_monitor_start').length, 0)
    assert.equal(Object.keys(harness.storageState).some(key => key.startsWith('outbox:')), false)
    const duplicate = await harness.request('conversation_send', persistentSendParams)
    assert.equal(duplicate.errorCode, 'DELIVERY_UNCERTAIN')
    assert.equal(harness.sentToTabs.filter(item => item.message.type === 'conversation_submit').length, 1)
  }
})

test('send preserves both prior and acknowledged persistent UUIDs despite a matching user on another thread', async () => {
  const otherUrl = persistentSendUrl.replace('1901f9', '1901f8')
  for (const { prior, acknowledged, committed } of [
    { prior: sendDraftUrl, acknowledged: persistentSendUrl, committed: otherUrl },
    { prior: persistentSendUrl, acknowledged: otherUrl, committed: persistentSendUrl },
    { prior: persistentSendUrl, acknowledged: persistentSendUrl, committed: otherUrl }
  ]) {
    const harness = persistentSendHarness({
      storage: { 'conversation:conv_persistent_send': { windowId: 10, tabId: 20, url: prior } },
      tabs: [{ id: 20, windowId: 10, url: prior }],
      submitResponseUrl: acknowledged,
      submitNavigatesTo: committed
    })
    const response = await harness.request('conversation_send', { ...persistentSendParams, externalUrl: prior })
    assert.equal(response.ok, false, JSON.stringify({ prior, acknowledged, committed }))
    assert.equal(response.errorCode, 'DELIVERY_UNCERTAIN')
    assert.equal(harness.storageState['pending:conv_persistent_send'].phase, 'submitting')
    assert.equal(harness.storageState['effect-receipt:request-persistent-send'], undefined)
    assert.equal(harness.storageState['conversation:conv_persistent_send'].url, prior)
    assert.equal(harness.sentToTabs.filter(item => item.message.type === 'conversation_monitor_start').length, 0)
    assert.equal(harness.sentToTabs.filter(item => item.message.type === 'conversation_submit').length, 1)
  }
})

test('first persistent ACK UUID can bind its matching committed thread after fresh user proof', async () => {
  const harness = persistentSendHarness({ submitResponseUrl: persistentSendUrl, submitNavigatesTo: persistentSendUrl })
  const response = await harness.request('conversation_send', persistentSendParams)
  assert.equal(response.ok, true)
  assert.equal(response.result.url, persistentSendUrl)
  assert.equal(harness.storageState['effect-receipt:request-persistent-send'].externalUrl, persistentSendUrl)
  assert.equal(harness.storageState['pending:conv_persistent_send'].phase, 'submitted')
})

test('new-thread receipt requires the acknowledged user UUID on the committed thread', async () => {
  for (const mismatch of ['missing-user', 'wrong-observer-url', 'tab-changed-after-observation']) {
    const harness = persistentSendHarness({
      submitNavigatesTo: persistentSendUrl,
      onSubmittedTabGet(tab) {
        if (mismatch === 'missing-user') tab.userMessageId = '00000000-0000-4000-8000-000000000099'
        if (mismatch === 'wrong-observer-url') tab.stateObservedUrl = persistentSendUrl.replace('1901f9', '1901f8')
      },
      onStateObservation() {
        if (mismatch === 'tab-changed-after-observation') void harness.updateTab(20, { url: persistentSendUrl.replace('1901f9', '1901f8') })
      }
    })
    const response = await harness.request('conversation_send', persistentSendParams)
    assert.equal(response.ok, false, mismatch)
    assert.equal(response.errorCode, 'DELIVERY_UNCERTAIN')
    assert.equal(harness.storageState['pending:conv_persistent_send'].phase, 'submitting')
    assert.equal(harness.storageState['effect-receipt:request-persistent-send'], undefined)
    assert.equal(harness.storageState['conversation:conv_persistent_send'].url, sendDraftUrl)
    assert.equal(harness.sentToTabs.filter(item => item.message.type === 'conversation_monitor_start').length, 0)
  }
})

test('submit acknowledgement without a persistent message UUID creates no delivered receipt or monitor', async () => {
  for (const submitUserMessageId of ['', 'local-user:7611e69c-88dd-4b54-99ab-56258c3c6643', 'user-turn-unknown']) {
    const harness = persistentSendHarness({ submitNavigatesTo: persistentSendUrl, submitUserMessageId })
    const response = await harness.request('conversation_send', persistentSendParams)
    assert.equal(response.ok, false, submitUserMessageId)
    assert.equal(response.errorCode, 'DELIVERY_UNCERTAIN')
    assert.equal(harness.storageState['pending:conv_persistent_send'].phase, 'submitting')
    assert.equal(harness.storageState['effect-receipt:request-persistent-send'], undefined)
    assert.equal(harness.sentToTabs.filter(item => item.message.type === 'conversation_monitor_start').length, 0)
  }
})

test('a committed UUID alone cannot recover a submitting turn before its submission proof', async () => {
  const pending = { conversationId: 'conv_persistent_send', turnId: 'turn_persistent_send', tabId: 20, phase: 'submitting', monitorVersion: 1 }
  const harness = makeHarness({
    storage: {
      'conversation:conv_persistent_send': { windowId: 10, tabId: 20, url: sendDraftUrl },
      'pending:conv_persistent_send': pending
    },
    tabs: [{ id: 20, windowId: 10, url: persistentSendUrl }]
  })
  const claimed = await harness.emitRuntimeMessage({ kind: 'pending_turn_lookup' }, { tab: { id: 20, url: persistentSendUrl } })
  assert.equal(claimed, null)
  await harness.updateTab(20, { url: persistentSendUrl })
  assert.equal(harness.storageState['conversation:conv_persistent_send'].url, sendDraftUrl)
  assert.deepEqual(harness.storageState['pending:conv_persistent_send'], pending)
  assert.equal(harness.sentToTabs.filter(item => item.message.type === 'conversation_monitor_start').length, 0)
})

test('same-tab pending recovery rejects provisional and changed persistent conversation UUIDs', async () => {
  const changedUrl = persistentSendUrl.replace('6abfe3a7-9f60-83e8-880b-58a25b1901f9', '6abfe3a7-9f60-83e8-880b-58a25b1901f8')
  for (const observedUrl of [provisionalSendUrl, changedUrl]) {
    const pending = { conversationId: 'conv_persistent_send', turnId: 'turn_persistent_send', tabId: 20, phase: 'submitting', monitorVersion: 1 }
    const harness = makeHarness({
      storage: {
        'conversation:conv_persistent_send': { windowId: 10, tabId: 20, url: persistentSendUrl },
        'pending:conv_persistent_send': pending
      },
      tabs: [{ id: 20, windowId: 10, url: observedUrl, pendingUrl: persistentSendUrl }]
    })
    const claimed = await harness.emitRuntimeMessage({ kind: 'pending_turn_lookup' }, { tab: { id: 20, url: observedUrl, pendingUrl: persistentSendUrl } })
    assert.equal(claimed, null, observedUrl)
    assert.deepEqual(harness.storageState['pending:conv_persistent_send'], pending)
    assert.equal(harness.storageState['conversation:conv_persistent_send'].url, persistentSendUrl)
    await harness.updateTab(20, { url: observedUrl })
    assert.equal(harness.sentToTabs.filter(item => item.message.type === 'conversation_monitor_start').length, 0)
  }
})

test('conversation_send captures the stable conversation URL after Project submit navigation', async () => {
  const projectUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946-subagents/project'
  const threadUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946-subagents/c/10000000-0000-4000-8000-000000000009'
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10 },
      'conversation:conv_project_nav': { windowId: 10, tabId: 20, url: projectUrl }
    },
    windows: [{ id: 10 }],
    tabs: [{ id: 20, windowId: 10, url: projectUrl }],
    submitNavigatesTo: threadUrl
  })

  const response = await harness.request('conversation_send', {
    conversationId: 'conv_project_nav',
    turnId: 'turn_project_nav',
    text: 'readonly watchdog acceptance task',
    externalUrl: projectUrl
  })

  assert.equal(response.ok, true)
  assert.equal(response.result.url, threadUrl)
  assert.equal(harness.storageState['conversation:conv_project_nav'].url, threadUrl)
})

test('send forwards a per-message app selection to the content-script prepare step', async () => {
  const externalUrl = 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000010'
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10, sentinelTabId: 19 },
      'conversation:conv_app': { windowId: 10, tabId: 20, url: externalUrl }
    },
    windows: [{ id: 10 }],
    tabs: [
      { id: 19, windowId: 10, url: 'chrome-extension://cfifihieaffhniimpimnfmignbbdaalb/automation-window.html', active: true },
      { id: 20, windowId: 10, url: externalUrl }
    ]
  })

  const response = await harness.request('conversation_send', {
    conversationId: 'conv_app',
    turnId: 'turn_app',
    text: 'use devspace',
    app: 'DevSpace',
    externalUrl
  })

  assert.equal(response.ok, true)
  const prepared = harness.sentToTabs.find(({ tabId, message }) =>
    tabId === 20 && message.type === 'conversation_prepare'
  )
  assert.equal(prepared?.message.app, 'DevSpace')
})

test('send forwards authoritative state ownership to prepare and submit without changing legacy default', async () => {
  const externalUrl = 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000011'
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10 },
      'conversation:conv_authoritative': { windowId: 10, tabId: 20, url: externalUrl }
    },
    windows: [{ id: 10 }],
    tabs: [{ id: 20, windowId: 10, url: externalUrl }]
  })

  const response = await harness.request('conversation_send', {
    conversationId: 'conv_authoritative',
    turnId: 'turn_authoritative',
    text: 'continue',
    expected: { userMessageId: 'u1', assistantMessageId: 'a1' },
    authoritativeState: true,
    externalUrl
  })

  assert.equal(response.ok, true)
  const prepare = harness.sentToTabs.find(({ message }) => message.type === 'conversation_prepare')
  const submit = harness.sentToTabs.find(({ message }) => message.type === 'conversation_submit')
  assert.equal(prepare?.message.authoritativeState, true)
  assert.equal(submit?.message.authoritativeState, true)
})

test('managed writer command fails closed when Extension authority is missing while untouched legacy remains compatible', async () => {
  const externalUrl = 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000012'
  const make = conversationId => makeHarness({
    storage: {
      window0: { windowId: 10 },
      [`conversation:${conversationId}`]: { windowId: 10, tabId: 20, url: externalUrl }
    },
    windows: [{ id: 10 }],
    tabs: [{ id: 20, windowId: 10, url: externalUrl }]
  })

  const managed = make('conv_managed_missing')
  const denied = await managed.request('conversation_send', {
    conversationId: 'conv_managed_missing', turnId: 'turn_managed_missing', text: 'must not send',
    writerEpoch: 2, externalUrl
  })
  assert.equal(denied.ok, false)
  assert.match(denied.error, /writer authority|writer epoch/i)
  assert.equal(managed.sentToTabs.some(({ message }) => message.type === 'conversation_prepare'), false)

  const legacy = make('conv_legacy_unclaimed')
  const accepted = await legacy.request('conversation_send', {
    conversationId: 'conv_legacy_unclaimed', turnId: 'turn_legacy_unclaimed', text: 'legacy send', externalUrl
  })
  assert.equal(accepted.ok, true)
  assert.equal(legacy.sentToTabs.filter(({ message }) => message.type === 'conversation_prepare').length, 1)
})

test('writer epoch claim fences stale browser commands at the Extension sink', async () => {
  const externalUrl = 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000013'
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10 },
      'conversation:conv_epoch': { windowId: 10, tabId: 20, url: externalUrl }
    },
    windows: [{ id: 10 }],
    tabs: [{ id: 20, windowId: 10, url: externalUrl }]
  })

  const claimed = await harness.request('writer_epoch_claim', { writerEpoch: 2 })
  assert.equal(claimed.ok, true)
  assert.equal(JSON.stringify(harness.storageState['writer:authority']), JSON.stringify({ version: 1, epoch: 2 }))
  assert.equal((await harness.request('extension_status', {})).result.writerEpoch, 2)

  const stale = await harness.request('conversation_send', {
    conversationId: 'conv_epoch', turnId: 'turn_stale', text: 'must not send',
    writerEpoch: 1, externalUrl
  })
  assert.equal(stale.ok, false)
  assert.match(stale.error, /writer epoch/i)
  assert.equal(harness.sentToTabs.some(({ message }) => message.type === 'conversation_prepare'), false)

  const legacyAfterClaim = await harness.request('conversation_send', {
    conversationId: 'conv_epoch', turnId: 'turn_legacy_after_claim', text: 'legacy must not share managed authority',
    externalUrl
  })
  assert.equal(legacyAfterClaim.ok, false)
  assert.match(legacyAfterClaim.error, /writer epoch/i)
  assert.equal(harness.sentToTabs.some(({ message }) => message.type === 'conversation_prepare'), false)

  const fresh = await harness.request('conversation_send', {
    conversationId: 'conv_epoch', turnId: 'turn_fresh', text: 'send once',
    writerEpoch: 2, externalUrl
  })
  assert.equal(fresh.ok, true)
  assert.equal(harness.sentToTabs.filter(({ message }) => message.type === 'conversation_prepare').length, 1)
})

test('writer epoch claim is serialized behind an older in-flight writer command', async () => {
  let releasePrepare
  const prepareGate = new Promise(resolve => { releasePrepare = resolve })
  const externalUrl = 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000014'
  const harness = makeHarness({
    prepareGate,
    storage: {
      window0: { windowId: 10 },
      'conversation:conv_epoch_order': { windowId: 10, tabId: 20, url: externalUrl }
    },
    windows: [{ id: 10 }],
    tabs: [{ id: 20, windowId: 10, url: externalUrl }]
  })

  assert.equal((await harness.request('writer_epoch_claim', { writerEpoch: 1 })).ok, true)

  const sendPromise = harness.request('conversation_send', {
    conversationId: 'conv_epoch_order', turnId: 'turn_old', text: 'old command',
    writerEpoch: 1, externalUrl
  })
  for (let attempt = 0; attempt < 8 && !harness.sentToTabs.some(({ message }) => message.type === 'conversation_prepare'); attempt += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.equal(harness.sentToTabs.some(({ message }) => message.type === 'conversation_prepare'), true)

  let claimResolved = false
  const claimPromise = harness.request('writer_epoch_claim', { writerEpoch: 2 }).then(result => {
    claimResolved = true
    return result
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(claimResolved, false)

  releasePrepare()
  assert.equal((await sendPromise).ok, true)
  assert.equal((await claimPromise).ok, true)
  assert.equal(harness.storageState['writer:authority'].epoch, 2)

  const stale = await harness.request('conversation_send', {
    conversationId: 'conv_epoch_order', turnId: 'turn_late_old', text: 'late old command',
    writerEpoch: 1, externalUrl
  })
  assert.equal(stale.ok, false)
})

const writerRegistration = '20000000-0000-4000-8000-000000000095'

test('writer_quiesce waits for a content-script promise after caller timeout and blocks queued mutations', async t => {
  let releasePrepare
  const prepareGate = new Promise(resolve => { releasePrepare = resolve })
  t.after(() => releasePrepare())
  const externalUrl = 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000015'
  const harness = makeHarness({
    prepareGate, expirePrepare: true,
    storage: {
      'writer:authority': { version: 1, epoch: 3 },
      'conversation:conv_quiesce': { windowId: 10, tabId: 20, url: externalUrl }
    },
    windows: [{ id: 10 }],
    tabs: [{ id: 20, windowId: 10, url: externalUrl }]
  })
  const failed = await harness.request('conversation_send', {
    conversationId: 'conv_quiesce', turnId: 'turn_timeout', requestId: 'send-timeout',
    text: 'held effect', externalUrl, writerEpoch: 3, registrationId: writerRegistration
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.errorCode, 'DELIVERY_UNCERTAIN')
  assert.equal(harness.sentToTabs.some(({ message }) => message.type === 'conversation_prepare'), true)

  await harness.sendNativeMessage({ kind: 'request', requestId: 'quiesce-held', method: 'writer_quiesce', params: { writerEpoch: 3, registrationId: writerRegistration } })
  await harness.sendNativeMessage({ kind: 'request', requestId: 'shift-queued', method: 'webgpt_shift_test', params: { target: 'Medium', target_tab_id: 20, writerEpoch: 3 } })
  assert.equal(harness.nativeMessages.some(message => message.kind === 'response' && message.requestId === 'quiesce-held'), false)
  assert.equal(harness.storageState['writer:revoked-registration:' + writerRegistration]?.registrationId, writerRegistration)
  assert.equal(harness.sentToTabs.some(({ message }) => message.type === 'webgpt_shift_test'), false)

  releasePrepare()
  for (let attempt = 0; attempt < 12; attempt += 1) await new Promise(resolve => setImmediate(resolve))
  const quiesced = harness.nativeMessages.find(message => message.kind === 'response' && message.requestId === 'quiesce-held')
  assert.equal(quiesced?.ok, true)
  assert.equal(quiesced.result.quiescent, true)
  assert.equal(harness.storageState['writer:authority'].epoch, 3)
  assert.equal(harness.nativeMessages.find(message => message.requestId === 'shift-queued')?.ok, true)
  assert.equal(harness.sentToTabs.some(({ message }) => message.type === 'conversation_submit'), false)
})

test('writer_quiesce persists registration revocation and rejects late native mutations across restart', async () => {
  const options = {
    storage: { 'writer:authority': { version: 1, epoch: 3 } },
    tabs: [{ id: 20, windowId: 10, url: 'https://chatgpt.com/' }]
  }
  const harness = makeHarness(options)
  const quiesced = await harness.request('writer_quiesce', { writerEpoch: 3, registrationId: writerRegistration })
  assert.equal(quiesced.ok, true)
  assert.equal(quiesced.result.quiescent, true)
  assert.deepEqual(JSON.parse(JSON.stringify(harness.storageState['writer:revoked-registration:' + writerRegistration])), {
    version: 1, registrationId: writerRegistration, writerEpoch: 3
  })

  await harness.sendNativeMessage({
    kind: 'request', requestId: 'late-revoked', method: 'webgpt_shift_test',
    params: { target: 'Medium', target_tab_id: 20, writerEpoch: 3, registrationId: writerRegistration }
  })
  const late = harness.nativeMessages.find(message => message.requestId === 'late-revoked')
  assert.equal(late?.ok, false)
  assert.match(late.error, /registration.*revoked/i)
  assert.equal(harness.sentToTabs.length, 0)

  const restarted = makeHarness({ ...options, storage: structuredClone(harness.storageState) })
  const denied = await restarted.request('webgpt_shift_test', {
    target: 'Medium', target_tab_id: 20, writerEpoch: 3, registrationId: writerRegistration
  })
  assert.equal(denied.ok, false)
  assert.equal(restarted.sentToTabs.length, 0)
  const fresh = await restarted.request('webgpt_shift_test', {
    target: 'Medium', target_tab_id: 20, writerEpoch: 3,
    registrationId: '20000000-0000-4000-8000-000000000094'
  })
  assert.equal(fresh.ok, true)
  const human = await restarted.request('webgpt_shift_test', { target: 'Medium', target_tab_id: 20, writerEpoch: 3 })
  assert.equal(human.ok, true)
  assert.equal(restarted.storageState['writer:authority'].epoch, 3)
})

test('writer registration fences reject malformed IDs and stale quiesce before revocation or effects', async () => {
  for (const registrationId of [null, '', 'not-a-uuid', 95]) {
    const harness = makeHarness({ storage: { 'writer:authority': { version: 1, epoch: 3 } } })
    const quiesced = await harness.request('writer_quiesce', { writerEpoch: 3, registrationId })
    assert.equal(quiesced.ok, false)
    const mutation = await harness.request('webgpt_shift_test', { target: 'Medium', target_tab_id: 20, writerEpoch: 3, registrationId })
    assert.equal(mutation.ok, false)
    assert.equal(Object.keys(harness.storageState).some(key => key.startsWith('writer:revoked-registration:')), false)
    assert.equal(harness.sentToTabs.length, 0)
  }
  const harness = makeHarness({ storage: { 'writer:authority': { version: 1, epoch: 3 } } })
  assert.equal((await harness.request('writer_quiesce', { writerEpoch: 2, registrationId: writerRegistration })).ok, false)
  assert.equal(harness.storageState['writer:revoked-registration:' + writerRegistration], undefined)
})

test('writer epoch claim waits for the actual timed-out content-script promise before migration', async t => {
  let releasePrepare
  const harness = makeHarness({
    prepareGate: new Promise(resolve => { releasePrepare = resolve }), expirePrepare: true,
    storage: {
      'writer:authority': { version: 1, epoch: 3 },
      'conversation:conv_claim_drain': { windowId: 10, tabId: 20, url: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000016' }
    },
    windows: [{ id: 10 }],
    tabs: [{ id: 20, windowId: 10, url: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000016' }]
  })
  t.after(() => releasePrepare())
  const failed = await harness.request('conversation_send', {
    conversationId: 'conv_claim_drain', turnId: 'turn_timeout', requestId: 'claim-drain-send',
    text: 'held old writer', externalUrl: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000016', writerEpoch: 3
  })
  assert.equal(failed.errorCode, 'DELIVERY_UNCERTAIN')
  await harness.sendNativeMessage({ kind: 'request', requestId: 'claim-drain', method: 'writer_epoch_claim', params: { writerEpoch: 4 } })
  assert.equal(harness.nativeMessages.some(message => message.requestId === 'claim-drain'), false)
  assert.equal(harness.storageState['writer:authority'].epoch, 3)

  releasePrepare()
  for (let attempt = 0; attempt < 12; attempt += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(harness.nativeMessages.find(message => message.requestId === 'claim-drain')?.ok, true)
  assert.equal(harness.storageState['writer:authority'].epoch, 4)
  assert.equal(harness.sentToTabs.some(({ message }) => message.type === 'conversation_submit'), false)
})

test('writer_quiesce revokes in memory when durable storage fails and never acknowledges quiescence', async () => {
  const options = {
    storage: { 'writer:authority': { version: 1, epoch: 3 } },
    tabs: [{ id: 20, windowId: 10, url: 'https://chatgpt.com/' }]
  }
  const harness = makeHarness({ ...options, failRevocationStorage: true })
  const quiesced = await harness.request('writer_quiesce', { writerEpoch: 3, registrationId: writerRegistration })
  assert.equal(quiesced.ok, false)
  assert.match(quiesced.error, /storage unavailable/)
  assert.equal(harness.storageState['writer:revoked-registration:' + writerRegistration], undefined)
  const late = await harness.request('webgpt_shift_test', {
    target: 'Medium', target_tab_id: 20, writerEpoch: 3, registrationId: writerRegistration
  })
  assert.equal(late.ok, false)
  assert.match(late.error, /registration.*revoked/i)
  assert.equal(harness.sentToTabs.length, 0)

  const restarted = makeHarness({ ...options, storage: structuredClone(harness.storageState) })
  assert.equal((await restarted.request('writer_epoch_claim', { writerEpoch: 4 })).ok, true)
  const oldEpoch = await restarted.request('webgpt_shift_test', {
    target: 'Medium', target_tab_id: 20, writerEpoch: 3, registrationId: writerRegistration
  })
  assert.equal(oldEpoch.ok, false)
  assert.match(oldEpoch.error, /epoch mismatch/)
  assert.equal(restarted.sentToTabs.length, 0)
})

test('writer quiesce and epoch claim barriers block extension reload while actual content work remains', async t => {
  for (const method of ['writer_quiesce', 'writer_epoch_claim']) {
    let releaseStop
    const harness = makeHarness({
      stopGate: new Promise(resolve => { releaseStop = resolve }), fastStopTimeout: true,
      storage: {
        'writer:authority': { version: 1, epoch: 3 },
        'conversation:conv_barrier_reload': { windowId: 10, tabId: 20, url: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000017' }
      },
      windows: [{ id: 10 }],
      tabs: [{ id: 20, windowId: 10, url: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000017', generating: true, userMessageId: 'user-barrier' }]
    })
    t.after(() => releaseStop())
    assert.equal((await harness.request('conversation_stop', {
      conversationId: 'conv_barrier_reload', turnId: 'turn_timeout', requestId: 'barrier-reload-stop',
      expected: { userMessageId: 'user-barrier', assistantMessageId: null },
      externalUrl: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000017', writerEpoch: 3
    })).errorCode, 'DELIVERY_UNCERTAIN')
    await harness.sendNativeMessage({
      kind: 'request', requestId: 'held-barrier', method, params: { writerEpoch: method === 'writer_quiesce' ? 3 : 4 }
    })
    assert.equal(harness.nativeMessages.some(message => message.requestId === 'held-barrier'), false)
    const reload = await harness.request('extension_reload', {
      requestId: 'reload-during-barrier', expectedInstanceId: 'test-instance', expectedBuildId: 'a'.repeat(64)
    })
    assert.equal(reload.ok, false, method)
    assert.match(reload.error, /busy/)
    assert.equal(harness.runtimeReloadCount, 0)
    releaseStop()
    for (let attempt = 0; attempt < 12; attempt += 1) await new Promise(resolve => setImmediate(resolve))
    assert.equal(harness.nativeMessages.find(message => message.requestId === 'held-barrier')?.ok, true)
  }
})

const effectDocument = '30000000000040008000000000000020'
const heldContentEffect = {
  version: 1, token: 'held-effect-token', tabId: 20, documentId: effectDocument,
  registrationId: writerRegistration, writerEpoch: 3, method: 'conversation_stop', instanceId: 'old-worker'
}

test('content document handshake accepts Chromium 32-hex IDs and preserves exact case through journal and targeting', async () => {
  const documentId = 'ABCDEF1234567890ABCDEF1234567890'
  const harness = refreshHarness({ tab: { documentId }, loseContentCompletion: true })
  const shifted = await harness.request('webgpt_shift_test', { target: 'Medium', target_tab_id: 20,
    writerEpoch: 3, registrationId: writerRegistration })
  assert.equal(shifted.ok, true)
  const dispatched = harness.sentToTabs.find(({ message }) => message.type === 'webgpt_shift_test')
  assert.equal(dispatched.options.documentId, documentId)
  assert.equal(dispatched.message.contentEffect.documentId, documentId)
  assert.equal(dispatched.message.contentEffect.registrationId, writerRegistration)
  const effect = dispatched.message.contentEffect
  assert.equal(harness.storageState['content-effect:' + effect.token].documentId, documentId)
  const complete = await harness.emitRuntimeMessage({ kind: 'content_effect_complete', effect }, {
    id: 'cfifihieaffhniimpimnfmignbbdaalb', tab: { id: 20 }, frameId: 0, documentId
  })
  assert.equal(complete.settled, true)
  assert.equal(harness.storageState['content-effect:' + effect.token], undefined)
})

test('content document handshake rejects malformed Chromium IDs and untrusted sender metadata', async () => {
  const harness = refreshHarness()
  const trusted = { id: 'cfifihieaffhniimpimnfmignbbdaalb', tab: { id: 20, url: refreshUrl }, frameId: 0, documentId: effectDocument }
  for (const sender of [
    ...['30000000-0000-4000-8000-000000000020', 'a'.repeat(31), 'a'.repeat(33), 'g'.repeat(32), '', null, 12].map(documentId => ({ ...trusted, documentId })),
    { ...trusted, id: 'another-extension' }, { ...trusted, frameId: 1 }, { ...trusted, tab: { id: '20' } }
  ]) {
    const result = await harness.emitRuntimeMessage({ kind: 'content_effect_document', token: 'probe' }, sender)
    assert.equal(result.ready, false)
    assert.equal(result.documentId, undefined)
  }
})

test('unresolved content effects prevent refresh despite a fresh inactive DOM and preserve read-only observations', async () => {
  const harness = refreshHarness({ storage: { 'content-effect:held-effect-token': heldContentEffect } })
  const refresh = await harness.request('conversation_refresh', refreshParams)
  assert.equal(refresh.ok, false)
  assert.equal(refresh.errorCode, 'DELIVERY_UNCERTAIN')
  assert.equal(harness.reloadedTabs.length, 0)
  assert.equal(harness.storageState['effect-receipt:request-refresh'], undefined)
  assert.deepEqual(harness.storageState['content-effect:held-effect-token'], heldContentEffect)
  const observed = await harness.request('conversation_state_observe', { conversationId: 'conv_refresh', externalUrl: refreshUrl,
    turnId: 'turn_observe', expectedUserMessageId: 'user-refresh' })
  assert.equal(observed.result.readable, true)
  assert.equal(observed.result.generating, false)
})

test('a timed-out same-worker content operation cannot be bypassed by an inactive refresh snapshot', async t => {
  let release
  const harness = refreshHarness({ stopGate: new Promise(resolve => { release = resolve }), fastStopTimeout: true,
    tab: { generating: true } })
  t.after(() => release())
  const stop = await harness.request('conversation_stop', { conversationId: 'conv_refresh', externalUrl: refreshUrl,
    turnId: 'turn_held', requestId: 'stop_held', expected: { userMessageId: 'user-refresh', assistantMessageId: 'assistant-refresh' }, writerEpoch: 3 })
  assert.equal(stop.errorCode, 'DELIVERY_UNCERTAIN')
  await harness.updateTab(20, { generating: false })
  const refresh = await harness.request('conversation_refresh', refreshParams)
  assert.equal(refresh.ok, false)
  assert.equal(refresh.errorCode, 'DELIVERY_UNCERTAIN')
  assert.equal(harness.reloadedTabs.length, 0)
  release()
  for (let attempt = 0; attempt < 40 && Object.keys(harness.storageState).some(key => key.startsWith('content-effect:')); attempt += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
  const settled = await harness.request('conversation_refresh', refreshParams)
  assert.equal(settled.result.refreshed, true)
})

test('refresh checks for an unresolved content effect again after fresh DOM observation', async () => {
  const harness = refreshHarness({ onStateObservation(storage) { storage['content-effect:held-effect-token'] = heldContentEffect } })
  const refresh = await harness.request('conversation_refresh', refreshParams)
  assert.equal(refresh.ok, false)
  assert.equal(refresh.errorCode, 'DELIVERY_UNCERTAIN')
  assert.equal(harness.reloadedTabs.length, 0)
  assert.equal(harness.storageState['content-effect:held-effect-token'].token, heldContentEffect.token)
})

const unsettledRefresh = { action: 'refresh', phase: 'issued', requestId: 'old-refresh', tabId: 20 }

test('new content dispatch cannot bypass a prior unknown refresh or content journal', async () => {
  for (const storage of [
    { 'effect-receipt:old-refresh': unsettledRefresh },
    { 'content-effect:held-effect-token': heldContentEffect }
  ]) {
    const harness = refreshHarness({ storage })
    const shift = await harness.request('webgpt_shift_test', { target: 'Medium', target_tab_id: 20, writerEpoch: 3 })
    assert.equal(shift.ok, false)
    assert.equal(shift.errorCode, 'DELIVERY_UNCERTAIN')
    assert.equal(harness.sentToTabs.some(({ message }) => message.type === 'webgpt_shift_test'), false)
    assert.equal(harness.reloadedTabs.length, 0)
  }
  const settled = refreshHarness({ storage: { 'effect-receipt:old-refresh': { ...unsettledRefresh, phase: 'applied' } } })
  assert.equal((await settled.request('webgpt_shift_test', { target: 'Medium', target_tab_id: 20, writerEpoch: 3 })).ok, true)
})

test('content dispatch rechecks unresolved effects after the read-only document handshake', async () => {
  const harness = refreshHarness({ onContentDocumentProbe(storage) { storage['effect-receipt:old-refresh'] = unsettledRefresh } })
  const shift = await harness.request('webgpt_shift_test', { target: 'Medium', target_tab_id: 20, writerEpoch: 3 })
  assert.equal(shift.ok, false)
  assert.equal(shift.errorCode, 'DELIVERY_UNCERTAIN')
  assert.equal(harness.sentToTabs.some(({ message }) => message.type === 'webgpt_shift_test'), false)
  assert.equal(Object.keys(harness.storageState).some(key => key.startsWith('content-effect:')), false)
})

test('restarted owner barriers probe only the exact document for already-settled completion before admission', async () => {
  for (const method of ['writer_quiesce', 'writer_epoch_claim']) {
    const harness = refreshHarness({ storage: { 'content-effect:held-effect-token': heldContentEffect }, completedEffectOnPing: heldContentEffect })
    const result = await harness.request(method, { writerEpoch: method === 'writer_quiesce' ? 3 : 4,
      ...(method === 'writer_quiesce' ? { registrationId: writerRegistration } : {}) })
    assert.equal(result.ok, true, method)
    assert.equal(harness.storageState['content-effect:held-effect-token'], undefined)
    const probes = harness.sentToTabs.filter(({ message }) => message.type === 'sidecar_ping')
    assert.equal(probes.length, 1)
    assert.equal(probes[0].tabId, heldContentEffect.tabId)
    assert.equal(probes[0].options.documentId, heldContentEffect.documentId)
    assert.equal(harness.sentToTabs.some(({ message }) => message.contentEffect), false)
    assert.equal(harness.reloadedTabs.length, 0)
  }
})

test('restart barrier probes cannot invent settlement for a missing document or mismatched completion', async () => {
  for (const options of [
    { tab: { documentId: effectDocument.replace('0020', '0021') }, completedEffectOnPing: heldContentEffect },
    { completedEffectOnPing: { ...heldContentEffect, writerEpoch: 2 } }
  ]) {
    const harness = refreshHarness({ storage: { 'content-effect:held-effect-token': heldContentEffect }, ...options })
    const result = await harness.request('writer_epoch_claim', { writerEpoch: 4 })
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'DELIVERY_UNCERTAIN')
    assert.equal(harness.storageState['content-effect:held-effect-token'].token, heldContentEffect.token)
    assert.equal(harness.storageState['writer:authority'].epoch, 3)
    assert.equal(harness.reloadedTabs.length, 0)
  }
})

test('content effects persist exact document and writer binding before dispatch and clear only after settlement', async () => {
  const harness = refreshHarness({ tab: { generating: true }, loseContentCompletion: true })
  const response = await harness.request('conversation_stop', {
    conversationId: 'conv_refresh', turnId: 'turn_effect', requestId: 'stop_effect',
    externalUrl: refreshUrl, expected: { userMessageId: 'user-refresh', assistantMessageId: 'assistant-refresh' },
    writerEpoch: 3, registrationId: writerRegistration
  })
  assert.equal(response.ok, true)
  const dispatched = harness.sentToTabs.find(({ message }) => message.type === 'conversation_stop')
  assert.ok(dispatched.message.contentEffect)
  const effect = dispatched.message.contentEffect
  assert.deepEqual(JSON.parse(JSON.stringify(dispatched.storageSnapshot['content-effect:' + effect.token])), JSON.parse(JSON.stringify(effect)))
  assert.equal(effect.tabId, 20)
  assert.equal(effect.documentId, effectDocument)
  assert.equal(effect.registrationId, writerRegistration)
  assert.equal(effect.writerEpoch, 3)
  assert.equal(dispatched.options.documentId, effectDocument)
  assert.equal(harness.storageState['content-effect:' + effect.token]?.token, effect.token)
  const blocked = await harness.request('writer_quiesce', { writerEpoch: 3, registrationId: writerRegistration })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.errorCode, 'DELIVERY_UNCERTAIN')
})

test('content journal write failure prevents dispatch and clear failure blocks quiescence', async () => {
  for (const failure of [{ failContentEffectStorage: true }, { failContentEffectClear: true }]) {
    const harness = refreshHarness({ tab: { generating: true }, ...failure })
    const response = await harness.request('conversation_stop', {
      conversationId: 'conv_refresh', turnId: 'turn_effect', requestId: 'stop_effect',
      externalUrl: refreshUrl, expected: { userMessageId: 'user-refresh', assistantMessageId: 'assistant-refresh' },
      writerEpoch: 3, registrationId: writerRegistration
    })
    assert.equal(response.ok, false)
    const dispatched = harness.sentToTabs.filter(({ message }) => message.type === 'conversation_stop')
    assert.equal(dispatched.length, failure.failContentEffectStorage ? 0 : 1)
    if (failure.failContentEffectClear) {
      const blocked = await harness.request('writer_quiesce', { writerEpoch: 3, registrationId: writerRegistration })
      assert.equal(blocked.ok, false)
      assert.equal(blocked.errorCode, 'DELIVERY_UNCERTAIN')
    }
  }
})

test('worker restart cannot acknowledge quiescence or claim a new epoch while a durable content effect is unsettled', async () => {
  for (const method of ['writer_quiesce', 'writer_epoch_claim', 'extension_reload']) {
    const harness = makeHarness({ storage: {
      'writer:authority': { version: 1, epoch: 3 },
      'content-effect:held-effect-token': heldContentEffect
    } })
    const params = method === 'extension_reload'
      ? { requestId: 'restart-reload', expectedInstanceId: 'test-instance', expectedBuildId: 'a'.repeat(64) }
      : { writerEpoch: method === 'writer_quiesce' ? 3 : 4, registrationId: writerRegistration }

    const result = await harness.request(method, params)

    assert.equal(result.ok, false, method)
    assert.equal(result.errorCode, 'DELIVERY_UNCERTAIN')
    assert.equal(harness.storageState['content-effect:held-effect-token'].token, heldContentEffect.token)
    assert.equal(harness.storageState['writer:authority'].epoch, 3)
    assert.equal(harness.runtimeReloadCount, 0)
  }
})

test('only exact trusted content completion clears a durable effect after worker restart', async () => {
  const harness = makeHarness({ storage: {
    'writer:authority': { version: 1, epoch: 3 },
    'content-effect:held-effect-token': heldContentEffect
  } })
  const exactSender = { id: 'cfifihieaffhniimpimnfmignbbdaalb', tab: { id: 20 }, frameId: 0, documentId: effectDocument }
  for (const [effect, sender] of [
    [{ ...heldContentEffect, token: 'other-token' }, exactSender],
    [heldContentEffect, { ...exactSender, tab: { id: 21 } }],
    [heldContentEffect, { ...exactSender, documentId: effectDocument.replace('0020', '0021') }],
    [heldContentEffect, { ...exactSender, frameId: 1 }],
    [heldContentEffect, { ...exactSender, id: 'another-extension' }],
    ...['30000000-0000-4000-8000-000000000020', 'a'.repeat(31), 'a'.repeat(33), 'g'.repeat(32)].map(documentId => [heldContentEffect, { ...exactSender, documentId }]),
    [{ ...heldContentEffect, registrationId: '20000000-0000-4000-8000-000000000094' }, exactSender],
    [{ ...heldContentEffect, writerEpoch: 2 }, exactSender]
  ]) {
    await harness.emitRuntimeMessage({ kind: 'content_effect_complete', effect }, sender)
    assert.equal(harness.storageState['content-effect:held-effect-token'].token, heldContentEffect.token)
  }
  const settled = await harness.emitRuntimeMessage({ kind: 'content_effect_complete', effect: heldContentEffect }, exactSender)
  assert.equal(settled?.settled, true)
  assert.equal(harness.storageState['content-effect:held-effect-token'], undefined)
  const quiesced = await harness.request('writer_quiesce', { writerEpoch: 3, registrationId: writerRegistration })
  assert.equal(quiesced.ok, true)
  assert.equal(quiesced.result.quiescent, true)
})

test('an issued refresh receipt is unknown across worker restart and cannot pass an owner barrier', async () => {
  const harness = refreshHarness({ storage: { 'effect-receipt:request-refresh': {
    action: 'refresh', phase: 'issued', requestId: refreshParams.requestId,
    conversationId: refreshParams.conversationId, externalUrl: refreshUrl,
    userMessageId: refreshParams.expectedUserMessageId, assistantMessageId: refreshParams.expectedAssistantMessageId,
    expectedWriterEpoch: 3, tabId: 20
  } } })
  const quiesced = await harness.request('writer_quiesce', { writerEpoch: 3, registrationId: writerRegistration })
  assert.equal(quiesced.ok, false)
  assert.equal(quiesced.errorCode, 'DELIVERY_UNCERTAIN')
})

test('writer_quiesce validates current durable epoch without changing authority', async () => {
  const harness = makeHarness({ storage: { 'writer:authority': { version: 1, epoch: 3 } } })
  const stale = await harness.request('writer_quiesce', { writerEpoch: 2 })
  assert.equal(stale.ok, false)
  assert.match(stale.error, /epoch mismatch/)
  const current = await harness.request('writer_quiesce', { writerEpoch: 3 })
  assert.equal(current.ok, true)
  assert.equal(current.result.quiescent, true)
  assert.equal(current.result.currentWriterEpoch, 3)
  assert.equal(harness.storageState['writer:authority'].epoch, 3)
})

test('writer epoch fences every Sidecar browser mutation command class', async () => {
  const externalUrl = 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000018'
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10 },
      'conversation:conv_epoch_all': { windowId: 10, tabId: 20, url: externalUrl }
    },
    windows: [{ id: 10 }],
    tabs: [{ id: 20, windowId: 10, url: externalUrl }]
  })
  assert.equal((await harness.request('writer_epoch_claim', { writerEpoch: 2 })).ok, true)

  const requests = [
    ['webgpt_shift_test', { target: 'High', writerEpoch: 1 }],
    ['project_create', { name: 'should-not-create', writerEpoch: 1 }],
    ['conversation_create', { conversationId: 'conv_stale_create', url: 'https://chatgpt.com/', writerEpoch: 1 }],
    ['conversation_send', { conversationId: 'conv_epoch_all', turnId: 'turn_stale_all', text: 'must not send', externalUrl, writerEpoch: 1 }]
  ]
  for (const [method, params] of requests) {
    const response = await harness.request(method, params)
    assert.equal(response.ok, false, `${method} must reject stale writer epoch`)
    assert.match(response.error, /writer epoch/i)
  }

  assert.equal(harness.createdWindows.length, 0)
  assert.equal(harness.createdTabs.length, 0)
  assert.equal(harness.sentToTabs.some(({ message }) => ['webgpt_shift_test', 'project_create', 'conversation_prepare'].includes(message.type)), false)
})

test('send persists pending state before the irreversible submit click', async () => {
  const externalUrl = 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000019'
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10 },
      'conversation:conv_existing': { windowId: 10, tabId: 20, url: externalUrl }
    },
    windows: [{ id: 10 }],
    tabs: [{ id: 20, windowId: 10, url: externalUrl }]
  })

  const response = await harness.request('conversation_send', {
    conversationId: 'conv_existing',
    turnId: 'turn_prepare',
    text: 'continue',
    externalUrl
  })

  assert.equal(response.ok, true)
  const prepareIndex = harness.sentToTabs.findIndex(({ message }) => message.type === 'conversation_prepare')
  const submitIndex = harness.sentToTabs.findIndex(({ message }) => message.type === 'conversation_submit')
  assert.ok(prepareIndex >= 0, 'send must prepare the editor before creating the pending record')
  assert.ok(submitIndex > prepareIndex, 'submit must happen after prepare')
  const submitRecord = harness.sentToTabs[submitIndex]
  assert.equal(submitRecord.storageSnapshot['pending:conv_existing']?.turnId, 'turn_prepare')
  assert.equal(submitRecord.storageSnapshot['pending:conv_existing']?.promptText, 'continue')
  assert.equal(submitRecord.storageSnapshot['pending:conv_existing']?.phase, 'submitting')
})

test('send preserves recoverable pending state when submit response is lost during navigation', async () => {
  const externalUrl = 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000020'
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10 },
      'conversation:conv_existing': { windowId: 10, tabId: 20, url: externalUrl }
    },
    windows: [{ id: 10 }],
    tabs: [{ id: 20, windowId: 10, url: externalUrl }],
    submitTransportFailure: true
  })

  const response = await harness.request('conversation_send', {
    conversationId: 'conv_existing',
    turnId: 'turn_submit_race',
    text: 'continue',
    externalUrl
  })

  assert.equal(response.ok, false)
  assert.match(response.error, /submit response lost/)
  assert.equal(harness.storageState['pending:conv_existing']?.turnId, 'turn_submit_race')
  assert.equal(harness.storageState['pending:conv_existing']?.phase, 'submitting')
})

test('webgpt shift probe reuses an existing ChatGPT tab without creating a tab', async () => {
  const externalUrl = 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000021'
  const harness = makeHarness({
    storage: { window0: { windowId: 10 } },
    windows: [{ id: 10 }],
    tabs: [{ id: 20, windowId: 10, url: externalUrl, active: true }]
  })

  const response = await harness.request('webgpt_shift_test', { target: 'Extra High' })

  assert.equal(response.ok, true)
  assert.equal(response.result.after, 'Extra High')
  assert.equal(harness.createdTabs.length, 0)
  assert.equal(
    harness.sentToTabs.some(({ tabId, message }) => tabId === 20 && message.type === 'webgpt_shift_test'),
    true
  )
})

test('webgpt shift probe prefers a managed ChatGPT tab over an active unmanaged tab', async () => {
  const managedUrl = 'https://chatgpt.com/g/g-p-project/project'
  const unmanagedUrl = 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000022'
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10 },
      'conversation:conv_managed': { windowId: 10, tabId: 20, url: managedUrl }
    },
    windows: [{ id: 10 }],
    tabs: [
      { id: 20, windowId: 10, url: managedUrl, active: false },
      { id: 21, windowId: 10, url: unmanagedUrl, active: true }
    ]
  })

  const response = await harness.request('webgpt_shift_test', { target: 'High' })

  assert.equal(response.ok, true)
  const shiftCalls = harness.sentToTabs.filter(({ message }) => message.type === 'webgpt_shift_test')
  assert.equal(shiftCalls.length, 1)
  assert.equal(shiftCalls[0].tabId, 20)
})

test('webgpt shift probe targets an exact managed conversation when target_url is provided', async () => {
  const targetUrl = 'https://chatgpt.com/g/g-p-project/c/10000000-0000-4000-8000-000000000023'
  const otherUrl = 'https://chatgpt.com/g/g-p-project/c/10000000-0000-4000-8000-000000000024'
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10 },
      'conversation:conv_target': { windowId: 10, tabId: 20, url: targetUrl },
      'conversation:conv_other': { windowId: 10, tabId: 21, url: otherUrl }
    },
    windows: [{ id: 10 }],
    tabs: [
      { id: 20, windowId: 10, url: targetUrl, active: false },
      { id: 21, windowId: 10, url: otherUrl, active: true }
    ]
  })

  const response = await harness.request('webgpt_shift_test', {
    target: 'Medium',
    target_url: targetUrl
  })

  assert.equal(response.ok, true)
  const shiftCalls = harness.sentToTabs.filter(({ message }) => message.type === 'webgpt_shift_test')
  assert.equal(shiftCalls.length, 1)
  assert.equal(shiftCalls[0].tabId, 20)
  assert.equal(shiftCalls[0].message.target, 'Medium')
})

test('webgpt shift probe targets the exact allocated managed tab when target_tab_id is provided', async () => {
  const firstUrl = 'https://chatgpt.com/g/g-p-project/c/10000000-0000-4000-8000-000000000025'
  const childUrl = 'https://chatgpt.com/g/g-p-project/project'
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10 },
      'conversation:conv_first': { windowId: 10, tabId: 20, url: firstUrl },
      'conversation:conv_child': { windowId: 10, tabId: 21, url: childUrl }
    },
    windows: [{ id: 10 }],
    tabs: [
      { id: 20, windowId: 10, url: firstUrl, active: true },
      { id: 21, windowId: 10, url: childUrl, active: false }
    ]
  })

  const response = await harness.request('webgpt_shift_test', {
    target: 'High',
    target_tab_id: 21
  })

  assert.equal(response.ok, true)
  const shiftCalls = harness.sentToTabs.filter(({ message }) => message.type === 'webgpt_shift_test')
  assert.equal(shiftCalls.length, 1)
  assert.equal(shiftCalls[0].tabId, 21)
  assert.equal(shiftCalls[0].message.target, 'High')
})

test('webgpt shift probe targets an explicit unmanaged tab in a different window without window0', async () => {
  const harness = makeHarness({
    storage: { 'conversation:conv_other': { windowId: 10, tabId: 20, url: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000002' } },
    windows: [{ id: 10 }, { id: 11 }],
    tabs: [
      { id: 20, windowId: 10, url: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000002', active: true },
      { id: 21, windowId: 11, url: 'https://chatgpt.com/', active: false }
    ]
  })

  const response = await harness.request('webgpt_shift_test', { target: 'Medium', target_tab_id: 21 })

  assert.equal(response.ok, true)
  assert.equal(response.result.tabId, 21)
  assert.deepEqual(harness.sentToTabs.filter(({ message }) => message.type === 'webgpt_shift_test').map(({ tabId }) => tabId), [21])
  assert.equal(harness.createdTabs.length, 0)
})

test('webgpt shift probe never coerces an explicit tab ID', async () => {
  const harness = makeHarness({
    storage: { window0: { windowId: 10 } },
    windows: [{ id: 10 }],
    tabs: [{ id: 21, windowId: 10, url: 'https://chatgpt.com/', active: true }]
  })

  const response = await harness.request('webgpt_shift_test', { target: 'Medium', target_tab_id: '21' })

  assert.equal(response.ok, false)
  assert.match(response.error, /target_tab_id must be an integer/)
  assert.equal(harness.sentToTabs.length, 0)
})

test('webgpt shift probe rejects an explicit tab when target_url names another page', async () => {
  const harness = makeHarness({
    storage: { window0: { windowId: 10 } },
    windows: [{ id: 10 }],
    tabs: [{ id: 21, windowId: 10, url: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000026', active: true }]
  })

  const response = await harness.request('webgpt_shift_test', {
    target: 'Medium', target_tab_id: 21, target_url: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000027'
  })

  assert.equal(response.ok, false)
  assert.match(response.error, /target_url/)
  assert.equal(harness.sentToTabs.length, 0)
})

test('webgpt shift probe rejects arbitrary ChatGPT routes and a missing explicit tab without fallback', async () => {
  for (const target of [
    { id: 21, url: 'https://chatgpt.com/settings' },
    { id: 21, url: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000026/extra' },
    { id: 21, url: 'https://example.com/' },
    null
  ]) {
    const harness = makeHarness({
      storage: { window0: { windowId: 10 } },
      windows: [{ id: 10 }],
      tabs: [{ id: 20, windowId: 10, url: 'https://chatgpt.com/', active: true }, ...(target ? [{ ...target, windowId: 10 }] : [])]
    })

    const response = await harness.request('webgpt_shift_test', { target: 'Medium', target_tab_id: 21 })

    assert.equal(response.ok, false, target?.url ?? 'closed tab')
    assert.equal(harness.sentToTabs.length, 0)
    assert.equal(harness.createdTabs.length, 0)
  }
})

test('webgpt shift probe bounds a missing content-script response', async () => {
  const externalUrl = 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000021'
  const harness = makeHarness({
    storage: { window0: { windowId: 10 } },
    windows: [{ id: 10 }],
    tabs: [{ id: 20, windowId: 10, url: externalUrl, active: true }],
    hangWebGptShift: true,
    fastWebGptShiftTimeout: true,
    webGptDiagnostic: [{
      tagName: 'DIV',
      className: '__composer-pill',
      handlers: ['onPointerDown', 'onKeyDown']
    }]
  })

  const response = await harness.request('webgpt_shift_test', { target: 'High' })

  assert.equal(response.ok, false)
  assert.match(response.error, /Content script response timeout: webgpt_shift_test/)
  assert.match(response.error, /onPointerDown/)
  assert.equal(harness.scriptingCalls.length, 1)
})

test('send reloads a matching tab whose content script was invalidated by extension reload', async () => {
  const externalUrl = 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000028'
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10, sentinelTabId: 19 },
      'conversation:conv_existing': { windowId: 10, tabId: 20, url: externalUrl }
    },
    windows: [{ id: 10 }],
    tabs: [
      { id: 19, windowId: 10, url: 'chrome-extension://cfifihieaffhniimpimnfmignbbdaalb/automation-window.html', active: true },
      { id: 20, windowId: 10, url: externalUrl, status: 'complete' }
    ],
    staleContentScriptTabIds: [20]
  })

  const response = await harness.request('conversation_send', {
    conversationId: 'conv_existing',
    turnId: 'turn_reload',
    text: 'continue',
    externalUrl
  })

  assert.equal(response.ok, true)
  assert.deepEqual(harness.reloadedTabs, [20])
  assert.equal(harness.createdTabs.length, 0)
  assert.equal(
    harness.sentToTabs.some(({ tabId, message }) => tabId === 20 && message.type === 'conversation_submit'),
    true
  )
})

test('send reattaches a project conversation to an already-open matching project thread', async () => {
  const externalUrl = 'https://chatgpt.com/g/g-p-project123-agent/c/10000000-0000-4000-8000-000000000029'
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10, sentinelTabId: 19 },
      'conversation:conv_project': { windowId: 10, tabId: 20, url: externalUrl }
    },
    windows: [{ id: 10 }],
    tabs: [
      { id: 19, windowId: 10, url: 'chrome-extension://cfifihieaffhniimpimnfmignbbdaalb/automation-window.html', active: true },
      { id: 30, windowId: 10, url: externalUrl }
    ]
  })

  const response = await harness.request('conversation_send', {
    conversationId: 'conv_project',
    turnId: 'turn_project',
    text: 'continue',
    externalUrl
  })

  assert.equal(response.ok, true)
  assert.equal(response.result.reattached, true)
  assert.equal(harness.createdTabs.length, 0)
  assert.equal(harness.storageState['conversation:conv_project'].tabId, 30)
})

test('send reattaches a stale tab binding to an already-open matching ChatGPT conversation', async () => {
  const externalUrl = 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000030'
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10, sentinelTabId: 19 },
      'conversation:conv_existing': { windowId: 10, tabId: 20, url: externalUrl }
    },
    windows: [{ id: 10 }],
    tabs: [
      { id: 19, windowId: 10, url: 'chrome-extension://cfifihieaffhniimpimnfmignbbdaalb/automation-window.html', active: true },
      { id: 30, windowId: 10, url: externalUrl }
    ]
  })

  const response = await harness.request('conversation_send', {
    conversationId: 'conv_existing',
    turnId: 'turn_1',
    text: 'continue',
    externalUrl
  })

  assert.equal(response.ok, true)
  assert.equal(response.result.reattached, true)
  assert.equal(harness.createdTabs.length, 0)
  assert.equal(harness.storageState['conversation:conv_existing'].tabId, 30)
  assert.equal(
    harness.sentToTabs.some(({ tabId, message }) => tabId === 30 && message.type === 'conversation_submit'),
    true
  )
})

test('send rehomes a legacy conversation binding out of the human window into the owned automation window', async () => {
  const externalUrl = 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000031'
  const sentinelUrl = 'chrome-extension://cfifihieaffhniimpimnfmignbbdaalb/automation-window.html'
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10, sentinelTabId: 19 },
      'conversation:conv_legacy_human': { windowId: 11, tabId: 30, url: externalUrl }
    },
    windows: [{ id: 10 }, { id: 11, focused: true }],
    tabs: [
      { id: 19, windowId: 10, url: sentinelUrl, active: true },
      { id: 30, windowId: 11, url: externalUrl, active: true }
    ]
  })

  const response = await harness.request('conversation_send', {
    conversationId: 'conv_legacy_human',
    turnId: 'turn_rehome',
    text: 'continue',
    externalUrl
  })

  assert.equal(response.ok, true)
  assert.equal(harness.createdTabs.length, 1)
  assert.equal(harness.createdTabs[0].windowId, 10)
  assert.equal(harness.createdTabs[0].url, externalUrl)
  assert.equal(
    harness.sentToTabs.some(({ tabId, message }) => tabId === 30 && message.type === 'conversation_prepare'),
    false
  )
  assert.equal(harness.storageState['conversation:conv_legacy_human'].windowId, 10)
  assert.equal(harness.storageState['conversation:conv_legacy_human'].tabId, harness.createdTabs[0].id)
})

test('send reopens the stable ChatGPT conversation URL when no matching tab remains', async () => {
  const externalUrl = 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000032'
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10 },
      'conversation:conv_existing': { windowId: 10, tabId: 20, url: externalUrl }
    },
    windows: [{ id: 10 }],
    tabs: [{ id: 31, windowId: 10, url: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000033' }]
  })

  const response = await harness.request('conversation_send', {
    conversationId: 'conv_existing',
    turnId: 'turn_2',
    text: 'continue',
    externalUrl
  })

  assert.equal(response.ok, true)
  assert.equal(response.result.reattached, true)
  assert.equal(harness.createdTabs.length, 1)
  assert.equal(harness.createdTabs[0].url, externalUrl)
  assert.equal(harness.storageState['conversation:conv_existing'].tabId, harness.createdTabs[0].id)
})

test('send replaces stale physical window0 with an owned sentinel window and reopens the exact conversation in a child tab', async () => {
  const externalUrl = 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000034'
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10 },
      'conversation:conv_existing': { windowId: 10, tabId: 20, url: externalUrl }
    }
  })

  const response = await harness.request('conversation_send', {
    conversationId: 'conv_existing',
    turnId: 'turn_3',
    text: 'continue',
    externalUrl
  })

  assert.equal(response.ok, true)
  assert.equal(response.result.reattached, true)
  assert.equal(harness.createdWindows.length, 1)
  assert.equal(
    harness.createdWindows[0].tabs[0].url,
    'chrome-extension://cfifihieaffhniimpimnfmignbbdaalb/automation-window.html'
  )
  assert.equal(harness.createdWindows[0].focused, false)
  assert.equal(harness.createdWindows[0].state, 'minimized')
  assert.equal(harness.createdTabs.length, 1)
  assert.equal(harness.createdTabs[0].url, externalUrl)
  assert.equal(harness.createdTabs[0].windowId, harness.createdWindows[0].id)
  assert.equal(
    harness.storageState['conversation:conv_existing'].tabId,
    harness.createdTabs[0].id
  )
})

test('terminal events stay in a durable outbox until the native host acknowledges them', async () => {
  const externalUrl = 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000035'
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10 },
      'conversation:conv_existing': { windowId: 10, tabId: 30, url: externalUrl },
      'pending:conv_existing': {
        conversationId: 'conv_existing',
        turnId: 'turn_outbox',
        tabId: 30,
        baselineAssistantCount: 0,
        startedAt: 1
      }
    },
    windows: [{ id: 10 }],
    tabs: [{ id: 30, windowId: 10, url: externalUrl }]
  })

  harness.setFailNativeEventPosts(true)
  await harness.emitRuntimeMessage({
    kind: 'conversation_event',
    event: {
      type: 'response_completed',
      conversationId: 'conv_existing',
      turnId: 'turn_outbox',
      text: 'durable result',
      externalUrl
    }
  }, { tab: { id: 30, windowId: 10, url: externalUrl } })

  const eventId = 'terminal:conv_existing:turn_outbox:response_completed'
  const outboxKey = `outbox:${eventId}`
  assert.equal(harness.storageState['pending:conv_existing'], undefined)
  assert.equal(harness.storageState[outboxKey]?.eventId, eventId)
  assert.equal(harness.storageState[outboxKey]?.event?.text, 'durable result')

  await harness.reconnectNative()
  const replayed = harness.nativeMessages.find((message) => message.kind === 'event' && message.eventId === eventId)
  assert.equal(replayed?.event?.text, 'durable result')
  assert.notEqual(harness.storageState[outboxKey], undefined)

  await harness.sendNativeMessage({ kind: 'event_ack', eventId })
  assert.equal(harness.storageState[outboxKey], undefined)
})

test('replayed durable terminal event clears the matching ghost pending turn', async () => {
  const externalUrl = 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000036'
  const eventId = 'terminal:conv_existing:turn_replay:response_completed'
  const terminalEvent = {
    type: 'response_completed',
    conversationId: 'conv_existing',
    turnId: 'turn_replay',
    text: 'durable result',
    externalUrl
  }
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10 },
      'conversation:conv_existing': { windowId: 10, tabId: 30, url: externalUrl },
      'pending:conv_existing': {
        conversationId: 'conv_existing',
        turnId: 'turn_replay',
        tabId: 30,
        phase: 'submitted'
      },
      [`outbox:${eventId}`]: { eventId, event: terminalEvent }
    },
    windows: [{ id: 10 }],
    tabs: [{ id: 30, windowId: 10, url: externalUrl }]
  })

  const response = await harness.emitRuntimeMessage({
    kind: 'conversation_event',
    event: terminalEvent
  }, { tab: { id: 30, windowId: 10, url: externalUrl } })

  assert.equal(response?.durable, true)
  assert.equal(response?.eventId, eventId)
  assert.equal(harness.storageState['pending:conv_existing'], undefined)
  assert.notEqual(harness.storageState[`outbox:${eventId}`], undefined)
})

test('conversation state observation wraps exact bound-tab facts in v1 envelope', async () => {
  const externalUrl = 'https://chatgpt.com/g/g-p-project/c/10000000-0000-4000-8000-000000000037'
  const harness = makeHarness({
    storage: { window0: { windowId: 10 }, 'conversation:conv_state': { windowId: 10, tabId: 30, url: externalUrl } },
    windows: [{ id: 10 }],
    tabs: [
      { id: 30, windowId: 10, url: externalUrl, userMessageId: 'user-1', assistantMessageId: 'assistant-1', assistantText: 'FULL RESPONSE', generating: false, terminal: true, body: 'substantive', humanGate: false },
      { id: 31, windowId: 10, url: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000002', userMessageId: 'user-1', assistantText: 'WRONG' }
    ]
  })
  const response = await harness.request('conversation_state_observe', {
    conversationId: 'conv_state', externalUrl, turnId: 'turn-1', expectedUserMessageId: 'user-1'
  })
  assert.equal(response.ok, true)
  assert.equal(response.result.contractVersion, 1)
  assert.equal(response.result.source, 'browser')
  assert.equal(response.result.conversationId, 'conv_state')
  assert.equal(response.result.target, externalUrl)
  assert.equal(response.result.turnId, 'turn-1')
  assert.equal(response.result.userMessageId, 'user-1')
  assert.equal(response.result.assistantMessageId, 'assistant-1')
  assert.equal(response.result.assistantText, 'FULL RESPONSE')
  assert.equal(response.result.terminal, true)
  assert.equal(response.result.body, 'substantive')
  assert.equal(response.result.delivery, 'unknown')
  assert.equal(response.result.requestId, null)
  assert.ok(Number.isFinite(Date.parse(response.result.observedAt)))
  assert.deepEqual(harness.sentToTabs.filter(({ message }) => message.type === 'conversation_state_observe').map(({ tabId }) => tabId), [30])
})

test('latest human state observation preserves the v1 envelope and forwards the explicit read-only proof request', async () => {
  const externalUrl = 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000038'
  const latestUser = '40000000-0000-4000-8000-000000000001'
  const harness = makeHarness({
    storage: { 'conversation:conv_state': { windowId: 10, tabId: 30, url: externalUrl } },
    windows: [{ id: 10 }],
    tabs: [{ id: 30, windowId: 10, url: externalUrl, userMessageId: latestUser, assistantMessageId: null, assistantText: '', generating: false, terminal: false, body: 'empty', humanGate: false }]
  })
  const before = Date.now()
  const params = { conversationId: 'conv_state', externalUrl, turnId: 'old-turn', expectedUserMessageId: 'known-old-user' }
  const legacy = await harness.request('conversation_state_observe', params)
  assert.equal(legacy.result.readable, false)
  const latest = await harness.request('conversation_state_observe', { ...params, allowLatestUser: true })
  assert.equal(latest.ok, true)
  assert.equal(latest.result.readable, true)
  assert.equal(latest.result.contractVersion, 1)
  assert.equal(latest.result.source, 'browser')
  assert.equal(latest.result.target, externalUrl)
  assert.equal(latest.result.turnId, 'old-turn')
  assert.equal(latest.result.userMessageId, latestUser)
  assert.equal(latest.result.assistantMessageId, null)
  assert.equal(latest.result.assistantText, '')
  assert.equal(latest.result.body, 'empty')
  assert.equal(latest.result.terminal, false)
  assert.equal(latest.result.humanGate, false)
  assert.ok(Date.parse(latest.result.observedAt) >= before)
  const reads = harness.sentToTabs.filter(({ message }) => message.type === 'conversation_state_observe')
  assert.equal(reads[0].message.allowLatestUser, undefined)
  assert.equal(reads[1].message.allowLatestUser, true)
  assert.equal(harness.createdTabs.length, 0)
  assert.equal(harness.reloadedTabs.length, 0)
  assert.equal(Object.keys(harness.storageState).some(key => key.startsWith('content-effect:')), false)
})

test('latest human state observation reports a typed missing-known-anchor diagnostic without extending v1 facts', async () => {
  const externalUrl = 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000039'
  const harness = makeHarness({ storage: { 'conversation:conv_state': { windowId: 10, tabId: 30, url: externalUrl } },
    windows: [{ id: 10 }], tabs: [{ id: 30, windowId: 10, url: externalUrl, stateReadable: false, stateReason: 'human_turn_anchor_unavailable' }] })
  const response = await harness.request('conversation_state_observe', { conversationId: 'conv_state', externalUrl,
    turnId: 'old-turn', expectedUserMessageId: 'known-user', allowLatestUser: true })
  assert.equal(response.ok, false)
  assert.equal(response.errorCode, 'HUMAN_TURN_ANCHOR_UNAVAILABLE')
  assert.equal(response.error, 'human_turn_anchor_unavailable')
  assert.equal(harness.createdTabs.length, 0)
  assert.equal(harness.reloadedTabs.length, 0)
})

test('latest human state observation rejects a synthetic user identity at the worker boundary', async () => {
  const externalUrl = 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000040'
  const harness = makeHarness({ storage: { 'conversation:conv_state': { windowId: 10, tabId: 30, url: externalUrl } },
    windows: [{ id: 10 }], tabs: [{ id: 30, windowId: 10, url: externalUrl, userMessageId: 'synthetic-new-user', body: 'empty' }] })
  const response = await harness.request('conversation_state_observe', { conversationId: 'conv_state', externalUrl,
    turnId: 'old-turn', expectedUserMessageId: 'old-user', allowLatestUser: true })
  assert.equal(response.ok, true)
  assert.equal(response.result.readable, false)
  assert.equal(response.result.userMessageId, null)
})

test('conversation state observation fails closed when expected user identity is absent', async () => {
  const externalUrl = 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000041'
  const harness = makeHarness({
    storage: { window0: { windowId: 10 }, 'conversation:conv_state': { windowId: 10, tabId: 30, url: externalUrl } },
    windows: [{ id: 10 }],
    tabs: [{ id: 30, windowId: 10, url: externalUrl, userMessageId: 'different-user', assistantText: 'WRONG' }]
  })
  const response = await harness.request('conversation_state_observe', {
    conversationId: 'conv_state', externalUrl, turnId: 'turn-1', expectedUserMessageId: 'user-1'
  })
  assert.equal(response.ok, true)
  assert.equal(response.result.readable, false)
  assert.equal(response.result.userMessageId, null)
  assert.equal(response.result.terminal, null)
  assert.equal(response.result.body, 'unknown')
})

test('conversation snapshot reads only the exact already-bound conversation tab', async () => {
  const externalUrl = 'https://chatgpt.com/g/g-p-project/c/10000000-0000-4000-8000-000000000042'
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10 },
      'conversation:conv_existing': { windowId: 10, tabId: 30, url: externalUrl }
    },
    windows: [{ id: 10 }],
    tabs: [
      { id: 30, windowId: 10, url: externalUrl, assistantText: 'FULL RESPONSE', generating: false },
      { id: 31, windowId: 10, url: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000002', assistantText: 'WRONG', generating: false }
    ]
  })

  const response = await harness.request('conversation_snapshot', {
    conversationId: 'conv_existing',
    externalUrl
  })

  assert.equal(response.ok, true)
  assert.equal(response.result.found, true)
  assert.equal(response.result.url, externalUrl)
  assert.equal(response.result.generating, false)
  assert.equal(response.result.assistantText, 'FULL RESPONSE')
  assert.equal(harness.createdTabs.length, 0)
  assert.equal(harness.createdWindows.length, 0)
  assert.deepEqual(
    harness.sentToTabs.filter(({ message }) => message.type === 'conversation_snapshot').map(({ tabId }) => tabId),
    [30]
  )
})

test('need_continue stays in the durable terminal outbox until native acknowledgement', async () => {
  const externalUrl = 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000043'
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10 },
      'conversation:conv_existing': { windowId: 10, tabId: 30, url: externalUrl },
      'pending:conv_existing': {
        conversationId: 'conv_existing',
        turnId: 'turn_need_continue',
        tabId: 30,
        baselineAssistantCount: 0,
        startedAt: 1
      }
    },
    windows: [{ id: 10 }],
    tabs: [{ id: 30, windowId: 10, url: externalUrl }]
  })

  harness.setFailNativeEventPosts(true)
  const receipt = await harness.emitRuntimeMessage({
    kind: 'conversation_event',
    event: {
      type: 'need_continue',
      conversationId: 'conv_existing',
      turnId: 'turn_need_continue',
      text: 'partial shell',
      reason: 'assistant_body_incomplete',
      externalUrl
    }
  }, { tab: { id: 30, windowId: 10, url: externalUrl } })

  const eventId = 'terminal:conv_existing:turn_need_continue:need_continue'
  const outboxKey = `outbox:${eventId}`
  assert.equal(receipt?.durable, true)
  assert.equal(receipt?.eventId, eventId)
  assert.equal(harness.storageState['pending:conv_existing'], undefined)
  assert.equal(harness.storageState[outboxKey]?.event?.reason, 'assistant_body_incomplete')

  await harness.reconnectNative()
  const replayed = harness.nativeMessages.find((message) => message.kind === 'event' && message.eventId === eventId)
  assert.equal(replayed?.event?.type, 'need_continue')
  assert.notEqual(harness.storageState[outboxKey], undefined)

  await harness.sendNativeMessage({ kind: 'event_ack', eventId })
  assert.equal(harness.storageState[outboxKey], undefined)
})

test('reload remains scheduled when the accepted native response transport is lost', async () => {
  const harness = makeHarness({
    deferReloadTimer: true,
    failAcceptedResponsePostOnce: true
  })

  await harness.sendNativeMessage({
    kind: 'request',
    requestId: 'reload-native-lost',
    method: 'extension_reload',
    params: {
      requestId: 'reload-lost-ack',
      expectedInstanceId: 'test-instance',
      expectedBuildId: 'a'.repeat(64)
    }
  })

  assert.equal(harness.nativeMessages.some(message => message.requestId === 'reload-native-lost'), false,
    'lost success ACK must not be replaced by a synthetic business rejection')
  assert.equal(harness.runtimeReloadCount, 0)
  harness.runDeferredReload()
  assert.equal(harness.runtimeReloadCount, 1, 'reload scheduling must not depend on successful ACK delivery')
})

test('reload admission blocks a terminal event that arrives before the deferred runtime reload', async () => {
  const externalUrl = 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000044'
  const harness = makeHarness({
    deferReloadTimer: true,
    storage: {
      window0: { windowId: 10 },
      'conversation:conv_existing': { windowId: 10, tabId: 30, url: externalUrl }
    },
    windows: [{ id: 10 }],
    tabs: [{ id: 30, windowId: 10, url: externalUrl }]
  })

  const reload = await harness.request('extension_reload', {
    requestId: 'reload-race',
    expectedInstanceId: 'test-instance',
    expectedBuildId: 'a'.repeat(64)
  })
  assert.equal(reload.ok, true)
  assert.equal(reload.result.accepted, true)
  assert.equal(harness.runtimeReloadCount, 0)

  // Once admission wins, a real pending writer cannot create new work.
  const send = await harness.request('conversation_send', {
    conversationId: 'conv_existing',
    turnId: 'turn_race',
    text: 'must not start',
    externalUrl
  })
  assert.equal(send.ok, false)
  assert.match(send.error, /reload in progress/i)
  assert.equal(harness.storageState['pending:conv_existing'], undefined)

  // A stale content-script event arriving in the same window also has no
  // authority to mutate durable state.
  const terminal = await harness.emitRuntimeMessage({
    kind: 'conversation_event',
    event: {
      type: 'response_completed',
      conversationId: 'conv_existing',
      turnId: 'turn_race',
      text: 'late terminal',
      externalUrl
    }
  }, { tab: { id: 30, windowId: 10, url: externalUrl } })

  assert.equal(terminal?.durable, false)
  assert.equal(terminal?.reason, 'reload_in_progress')
  assert.equal(harness.storageState['pending:conv_existing'], undefined)
  assert.equal(harness.storageState['outbox:terminal:conv_existing:turn_race:response_completed'], undefined)

  harness.runDeferredReload()
  assert.equal(harness.runtimeReloadCount, 1)
})

test('terminal runtime events acknowledge only after the durable outbox write', async () => {
  const externalUrl = 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000045'
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10 },
      'conversation:conv_existing': { windowId: 10, tabId: 30, url: externalUrl },
      'pending:conv_existing': {
        conversationId: 'conv_existing',
        turnId: 'turn_ack',
        tabId: 30,
        baselineAssistantCount: 0,
        startedAt: 1
      }
    },
    windows: [{ id: 10 }],
    tabs: [{ id: 30, windowId: 10, url: externalUrl }]
  })

  const response = await harness.emitRuntimeMessage({
    kind: 'conversation_event',
    event: {
      type: 'response_completed',
      conversationId: 'conv_existing',
      turnId: 'turn_ack',
      text: 'done',
      externalUrl
    }
  }, { tab: { id: 30, windowId: 10, url: externalUrl } })

  const eventId = 'terminal:conv_existing:turn_ack:response_completed'
  assert.equal(response?.durable, true)
  assert.equal(response?.eventId, eventId)
  assert.equal(harness.storageState[`outbox:${eventId}`]?.event?.text, 'done')
  assert.equal(harness.storageState['pending:conv_existing'], undefined)
})

test('terminal event from the wrong tab cannot mutate attachment, pending, or outbox', async () => {
  const externalUrl = 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000046'
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10 },
      'conversation:conv_existing': { windowId: 10, tabId: 30, url: externalUrl },
      'pending:conv_existing': {
        conversationId: 'conv_existing',
        turnId: 'turn_right',
        tabId: 30,
        baselineAssistantCount: 0,
        startedAt: 1
      }
    },
    windows: [{ id: 10 }],
    tabs: [
      { id: 30, windowId: 10, url: externalUrl },
      { id: 31, windowId: 10, url: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000047' }
    ]
  })

  const response = await harness.emitRuntimeMessage({
    kind: 'conversation_event',
    event: {
      type: 'response_completed',
      conversationId: 'conv_existing',
      turnId: 'turn_right',
      text: 'wrong source',
      externalUrl: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000047'
    }
  }, { tab: { id: 31, windowId: 10, url: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000047' } })

  assert.equal(response?.durable, false)
  assert.equal(response?.reason, 'stale_source')
  assert.equal(harness.storageState['conversation:conv_existing'].tabId, 30)
  assert.equal(harness.storageState['conversation:conv_existing'].url, externalUrl)
  assert.equal(harness.storageState['pending:conv_existing'].turnId, 'turn_right')
  assert.equal(harness.storageState['outbox:terminal:conv_existing:turn_right:response_completed'], undefined)
})

test('navigation recovery claims a newer monitor owner and rejects the stale project monitor terminal', async () => {
  const projectUrl = 'https://chatgpt.com/g/g-p-project123-agent/project'
  const threadUrl = 'https://chatgpt.com/g/g-p-project123-agent/c/10000000-0000-4000-8000-000000000048'
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10 },
      'conversation:conv_existing': { windowId: 10, tabId: 30, url: projectUrl },
      'pending:conv_existing': {
        conversationId: 'conv_existing',
        turnId: 'turn_owned',
        tabId: 30,
        promptText: 'inspect',
        startedAt: 1,
        monitorVersion: 1
      }
    },
    windows: [{ id: 10 }],
    tabs: [{ id: 30, windowId: 10, url: threadUrl }]
  })

  const claimed = await harness.emitRuntimeMessage(
    { kind: 'pending_turn_lookup' },
    { tab: { id: 30, windowId: 10, url: threadUrl } }
  )

  assert.equal(claimed?.monitorVersion, 2)
  assert.equal(harness.storageState['pending:conv_existing'].monitorVersion, 2)
  assert.equal(harness.storageState['conversation:conv_existing'].url, threadUrl)

  const stale = await harness.emitRuntimeMessage({
    kind: 'conversation_event',
    event: {
      type: 'error',
      conversationId: 'conv_existing',
      turnId: 'turn_owned',
      monitorVersion: 1,
      message: 'old project monitor timed out',
      externalUrl: projectUrl
    }
  }, { tab: { id: 30, windowId: 10, url: threadUrl } })

  assert.equal(stale?.durable, false)
  assert.equal(stale?.reason, 'stale_monitor')
  assert.equal(harness.storageState['pending:conv_existing'].monitorVersion, 2)
  assert.equal(harness.storageState['outbox:terminal:conv_existing:turn_owned:error'], undefined)

  const current = await harness.emitRuntimeMessage({
    kind: 'conversation_event',
    event: {
      type: 'response_completed',
      conversationId: 'conv_existing',
      turnId: 'turn_owned',
      monitorVersion: 2,
      text: 'owned result',
      externalUrl: threadUrl
    }
  }, { tab: { id: 30, windowId: 10, url: threadUrl } })

  assert.equal(current?.durable, true)
  assert.equal(harness.storageState['pending:conv_existing'], undefined)
})

test('closed submitted pending can be claimed by a new tab for the exact same conversation', async () => {
  const threadUrl = 'https://chatgpt.com/g/g-p-project123-agent/c/10000000-0000-4000-8000-000000000049'
  const harness = makeHarness({
    storage: {
      'conversation:conv_existing': { windowId: 10, tabId: 30, url: threadUrl },
      'pending:conv_existing': {
        conversationId: 'conv_existing',
        turnId: 'turn_rebind',
        requestId: 'request_rebind',
        tabId: 30,
        promptText: 'inspect',
        startedAt: 1,
        monitorVersion: 1,
        phase: 'submitted'
      },
      'effect-receipt:request_rebind': {
        conversationId: 'conv_existing',
        turnId: 'turn_rebind',
        requestId: 'request_rebind',
        userMessageId: 'user_rebind',
        externalUrl: threadUrl
      }
    },
    windows: [{ id: 10 }],
    tabs: [{ id: 31, windowId: 10, url: threadUrl }]
  })

  const claimed = await harness.emitRuntimeMessage(
    { kind: 'pending_turn_lookup' },
    { tab: { id: 31, windowId: 10, url: threadUrl } }
  )

  assert.equal(claimed?.monitorVersion, 2)
  assert.equal(claimed?.tabId, 31)
  assert.equal(harness.storageState['pending:conv_existing'].tabId, 31)
  assert.equal(harness.storageState['conversation:conv_existing'].tabId, 31)
})

test('submitted pending cannot be stolen while its original tab is still live', async () => {
  const threadUrl = 'https://chatgpt.com/g/g-p-project123-agent/c/10000000-0000-4000-8000-000000000050'
  const harness = makeHarness({
    storage: {
      'conversation:conv_existing': { windowId: 10, tabId: 30, url: threadUrl },
      'pending:conv_existing': {
        conversationId: 'conv_existing',
        turnId: 'turn_live_owner',
        requestId: 'request_live_owner',
        tabId: 30,
        monitorVersion: 1,
        phase: 'submitted'
      },
      'effect-receipt:request_live_owner': {
        conversationId: 'conv_existing',
        turnId: 'turn_live_owner',
        requestId: 'request_live_owner',
        userMessageId: 'user_live_owner',
        externalUrl: threadUrl
      }
    },
    windows: [{ id: 10 }],
    tabs: [
      { id: 30, windowId: 10, url: threadUrl },
      { id: 31, windowId: 10, url: threadUrl }
    ]
  })

  const claimed = await harness.emitRuntimeMessage(
    { kind: 'pending_turn_lookup' },
    { tab: { id: 31, windowId: 10, url: threadUrl } }
  )

  assert.equal(claimed, null)
  assert.equal(harness.storageState['pending:conv_existing'].tabId, 30)
  assert.equal(harness.storageState['pending:conv_existing'].monitorVersion, 1)
})

test('same-document thread URL transition claims recovery ownership and updates attachment', async () => {
  const projectUrl = 'https://chatgpt.com/g/g-p-project123-agent/project'
  const threadUrl = 'https://chatgpt.com/g/g-p-project123-agent/c/10000000-0000-4000-8000-000000000051'
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10 },
      'conversation:conv_existing': { windowId: 10, tabId: 30, url: projectUrl },
      'pending:conv_existing': {
        conversationId: 'conv_existing',
        turnId: 'turn_spa',
        tabId: 30,
        promptText: 'inspect',
        startedAt: 1,
        monitorVersion: 1,
        phase: 'submitted'
      }
    },
    windows: [{ id: 10 }],
    tabs: [{ id: 30, windowId: 10, url: projectUrl }]
  })

  await harness.updateTab(30, { url: threadUrl, status: 'complete' })

  assert.equal(harness.storageState['pending:conv_existing'].monitorVersion, 2)
  assert.equal(harness.storageState['conversation:conv_existing'].url, threadUrl)
  const kick = harness.sentToTabs.find(({ tabId, message }) => (
    tabId === 30 &&
    message.type === 'conversation_monitor_start' &&
    message.turnId === 'turn_spa' &&
    message.monitorVersion === 2
  ))
  assert.equal(kick?.message?.recovery, true)
})

test('completion events persist the canonical ChatGPT URL before forwarding the event', async () => {
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10 },
      'conversation:conv_existing': { windowId: 10, tabId: 30, url: 'https://chatgpt.com/' },
      'pending:conv_existing': {
        conversationId: 'conv_existing',
        turnId: 'turn_4',
        tabId: 30,
        baselineAssistantCount: 0,
        startedAt: 1
      }
    },
    windows: [{ id: 10 }],
    tabs: [{ id: 30, windowId: 10, url: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000052' }]
  })

  await harness.emitRuntimeMessage({
    kind: 'conversation_event',
    event: {
      type: 'response_completed',
      conversationId: 'conv_existing',
      turnId: 'turn_4',
      text: 'done',
      externalUrl: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000052'
    }
  }, { tab: { id: 30, windowId: 10 } })

  assert.equal(
    harness.storageState['conversation:conv_existing'].url,
    'https://chatgpt.com/c/10000000-0000-4000-8000-000000000052'
  )
  assert.equal(harness.storageState['conversation:conv_existing'].tabId, 30)
  assert.equal(harness.storageState['pending:conv_existing'], undefined)
})
