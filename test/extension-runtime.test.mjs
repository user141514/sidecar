import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const workerSource = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8')
const lifecycleSource = await readFile(new URL('../extension/lifecycle.js', import.meta.url), 'utf8')

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

let harnessEffectToken = 0

function makeHarness({ storage = {}, windows = [], tabs = [], staleContentScriptTabIds = [], projectOpenChannelClosesAfterNavigation = false, projectOpenRejectOnRoot = false, projectDraftRequiresReload = false, submitTransportFailure = false, submitNavigatesTo = null, prepareTransportFailure = false, prepareRejected = false, expirePrepare = false, prepareGate = null, deferReloadTimer = false, failAcceptedResponsePostOnce = false, hangWebGptShift = false, fastWebGptShiftTimeout = false, webGptDiagnostic = null, reloadTransportFailure = false, refreshAdmissionTabChanges = null, failRevocationStorage = false, stopGate = null, fastStopTimeout = false, loseContentCompletion = false, failContentEffectStorage = false, failContentEffectClear = false, onContentDocumentProbe = null, onStateObservation = null, completedEffectOnPing = null } = {}) {
  const storageState = { ...storage }
  const staleContentScriptTabs = new Set(staleContentScriptTabIds)
  const windowMap = new Map(windows.map((window) => [window.id, { ...window }]))
  const tabMap = new Map(tabs.map((tab) => [tab.id, { ...tab }]))
  const nativeMessages = []
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
          if (Number.isInteger(tabId)) staleContentScriptTabs.delete(tabId)
        }
        return [{ result: webGptDiagnostic }]
      }
    },
    storage: {
      local: {
        async get(key) {
          if (key === null) return { ...storageState }
          if (typeof key === 'string') {
            return Object.hasOwn(storageState, key) ? { [key]: storageState[key] } : {}
          }
          throw new Error(`Unsupported storage.get key: ${String(key)}`)
        },
        async set(values) {
          if (failRevocationStorage && Object.keys(values).some(key => key.startsWith('writer:revoked-registration:'))) throw new Error('Revocation storage unavailable')
          if (failContentEffectStorage && Object.keys(values).some(key => key.startsWith('content-effect:'))) throw new Error('Content effect storage unavailable')
          Object.assign(storageState, values)
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
        return { ...tab }
      },
      async query({ windowId } = {}) {
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
        if (message.type === 'sidecar_effect_document') {
          const result = await runtime({ kind: 'content_effect_document', token: message.token })
          onContentDocumentProbe?.(storageState)
          return result
        }
        try {
        const result = await (async () => {
        if (message.type === 'sidecar_ping') {
          if (staleContentScriptTabs.has(tabId)) throw new Error('Could not establish connection. Receiving end does not exist.')
          if (completedEffectOnPing) await runtime({ kind: 'content_effect_complete', effect: completedEffectOnPing })
          return { ready: true, url: tab.url, buildId: 'a'.repeat(64), composerPresent: tab.composerPresent === true }
        }
        if (message.type === 'conversation_observe') {
          if (staleContentScriptTabs.has(tabId)) throw new Error('Could not establish connection. Receiving end does not exist.')
          return {
            ready: tab.observationReady !== false, url: tab.observedUrl ?? tab.url,
            allowed: tab.generating !== true, reason: tab.generating === true ? 'assistant_active' : null,
            userMessageId: tab.userMessageId ?? '', assistantMessageId: tab.assistantMessageId ?? ''
          }
        }
        if (message.type === 'conversation_state_observe') {
          if (staleContentScriptTabs.has(tabId)) throw new Error('Could not establish connection. Receiving end does not exist.')
          const readable = tab.stateReadable !== false && (message.allowLatestUser === true || tab.userMessageId === message.expectedUserMessageId)
          onStateObservation?.(storageState)
          return {
            ready: true,
            url: tab.url,
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
        if (message.type === 'conversation_prepare') {
          if (prepareGate) await prepareGate
          if (prepareTransportFailure) throw new Error('prepare response lost')
          if (prepareRejected) return { prepared: false, error: 'editor missing' }
          return { prepared: true, url: tab.url, baselineAssistantCount: 0 }
        }
        if (message.type === 'conversation_submit') {
          if (submitTransportFailure) throw new Error('submit response lost during navigation')
          const responseUrl = tab.url
          if (submitNavigatesTo) tab.url = submitNavigatesTo
          return { accepted: true, userMessageId: `user-${message.turnId}`, url: responseUrl }
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
    crypto: { randomUUID: () => ++uuidCalls === 1 ? 'test-instance' : `test-effect-${++harnessEffectToken}` },
    importScripts(...files) {
      for (const file of files) {
        if (file === 'build-info.js') vm.runInContext(`globalThis.__sidecarBuildId = ${JSON.stringify('a'.repeat(64))}`, context)
        else if (file === 'lifecycle.js') vm.runInContext(lifecycleSource, context)
        else throw new Error(`Unexpected import: ${file}`)
      }
    },
    console,
    URL,
    Date,
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
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = nativeMessages.find((message) => message.kind === 'response' && message.requestId === requestId)
      if (response) return response
      await new Promise((resolve) => setImmediate(resolve))
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
    [{ ...adoptionTab, userMessageId: '' }],
    [{ ...adoptionTab, userMessageId: 'synthetic-user' }],
    [{ ...adoptionTab, assistantMessageId: 'synthetic-assistant' }],
    [{ ...adoptionTab, observedUrl: adoptionTarget.replace('0061', '0062') }]
  ]) {
    const h = makeHarness({ storage: { 'writer:authority': { version: 1, epoch: 3 } }, tabs, windows: [{ id: 6 }] })
    const inspected = await h.request('conversation_supervision_inspect', { externalUrl: adoptionTarget, writerEpoch: 3 })
    assert.equal(inspected.ok, true)
    assert.equal(inspected.result.found, false, JSON.stringify(tabs))
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
  const harness = makeHarness({
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
  assert.equal(status.result.managedTabs[0].url, alias)
  assert.equal(harness.storageState['conversation:conv_alias'].url, alias)
  assert.equal(result.result.url, alias)
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
    userMessageId: 'user-turn_receipt',
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
    { tab: { url: 'https://chatgpt.com/c/wrong' } },
    { storage: { 'conversation:conv_refresh': { windowId: 10, tabId: 20, url: 'https://chatgpt.com/c/wrong' } } }
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
    { externalUrl: 'https://chatgpt.com/c/other' },
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
  assert.equal(duplicate.result.userMessageId, 'user-turn_dedupe')
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

  assert.equal(harness.storageState['effect-receipt:effect-ack-lost']?.userMessageId, 'user-turn_ack_lost')
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
  const externalUrl = 'https://chatgpt.com/c/shared-thread'
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
      { id: 20, windowId: 10, url: 'https://chatgpt.com/c/other', projectName: 'agent', projectUrl: 'https://chatgpt.com/g/g-p-agent-test/project' },
      { id: 21, windowId: 11, url: 'https://chatgpt.com/c/current', projectName: 'subagents', projectUrl }
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
    tabs: [{ id: 20, windowId: 10, url: 'https://chatgpt.com/c/human-current', active: true }]
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
  const seedThreadUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946/c/thread-existing'
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
  const seedThreadUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946/c/thread-existing'
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
  const externalUrl = 'https://chatgpt.com/g/g-p-rehome-test/c/thread-existing'
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
  const threadUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946-subagents/c/thread-materialized'
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
  const seedThreadUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946-subagents/c/thread-persisted'
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
  const seedThreadUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946-subagents/c/thread-existing'
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

test('conversation_create reloads an incomplete Project draft surface once', async () => {
  const projectUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946-subagents/project'
  const seedThreadUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946-subagents/c/thread-existing'
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

test('conversation_send captures the stable conversation URL after Project submit navigation', async () => {
  const projectUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946-subagents/project'
  const threadUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946-subagents/c/thread-new'
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
  const externalUrl = 'https://chatgpt.com/c/app-selection-123'
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
  const externalUrl = 'https://chatgpt.com/c/authoritative-guard'
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
  const externalUrl = 'https://chatgpt.com/c/writer-authority-missing'
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
  const externalUrl = 'https://chatgpt.com/c/writer-epoch-fence'
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
  const externalUrl = 'https://chatgpt.com/c/writer-epoch-order'
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
  const externalUrl = 'https://chatgpt.com/c/quiesce-late-effect'
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
      'conversation:conv_claim_drain': { windowId: 10, tabId: 20, url: 'https://chatgpt.com/c/claim-drain' }
    },
    windows: [{ id: 10 }],
    tabs: [{ id: 20, windowId: 10, url: 'https://chatgpt.com/c/claim-drain' }]
  })
  t.after(() => releasePrepare())
  const failed = await harness.request('conversation_send', {
    conversationId: 'conv_claim_drain', turnId: 'turn_timeout', requestId: 'claim-drain-send',
    text: 'held old writer', externalUrl: 'https://chatgpt.com/c/claim-drain', writerEpoch: 3
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
        'conversation:conv_barrier_reload': { windowId: 10, tabId: 20, url: 'https://chatgpt.com/c/barrier-reload' }
      },
      windows: [{ id: 10 }],
      tabs: [{ id: 20, windowId: 10, url: 'https://chatgpt.com/c/barrier-reload', generating: true, userMessageId: 'user-barrier' }]
    })
    t.after(() => releaseStop())
    assert.equal((await harness.request('conversation_stop', {
      conversationId: 'conv_barrier_reload', turnId: 'turn_timeout', requestId: 'barrier-reload-stop',
      expected: { userMessageId: 'user-barrier', assistantMessageId: null },
      externalUrl: 'https://chatgpt.com/c/barrier-reload', writerEpoch: 3
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
  const externalUrl = 'https://chatgpt.com/c/writer-epoch-all-mutations'
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
  const externalUrl = 'https://chatgpt.com/c/prepared-before-submit'
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
  const externalUrl = 'https://chatgpt.com/c/submit-response-lost'
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
  const externalUrl = 'https://chatgpt.com/c/profile-test'
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
  const unmanagedUrl = 'https://chatgpt.com/c/unmanaged-active'
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
  const targetUrl = 'https://chatgpt.com/g/g-p-project/c/thread-target'
  const otherUrl = 'https://chatgpt.com/g/g-p-project/c/thread-other'
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
  const firstUrl = 'https://chatgpt.com/g/g-p-project/c/thread-first'
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
    storage: { 'conversation:conv_other': { windowId: 10, tabId: 20, url: 'https://chatgpt.com/c/other' } },
    windows: [{ id: 10 }, { id: 11 }],
    tabs: [
      { id: 20, windowId: 10, url: 'https://chatgpt.com/c/other', active: true },
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
    tabs: [{ id: 21, windowId: 10, url: 'https://chatgpt.com/c/actual', active: true }]
  })

  const response = await harness.request('webgpt_shift_test', {
    target: 'Medium', target_tab_id: 21, target_url: 'https://chatgpt.com/c/expected'
  })

  assert.equal(response.ok, false)
  assert.match(response.error, /target_url/)
  assert.equal(harness.sentToTabs.length, 0)
})

test('webgpt shift probe rejects arbitrary ChatGPT routes and a missing explicit tab without fallback', async () => {
  for (const target of [
    { id: 21, url: 'https://chatgpt.com/settings' },
    { id: 21, url: 'https://chatgpt.com/c/actual/extra' },
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
  const externalUrl = 'https://chatgpt.com/c/profile-test'
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
  const externalUrl = 'https://chatgpt.com/c/pre-reload-123'
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
  const externalUrl = 'https://chatgpt.com/g/g-p-project123-agent/c/thread-456'
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
  const externalUrl = 'https://chatgpt.com/c/persistent-123'
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
  const externalUrl = 'https://chatgpt.com/c/legacy-human-bound'
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
  const externalUrl = 'https://chatgpt.com/c/persistent-456'
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10 },
      'conversation:conv_existing': { windowId: 10, tabId: 20, url: externalUrl }
    },
    windows: [{ id: 10 }],
    tabs: [{ id: 31, windowId: 10, url: 'https://chatgpt.com/c/unrelated' }]
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
  const externalUrl = 'https://chatgpt.com/c/persistent-789'
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
  const externalUrl = 'https://chatgpt.com/c/outbox-123'
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
  const externalUrl = 'https://chatgpt.com/c/durable-replay'
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
  const externalUrl = 'https://chatgpt.com/g/g-p-project/c/exact-state'
  const harness = makeHarness({
    storage: { window0: { windowId: 10 }, 'conversation:conv_state': { windowId: 10, tabId: 30, url: externalUrl } },
    windows: [{ id: 10 }],
    tabs: [
      { id: 30, windowId: 10, url: externalUrl, userMessageId: 'user-1', assistantMessageId: 'assistant-1', assistantText: 'FULL RESPONSE', generating: false, terminal: true, body: 'substantive', humanGate: false },
      { id: 31, windowId: 10, url: 'https://chatgpt.com/c/other', userMessageId: 'user-1', assistantText: 'WRONG' }
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
  const externalUrl = 'https://chatgpt.com/c/exact-latest-state'
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
  const externalUrl = 'https://chatgpt.com/c/exact-latest-anchor-missing'
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
  const externalUrl = 'https://chatgpt.com/c/exact-latest-invalid'
  const harness = makeHarness({ storage: { 'conversation:conv_state': { windowId: 10, tabId: 30, url: externalUrl } },
    windows: [{ id: 10 }], tabs: [{ id: 30, windowId: 10, url: externalUrl, userMessageId: 'synthetic-new-user', body: 'empty' }] })
  const response = await harness.request('conversation_state_observe', { conversationId: 'conv_state', externalUrl,
    turnId: 'old-turn', expectedUserMessageId: 'old-user', allowLatestUser: true })
  assert.equal(response.ok, true)
  assert.equal(response.result.readable, false)
  assert.equal(response.result.userMessageId, null)
})

test('conversation state observation fails closed when expected user identity is absent', async () => {
  const externalUrl = 'https://chatgpt.com/c/exact-state-missing'
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
  const externalUrl = 'https://chatgpt.com/g/g-p-project/c/exact-read'
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10 },
      'conversation:conv_existing': { windowId: 10, tabId: 30, url: externalUrl }
    },
    windows: [{ id: 10 }],
    tabs: [
      { id: 30, windowId: 10, url: externalUrl, assistantText: 'FULL RESPONSE', generating: false },
      { id: 31, windowId: 10, url: 'https://chatgpt.com/c/other', assistantText: 'WRONG', generating: false }
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
  const externalUrl = 'https://chatgpt.com/c/need-continue-123'
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
  const externalUrl = 'https://chatgpt.com/c/reload-race'
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
  const externalUrl = 'https://chatgpt.com/c/durable-ack'
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
  const externalUrl = 'https://chatgpt.com/c/right-thread'
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
      { id: 31, windowId: 10, url: 'https://chatgpt.com/c/wrong-thread' }
    ]
  })

  const response = await harness.emitRuntimeMessage({
    kind: 'conversation_event',
    event: {
      type: 'response_completed',
      conversationId: 'conv_existing',
      turnId: 'turn_right',
      text: 'wrong source',
      externalUrl: 'https://chatgpt.com/c/wrong-thread'
    }
  }, { tab: { id: 31, windowId: 10, url: 'https://chatgpt.com/c/wrong-thread' } })

  assert.equal(response?.durable, false)
  assert.equal(response?.reason, 'stale_source')
  assert.equal(harness.storageState['conversation:conv_existing'].tabId, 30)
  assert.equal(harness.storageState['conversation:conv_existing'].url, externalUrl)
  assert.equal(harness.storageState['pending:conv_existing'].turnId, 'turn_right')
  assert.equal(harness.storageState['outbox:terminal:conv_existing:turn_right:response_completed'], undefined)
})

test('navigation recovery claims a newer monitor owner and rejects the stale project monitor terminal', async () => {
  const projectUrl = 'https://chatgpt.com/g/g-p-project123-agent/project'
  const threadUrl = 'https://chatgpt.com/g/g-p-project123-agent/c/thread-owned'
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
  const threadUrl = 'https://chatgpt.com/g/g-p-project123-agent/c/thread-rebind'
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
  const threadUrl = 'https://chatgpt.com/g/g-p-project123-agent/c/thread-live-owner'
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
  const threadUrl = 'https://chatgpt.com/g/g-p-project123-agent/c/thread-spa'
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
    tabs: [{ id: 30, windowId: 10, url: 'https://chatgpt.com/c/canonical-123' }]
  })

  await harness.emitRuntimeMessage({
    kind: 'conversation_event',
    event: {
      type: 'response_completed',
      conversationId: 'conv_existing',
      turnId: 'turn_4',
      text: 'done',
      externalUrl: 'https://chatgpt.com/c/canonical-123'
    }
  }, { tab: { id: 30, windowId: 10 } })

  assert.equal(
    harness.storageState['conversation:conv_existing'].url,
    'https://chatgpt.com/c/canonical-123'
  )
  assert.equal(harness.storageState['conversation:conv_existing'].tabId, 30)
  assert.equal(harness.storageState['pending:conv_existing'], undefined)
})
