importScripts('build-info.js', 'lifecycle.js')
const extensionLifecycle = createSidecarLifecycle({
  chrome,
  buildId: globalThis.__sidecarBuildId,
  instanceId: crypto.randomUUID(),
  matchesTab: tabMatchesExpectedUrl
})
const lifecycleReady = extensionLifecycle.restoreAfterReload()

const NATIVE_HOST = 'com.conversation_sidecar.host'
const CHATGPT_URL = 'https://chatgpt.com/'
const STORAGE_PREFIX = 'conversation:'
const PENDING_PREFIX = 'pending:'
const OUTBOX_PREFIX = 'outbox:'
const WINDOW0_KEY = 'window0'

let nativePort = null
let reconnectTimer = null
const sendOwners = new Set()
const tabOwners = new Map()
const activeSends = new Map()

function deliveryUncertain(error) {
  return Object.assign(new Error(error instanceof Error ? error.message : String(error)), { code: 'DELIVERY_UNCERTAIN' })
}

async function boundedMessage(tabId, message, timeoutMs, onLateResponse) {
  let timer
  let expired = false
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, message).then(result => {
        if (expired && onLateResponse) void onLateResponse(result).catch(() => {})
        return result
      }),
      new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error(`Content script response timeout: ${message.type}`)) }, timeoutMs) })
    ])
  } finally { clearTimeout(timer) }
}

function canonicalProjectPath(path) {
  return path.replace(/^(\/g\/g-p-[a-f0-9]{32})(?:-[^/]+)?(?=\/)/i, '$1')
}

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

function pageIdentity(url) {
  const page = chatGptPageUrl(url)
  if (!page) return null
  const parsed = new URL(page)
  return parsed.origin + canonicalProjectPath(parsed.pathname)
}

function tabMatchesExpectedUrl(tab, expectedUrl) {
  const expectedStable = stableConversationUrl(expectedUrl)
  if (expectedStable) return pageIdentity(stableConversationUrl(tabPageUrl(tab))) === pageIdentity(expectedStable)
  return pageIdentity(tabPageUrl(tab)) === pageIdentity(expectedUrl)
}

function projectIdentity(url) {
  if (typeof url !== 'string' || !url) return null
  try {
    const parsed = new URL(url)
    if (parsed.origin !== 'https://chatgpt.com') return null
    const match = parsed.pathname.match(/^\/g\/(g-p-[a-f0-9]{32})(?:-[^/]+)?(?=\/)/i)
    return match ? `${parsed.origin}/g/${match[1].toLowerCase()}` : null
  } catch {
    return null
  }
}

