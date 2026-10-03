// Shared by the integrated Sidecar and standalone provider. No OS decisions here.
function isRecoverableSubmittedPending(state, pending) {
  if (!pending || pending.phase !== 'submitted') return false
  if (typeof pending.conversationId !== 'string' || !pending.conversationId) return false
  if (typeof pending.turnId !== 'string' || !pending.turnId) return false
  if (typeof pending.requestId !== 'string' || !pending.requestId) return false
  if (!Number.isInteger(pending.tabId)) return false

  const receipt = state[`effect-receipt:${pending.requestId}`]
  if (!receipt || receipt.requestId !== pending.requestId) return false
  if (receipt.conversationId !== pending.conversationId || receipt.turnId !== pending.turnId) return false
  if (typeof receipt.userMessageId !== 'string' || !receipt.userMessageId) return false

  const binding = state[`conversation:${pending.conversationId}`]
  return Boolean(binding && Number.isInteger(binding.tabId) && typeof binding.url === 'string' && binding.url)
}

async function pendingDigest(pending) {
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    return value
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical(pending))))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

async function validPendingRetirement(state, pending) {
  const receipt = state[`pending-retirement:${pending?.conversationId}`]
  if (!receipt || receipt.version !== 1 || receipt.state !== 'retired' || receipt.delivery !== 'unknown' ||
      typeof receipt.operationId !== 'string' || !receipt.operationId ||
      !Number.isInteger(receipt.writerEpoch) || receipt.writerEpoch <= 0 ||
      typeof receipt.instanceId !== 'string' || !receipt.instanceId || !/^[a-f0-9]{64}$/.test(receipt.buildId) ||
      !Number.isFinite(receipt.retiredAt) || receipt.retiredAt <= 0 ||
      !['conversationId', 'turnId', 'requestId', 'tabId'].every(key => receipt[key] === pending[key]) ||
      receipt.proof?.originalTabAbsent !== true ||
      receipt.proof?.writerDrained !== true || receipt.proof?.contentDrained !== true ||
      receipt.proof?.contentEffectCount !== 0 || receipt.proof?.outboxCount !== 0) return false
  if (receipt.owner === 'manual') {
    const authority = state['writer:authority']
    const canonicalTarget = retirementTarget(receipt.target)
    if (receipt.reason !== 'closed_manual_owner_after_quiesce' || pending.phase !== 'submitting' ||
        pending.registrationId !== undefined || (pending.source != null && pending.source !== 'manual') ||
        Object.hasOwn(receipt, 'registrationId') ||
        receipt.target !== manualRetirementTarget(receipt.target) || !receipt.target ||
        manualRetirementTarget(state[`conversation:${pending.conversationId}`]?.url) !== receipt.target ||
        receipt.proof.generationSource !== 'manual_owner' || Object.hasOwn(receipt.proof, 'revokedRegistration') ||
        (canonicalTarget ? receipt.proof.targetAbsent !== true : Object.hasOwn(receipt.proof, 'targetAbsent')) ||
        authority?.version !== 1 || !Number.isInteger(authority.epoch) || authority.epoch < receipt.writerEpoch) return false
  } else {
    if (receipt.owner !== undefined || receipt.reason !== 'closed_target_after_quiesce' ||
        typeof receipt.registrationId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(receipt.registrationId) ||
        (pending.registrationId !== undefined && (typeof pending.registrationId !== 'string' || pending.registrationId.toLowerCase() !== receipt.registrationId)) ||
        receipt.target !== retirementTarget(receipt.target) || !receipt.target ||
        retirementTarget(state[`conversation:${pending.conversationId}`]?.url) !== receipt.target ||
        receipt.proof.targetAbsent !== true || receipt.proof.revokedRegistration !== true ||
        receipt.proof.generationSource !== (pending.registrationId ? 'native_pending' : 'host_ledger')) return false
    const revoked = state[`writer:revoked-registration:${receipt.registrationId}`]
    if (revoked?.version !== 1 || revoked.registrationId !== receipt.registrationId ||
        !Number.isInteger(revoked.writerEpoch) || revoked.writerEpoch < receipt.writerEpoch || revoked.target !== receipt.target) return false
  }
  return receipt.pendingDigest === await pendingDigest(pending)
}

