const NATIVE_HOST = 'com.conversation_sidecar.host'
const CHATGPT_URL = 'https://chatgpt.com/'
const STORAGE_PREFIX = 'conversation:'
const PENDING_PREFIX = 'pending:'
const WINDOW0_KEY = 'window0'

let nativePort = null
let reconnectTimer = null

function storageKey(conversationId) {
  return `${STORAGE_PREFIX}${conversationId}`
}

function pendingKey(conversationId) {
  return `${PENDING_PREFIX}${conversationId}`
}

function stableConversationUrl(url) {
  if (typeof url !== 'string' || !url) return null
  try {
    const parsed = new URL(url)
    if (parsed.origin !== 'https://chatgpt.com') return null
    const match = parsed.pathname.match(/^\/c\/[^/]+/)
    return match ? `${parsed.origin}${match[0]}` : null
  } catch {
    return null
  }
}

function chatGptPageUrl(url) {
  if (typeof url !== 'string' || !url) return null
  try {
    const parsed = new URL(url)
    if (parsed.origin !== 'https://chatgpt.com') return null
    const pathname = parsed.pathname === '/' ? '/' : parsed.pathname.replace(/\/+$/, '')
    return `${parsed.origin}${pathname}`
  } catch {
    return null
  }
}

function chooseConversationUrl(preferred, fallback) {
  return stableConversationUrl(preferred) ||
    stableConversationUrl(fallback) ||
    chatGptPageUrl(preferred) ||
    chatGptPageUrl(fallback) ||
    CHATGPT_URL
}

function tabPageUrl(tab) {
  return tab?.pendingUrl || tab?.url || null
}

function tabMatchesExpectedUrl(tab, expectedUrl) {
  const expectedStable = stableConversationUrl(expectedUrl)
  if (expectedStable) return stableConversationUrl(tabPageUrl(tab)) === expectedStable
  return chatGptPageUrl(tabPageUrl(tab)) === chatGptPageUrl(expectedUrl)
}

function postNative(message) {
  if (!nativePort) throw new Error('Native host is not connected')
  nativePort.postMessage(message)
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectNative()
  }, 1000)
}

function connectNative() {
  if (nativePort) return
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST)
    nativePort = port
    port.onMessage.addListener((message) => {
      void handleNativeRequest(message)
    })
    port.onDisconnect.addListener(() => {
      nativePort = null
      scheduleReconnect()
    })
    port.postMessage({ kind: 'bridge_ready', extensionVersion: chrome.runtime.getManifest().version })
  } catch {
    nativePort = null
    scheduleReconnect()
  }
}

async function saveConversation(conversationId, value) {
  await chrome.storage.local.set({ [storageKey(conversationId)]: value })
}

async function loadConversation(conversationId) {
  const key = storageKey(conversationId)
  const stored = await chrome.storage.local.get(key)
  return stored[key] ?? null
}

async function savePendingTurn(pending) {
  await chrome.storage.local.set({ [pendingKey(pending.conversationId)]: pending })
}

async function loadPendingTurn(conversationId) {
  const key = pendingKey(conversationId)
  const stored = await chrome.storage.local.get(key)
  return stored[key] ?? null
}

async function clearPendingTurn(conversationId) {
  await chrome.storage.local.remove(pendingKey(conversationId))
}

async function loadWindow0() {
  const stored = await chrome.storage.local.get(WINDOW0_KEY)
  return stored[WINDOW0_KEY] ?? null
}

async function saveWindow0(window0) {
  await chrome.storage.local.set({ [WINDOW0_KEY]: window0 })
}

async function clearWindow0() {
  await chrome.storage.local.remove(WINDOW0_KEY)
}

async function ensureWindow0(url) {
  const stored = await loadWindow0()
  if (typeof stored?.windowId === 'number') {
    try {
      await chrome.windows.get(stored.windowId)
      return { windowId: stored.windowId, created: false, tab: null }
    } catch {
      await clearWindow0()
    }
  }

  const window = await chrome.windows.create({
    url,
    type: 'normal',
    focused: false
  })
  const tab = window?.tabs?.[0]
  if (!window || typeof window.id !== 'number' || !tab || typeof tab.id !== 'number') {
    throw new Error('Chrome did not return window0 and its initial tab')
  }

  const window0 = { windowId: window.id }
  await saveWindow0(window0)
  return { ...window0, created: true, tab }
}

async function findRegisteredLiveTab(state, expectedUrl) {
  if (!state || typeof state.tabId !== 'number') return null
  try {
    const tab = await chrome.tabs.get(state.tabId)
    return tabMatchesExpectedUrl(tab, expectedUrl) ? tab : null
  } catch {
    return null
  }
}

async function findMatchingConversationTab(windowId, expectedUrl) {
  if (!stableConversationUrl(expectedUrl)) return null
  const tabs = await chrome.tabs.query({ windowId })
  return tabs.find((tab) => tabMatchesExpectedUrl(tab, expectedUrl)) ?? null
}