async function findProjectConversationSeedUrl(projectUrl) {
  const expectedIdentity = projectIdentity(projectUrl)
  if (!expectedIdentity) return null
  for (const tab of await chrome.tabs.query({})) {
    const currentUrl = stableConversationUrl(tabPageUrl(tab))
    if (!currentUrl || projectIdentity(currentUrl) !== expectedIdentity) continue
    return currentUrl
  }
  return null
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
    if (value.phase === 'preparing' || value.phase === 'prepared') continue

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
  const deadline = Date.now() + maxAttempts * 250
  for (let attempt = 0; attempt < maxAttempts && Date.now() < deadline; attempt += 1) {
    try {
      const response = await boundedMessage(tabId, { type: 'sidecar_ping' }, Math.min(2000, Math.max(1, deadline - Date.now())))
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

async function waitForProjectDraftSurface(tabId, expectedProjectUrl) {
  const expectedRoute = chatGptPageUrl(expectedProjectUrl)
  let lastUrl = null
  let lastError = null
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId)
    lastUrl = tabPageUrl(tab)
    const actualProjectUrl = projectHomeUrl(lastUrl)
    if (actualProjectUrl && chatGptPageUrl(actualProjectUrl) === expectedRoute) {
      try {
        const page = await boundedMessage(tabId, { type: 'sidecar_ping' }, Math.min(2000, Math.max(1, deadline - Date.now())))
        if (page?.ready === true && page?.composerPresent === true) return actualProjectUrl
      } catch (error) {
        lastError = error
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const detail = lastError instanceof Error ? `; last error was ${lastError.message}` : ''
  throw new Error(`ChatGPT Project draft surface did not become ready${lastUrl ? `; last URL was ${lastUrl}` : ''}${detail}`)
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
  const projectUrl = projectHomeUrl(url)
  const projectSeedUrl = projectUrl ? await findProjectConversationSeedUrl(projectUrl) : null
  const initialUrl = projectUrl ? (projectSeedUrl || CHATGPT_URL) : url
  const window0 = await ensureWindow0(initialUrl)
  const tab = window0.created
    ? window0.tab
    : await chrome.tabs.create({ windowId: window0.windowId, url: initialUrl, active: Boolean(projectUrl) })

  if (!tab || typeof tab.id !== 'number') {
    throw new Error('Chrome did not return a tab for the new conversation')
  }

  let attachedUrl = tab.pendingUrl || tab.url || initialUrl
  if (projectUrl) {
    await waitForContentScript(tab.id)
    const opened = await boundedMessage(tab.id, { type: 'project_open', projectUrl }, 15_000)
    if (opened?.accepted !== true) {
      throw new Error(opened?.error || 'ChatGPT content script could not open the Project')
    }
    const navigationProjectUrl = projectHomeUrl(opened?.projectUrl) || projectUrl
    try {
      attachedUrl = await waitForProjectDraftSurface(tab.id, navigationProjectUrl)
    } catch (error) {
      const control = opened?.control ? `; project_open control=${JSON.stringify(opened.control)}` : ''
      throw new Error(`${error instanceof Error ? error.message : String(error)}${control}`)
    }
  }

  const state = {
    windowId: window0.windowId,
    tabId: tab.id,
    url: attachedUrl
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
  const id = params.conversationId
  if (sendOwners.has(id)) throw deliveryUncertain('Conversation already has an active browser send')
  sendOwners.add(id)
  const operation = { conversationId: id, turnId: params.turnId, phase: 'attaching', startedAt: Date.now() }
  activeSends.set(id, operation)
  try {
    if (await loadPendingTurn(id)) throw deliveryUncertain('Conversation has an unresolved pending turn; read its result before sending again')
    return await performSend(params, operation)
  } catch (error) {
    if (error?.code !== 'DELIVERY_UNCERTAIN') {
      const event = {
        type: 'error', conversationId: id, turnId: params.turnId,
        message: error instanceof Error ? error.message : String(error)
      }
      await saveOutboxEvent({ eventId: terminalEventId(event), event })
      void flushOutbox()
    }
    throw error
  } finally {
    sendOwners.delete(id)
    activeSends.delete(id)
    if (tabOwners.get(operation.tabId) === id) tabOwners.delete(operation.tabId)
  }
}

async function performSend(params, operation) {
  const { state, reattached, reloadOnReadinessFailure } = await resolveConversationAttachment(
    params.conversationId,
    params.externalUrl
  )

  operation.tabId = state.tabId
  if (tabOwners.has(state.tabId)) throw deliveryUncertain('Tab already has an active browser send')
  const stored = await chrome.storage.local.get(null)
  if (Object.entries(stored).some(([key, value]) => key.startsWith(PENDING_PREFIX) && value?.tabId === state.tabId)) {
    throw deliveryUncertain('Tab has an unresolved pending turn')
  }
  tabOwners.set(state.tabId, params.conversationId)
  operation.phase = 'readiness'
  await ensureContentScriptForAttachment(state, reloadOnReadinessFailure)
  let pending = {
    conversationId: params.conversationId,
    turnId: params.turnId,
    tabId: state.tabId,
    promptText: params.text,
    startedAt: Date.now(),
    phase: 'preparing',
    monitorVersion: 1
  }
  await savePendingTurn(pending)
  operation.phase = 'preparing'
  let prepared
  try { prepared = await boundedMessage(state.tabId, {
    type: 'conversation_prepare',
    conversationId: params.conversationId,
    turnId: params.turnId,
    text: params.text,
    ...(params.app ? { app: params.app } : {})
  }, 60_000, async () => {
    // The late receipt proves prepare has ended. This send path has already
    // stopped before submit, so closing only this preparing turn is safe.
    const current = await loadPendingTurn(params.conversationId)
    if (current?.turnId !== params.turnId || current.phase !== 'preparing') return
    const event = {
      type: 'error', conversationId: params.conversationId, turnId: params.turnId,
      message: 'Prepare acknowledgement arrived after timeout; prompt was not submitted'
    }
    await saveOutboxEvent({ eventId: terminalEventId(event), event })
    await clearPendingTurn(params.conversationId)
    void flushOutbox()
  }) } catch (error) { throw deliveryUncertain(error) }
  if (prepared?.prepared !== true) {
    await clearPendingTurn(params.conversationId)
    throw new Error(prepared?.error || 'ChatGPT content script could not prepare the prompt')
  }

  const currentState = {
    ...state,
    url: chooseConversationUrl(prepared.url, state.url)
  }
  await saveConversation(params.conversationId, currentState)

  pending = {
    ...pending,
    baselineAssistantCount: Number(prepared.baselineAssistantCount ?? 0),
    phase: 'prepared'
  }
  await savePendingTurn(pending)

  pending = { ...pending, phase: 'submitting' }
  await savePendingTurn(pending)
  operation.phase = 'submitting'
  let submitted
  try { submitted = await boundedMessage(currentState.tabId, {
    type: 'conversation_submit',
    conversationId: params.conversationId,
    turnId: params.turnId
  }, 15_000) } catch (error) { throw deliveryUncertain(error) }
  if (submitted?.accepted !== true) {
    await clearPendingTurn(params.conversationId)
    throw new Error(submitted?.error || 'ChatGPT content script rejected the prompt submission')
  }

  const submittedState = {
    ...currentState,
    url: chooseConversationUrl(submitted.url, currentState.url)
  }
  await saveConversation(params.conversationId, submittedState)
  pending = { ...pending, phase: 'submitted' }
  const currentPending = await loadPendingTurn(params.conversationId)
  if (currentPending?.turnId !== params.turnId) return { accepted: true, ...submittedState, reattached }
  pending.monitorVersion = currentPending.monitorVersion
  await savePendingTurn(pending)

  operation.phase = 'monitoring'
  try {
    await boundedMessage(submittedState.tabId, {
      type: 'conversation_monitor_start',
      ...pending
    }, 2000)
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

async function reconcileClosedPreSubmitTurns() {
  // Run once before accepting sends. A missing tab cannot continue prepare,
  // and these durable phases prove the worker never issued submit.
  const stored = await chrome.storage.local.get(null)
  const tabs = await chrome.tabs.query({})
  const liveTabIds = new Set(tabs.map(tab => tab.id))
  for (const [key, pending] of Object.entries(stored)) {
    if (!key.startsWith(PENDING_PREFIX) || !pending?.conversationId || !pending.turnId) continue
    if (pending.phase !== 'preparing' && pending.phase !== 'prepared') continue
    if (typeof pending.tabId !== 'number' || liveTabIds.has(pending.tabId)) continue
    const event = {
      type: 'error', conversationId: pending.conversationId, turnId: pending.turnId,
      message: 'Pre-submit turn interrupted and original tab closed; prompt was not submitted'
    }
    await saveOutboxEvent({ eventId: terminalEventId(event), event })
    await clearPendingTurn(pending.conversationId)
  }
  await flushOutbox()
}

async function executeRequest(message) {
  await recoveryReady
  if (message.method === 'extension_status') {
    const stored = await chrome.storage.local.get(null)
    const bindings = Object.entries(stored).filter(([key]) => key.startsWith(STORAGE_PREFIX))
    const tabs = await chrome.tabs.query({})
    const managedTabs = tabs.filter(tab => bindings.some(([, binding]) => binding?.tabId === tab.id))
      .map(tab => ({ tabId: tab.id, windowId: tab.windowId, url: tabPageUrl(tab), title: tab.title, status: tab.status, discarded: tab.discarded }))
    await Promise.all(managedTabs.map(async tab => {
      try { tab.page = await boundedMessage(tab.tabId, { type: 'sidecar_ping' }, 2000) }
      catch (error) { tab.pageError = error instanceof Error ? error.message : String(error) }
    }))
    return { ...await extensionLifecycle.status(), operations: [...activeSends.values()], managedTabs }
  }
  if (message.method === 'extension_reload') return extensionLifecycle.requestReload(message.params)
  if (message.method === 'project_find') return findProject(message.params ?? {})
  if (message.method === 'project_create') return extensionLifecycle.runMutation(() => createProject(message.params ?? {}))
  if (message.method === 'conversation_create') return extensionLifecycle.runMutation(() => createConversation(message.params ?? {}))
  if (message.method === 'conversation_send') return extensionLifecycle.runMutation(() => sendConversation(message.params ?? {}))
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
    extensionLifecycle.afterResponse(message.method, result)
    postNative({ kind: 'response', requestId: message.requestId, ok: true, result })
  } catch (error) {
    postNative({
      kind: 'response',
      requestId: message.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      errorCode: error?.code
    })
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.kind === 'pending_turn_lookup') {
    void extensionLifecycle.runMutation(() => claimPendingTurnForTab(sender.tab))
      .then((pending) => sendResponse(pending))
      .catch(() => sendResponse(null))
    return true
  }

  if (message?.kind !== 'conversation_event' || !message.event) return

  const event = message.event
  const isTerminal = event.type === 'response_completed' || event.type === 'error'
  if (isTerminal) {
    void extensionLifecycle.runMutation(async () => {
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
      const wrongSenderUrl = Boolean(eventUrl && senderUrl && pageIdentity(eventUrl) !== pageIdentity(senderUrl))
      const wrongCurrentUrl = Boolean(currentUrl && eventUrl && pageIdentity(currentUrl) !== pageIdentity(eventUrl))
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
    }).catch((error) => sendResponse({
      durable: false,
      reason: /reload in progress/i.test(error instanceof Error ? error.message : String(error))
        ? 'reload_in_progress'
        : 'storage_error'
    }))
    return true
  }

  void extensionLifecycle.runMutation(async () => {
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
  }).catch(() => {})
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!stableConversationUrl(changeInfo?.url)) return
  void extensionLifecycle.runMutation(() => claimAndKickRecoveryMonitor(tabId, changeInfo, tab)).catch(() => {})
})

const recoveryReady = lifecycleReady.then(reconcileClosedPreSubmitTurns)
chrome.runtime.onInstalled.addListener(connectNative)
chrome.runtime.onStartup.addListener(connectNative)
connectNative()
