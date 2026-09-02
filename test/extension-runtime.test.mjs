import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const workerSource = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8')

function makeHarness({ storage = {}, windows = [], tabs = [], staleContentScriptTabIds = [] } = {}) {
  const storageState = { ...storage }
  const staleContentScriptTabs = new Set(staleContentScriptTabIds)
  const windowMap = new Map(windows.map((window) => [window.id, { ...window }]))
  const tabMap = new Map(tabs.map((tab) => [tab.id, { ...tab }]))
  const nativeMessages = []
  const runtimeMessageListeners = []
  const sentToTabs = []
  const createdTabs = []
  const createdWindows = []
  const reloadedTabs = []
  let nativeRequestListener = null
  let nativeDisconnectListener = null
  let failNativeEventPosts = false
  let nextTabId = 1000
  let nextWindowId = 2000

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
      if (failNativeEventPosts && message?.kind === 'event') {
        throw new Error('Native host disconnected during event delivery')
      }
      nativeMessages.push(message)
    }
  }

  const chrome = {
    runtime: {
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
      async get(tabId) {
        const tab = tabMap.get(tabId)
        if (!tab) throw new Error(`No tab ${tabId}`)
        return { ...tab }
      },
      async query({ windowId }) {
        return [...tabMap.values()]
          .filter((tab) => tab.windowId === windowId)
          .map((tab) => ({ ...tab }))
      },
      async create({ windowId, url, active }) {
        if (!windowMap.has(windowId)) throw new Error(`No window ${windowId}`)
        const tab = { id: nextTabId++, windowId, url, active }
        tabMap.set(tab.id, tab)
        createdTabs.push(tab)
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
        sentToTabs.push({ tabId, message })
        if (message.type === 'sidecar_ping') {
          if (staleContentScriptTabs.has(tabId)) throw new Error('Could not establish connection. Receiving end does not exist.')
          return { ready: true, url: tab.url }
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

  vm.runInNewContext(workerSource, {
    chrome,
    console,
    URL,
    Date,
    Promise,
    Object,
    setTimeout: fastSetTimeout,
    clearTimeout() {}
  }, { filename: 'extension/service-worker.js' })

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
    for (const listener of runtimeMessageListeners) listener(message, sender, () => {})
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  async function sendNativeMessage(message) {
    if (!nativeRequestListener) throw new Error('Native request listener was not registered')
    nativeRequestListener(message)
    for (let attempt = 0; attempt < 4; attempt += 1) {
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
    reconnectNative,
    setFailNativeEventPosts(value) {
      failNativeEventPosts = value
    }
  }
}

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
    harness.sentToTabs.some(({ tabId, message }) => tabId === 20 && message.type === 'conversation_send'),
    true
  )
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
    harness.sentToTabs.some(({ tabId, message }) => tabId === 30 && message.type === 'conversation_send'),
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
