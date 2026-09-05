const NATIVE_HOST = 'com.conversation_sidecar.host'
const CHATGPT_URL = 'https://chatgpt.com/'
const STORAGE_PREFIX = 'conversation:'
const PENDING_PREFIX = 'pending:'
const OUTBOX_PREFIX = 'outbox:'
const WINDOW0_KEY = 'window0'

let nativePort = null
let reconnectTimer = null

function storageKey(conversationId) {
  return `${STORAGE_PREFIX}${conversationId}`
}

function pendingKey(conversationId) {
  return `${PENDING_PREFIX}${conversationId}`
}

function terminalEventId(event) {
  return `terminal:${event.conversationId}:${event.turnId}:${event.type}`
}

function outboxKey(eventId) {
  return `${OUTBOX_PREFIX}${eventId}`
}

function projectHomeUrl(url) {
  if (typeof url !== 'string' || !url) return null
  try {
    const parsed = new URL(url)
    if (parsed.origin !== 'https://chatgpt.com') return null
    const match = parsed.pathname.match(/^\/g\/g-p-[^/]+\/project\/?$/)
    return match ? `${parsed.origin}${match[0].replace(/\/$/, '')}` : null
  } catch {
    return null
  }
}

function stableConversationUrl(url) {
  if (typeof url !== 'string' || !url) return null
  try {
    const parsed = new URL(url)
    if (parsed.origin !== 'https://chatgpt.com') return null
    const rootMatch = parsed.pathname.match(/^\/c\/[^/]+/)
    if (rootMatch) return `${parsed.origin}${rootMatch[0]}`
    const projectMatch = parsed.pathname.match(/^\/g\/g-p-[^/]+\/c\/[^/]+/)
    return projectMatch ? `${parsed.origin}${projectMatch[0]}` : null
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
    void flushOutbox()
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

async function saveOutboxEvent(record) {
  await chrome.storage.local.set({ [outboxKey(record.eventId)]: record })
}

async function clearOutboxEvent(eventId) {
  await chrome.storage.local.remove(outboxKey(eventId))
}

async function loadOutboxEvent(eventId) {
  const key = outboxKey(eventId)
  const stored = await chrome.storage.local.get(key)
  return stored[key] ?? null
}

async function loadOutboxEvents() {
  const stored = await chrome.storage.local.get(null)
  return Object.entries(stored)
    .filter(([key, value]) => key.startsWith(OUTBOX_PREFIX) && value?.eventId && value?.event)
    .map(([, value]) => value)
}

async function flushOutbox() {
  try {
    for (const record of await loadOutboxEvents()) {
      postNative({ kind: 'event', eventId: record.eventId, event: record.event })
    }
  } catch {
    scheduleReconnect()
  }
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
    return {
      state,
      reattached: false,
      reloadOnReadinessFailure: liveTab.status === 'complete'
    }
  }

  const window0 = await ensureWindow0(expectedUrl)
  let tab = window0.created
    ? window0.tab
    : await findMatchingConversationTab(window0.windowId, expectedUrl)
  const matchedExistingTab = !window0.created && Boolean(tab)

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
  return {
    state,
    reattached: true,
    reloadOnReadinessFailure: matchedExistingTab && tab.status === 'complete'
  }
}

async function claimPendingTurnForTab(tab) {
  if (typeof tab?.id !== 'number') return null
  const stored = await chrome.storage.local.get(null)
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(PENDING_PREFIX)) continue
    if (value?.tabId !== tab.id) continue

    const claimed = {
      ...value,
      monitorVersion: Number.isInteger(value.monitorVersion) ? value.monitorVersion + 1 : 1
    }
    await savePendingTurn(claimed)

    const current = await loadConversation(claimed.conversationId)
    if (current) {
      await saveConversation(claimed.conversationId, {
        windowId: tab.windowId ?? current.windowId,
        tabId: tab.id,
        url: chooseConversationUrl(tabPageUrl(tab), current.url)
      })
    }
    return claimed
  }
  return null
}

async function claimAndKickRecoveryMonitor(tabId, changeInfo, tab) {
  const threadUrl = stableConversationUrl(changeInfo?.url)
  if (!threadUrl) return

  const claimed = await claimPendingTurnForTab({
    ...tab,
    id: tabId,
    url: threadUrl
  })
  if (!claimed) return

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'conversation_monitor_start',
      ...claimed,
      recovery: true
    })
  } catch {
    // A replacing document can still be loading. Its content script will
    // recover the same durable pending turn and claim a newer owner.
  }
}