async function pendingSummary(state) {
  let pendingCount = 0
  let recoverablePendingCount = 0
  let retiredPendingCount = 0
  for (const [key, pending] of Object.entries(state)) {
    if (!key.startsWith('pending:')) continue
    pendingCount += 1
    if (key !== `pending:${pending?.conversationId}`) continue
    if (await validPendingRetirement(state, pending)) retiredPendingCount += 1
    else if (!Object.hasOwn(state, `pending-retirement:${pending?.conversationId}`) && isRecoverableSubmittedPending(state, pending)) recoverablePendingCount += 1
  }
  return {
    pendingCount,
    recoverablePendingCount,
    retiredPendingCount,
    blockingPendingCount: pendingCount - recoverablePendingCount - retiredPendingCount
  }
}

function createSidecarLifecycle({ chrome, buildId, instanceId, matchesTab, schedule = setTimeout }) {
  const receiptKey = 'reload:receipt'
  let activeOperations = 0
  let maintenance = false
  const drainWaiters = []
  let admitted = null
  let admissionPromise = null
  let scheduled = false
  let restoration = { state: 'starting', refreshedTabs: [], skippedTabs: [] }

  async function status() {
    const state = await chrome.storage.local.get(null)
    const pending = await pendingSummary(state)
    return {
      extensionId: chrome.runtime.id,
      version: chrome.runtime.getManifest().version,
      buildId,
      instanceId,
      ...pending,
      outboxCount: Object.keys(state).filter((key) => key.startsWith('outbox:')).length,
      activeOperations,
      maintenance,
      reloading: admitted !== null,
      lastReload: state[receiptKey] ?? null,
      restoration
    }
  }

  async function runMutation(action, { control = false } = {}) {
    if (admitted || restoration.state === 'restoring') throw new Error('Extension reload in progress')
    if (maintenance) throw new Error('Extension maintenance in progress')
    if (!control && restoration.state !== 'ready') throw new Error('Extension restoration is not ready')
    activeOperations += 1
    try { return await action() } finally {
      activeOperations -= 1
      if (activeOperations === 0) for (const resolve of drainWaiters.splice(0)) resolve()
    }
  }

  async function runMaintenance(action) {
    if (maintenance || admitted || restoration.state === 'restoring') throw new Error('Extension maintenance or reload in progress')
    maintenance = true
    try {
      if (activeOperations) await new Promise(resolve => drainWaiters.push(resolve))
      return await action()
    } finally { maintenance = false }
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
    if (activeOperations || maintenance || restoration.state === 'restoring') throw new Error('Extension busy: browser mutation or restore in flight')
    admitted = { requestId, previousInstanceId: instanceId, expectedBuildId }
    admissionPromise = (async () => {
      const before = await status()
      if (before.blockingPendingCount || before.outboxCount) throw new Error('Extension busy: unsafe pending turns or unacknowledged outbox; no force reload')
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
    const pending = await pendingSummary(state)
    if (pending.blockingPendingCount) {
      restoration = { ...restoration, state: 'failed', error: 'Unsafe pending turns appeared during reload' }
      return
    }
    restoration.state = 'restoring'
    const seen = new Set()
    try {
      for (const [key, binding] of Object.entries(state)) {
        if (!key.startsWith('conversation:') || !Number.isInteger(binding?.tabId) || seen.has(binding.tabId)) continue
        if (Object.hasOwn(state, `pending-retirement:${key.slice('conversation:'.length)}`)) {
          restoration.skippedTabs.push({ tabId: binding.tabId, reason: 'retired_unknown' })
          continue
        }
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

  return { status, runMutation, runMaintenance, requestReload, afterResponse, restoreAfterReload }
}