async function resolveConversationAttachment(conversationId, requestedUrl) {
  const stored = await loadConversation(conversationId)
  const expectedUrl = chooseConversationUrl(requestedUrl, stored?.url)
  const liveTab = await findRegisteredLiveTab(stored, expectedUrl)

  if (liveTab) {
    const state = {
      windowId: liveTab.windowId,
      tabId: liveTab.id,
      url: chooseConversationUrl(tabPageUrl(liveTab), expectedUrl)
    }
    await saveConversation(conversationId, state)
    return { state, reattached: false }
  }

  const window0 = await ensureWindow0(expectedUrl)
  let tab = window0.created
    ? window0.tab
    : await findMatchingConversationTab(window0.windowId, expectedUrl)

  if (!tab) {
    tab = await chrome.tabs.create({
      windowId: window0.windowId,
      url: expectedUrl,
      active: false
    })
  }

  if (!tab || typeof tab.id !== 'number') {
    throw new Error(`Could not attach ${conversationId} to a Chrome tab`)
  }

  const state = {
    windowId: window0.windowId,
    tabId: tab.id,
    url: chooseConversationUrl(tabPageUrl(tab), expectedUrl)
  }
  await saveConversation(conversationId, state)
  return { state, reattached: true }
}

async function pendingTurnForTab(tabId) {
  if (typeof tabId !== 'number') return null
  const stored = await chrome.storage.local.get(null)
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(PENDING_PREFIX)) continue
    if (value?.tabId === tabId) return value
  }
  return null
}

async function waitForContentScript(tabId) {
  let lastError = null
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'sidecar_ping' })
      if (response?.ready === true) return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw lastError ?? new Error('ChatGPT content script did not become ready')
}

async function createConversation(params) {
  const url = params.url || CHATGPT_URL
  const window0 = await ensureWindow0(url)
  const tab = window0.created
    ? window0.tab
    : await chrome.tabs.create({ windowId: window0.windowId, url, active: false })

  if (!tab || typeof tab.id !== 'number') {
    throw new Error('Chrome did not return a tab for the new conversation')
  }

  const state = {
    windowId: window0.windowId,
    tabId: tab.id,
    url: tab.pendingUrl || tab.url || url
  }
  await saveConversation(params.conversationId, state)
  return state
}

async function sendConversation(params) {
  const { state, reattached } = await resolveConversationAttachment(
    params.conversationId,
    params.externalUrl
  )

  await waitForContentScript(state.tabId)
  const response = await chrome.tabs.sendMessage(state.tabId, {
    type: 'conversation_send',
    conversationId: params.conversationId,
    turnId: params.turnId,
    text: params.text
  })
  if (response?.accepted !== true) {
    throw new Error(response?.error || 'ChatGPT content script rejected the prompt')
  }

  const currentState = {
    ...state,
    url: chooseConversationUrl(response.url, state.url)
  }
  await saveConversation(params.conversationId, currentState)

  const pending = {
    conversationId: params.conversationId,
    turnId: params.turnId,
    tabId: currentState.tabId,
    baselineAssistantCount: Number(response.baselineAssistantCount ?? 0),
    startedAt: Date.now()
  }
  await savePendingTurn(pending)

  try {
    await chrome.tabs.sendMessage(currentState.tabId, {
      type: 'conversation_monitor_start',
      ...pending
    })
  } catch {
    // Navigation may replace the document immediately after submit. The new
    // content script resumes from chrome.storage.local when it loads.
  }

  return {
    ...response,
    baselineAssistantCount: pending.baselineAssistantCount,
    windowId: currentState.windowId,
    tabId: currentState.tabId,
    url: currentState.url,
    reattached
  }
}

async function executeRequest(message) {
  if (message.method === 'conversation_create') return createConversation(message.params ?? {})
  if (message.method === 'conversation_send') return sendConversation(message.params ?? {})
  throw new Error(`Unknown native request method: ${message.method}`)
}

async function handleNativeRequest(message) {
  if (message?.kind !== 'request' || typeof message.requestId !== 'string') return
  try {
    const result = await executeRequest(message)
    postNative({ kind: 'response', requestId: message.requestId, ok: true, result })
  } catch (error) {
    postNative({
      kind: 'response',
      requestId: message.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.kind === 'pending_turn_lookup') {
    void pendingTurnForTab(sender.tab?.id)
      .then((pending) => sendResponse(pending))
      .catch(() => sendResponse(null))
    return true
  }

  if (message?.kind !== 'conversation_event' || !message.event) return

  void (async () => {
    const event = message.event
    const conversationId = event.conversationId
    if (typeof conversationId === 'string') {
      const current = await loadConversation(conversationId)
      if (current || typeof sender.tab?.id === 'number') {
        await saveConversation(conversationId, {
          windowId: sender.tab?.windowId ?? current?.windowId,
          tabId: sender.tab?.id ?? current?.tabId,
          url: chooseConversationUrl(event.externalUrl, sender.tab?.url || current?.url)
        })
      }
    }

    if (event.type === 'response_completed' || event.type === 'error') {
      const pending = await loadPendingTurn(event.conversationId)
      if (!pending || pending.turnId !== event.turnId) return
      await clearPendingTurn(event.conversationId)
    }

    try {
      postNative({
        kind: 'event',
        event: {
          ...event,
          tabId: sender.tab?.id,
          windowId: sender.tab?.windowId
        }
      })
    } catch {
      scheduleReconnect()
    }
  })()
})

chrome.runtime.onInstalled.addListener(connectNative)
chrome.runtime.onStartup.addListener(connectNative)
connectNative()