async function waitForContentScript(tabId, maxAttempts = 80) {
  let lastError = null
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
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

async function waitForProjectHome(tabId) {
  let lastUrl = null
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const tab = await chrome.tabs.get(tabId)
    lastUrl = tabPageUrl(tab)
    const projectUrl = projectHomeUrl(lastUrl)
    if (projectUrl) return projectUrl
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for ChatGPT Project creation${lastUrl ? `; last URL was ${lastUrl}` : ''}`)
}

async function findProject(params) {
  const name = typeof params.name === 'string' ? params.name.trim() : ''
  if (!name) throw new Error('Project name is required')

  const tabs = await chrome.tabs.query({})
  for (const tab of tabs) {
    const url = tabPageUrl(tab)
    if (typeof tab.id !== 'number' || !chatGptPageUrl(url)) continue
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'project_find',
        name
      })
      if (response?.found !== true) continue
      const canonical = projectHomeUrl(response.projectUrl)
      if (!canonical) continue
      return {
        found: true,
        name,
        projectUrl: canonical,
        windowId: tab.windowId,
        tabId: tab.id
      }
    } catch {
      // A stale or loading ChatGPT tab is not authoritative; continue scanning.
    }
  }

  return { found: false, name }
}

async function createProject(params) {
  const name = typeof params.name === 'string' ? params.name.trim() : ''
  if (!name) throw new Error('Project name is required')

  const window0 = await ensureWindow0(CHATGPT_URL)
  const tab = window0.created
    ? window0.tab
    : await chrome.tabs.create({ windowId: window0.windowId, url: CHATGPT_URL, active: false })

  if (!tab || typeof tab.id !== 'number') {
    throw new Error('Chrome did not return a tab for Project creation')
  }

  await waitForContentScript(tab.id)
  const response = await chrome.tabs.sendMessage(tab.id, {
    type: 'project_create',
    name
  })
  if (response?.accepted !== true) {
    throw new Error(response?.error || 'ChatGPT content script rejected Project creation')
  }

  const projectUrl = await waitForProjectHome(tab.id)
  return {
    name,
    projectUrl,
    windowId: window0.windowId,
    tabId: tab.id
  }
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

async function ensureContentScriptForAttachment(state, reloadOnReadinessFailure) {
  try {
    await waitForContentScript(state.tabId, reloadOnReadinessFailure ? 8 : 80)
  } catch (error) {
    if (!reloadOnReadinessFailure) throw error
    await chrome.tabs.reload(state.tabId)
    await waitForContentScript(state.tabId)
  }
}

async function sendConversation(params) {
  const { state, reattached, reloadOnReadinessFailure } = await resolveConversationAttachment(
    params.conversationId,
    params.externalUrl
  )

  await ensureContentScriptForAttachment(state, reloadOnReadinessFailure)
  const prepared = await chrome.tabs.sendMessage(state.tabId, {
    type: 'conversation_prepare',
    conversationId: params.conversationId,
    turnId: params.turnId,
    text: params.text
  })
  if (prepared?.prepared !== true) {
    throw new Error(prepared?.error || 'ChatGPT content script could not prepare the prompt')
  }

  const currentState = {
    ...state,
    url: chooseConversationUrl(prepared.url, state.url)
  }
  await saveConversation(params.conversationId, currentState)

  let pending = {
    conversationId: params.conversationId,
    turnId: params.turnId,
    tabId: currentState.tabId,
    baselineAssistantCount: Number(prepared.baselineAssistantCount ?? 0),
    promptText: params.text,
    startedAt: Date.now(),
    phase: 'prepared',
    monitorVersion: 1
  }
  await savePendingTurn(pending)

  pending = { ...pending, phase: 'submitting' }
  await savePendingTurn(pending)
  const submitted = await chrome.tabs.sendMessage(currentState.tabId, {
    type: 'conversation_submit',
    conversationId: params.conversationId,
    turnId: params.turnId
  })
  if (submitted?.accepted !== true) {
    throw new Error(submitted?.error || 'ChatGPT content script rejected the prompt submission')
  }

  const submittedState = {
    ...currentState,
    url: chooseConversationUrl(submitted.url, currentState.url)
  }
  await saveConversation(params.conversationId, submittedState)
  pending = { ...pending, phase: 'submitted' }
  await savePendingTurn(pending)

  try {
    await chrome.tabs.sendMessage(submittedState.tabId, {
      type: 'conversation_monitor_start',
      ...pending
    })
  } catch {
    // Navigation may replace the document immediately after submit. The new
    // content script performs bounded pending lookup retries when it loads.
  }

  return {
    accepted: true,
    baselineAssistantCount: pending.baselineAssistantCount,
    windowId: submittedState.windowId,
    tabId: submittedState.tabId,
    url: submittedState.url,
    reattached
  }
}

async function executeRequest(message) {
  if (message.method === 'project_find') return findProject(message.params ?? {})
  if (message.method === 'project_create') return createProject(message.params ?? {})
  if (message.method === 'conversation_create') return createConversation(message.params ?? {})
  if (message.method === 'conversation_send') return sendConversation(message.params ?? {})
  throw new Error(`Unknown native request method: ${message.method}`)
}

async function handleNativeRequest(message) {
  if (message?.kind === 'event_ack') {
    if (typeof message.eventId === 'string' && message.eventId) {
      await clearOutboxEvent(message.eventId)
    }
    return
  }

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
    void claimPendingTurnForTab(sender.tab)
      .then((pending) => sendResponse(pending))
      .catch(() => sendResponse(null))
    return true
  }

  if (message?.kind !== 'conversation_event' || !message.event) return

  const event = message.event
  const isTerminal = event.type === 'response_completed' || event.type === 'error'
  if (isTerminal) {
    void (async () => {
      const eventId = terminalEventId(event)
      const existing = await loadOutboxEvent(eventId)
      if (existing) {
        sendResponse({ durable: true, eventId })
        void flushOutbox()
        return
      }

      const pending = await loadPendingTurn(event.conversationId)
      if (!pending || pending.turnId !== event.turnId) {
        sendResponse({ durable: false, reason: 'stale_turn' })
        return
      }

      const current = await loadConversation(event.conversationId)
      const senderTabId = sender.tab?.id
      const eventUrl = stableConversationUrl(event.externalUrl)
      const senderUrl = stableConversationUrl(sender.tab?.url)
      const currentUrl = stableConversationUrl(current?.url)
      const staleMonitor = Number.isInteger(pending.monitorVersion) && event.monitorVersion !== pending.monitorVersion
      if (staleMonitor) {
        sendResponse({ durable: false, reason: 'stale_monitor' })
        return
      }

      const wrongTab = typeof pending.tabId === 'number' && senderTabId !== pending.tabId
      const wrongSenderUrl = Boolean(eventUrl && senderUrl && eventUrl !== senderUrl)
      const wrongCurrentUrl = Boolean(currentUrl && eventUrl && currentUrl !== eventUrl)
      if (wrongTab || wrongSenderUrl || wrongCurrentUrl) {
        sendResponse({ durable: false, reason: 'stale_source' })
        return
      }

      const forwardedEvent = {
        ...event,
        tabId: senderTabId,
        windowId: sender.tab?.windowId
      }
      if (current || typeof senderTabId === 'number') {
        await saveConversation(event.conversationId, {
          windowId: sender.tab?.windowId ?? current?.windowId,
          tabId: senderTabId ?? current?.tabId,
          url: chooseConversationUrl(event.externalUrl, sender.tab?.url || current?.url)
        })
      }
      await saveOutboxEvent({ eventId, event: forwardedEvent })
      await clearPendingTurn(event.conversationId)
      sendResponse({ durable: true, eventId })
      void flushOutbox()
    })().catch(() => sendResponse({ durable: false, reason: 'storage_error' }))
    return true
  }

  void (async () => {
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

    const forwardedEvent = {
      ...event,
      tabId: sender.tab?.id,
      windowId: sender.tab?.windowId
    }
    try {
      postNative({ kind: 'event', event: forwardedEvent })
    } catch {
      scheduleReconnect()
    }
  })()
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!stableConversationUrl(changeInfo?.url)) return
  void claimAndKickRecoveryMonitor(tabId, changeInfo, tab)
})

chrome.runtime.onInstalled.addListener(connectNative)
chrome.runtime.onStartup.addListener(connectNative)
connectNative()
