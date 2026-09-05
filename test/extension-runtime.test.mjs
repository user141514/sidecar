import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const workerSource = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8')
const lifecycleSource = await readFile(new URL('../extension/lifecycle.js', import.meta.url), 'utf8')

function makeHarness({ storage = {}, windows = [], tabs = [], staleContentScriptTabIds = [], submitTransportFailure = false, deferReloadTimer = false, failAcceptedResponsePostOnce = false } = {}) {
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
  let nativeRequestListener = null
  let nativeDisconnectListener = null
  let failNativeEventPosts = false
  let nextTabId = 1000
  let nextWindowId = 2000
  const deferredReloadTimers = []
  let runtimeReloadCount = 0

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
      onMessage: {
        addListener(listener) {
          runtimeMessageListeners.push(listener)
        }
      },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} }
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
          Object.assign(storageState, values)
        },
        async remove(key) {
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
      async create({ url, type, focused }) {
        const windowId = nextWindowId++
        const tab = { id: nextTabId++, windowId, url }
        const window = { id: windowId, type, focused, tabs: [tab] }
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
        if (!tabMap.has(tabId)) throw new Error(`No tab ${tabId}`)
        reloadedTabs.push(tabId)
        staleContentScriptTabs.delete(tabId)
      },
      async sendMessage(tabId, message) {
        const tab = tabMap.get(tabId)
        if (!tab) throw new Error(`No tab ${tabId}`)
        sentToTabs.push({ tabId, message, storageSnapshot: structuredClone(storageState) })
        if (message.type === 'sidecar_ping') {
          if (staleContentScriptTabs.has(tabId)) throw new Error('Could not establish connection. Receiving end does not exist.')
          return { ready: true, url: tab.url }
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
          return { prepared: true, url: tab.url, baselineAssistantCount: 0 }
        }
        if (message.type === 'conversation_submit') {
          if (submitTransportFailure) throw new Error('submit response lost during navigation')
          return { accepted: true, url: tab.url }
        }
        if (message.type === 'conversation_send') {
          return { accepted: true, url: tab.url, baselineAssistantCount: 0 }
        }
        if (message.type === 'conversation_monitor_start') return { started: true }
        throw new Error(`Unexpected tab message ${message.type}`)
      }
    }
  }

  const fastSetTimeout = (callback) => {
    queueMicrotask(callback)
    return 1
  }

  const context = vm.createContext({
    chrome,
    crypto: { randomUUID: () => 'test-instance' },
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
      return fastSetTimeout(callback)
    },
    clearTimeout() {}
  })
  vm.runInContext(workerSource, context, { filename: 'extension/service-worker.js' })

  async function request(method, params) {
    if (!nativeRequestListener) throw new Error('Native request listener was not registered')
    const requestId = `req-${nativeMessages.length}`
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

test('project_create opens one root tab in window0 and returns its canonical Project URL', async () => {
  const harness = makeHarness({
    storage: { window0: { windowId: 10 } },
    windows: [{ id: 10 }]
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

test('send reloads a matching tab whose content script was invalidated by extension reload', async () => {
  const externalUrl = 'https://chatgpt.com/c/pre-reload-123'
  const harness = makeHarness({
    storage: {
      window0: { windowId: 10 },
      'conversation:conv_existing': { windowId: 10, tabId: 20, url: externalUrl }
    },
    windows: [{ id: 10 }],
    tabs: [{ id: 20, windowId: 10, url: externalUrl, status: 'complete' }],
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
      window0: { windowId: 10 },
      'conversation:conv_project': { windowId: 10, tabId: 20, url: externalUrl }
    },
    windows: [{ id: 10 }],
    tabs: [{ id: 30, windowId: 10, url: externalUrl }]
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
      window0: { windowId: 10 },
      'conversation:conv_existing': { windowId: 10, tabId: 20, url: externalUrl }
    },
    windows: [{ id: 10 }],
    tabs: [{ id: 30, windowId: 10, url: externalUrl }]
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

test('send replaces stale physical window0 and attaches the old logical conversation to its initial tab', async () => {
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
  assert.equal(harness.createdWindows[0].tabs[0].url, externalUrl)
  assert.equal(harness.createdTabs.length, 0)
  assert.equal(
    harness.storageState['conversation:conv_existing'].tabId,
    harness.createdWindows[0].tabs[0].id
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

test('reload remains scheduled when the accepted native response transport is lost', async () => {
  const harness = makeHarness({
    deferReloadTimer: true,
    failAcceptedResponsePostOnce: true
  })

  const response = await harness.request('extension_reload', {
    requestId: 'reload-lost-ack',
    expectedInstanceId: 'test-instance',
    expectedBuildId: 'a'.repeat(64)
  })

  assert.equal(response.ok, false, 'the simulated native transport must lose the accepted response')
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
