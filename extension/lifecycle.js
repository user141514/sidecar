// Shared by the integrated Sidecar and standalone provider. No OS decisions here.
function createSidecarLifecycle({ chrome, buildId, instanceId, matchesTab, schedule = setTimeout }) {
  const receiptKey = 'reload:receipt'
  let activeOperations = 0
  let admitted = null
  let admissionPromise = null
  let scheduled = false
  let restoration = { state: 'starting', refreshedTabs: [], skippedTabs: [] }

  async function status() {
    const state = await chrome.storage.local.get(null)
    return {
      extensionId: chrome.runtime.id,
      version: chrome.runtime.getManifest().version,
      buildId,
      instanceId,
      pendingCount: Object.keys(state).filter((key) => key.startsWith('pending:')).length,
      outboxCount: Object.keys(state).filter((key) => key.startsWith('outbox:')).length,
      activeOperations,
      reloading: admitted !== null,
      lastReload: state[receiptKey] ?? null,
      restoration
    }
  }

  async function runMutation(action) {
    if (admitted || restoration.state === 'restoring') throw new Error('Extension reload in progress')
    activeOperations += 1
    try { return await action() } finally { activeOperations -= 1 }
  }

  async function requestReload({ requestId, expectedInstanceId, expectedBuildId } = {}) {
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) throw new Error('Invalid reload requestId')
    if (typeof expectedBuildId !== 'string' || !/^[a-f0-9]{64}$/.test(expectedBuildId)) throw new Error('Invalid target build ID')
    if (expectedInstanceId !== instanceId) throw new Error('Extension instance changed; read status again')
    if (admitted) {
      if (admitted.requestId !== requestId || admitted.expectedBuildId !== expectedBuildId) throw new Error('Extension reload already in progress')
      await admissionPromise
      return { accepted: true, requestId, previousInstanceId: instanceId }
    }
    if (activeOperations || restoration.state === 'restoring') throw new Error('Extension busy: browser mutation or restore in flight')
    admitted = { requestId, previousInstanceId: instanceId, expectedBuildId }
    admissionPromise = (async () => {
      const before = await status()
      if (before.pendingCount || before.outboxCount) throw new Error('Extension busy: pending turns or unacknowledged outbox; no force reload')
      await chrome.storage.local.set({ [receiptKey]: admitted })
    })()
    try {
      await admissionPromise
      return { accepted: true, requestId, previousInstanceId: instanceId }
    } catch (error) {
      admitted = null
      throw error
    }
  }

  function afterResponse(method, result) {
    if (method !== 'extension_reload' || !result?.accepted || result.requestId !== admitted?.requestId || scheduled) return
    scheduled = true
    // Native response is posted before scheduling. The independent CLI tolerates
    // losing its HTTP ACK and verifies the receipt after host replacement.
    schedule(() => chrome.runtime.reload(), 250)
  }

  async function bounded(action, timeoutMs = 2000) {
    let timer
    try {
      return await Promise.race([
        action(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Content script readiness timeout')), timeoutMs) })
      ])
    } finally { clearTimeout(timer) }
  }

  async function restoreAfterReload() {
    const state = await chrome.storage.local.get(null)
    const receipt = state[receiptKey]
    restoration = { state: 'ready', refreshedTabs: [], skippedTabs: [] }
    if (!receipt || receipt.previousInstanceId === instanceId) return
    if (receipt.expectedBuildId !== buildId) {
      restoration = { ...restoration, state: 'failed', error: 'Target build mismatch' }
      return
    }
    if (Object.keys(state).some((key) => key.startsWith('pending:'))) {
      restoration = { ...restoration, state: 'failed', error: 'Pending turns appeared during reload' }
      return
    }
    restoration.state = 'restoring'
    const seen = new Set()
    try {
      for (const [key, binding] of Object.entries(state)) {
        if (!key.startsWith('conversation:') || !Number.isInteger(binding?.tabId) || seen.has(binding.tabId)) continue
        seen.add(binding.tabId)
        let tab
        try { tab = await chrome.tabs.get(binding.tabId) } catch {
          restoration.skippedTabs.push({ tabId: binding.tabId, reason: 'closed' })
          continue
        }
        if (!matchesTab(tab, binding.url)) {
          restoration.skippedTabs.push({ tabId: tab.id, reason: 'binding_changed' })
          continue
        }
        let ping
        try { ping = await bounded(() => chrome.tabs.sendMessage(tab.id, { type: 'sidecar_ping' })) } catch {}
        if (ping?.ready && ping.buildId === buildId) continue
        await bounded(() => chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['build-info.js', 'content-script.js'] }), 5000)
        ping = await bounded(() => chrome.tabs.sendMessage(tab.id, { type: 'sidecar_ping' }))
        if (!ping?.ready || ping.buildId !== buildId) throw new Error(`Content build verification failed for tab ${tab.id}`)
        restoration.refreshedTabs.push(tab.id)
      }
      restoration.state = 'ready'
    } catch (error) {
      restoration = { ...restoration, state: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
  }

  return { status, runMutation, requestReload, afterResponse, restoreAfterReload }
}
