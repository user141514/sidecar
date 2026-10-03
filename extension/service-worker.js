importScripts('build-info.js', 'lifecycle.js')
const extensionInstanceId = crypto.randomUUID()
const extensionLifecycle = createSidecarLifecycle({
  chrome,
  buildId: globalThis.__sidecarBuildId,
  instanceId: extensionInstanceId,
  matchesTab: tabMatchesExpectedUrl
})
const lifecycleReady = extensionLifecycle.restoreAfterReload()

const NATIVE_HOST = 'com.conversation_sidecar.host'
const CHATGPT_URL = 'https://chatgpt.com/'
const STORAGE_PREFIX = 'conversation:'
const PENDING_PREFIX = 'pending:'
const OUTBOX_PREFIX = 'outbox:'
const EFFECT_RECEIPT_PREFIX = 'effect-receipt:'
const WRITER_AUTHORITY_KEY = 'writer:authority'
const REVOKED_REGISTRATION_PREFIX = 'writer:revoked-registration:'
const CONTENT_EFFECT_PREFIX = 'content-effect:'
const CONTENT_EFFECT_METHODS = new Set(['conversation_prepare', 'conversation_submit', 'conversation_stop', 'webgpt_shift_test', 'project_open', 'project_create'])
const WINDOW0_KEY = 'window0'
const AUTOMATION_WINDOW_SENTINEL = 'automation-window.html'

let nativePort = null
let reconnectTimer = null
let activeWriterCommands = 0
let pendingWriterClaims = 0
let writerClaimTail = Promise.resolve()
const writerDrainWaiters = []
const sendOwners = new Set()
const tabOwners = new Map()
const activeSends = new Map()
const contentScriptPromises = new Set()
const refreshRequests = new Map()
const revokedRegistrations = new Set()
const contentEffectReservations = new Set()

function finishWriterCommand() {
  activeWriterCommands -= 1
  if (activeWriterCommands !== 0) return
  for (const resolve of writerDrainWaiters.splice(0)) resolve()
}

function waitForWriterDrain() {
  if (activeWriterCommands === 0) return Promise.resolve()
  return new Promise(resolve => writerDrainWaiters.push(resolve))
}

async function loadWriterAuthority() {
  const stored = await chrome.storage.local.get(WRITER_AUTHORITY_KEY)
  const authority = stored[WRITER_AUTHORITY_KEY] ?? null
  if (authority === null) return null
  if (authority?.version !== 1 || !Number.isInteger(authority.epoch) || authority.epoch <= 0) {
    throw new Error('Invalid durable writer authority')
  }
  return authority
}

async function claimWriterEpoch(params = {}) {
  const epoch = params.writerEpoch
  if (!Number.isInteger(epoch) || epoch <= 0) throw new Error('Valid writer epoch required')
  const current = await loadWriterAuthority()
  if (current && epoch < current.epoch) throw new Error('Writer epoch is stale')
  if (!current || epoch > current.epoch) {
    await chrome.storage.local.set({ [WRITER_AUTHORITY_KEY]: { version: 1, epoch } })
  }
  return { accepted: true, currentWriterEpoch: epoch }
}

async function assertWriterEpoch(params = {}) {
  const current = await loadWriterAuthority()
  if (!current) {
    if (Number.isInteger(params.writerEpoch)) throw new Error('Writer authority is missing')
    return
  }
  if (!Number.isInteger(params.writerEpoch) || params.writerEpoch !== current.epoch) {
    throw new Error(`Writer epoch mismatch: expected ${current.epoch}`)
  }
}

function writerRegistrationId(params = {}) {
  if (params.registrationId === undefined) return null
  if (typeof params.registrationId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(params.registrationId)) {
    throw new Error('Valid writer registration UUID required')
  }
  return params.registrationId.toLowerCase()
}

async function assertRegistrationActive(params) {
  const registrationId = writerRegistrationId(params)
  if (registrationId === null) return
  if (revokedRegistrations.has(registrationId)) throw new Error('Writer registration revoked')
  const key = REVOKED_REGISTRATION_PREFIX + registrationId
  const stored = await chrome.storage.local.get(key)
  if (Object.hasOwn(stored, key)) {
    revokedRegistrations.add(registrationId)
    throw new Error('Writer registration revoked')
  }
}

async function waitForContentScriptDrain() {
  // A bounded caller timeout is not proof that the remote DOM operation ended.
  while (contentScriptPromises.size) await Promise.allSettled([...contentScriptPromises])
}

function contentEffectIdentityMatches(left, right) {
  return left && right && ['version', 'token', 'tabId', 'documentId', 'registrationId', 'writerEpoch', 'method', 'instanceId']
    .every(key => Object.hasOwn(left, key) && left[key] === right[key])
}

function trustedContentSender(sender) {
  return sender?.id === chrome.runtime.id && Number.isInteger(sender.tab?.id) && sender.frameId === 0 &&
    typeof sender.documentId === 'string' && /^[0-9a-f]{32}$/i.test(sender.documentId)
}

async function settleContentEffect(effect, sender) {
  if (!trustedContentSender(sender) || typeof effect?.token !== 'string' || !effect.token || effect.token.length > 256) {
    return { settled: false, reason: 'untrusted_content_completion' }
  }
  const key = CONTENT_EFFECT_PREFIX + effect.token
  const record = (await chrome.storage.local.get(key))[key]
  if (!record) return { settled: true, token: effect.token }
  if (!contentEffectIdentityMatches(effect, record) || sender.tab.id !== record.tabId || sender.documentId !== record.documentId) {
    return { settled: false, reason: 'content_completion_identity_mismatch' }
  }
  await chrome.storage.local.remove(key)
  return { settled: true, token: effect.token }
}

async function assertNoPendingContentEffects() {
  const stored = await chrome.storage.local.get(null)
  if (contentScriptPromises.size || Object.entries(stored).some(([key, value]) =>
      key.startsWith(CONTENT_EFFECT_PREFIX) ||
      (key.startsWith(EFFECT_RECEIPT_PREFIX) && value?.action === 'refresh' && !['applied', 'denied'].includes(value.phase)))) {
    throw deliveryUncertain('Extension busy: unresolved browser effect; outcome unknown')
  }
}

async function recoverSettledContentEffects() {
  const stored = await chrome.storage.local.get(null)
  const pending = Object.entries(stored).filter(([key]) => key.startsWith(CONTENT_EFFECT_PREFIX))
  await Promise.all(pending.map(async ([, effect]) => {
    if (!Number.isInteger(effect?.tabId) || typeof effect?.documentId !== 'string' ||
        !/^[0-9a-f]{32}$/i.test(effect.documentId)) return
    try {
      // This exact-document read retries only already-settled completion
      // metadata. The trusted runtime completion handler remains the clearer.
      await boundedMessage(effect.tabId, { type: 'sidecar_ping' }, 2000, undefined, {}, effect.documentId)
    } catch {}
  }))
}

async function assertNoUnsettledEffectsForTab(tabId, ownRefreshRequestId = null) {
  const stored = await chrome.storage.local.get(null)
  if (Object.entries(stored).some(([key, record]) =>
      (record?.tabId === tabId || !Number.isInteger(record?.tabId)) &&
      (key.startsWith(CONTENT_EFFECT_PREFIX) ||
       (key.startsWith(EFFECT_RECEIPT_PREFIX) && record?.action === 'refresh' &&
        !['applied', 'denied'].includes(record.phase) && key !== effectReceiptKey(ownRefreshRequestId))))) {
    throw deliveryUncertain('Tab has an unsettled browser effect; outcome unknown')
  }
}

async function runWriterMutation(params, action) {
  while (pendingWriterClaims > 0) {
    const barrier = writerClaimTail
    await barrier.catch(() => {})
  }
  activeWriterCommands += 1
  try {
    await assertWriterEpoch(params)
    await assertRegistrationActive(params)
    return await extensionLifecycle.runMutation(async () => {
      await assertNoRetiredConversationWrite(params)
      return action()
    })
  } finally {
    finishWriterCommand()
  }
}

function runWriterClaim(params) {
  pendingWriterClaims += 1
  const previous = writerClaimTail
  const run = previous.catch(() => {}).then(() => extensionLifecycle.runMutation(async () => {
    await waitForWriterDrain()
    await waitForContentScriptDrain()
    await recoverSettledContentEffects()
    await assertNoPendingContentEffects()
    return claimWriterEpoch(params)
  }, { control: true }))
  writerClaimTail = run
  return run.finally(() => { pendingWriterClaims -= 1 })
}

function runWriterQuiesce(params) {
  pendingWriterClaims += 1
  const previous = writerClaimTail
  const run = previous.catch(() => {}).then(() => extensionLifecycle.runMutation(async () => {
    const registrationId = writerRegistrationId(params)
    if (!Number.isInteger(params.writerEpoch) || params.writerEpoch <= 0) throw new Error('Valid writer epoch required')
    await assertWriterEpoch(params)
    if (registrationId !== null) {
      // Reject late native arrivals even when the durable write fails. A failed
      // journal write cannot produce a quiescent acknowledgement.
      revokedRegistrations.add(registrationId)
      const key = REVOKED_REGISTRATION_PREFIX + registrationId
      const existing = (await chrome.storage.local.get(key))[key]
      const target = params.target === undefined ? existing?.target : retirementTarget(params.target)
      if (params.target !== undefined && !target) throw new Error('Exact revoked registration target required')
      if (existing && (existing.version !== 1 || existing.registrationId !== registrationId ||
          !Number.isInteger(existing.writerEpoch) || existing.writerEpoch > params.writerEpoch ||
          (existing.target !== undefined && existing.target !== target))) throw new Error('Revoked registration target conflict')
      await chrome.storage.local.set({
        [key]: { version: 1, registrationId, writerEpoch: params.writerEpoch, ...(target ? { target } : {}) }
      })
    }
    await waitForWriterDrain()
    await waitForContentScriptDrain()
    await recoverSettledContentEffects()
    await assertNoPendingContentEffects()
    await assertWriterEpoch(params)
    return { quiescent: true, currentWriterEpoch: params.writerEpoch, ...(registrationId === null ? {} : { registrationId }),
      ...(params.target === undefined ? {} : { target: retirementTarget(params.target) }) }
  }, { control: true }))
  writerClaimTail = run
  return run.finally(() => { pendingWriterClaims -= 1 })
}

async function assertNoRetiredConversationWrite(params) {
  const state = await chrome.storage.local.get(null)
  const target = retirementTarget(params.externalUrl || params.url || params.target_url || params.target)
  for (const [key, receipt] of Object.entries(state)) {
    if (!key.startsWith('pending-retirement:') && !key.startsWith('pending-retirement-staged:')) continue
    if (key === `pending-retirement:${params.conversationId}` || key === `pending-retirement-staged:${params.conversationId}` ||
        (params.requestId && receipt?.requestId === params.requestId) ||
        (target && receipt?.target === target)) throw deliveryUncertain('Conversation attempt is permanently retired with unknown delivery')
  }
}

function runPendingMaintenance(action) {
  pendingWriterClaims += 1
  const previous = writerClaimTail
  const run = previous.catch(() => {}).then(() => extensionLifecycle.runMaintenance(async () => {
    await waitForWriterDrain()
    await waitForContentScriptDrain()
    return action()
  }))
  writerClaimTail = run
  return run.finally(() => { pendingWriterClaims -= 1 })
}

async function inspectPendingRetirement(params) {
  for (const key of ['conversationId', 'turnId', 'requestId']) {
    if (typeof params[key] !== 'string' || !params[key] || params[key].length > 256) throw new Error(`Retirement requires ${key}`)
  }
  const registrationId = writerRegistrationId(params)
  if (!registrationId) throw new Error('Retirement requires revoked registration')
  const target = retirementTarget(params.target)
  if (!target) throw new Error('Retirement requires exact canonical target')
  await assertWriterEpoch(params)
  const state = await chrome.storage.local.get(null)
  const pending = state[pendingKey(params.conversationId)]
  const identity = { conversationId: params.conversationId, turnId: params.turnId, requestId: params.requestId,
    registrationId, target, writerEpoch: params.writerEpoch, instanceId: extensionInstanceId, buildId: globalThis.__sidecarBuildId }
  if (!pending) return { ...identity, found: false, retirable: false, reason: 'pending_missing' }
  const result = { ...identity, found: true, retirable: false, tabId: pending.tabId, pendingDigest: await pendingDigest(pending) }
  const deny = reason => ({ ...result, reason })
  if (pending.conversationId !== params.conversationId || pending.turnId !== params.turnId || pending.requestId !== params.requestId ||
      !Number.isInteger(pending.tabId) || (pending.registrationId !== undefined &&
        (typeof pending.registrationId !== 'string' || pending.registrationId.toLowerCase() !== registrationId))) return deny('pending_identity_mismatch')
  const binding = state[storageKey(params.conversationId)]
  if (binding?.tabId !== pending.tabId || retirementTarget(binding?.url) !== target ||
      ['url', 'externalUrl', 'target'].some(key => pending[key] !== undefined && retirementTarget(pending[key]) !== target)) return deny('pending_target_mismatch')
  const revoked = state[REVOKED_REGISTRATION_PREFIX + registrationId]
  if (revoked?.version !== 1 || revoked.registrationId !== registrationId || revoked.target !== target ||
      !Number.isInteger(revoked.writerEpoch) || revoked.writerEpoch !== params.writerEpoch) return deny('registration_not_revoked_for_target')
  const receipt = state[`pending-retirement:${params.conversationId}`]
  if (receipt) {
    if (!await validPendingRetirement(state, pending) || receipt.registrationId !== registrationId || receipt.target !== target) return deny('retirement_receipt_mismatch')
    return { ...result, retirable: true, retirement: receipt }
  }
  if (pending.phase !== 'submitting' || state[effectReceiptKey(params.requestId)]) return deny('pending_not_unknown_submit')
  if (activeWriterCommands || contentScriptPromises.size || contentEffectReservations.size || activeSends.size || tabOwners.size) return deny('writer_not_drained')
  if (Object.entries(state).some(([key, value]) => key.startsWith(CONTENT_EFFECT_PREFIX) ||
      (key.startsWith(EFFECT_RECEIPT_PREFIX) && value?.action === 'refresh' && !['applied', 'denied'].includes(value.phase)))) return deny('content_effect_unresolved')
  if (Object.keys(state).some(key => key.startsWith(OUTBOX_PREFIX))) return deny('outbox_not_empty')
  let tabs
  try { tabs = await chrome.tabs.query({}) } catch { return deny('tabs_lookup_failed') }
  if (!Array.isArray(tabs)) return deny('tabs_lookup_failed')
  if (tabs.some(tab => tab.id === pending.tabId)) return deny('original_tab_open')
  if (tabs.some(tab => retirementTarget(tab.url) === target || retirementTarget(tab.pendingUrl) === target)) return deny('target_open')
  return { ...result, retirable: true }
}

async function retirePending(params) {
  if (typeof params.operationId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(params.operationId) ||
      params.reason !== 'closed_target_after_quiesce') throw new Error('Invalid retirement operation or reason')
  const inspected = await inspectPendingRetirement(params)
  if (!inspected.retirable) throw new Error(`Pending retirement rejected: ${inspected.reason}`)
  if (params.expectedPendingDigest !== inspected.pendingDigest) throw new Error('Pending retirement digest changed')
  if (inspected.retirement) {
    const receipt = inspected.retirement
    if (receipt.operationId !== params.operationId || receipt.reason !== params.reason ||
        receipt.instanceId !== params.expectedInstanceId || receipt.buildId !== params.expectedBuildId) throw new Error('Pending retirement operation conflict')
    return { accepted: true, retired: true, delivery: 'unknown', receipt }
  }
  const state = await chrome.storage.local.get(null)
  const pending = state[pendingKey(params.conversationId)]
  if (await pendingDigest(pending) !== inspected.pendingDigest) throw new Error('Pending retirement digest changed')
  const stagedKey = `pending-retirement-staged:${params.conversationId}`
  const priorCandidate = state[stagedKey]
  if (priorCandidate) {
    if (priorCandidate.operationId !== params.operationId || priorCandidate.reason !== params.reason ||
        priorCandidate.instanceId !== params.expectedInstanceId || priorCandidate.buildId !== params.expectedBuildId ||
        priorCandidate.pendingDigest !== params.expectedPendingDigest || priorCandidate.registrationId !== inspected.registrationId ||
        priorCandidate.target !== inspected.target || priorCandidate.writerEpoch > params.writerEpoch ||
        !await validPendingRetirement({ ...state, [`pending-retirement:${params.conversationId}`]: priorCandidate }, pending)) {
      throw new Error('Pending retirement candidate conflict')
    }
  } else if (params.expectedInstanceId !== extensionInstanceId || params.expectedBuildId !== globalThis.__sidecarBuildId) {
    throw new Error('Retirement instance or build changed')
  }
  const receipt = { version: 1, state: 'retired', delivery: 'unknown', operationId: params.operationId, reason: params.reason,
    conversationId: inspected.conversationId, turnId: inspected.turnId, requestId: inspected.requestId,
    registrationId: inspected.registrationId, target: inspected.target, tabId: inspected.tabId,
    pendingDigest: inspected.pendingDigest, writerEpoch: inspected.writerEpoch, instanceId: inspected.instanceId,
    buildId: inspected.buildId, retiredAt: Date.now(), proof: { originalTabAbsent: true, targetAbsent: true,
      writerDrained: true, contentDrained: true, contentEffectCount: 0, outboxCount: 0, revokedRegistration: true,
      generationSource: pending.registrationId ? 'native_pending' : 'host_ledger' } }
  // Read back an inert candidate before publishing the lifecycle-unblocking
  // receipt. A failed readback must leave the original pending blocking.
  const candidate = priorCandidate ?? receipt
  await chrome.storage.local.set({ [stagedKey]: candidate })
  const persisted = await chrome.storage.local.get(null)
  if (JSON.stringify(persisted[stagedKey]) !== JSON.stringify(candidate) ||
      !await validPendingRetirement({ ...persisted, [`pending-retirement:${params.conversationId}`]: candidate }, persisted[pendingKey(params.conversationId)])) {
    throw new Error('Retirement persistence verification failed')
  }
  const finalInspection = await inspectPendingRetirement(params)
  if (!finalInspection.retirable || finalInspection.pendingDigest !== candidate.pendingDigest) {
    throw new Error(`Pending retirement changed before publication: ${finalInspection.reason || 'digest_changed'}`)
  }
  await chrome.storage.local.set({ [`pending-retirement:${params.conversationId}`]: candidate })
  return { accepted: true, retired: true, delivery: 'unknown', receipt: candidate }
}

function deliveryUncertain(error) {
  return Object.assign(new Error(error instanceof Error ? error.message : String(error)), { code: 'DELIVERY_UNCERTAIN' })
}

async function boundedMessage(tabId, message, timeoutMs, onLateResponse, writerParams = {}, targetDocumentId = null) {
  let timer
  let expired = false
  let effect = null
  if (CONTENT_EFFECT_METHODS.has(message.type)) {
    if (contentEffectReservations.has(tabId)) throw deliveryUncertain('Tab has an unsettled content effect')
    contentEffectReservations.add(tabId)
    try {
      await assertNoUnsettledEffectsForTab(tabId)
      const token = crypto.randomUUID()
      const document = await boundedMessage(tabId, { type: 'sidecar_effect_document', token }, 2000)
      if (document?.token !== token || document.tabId !== tabId ||
          typeof document.documentId !== 'string' || !/^[0-9a-f]{32}$/i.test(document.documentId) ||
          !webGptShiftPageUrl(document.url)) throw deliveryUncertain('Exact content document unavailable')
      await assertNoUnsettledEffectsForTab(tabId)
      effect = {
        version: 1, token, tabId, documentId: document.documentId,
        registrationId: writerRegistrationId(writerParams), writerEpoch: writerParams.writerEpoch ?? null,
        method: message.type, instanceId: extensionInstanceId
      }
      await chrome.storage.local.set({ [CONTENT_EFFECT_PREFIX + token]: effect })
    } finally { contentEffectReservations.delete(tabId) }
  }
  const dispatched = chrome.tabs.sendMessage(tabId, effect ? { ...message, contentEffect: effect } : message,
    effect ? { documentId: effect.documentId } : targetDocumentId ? { documentId: targetDocumentId } : { frameId: 0 })
  const original = effect ? dispatched.then(async result => {
    if (contentEffectIdentityMatches(result?.contentEffectSettled, effect)) {
      await settleContentEffect(effect, { id: chrome.runtime.id, tab: { id: tabId }, frameId: 0, documentId: effect.documentId })
    }
    return result
  }) : dispatched
  const settled = original.then(async result => {
    // The late receipt callback is still writer work: drain its durable state
    // changes before any maintenance snapshot can certify quiescence.
    if (expired && onLateResponse) await onLateResponse(result).catch(() => {})
    return result
  })
  contentScriptPromises.add(settled)
  void settled.then(
    () => contentScriptPromises.delete(settled),
    () => contentScriptPromises.delete(settled)
  )
  try {
    return await Promise.race([
      settled,
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

function effectReceiptKey(requestId) {
  return `${EFFECT_RECEIPT_PREFIX}${requestId}`
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
    if (parsed.username || parsed.password) return null
    const match = parsed.pathname.match(/^\/(?:g\/g-p-[^/]+\/)?c\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/?$/i)
    return match ? `${parsed.origin}${match[0].replace(/\/$/, '')}` : null
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
    projectHomeUrl(preferred) ||
    projectHomeUrl(fallback) ||
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
  const stored = await chrome.storage.local.get(null)
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(STORAGE_PREFIX)) continue
    const currentUrl = stableConversationUrl(value?.url)
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
  await assertNoRetiredConversationWrite({ conversationId, externalUrl: value?.url })
  await chrome.storage.local.set({ [storageKey(conversationId)]: value })
}

async function loadConversation(conversationId) {
  const key = storageKey(conversationId)
  const stored = await chrome.storage.local.get(key)
  return stored[key] ?? null
}

async function savePendingTurn(pending) {
  await assertNoRetiredConversationWrite(pending)
  await chrome.storage.local.set({ [pendingKey(pending.conversationId)]: pending })
}

async function loadPendingTurn(conversationId) {
  const key = pendingKey(conversationId)
  const stored = await chrome.storage.local.get(key)
  return stored[key] ?? null
}

async function clearPendingTurn(conversationId) {
  await assertNoRetiredConversationWrite({ conversationId })
  await chrome.storage.local.remove(pendingKey(conversationId))
}

async function saveEffectReceipt(receipt) {
  const key = effectReceiptKey(receipt.requestId)
  const stored = await chrome.storage.local.get(key)
  const existing = stored[key]
  if (existing && JSON.stringify(existing) !== JSON.stringify(receipt)) {
    throw new Error('effect receipt identity conflict')
  }
  if (!existing) await chrome.storage.local.set({ [key]: receipt })
  return existing ?? receipt
}

async function loadEffectReceipt(requestId) {
  const key = effectReceiptKey(requestId)
  const stored = await chrome.storage.local.get(key)
  return stored[key] ?? null
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

function automationWindowSentinelUrl() {
  return chrome.runtime.getURL(AUTOMATION_WINDOW_SENTINEL)
}

async function validOwnedWindow0(stored) {
  if (!Number.isInteger(stored?.windowId) || !Number.isInteger(stored?.sentinelTabId)) return null
  try {
    await chrome.windows.get(stored.windowId)
    const sentinel = await chrome.tabs.get(stored.sentinelTabId)
    if (sentinel.windowId !== stored.windowId) return null
    if (tabPageUrl(sentinel) !== automationWindowSentinelUrl()) return null
    return { windowId: stored.windowId, sentinelTabId: stored.sentinelTabId }
  } catch {
    return null
  }
}

async function ensureWindow0() {
  const stored = await loadWindow0()
  const owned = await validOwnedWindow0(stored)
  if (owned) return { ...owned, created: false }
  if (stored) await clearWindow0()

  const window = await chrome.windows.create({
    url: automationWindowSentinelUrl(),
    type: 'normal',
    focused: false,
    state: 'minimized'
  })
  const sentinel = window?.tabs?.[0]
  if (!window || typeof window.id !== 'number' || !sentinel || typeof sentinel.id !== 'number') {
    throw new Error('Chrome did not return an owned automation window and sentinel tab')
  }

  const window0 = { windowId: window.id, sentinelTabId: sentinel.id }
  await saveWindow0(window0)
  return { ...window0, created: true }
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

async function resolveConversationAttachment(conversationId, requestedUrl, existingOnly = false) {
  if (existingOnly) {
    const matches = (await chrome.tabs.query({})).filter(tab => tabMatchesExpectedUrl(tab, requestedUrl))
    if (matches.length !== 1) throw new Error('exact existing conversation tab required')
    const tab = matches[0]
    const state = { windowId: tab.windowId, tabId: tab.id, url: tabPageUrl(tab) }
    await saveConversation(conversationId, state)
    return { state, reattached: true, reloadOnReadinessFailure: false }
  }
  const stored = await loadConversation(conversationId)
  const expectedUrl = chooseConversationUrl(requestedUrl, stored?.url)
  const window0 = await ensureWindow0()
  const liveTab = await findRegisteredLiveTab(stored, expectedUrl)

  if (liveTab && liveTab.windowId === window0.windowId) {
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

  let tab = await findMatchingConversationTab(window0.windowId, expectedUrl)
  const matchedExistingTab = Boolean(tab)

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
  try { tab = await chrome.tabs.get(tab.id) } catch { return null }
  const candidateUrl = stableConversationUrl(tab.url)
  if (!candidateUrl) return null
  const stored = await chrome.storage.local.get(null)
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(PENDING_PREFIX)) continue
    if (Object.hasOwn(stored, `pending-retirement:${value.conversationId}`) ||
        Object.hasOwn(stored, `pending-retirement-staged:${value.conversationId}`)) continue
    if (value.phase === 'preparing' || value.phase === 'prepared' || value.phase === 'submitting') continue

    const binding = stored[`${STORAGE_PREFIX}${value.conversationId}`]
    const bindingUrl = stableConversationUrl(binding?.url)
    let rebind = false
    if (value?.tabId === tab.id) {
      if (bindingUrl) {
        if (exactAdoptionUuid(bindingUrl) !== exactAdoptionUuid(candidateUrl)) continue
      } else if (!binding || (!projectHomeUrl(binding.url) && chatGptPageUrl(binding.url) !== CHATGPT_URL)) {
        continue
      }
    } else {
      if (!isRecoverableSubmittedPending(stored, value)) continue
      if (!bindingUrl || pageIdentity(bindingUrl) !== pageIdentity(candidateUrl)) continue

      if (typeof value.tabId === 'number') {
        try {
          const priorTab = await chrome.tabs.get(value.tabId)
          const priorUrl = stableConversationUrl(priorTab.url)
          if (priorUrl && pageIdentity(priorUrl) === pageIdentity(bindingUrl)) continue
        } catch {
          // The original tab is gone, so the exact same conversation may take over monitoring.
        }
      }
      rebind = true
    }

    const claimed = {
      ...value,
      ...(rebind ? { tabId: tab.id } : {}),
      monitorVersion: Number.isInteger(value.monitorVersion) ? value.monitorVersion + 1 : 1
    }
    await savePendingTurn(claimed)

    const current = await loadConversation(claimed.conversationId)
    if (current) {
      await saveConversation(claimed.conversationId, {
        windowId: tab.windowId ?? current.windowId,
        tabId: tab.id,
        url: candidateUrl
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
  let reloaded = false
  let reinjected = false
  const sameProject = url => {
    const projectUrl = projectHomeUrl(url)
    return projectUrl !== null && chatGptPageUrl(projectUrl) === expectedRoute
  }
  const freshPage = page => page?.ready === true && page.buildId === globalThis.__sidecarBuildId && sameProject(page.url)
  const currentProjectTab = async () => {
    const current = await chrome.tabs.get(tabId)
    if (current.id !== tabId || !sameProject(tabPageUrl(current))) throw new Error('Project draft target changed')
    return current
  }
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId)
    lastUrl = tabPageUrl(tab)
    const actualProjectUrl = projectHomeUrl(lastUrl)
    if (actualProjectUrl && chatGptPageUrl(actualProjectUrl) === expectedRoute) {
      try {
        const page = await boundedMessage(tabId, { type: 'sidecar_ping' }, Math.min(2000, Math.max(1, deadline - Date.now())))
        const current = await currentProjectTab()
        if (freshPage(page) && page.composerPresent === true) return projectHomeUrl(tabPageUrl(current))
        if (freshPage(page) && page.composerPresent !== true && !reloaded && !reinjected) {
          reloaded = true
          try {
            await chrome.tabs.reload(tabId)
          } catch (error) {
            lastError = error
          }
        }
      } catch (error) {
        lastError = error
        if (!reinjected && /receiving end does not exist/i.test(error instanceof Error ? error.message : String(error)) && chrome.scripting?.executeScript) {
          reinjected = true
          await currentProjectTab()
          await chrome.scripting.executeScript({
            target: { tabId, frameIds: [0] }, files: ['build-info.js', 'content-script.js']
          })
          await currentProjectTab()
          const page = await boundedMessage(tabId, { type: 'sidecar_ping' }, Math.min(2000, Math.max(1, deadline - Date.now())))
          const current = await currentProjectTab()
          if (freshPage(page) && page.composerPresent === true) return projectHomeUrl(tabPageUrl(current))
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const detail = lastError instanceof Error ? `; last error was ${lastError.message}` : ''
  throw new Error(`ChatGPT Project draft surface did not become ready${lastUrl ? `; last URL was ${lastUrl}` : ''}${detail}`)
}

async function waitForConversationThreadUrl(tabId, fallbackUrl, timeoutMs = 5000) {
  const existing = stableConversationUrl(fallbackUrl)
  const deadline = Date.now() + timeoutMs
  let lastUrl = fallbackUrl
  while (Date.now() < deadline) {
    let tab
    try { tab = await chrome.tabs.get(tabId) } catch (error) { throw deliveryUncertain(error) }
    lastUrl = tab.url || lastUrl
    const stable = stableConversationUrl(tab.url)
    if (stable) {
      if (existing && exactAdoptionUuid(existing) !== exactAdoptionUuid(stable)) {
        throw deliveryUncertain('Submitted tab changed persistent conversation identity')
      }
      return stable
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw deliveryUncertain(`Submitted tab did not expose a committed persistent conversation URL; last URL was ${lastUrl}`)
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

  const window0 = await ensureWindow0()
  const tab = await chrome.tabs.create({ windowId: window0.windowId, url: CHATGPT_URL, active: false })

  if (!tab || typeof tab.id !== 'number') {
    throw new Error('Chrome did not return a tab for Project creation')
  }

  await waitForContentScript(tab.id)
  const response = await boundedMessage(tab.id, {
    type: 'project_create',
    name
  }, 60_000, undefined, params)
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

async function reuseAllocatedConversationAttachment(conversationId, requestedUrl) {
  const stored = await loadConversation(conversationId)
  if (!stored) return null
  const expectedUrl = chooseConversationUrl(stored.url, requestedUrl)
  const window0 = await ensureWindow0()
  const liveTab = await findRegisteredLiveTab(stored, expectedUrl)
  if (liveTab && liveTab.windowId === window0.windowId) {
    const state = {
      windowId: liveTab.windowId,
      tabId: liveTab.id,
      url: chooseConversationUrl(tabPageUrl(liveTab), expectedUrl)
    }
    await saveConversation(conversationId, state)
    return state
  }
  if (stableConversationUrl(stored.url)) {
    return (await resolveConversationAttachment(conversationId, stored.url)).state
  }
  return null
}

async function createConversation(params) {
  const url = params.url || CHATGPT_URL
  const existing = await reuseAllocatedConversationAttachment(params.conversationId, url)
  if (existing) return existing
  const projectUrl = projectHomeUrl(url)
  const projectSeedUrl = projectUrl ? await findProjectConversationSeedUrl(projectUrl) : null
  const initialUrl = projectUrl ? (projectSeedUrl || CHATGPT_URL) : url
  const window0 = await ensureWindow0()
  const tab = await chrome.tabs.create({ windowId: window0.windowId, url: initialUrl, active: Boolean(projectUrl) })

  if (!tab || typeof tab.id !== 'number') {
    throw new Error('Chrome did not return a tab for the new conversation')
  }

  let attachedUrl = tab.pendingUrl || tab.url || initialUrl
  if (projectUrl) {
    await waitForContentScript(tab.id)
    let opened = null
    try {
      opened = await boundedMessage(tab.id, { type: 'project_open', projectUrl }, 15_000, undefined, params)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/message (?:channel|port) closed.*response/i.test(message)) throw error
    }
    if (opened && opened.accepted !== true) {
      throw new Error(opened.error || 'ChatGPT content script could not open the Project')
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

function exactAdoptionUuid(value) {
  try {
    const url = new URL(value)
    const match = url.pathname.match(/^\/(?:g\/g-p-[^/]+\/)?c\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/?$/i)
    return url.origin === 'https://chatgpt.com' && !url.username && !url.password && !url.search && !url.hash && match
      ? match[1].toLowerCase() : null
  } catch { return null }
}

async function ensureAdoptionContentScript(tab, uuid) {
  const current = await chrome.tabs.get(tab.id)
  if (exactAdoptionUuid(tabPageUrl(current)) !== uuid) {
    return { ready: false, reason: 'adoption_target_changed' }
  }

  let ping = null
  try { ping = await boundedMessage(tab.id, { type: 'sidecar_ping' }, 2000) } catch {}
  if (ping?.ready === true && ping.buildId === globalThis.__sidecarBuildId) {
    if (exactAdoptionUuid(ping.url) !== uuid) return { ready: false, reason: 'adoption_target_changed' }
    return { ready: true }
  }

  if (!chrome.scripting?.executeScript) return { ready: false, reason: 'content_script_unavailable' }
  const beforeInjection = await chrome.tabs.get(tab.id)
  if (exactAdoptionUuid(tabPageUrl(beforeInjection)) !== uuid) {
    return { ready: false, reason: 'adoption_target_changed' }
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      files: ['build-info.js', 'content-script.js']
    })
    ping = await boundedMessage(tab.id, { type: 'sidecar_ping' }, 2000)
  } catch {
    return { ready: false, reason: 'content_script_unavailable' }
  }
  if (ping?.ready !== true || ping.buildId !== globalThis.__sidecarBuildId || exactAdoptionUuid(ping.url) !== uuid) {
    return { ready: false, reason: 'content_script_unavailable' }
  }
  return { ready: true }
}

async function inspectSupervision(params) {
  const uuid = exactAdoptionUuid(params.externalUrl)
  if (!uuid) throw new Error('exact conversation UUID required for supervision inspection')
  const tabs = (await chrome.tabs.query({})).filter(tab => exactAdoptionUuid(tabPageUrl(tab)) === uuid)
  if (tabs.length !== 1) return { found: false, reason: tabs.length ? 'ambiguous_target_tabs' : 'exact_tab_unavailable' }
  const tab = tabs[0]
  const content = await ensureAdoptionContentScript(tab, uuid)
  if (content.ready !== true) return { found: false, reason: content.reason }
  let snapshot
  try { snapshot = await boundedMessage(tab.id, { type: 'conversation_observe', authoritativeState: true }, 2000) }
  catch { return { found: false, reason: 'supervision_unreadable' } }
  const persistentId = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
  const assistantMessageId = snapshot?.assistantMessageId || null
  if (snapshot?.ready !== true || exactAdoptionUuid(snapshot.url) !== uuid ||
      pageIdentity(snapshot.url) !== pageIdentity(tabPageUrl(tab))) {
    return { found: false, reason: 'supervision_identity_mismatch' }
  }
  if (snapshot.readable !== true || !persistentId(snapshot.userMessageId) ||
      (assistantMessageId !== null && !persistentId(assistantMessageId))) {
    return { found: false, reason: 'persistent_turn_identity_unavailable' }
  }
  let current
  try { current = await chrome.tabs.get(tab.id) } catch { return { found: false, reason: 'exact_tab_unavailable' } }
  if (exactAdoptionUuid(tabPageUrl(current)) !== uuid || pageIdentity(tabPageUrl(current)) !== pageIdentity(snapshot.url)) {
    return { found: false, reason: 'supervision_target_changed' }
  }
  return { found: true, readable: true, url: snapshot.url, userMessageId: snapshot.userMessageId, assistantMessageId }
}

async function inspectAdoption(params) {
  const uuid = exactAdoptionUuid(params.externalUrl)
  if (!uuid) throw new Error('exact conversation UUID required for adoption')
  if (typeof params.expectedUserMessageId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(params.expectedUserMessageId)) {
    throw new Error('explicit persistent user message UUID required')
  }
  const tabs = (await chrome.tabs.query({})).filter(tab => exactAdoptionUuid(tabPageUrl(tab)) === uuid)
  if (tabs.length !== 1) return { found: false, reason: tabs.length ? 'ambiguous_target_tabs' : 'exact_tab_unavailable' }
  const tab = tabs[0]
  const content = await ensureAdoptionContentScript(tab, uuid)
  if (content.ready !== true) return { found: false, reason: content.reason }
  const snapshot = await boundedMessage(tab.id, { type: 'conversation_state_observe', expectedUserMessageId: params.expectedUserMessageId }, 2000)
  if (snapshot?.ready !== true || snapshot?.readable !== true || snapshot.userMessageId !== params.expectedUserMessageId ||
      exactAdoptionUuid(snapshot.url) !== uuid) return { found: false, reason: 'adoption_identity_mismatch' }
  return { found: true, url: snapshot.url, tabId: tab.id, windowId: tab.windowId,
    userMessageId: snapshot.userMessageId, assistantMessageId: snapshot.assistantMessageId ?? null,
    readable: true, generating: snapshot.generating, terminal: snapshot.terminal,
    body: snapshot.body, humanGate: snapshot.humanGate }
}

async function adoptConversation(params) {
  for (const key of ['conversationId', 'turnId', 'requestId']) {
    if (typeof params[key] !== 'string' || !params[key] || params[key].length > 256) throw new Error(`adoption requires ${key}`)
  }
  const live = await inspectAdoption(params)
  if (live.found !== true) return { accepted: false, reason: live.reason }
  const uuid = exactAdoptionUuid(live.url)
  if (tabOwners.has(live.tabId)) return { accepted: false, reason: 'busy' }
  tabOwners.set(live.tabId, params.conversationId)
  try {
    const all = await chrome.storage.local.get(null)
    const conflict = Object.entries(all).some(([key, value]) =>
      key.startsWith(STORAGE_PREFIX) && key !== storageKey(params.conversationId) &&
      (value?.tabId === live.tabId || exactAdoptionUuid(value?.url) === uuid))
    if (conflict) return { accepted: false, reason: 'browser_binding_conflict' }
    if (Object.entries(all).some(([key, value]) => key.startsWith(PENDING_PREFIX) && value?.tabId === live.tabId)) {
      return { accepted: false, reason: 'pending_browser_operation' }
    }
    const prior = all[effectReceiptKey(params.requestId)]
    if (prior) {
      if (prior.action !== 'adopt' || prior.conversationId !== params.conversationId || prior.turnId !== params.turnId ||
          prior.userMessageId !== params.expectedUserMessageId || exactAdoptionUuid(prior.externalUrl) !== uuid) {
        throw new Error('adoption receipt identity conflict')
      }
      const binding = all[storageKey(params.conversationId)]
      if (binding?.tabId !== live.tabId || exactAdoptionUuid(binding?.url) !== uuid) return { accepted: false, reason: 'binding_reconciliation_required' }
      return { accepted: true, reconciled: true, receipt: prior }
    }
    // Re-observe after asynchronous storage inspection; no guessed tab fallback.
    const fresh = await inspectAdoption(params)
    if (fresh.found !== true || fresh.tabId !== live.tabId) return { accepted: false, reason: 'adoption_target_changed' }
    const binding = { tabId: fresh.tabId, windowId: fresh.windowId, url: fresh.url, adopted: true }
    const receipt = { requestId: params.requestId, action: 'adopt', conversationId: params.conversationId,
      turnId: params.turnId, externalUrl: fresh.url, userMessageId: fresh.userMessageId,
      assistantMessageId: fresh.assistantMessageId, generating: fresh.generating,
      tabId: fresh.tabId, windowId: fresh.windowId, expectedWriterEpoch: params.writerEpoch }
    // One atomic storage operation: browser binding is a rebuildable attachment;
    // the Sidecar ledger alone owns the adopted conversation and its lifecycle.
    await chrome.storage.local.set({ [storageKey(params.conversationId)]: binding, [effectReceiptKey(params.requestId)]: receipt })
    return { accepted: true, receipt }
  } finally {
    if (tabOwners.get(live.tabId) === params.conversationId) tabOwners.delete(live.tabId)
  }
}

async function stopConversation(params) {
  const id = params.conversationId
  if (typeof id !== 'string' || !id) throw new TypeError('conversationId is required')
  if (typeof params.turnId !== 'string' || !params.turnId) throw new TypeError('turnId is required')
  if (typeof params.requestId !== 'string' || !params.requestId) throw new TypeError('requestId is required')
  const expected = params.expected
  if (!expected || typeof expected !== 'object' || typeof expected.userMessageId !== 'string' || !expected.userMessageId) {
    throw new TypeError('stop requires expected user message identity')
  }

  const prior = await loadEffectReceipt(params.requestId)
  if (prior) {
    const expectedAssistant = typeof expected.assistantMessageId === 'string' && expected.assistantMessageId
      ? expected.assistantMessageId : null
    const priorAssistant = typeof prior.assistantMessageId === 'string' && prior.assistantMessageId
      ? prior.assistantMessageId : null
    if (
      prior.action !== 'stop' ||
      prior.conversationId !== id ||
      prior.turnId !== params.turnId ||
      prior.userMessageId !== expected.userMessageId ||
      priorAssistant !== expectedAssistant ||
      prior.expectedStateVersion !== params.expectedStateVersion ||
      prior.expectedWriterEpoch !== params.writerEpoch
    ) {
      throw new Error('effect receipt identity conflict')
    }
    return {
      accepted: true,
      reconciled: true,
      userMessageId: prior.userMessageId,
      assistantMessageId: priorAssistant,
      url: prior.externalUrl || params.externalUrl || CHATGPT_URL
    }
  }

  const { state } = await resolveConversationAttachment(id, params.externalUrl, true)
  await ensureContentScriptForAttachment(state, false)
  let stopped
  try {
    stopped = await boundedMessage(state.tabId, {
      type: 'conversation_stop',
      expected
    }, 5_000, undefined, params)
  } catch (error) {
    throw deliveryUncertain(error)
  }
  if (stopped?.deliveryUncertain === true) {
    throw deliveryUncertain(stopped.error || 'Stop outcome unknown')
  }
  if (stopped?.accepted !== true) {
    throw new Error(stopped?.error || 'ChatGPT content script rejected stop')
  }

  const externalUrl = chooseConversationUrl(stopped.url, state.url)
  const assistantMessageId = typeof stopped.assistantMessageId === 'string' && stopped.assistantMessageId
    ? stopped.assistantMessageId : null
  const receipt = await saveEffectReceipt({
    requestId: params.requestId,
    action: 'stop',
    conversationId: id,
    turnId: params.turnId,
    userMessageId: stopped.userMessageId,
    assistantMessageId,
    expectedStateVersion: params.expectedStateVersion,
    expectedWriterEpoch: params.writerEpoch,
    externalUrl
  })
  return {
    accepted: true,
    userMessageId: receipt.userMessageId,
    assistantMessageId: receipt.assistantMessageId,
    assistantText: typeof stopped.assistantText === 'string' ? stopped.assistantText : '',
    url: externalUrl
  }
}

function refreshReceiptResult(receipt, reconciled = false) {
  const common = { receipt, ...(reconciled ? { reconciled: true } : {}) }
  if (receipt.phase === 'applied') return { ...common, accepted: true, refreshed: true }
  if (receipt.phase === 'denied') return { ...common, accepted: false, refreshed: false, reason: receipt.reason }
  return { ...common, accepted: false, refreshed: null, deliveryUncertain: true, reason: 'refresh_outcome_unknown' }
}

async function refreshConversation(params) {
  const identity = JSON.stringify({
    conversationId: params.conversationId, externalUrl: params.externalUrl,
    expectedUserMessageId: params.expectedUserMessageId, expectedAssistantMessageId: params.expectedAssistantMessageId,
    writerEpoch: params.writerEpoch
  })
  const active = refreshRequests.get(params.requestId)
  if (active) {
    if (active.identity !== identity) throw new Error('effect receipt identity conflict')
    return { ...await active.promise, reconciled: true }
  }
  const promise = performRefresh(params)
  refreshRequests.set(params.requestId, { identity, promise })
  try { return await promise }
  finally { if (refreshRequests.get(params.requestId)?.promise === promise) refreshRequests.delete(params.requestId) }
}

async function performRefresh(params) {
  for (const key of ['requestId', 'conversationId', 'expectedUserMessageId']) {
    if (typeof params[key] !== 'string' || !params[key] || params[key].length > 256) throw new TypeError(`refresh requires ${key}`)
  }
  if (params.expectedAssistantMessageId !== null &&
      (typeof params.expectedAssistantMessageId !== 'string' || !params.expectedAssistantMessageId || params.expectedAssistantMessageId.length > 256)) {
    throw new TypeError('refresh requires exact expectedAssistantMessageId or null')
  }
  if (!Number.isInteger(params.writerEpoch) || params.writerEpoch <= 0) throw new TypeError('refresh requires writerEpoch')
  const externalUrl = webGptShiftPageUrl(params.externalUrl)
  if (!externalUrl || !stableConversationUrl(externalUrl)) throw new TypeError('refresh requires exact conversation externalUrl')
  const sameUrl = url => pageIdentity(webGptShiftPageUrl(url)) === pageIdentity(externalUrl)
  const prior = await loadEffectReceipt(params.requestId)
  if (prior) {
    if (prior.action !== 'refresh' || prior.conversationId !== params.conversationId ||
        !sameUrl(prior.externalUrl) || prior.userMessageId !== params.expectedUserMessageId ||
        prior.assistantMessageId !== params.expectedAssistantMessageId || prior.expectedWriterEpoch !== params.writerEpoch) {
      throw new Error('effect receipt identity conflict')
    }
    return refreshReceiptResult(prior, true)
  }

  const denied = reason => ({ accepted: false, refreshed: false, reason })
  const binding = await loadConversation(params.conversationId)
  if (!Number.isInteger(binding?.tabId) || !sameUrl(binding.url)) return denied('exact_binding_unavailable')
  if (sendOwners.has(params.conversationId) || tabOwners.has(binding.tabId)) return denied('busy')
  const owner = {}
  tabOwners.set(binding.tabId, owner)
  try {
    await assertNoUnsettledEffectsForTab(binding.tabId)
    const all = await chrome.storage.local.get(null)
    if (Object.entries(all).some(([key, pending]) => key.startsWith(PENDING_PREFIX) && pending?.tabId === binding.tabId &&
        (pending.phase !== 'submitted' || pending.conversationId !== params.conversationId))) {
      return denied('pending_browser_operation')
    }
    let tab
    try { tab = await chrome.tabs.get(binding.tabId) } catch { return denied('exact_tab_unavailable') }
    if (tab.id !== binding.tabId || !sameUrl(tabPageUrl(tab))) return denied('exact_tab_unavailable')

    const receipt = await saveEffectReceipt({
      requestId: params.requestId, action: 'refresh', phase: 'issued',
      conversationId: params.conversationId, externalUrl,
      userMessageId: params.expectedUserMessageId, assistantMessageId: params.expectedAssistantMessageId,
      expectedWriterEpoch: params.writerEpoch, tabId: binding.tabId
    })
    const denyReceipt = async reason => {
      const completed = { ...receipt, phase: 'denied', reason }
      await chrome.storage.local.set({ [effectReceiptKey(params.requestId)]: completed })
      return refreshReceiptResult(completed)
    }

    // Recheck exact binding and DOM after durable admission. This route never
    // resolves, navigates, creates, reloads for readiness, or reattaches a tab.
    const freshBinding = await loadConversation(params.conversationId)
    if (freshBinding?.tabId !== binding.tabId || !sameUrl(freshBinding.url)) return denyReceipt('exact_binding_changed')
    try { tab = await chrome.tabs.get(binding.tabId) } catch { return denyReceipt('exact_tab_unavailable') }
    if (tab.id !== binding.tabId || !sameUrl(tabPageUrl(tab))) return denyReceipt('exact_tab_unavailable')
    let snapshot
    try {
      snapshot = await boundedMessage(binding.tabId, {
        type: 'conversation_state_observe', expectedUserMessageId: params.expectedUserMessageId
      }, 2000)
    } catch { return denyReceipt('unreadable_dom') }
    if (snapshot?.ready !== true || snapshot.readable !== true || !sameUrl(snapshot.url) ||
        snapshot.userMessageId !== params.expectedUserMessageId ||
        snapshot.assistantMessageId !== params.expectedAssistantMessageId) return denyReceipt('dom_identity_mismatch')
    if (snapshot.humanGate !== false) return denyReceipt('human_gate')
    if (snapshot.generating !== false) return denyReceipt('active_or_unknown_generation')
    if (snapshot.terminal !== true && !['empty', 'incomplete'].includes(snapshot.body)) return denyReceipt('not_terminal_or_blocked')
    // An inactive snapshot cannot prove that an older timed-out command ended.
    await assertNoUnsettledEffectsForTab(binding.tabId, params.requestId)

    try {
      await chrome.tabs.reload(binding.tabId)
      const completed = { ...receipt, phase: 'applied' }
      await chrome.storage.local.set({ [effectReceiptKey(params.requestId)]: completed })
      return refreshReceiptResult(completed)
    } catch {
      // The issued durable intent survives restart. Its effect is unknown and
      // the same request is never allowed to issue another reload.
      return refreshReceiptResult(receipt)
    }
  } finally {
    if (tabOwners.get(binding.tabId) === owner) tabOwners.delete(binding.tabId)
  }
}

async function sendConversation(params) {
  const id = params.conversationId
  if (typeof params.requestId === 'string' && params.requestId) {
    const receipt = await loadEffectReceipt(params.requestId)
    if (receipt) {
      if (receipt.conversationId !== id || receipt.turnId !== params.turnId) {
        throw new Error('effect receipt identity conflict')
      }
      return {
        accepted: true,
        reconciled: true,
        userMessageId: receipt.userMessageId,
        url: receipt.externalUrl || params.externalUrl || CHATGPT_URL
      }
    }
  }
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
    params.externalUrl,
    params.existingOnly === true
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
    ...(params.requestId ? { requestId: params.requestId } : {}),
    ...(writerRegistrationId(params) ? { registrationId: writerRegistrationId(params), writerEpoch: params.writerEpoch } : {}),
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
    guarded: true,
    ...(params.expected ? { expected: params.expected } : {}),
    ...(params.authoritativeState === true ? { authoritativeState: true } : {}),
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
  }, params) } catch (error) { throw deliveryUncertain(error) }
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
    turnId: params.turnId,
    guarded: true,
    ...(params.authoritativeState === true ? { authoritativeState: true } : {})
  }, 15_000, undefined, params) } catch (error) { throw deliveryUncertain(error) }
  if (submitted?.deliveryUncertain === true) throw deliveryUncertain(submitted.error || 'Submit outcome unknown')
  if (submitted?.accepted !== true) {
    await clearPendingTurn(params.conversationId)
    throw new Error(submitted?.error || 'ChatGPT content script rejected the prompt submission')
  }
  if (typeof submitted.userMessageId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(submitted.userMessageId)) {
    throw deliveryUncertain('Submit acknowledgement lacked stable user message identity')
  }
  const submittedUrl = await waitForConversationThreadUrl(currentState.tabId, currentState.url)
  const knownUrls = [stableConversationUrl(state.url), stableConversationUrl(submitted.url)]
  if (knownUrls.some(url => url && exactAdoptionUuid(url) !== exactAdoptionUuid(submittedUrl))) {
    throw deliveryUncertain('Committed conversation UUID conflicts with the prior binding or submission acknowledgement')
  }
  let observed
  let committedTab
  try {
    observed = await boundedMessage(currentState.tabId, {
      type: 'conversation_state_observe', expectedUserMessageId: submitted.userMessageId
    }, 2000)
    committedTab = await chrome.tabs.get(currentState.tabId)
  } catch (error) { throw deliveryUncertain(error) }
  if (observed?.ready !== true || observed.readable !== true || observed.userMessageId !== submitted.userMessageId ||
      pageIdentity(stableConversationUrl(observed.url)) !== pageIdentity(submittedUrl) ||
      pageIdentity(stableConversationUrl(committedTab.url)) !== pageIdentity(submittedUrl)) {
    throw deliveryUncertain('Submitted user UUID was not observed on the committed conversation')
  }
  const submittedState = {
    ...currentState,
    url: submittedUrl
  }
  await saveConversation(params.conversationId, submittedState)
  if (typeof params.requestId === 'string' && params.requestId) {
    await saveEffectReceipt({
      requestId: params.requestId,
      conversationId: params.conversationId,
      turnId: params.turnId,
      userMessageId: submitted.userMessageId,
      externalUrl: submittedUrl
    })
  }
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

async function webGptStrengthDomDiagnostic(tabId) {
  if (!chrome.scripting?.executeScript) return null
  try {
    const execution = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const labelOf = (node) => (
          node?.getAttribute?.('aria-label') ||
          node?.getAttribute?.('title') ||
          node?.textContent ||
          ''
        ).trim()
        const reactPropsOf = (node) => {
          if (!node) return null
          const propsKey = Object.keys(node).find((key) => key.startsWith('__reactProps$'))
          const props = propsKey ? node[propsKey] : null
          return props && typeof props === 'object' ? props : null
        }
        const handlersOf = (node) => {
          const props = reactPropsOf(node)
          if (!props) return []
          return Object.entries(props)
            .filter(([key, value]) => /^on[A-Z]/.test(key) && typeof value === 'function')
            .map(([key]) => key)
            .sort()
        }
        const handlerSourcesOf = (node) => {
          const props = reactPropsOf(node)
          if (!props) return {}
          return Object.fromEntries(
            Object.entries(props)
              .filter(([key, value]) => /^on[A-Z]/.test(key) && typeof value === 'function')
              .map(([key, value]) => [key, String(value).slice(0, 800)])
          )
        }
        const rectOf = (node) => {
          const rect = node?.getBoundingClientRect?.()
          return rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null
        }
        return [...document.querySelectorAll('.__composer-pill')]
          .slice(0, 12)
          .map((node) => {
            const popupId = node.getAttribute?.('aria-controls') || null
            const popup = popupId ? document.getElementById(popupId) : null
            const popupItems = popup?.querySelectorAll
              ? [...popup.querySelectorAll('[role], [aria-valuenow], [aria-checked], button, input')].slice(0, 40).map((item) => ({
                tagName: item.tagName,
                role: item.getAttribute?.('role') || null,
                text: labelOf(item),
                ariaChecked: item.getAttribute?.('aria-checked') || null,
                ariaSelected: item.getAttribute?.('aria-selected') || null,
                ariaValueNow: item.getAttribute?.('aria-valuenow') || null,
                ariaValueMin: item.getAttribute?.('aria-valuemin') || null,
                ariaValueMax: item.getAttribute?.('aria-valuemax') || null,
                ariaValueText: item.getAttribute?.('aria-valuetext') || null,
                dataState: item.getAttribute?.('data-state') || null,
                className: typeof item.className === 'string' ? item.className : null,
                handlers: handlersOf(item),
                handlerSources: handlerSourcesOf(item),
                rect: rectOf(item),
                children: typeof item.className === 'string' && item.className.includes('SliderControl')
                  ? [...item.querySelectorAll('*')].slice(0, 40).map((child) => ({
                    tagName: child.tagName,
                    role: child.getAttribute?.('role') || null,
                    className: typeof child.className === 'string' ? child.className : null,
                    textContent: (child.textContent || '').trim().slice(0, 100),
                    ariaValueNow: child.getAttribute?.('aria-valuenow') || null,
                    ariaValueMin: child.getAttribute?.('aria-valuemin') || null,
                    ariaValueMax: child.getAttribute?.('aria-valuemax') || null,
                    rect: rectOf(child)
                  }))
                  : null
              }))
              : []
            return {
              tagName: node.tagName,
              id: node.id || null,
              className: typeof node.className === 'string' ? node.className : null,
              text: labelOf(node),
              ariaLabel: node.getAttribute?.('aria-label') || null,
              title: node.getAttribute?.('title') || null,
              textContent: (node.textContent || '').trim(),
              attributes: Object.fromEntries([...node.attributes].map((attribute) => [attribute.name, attribute.value])),
              handlers: handlersOf(node),
              handlerSources: handlerSourcesOf(node),
              rect: rectOf(node),
              parent: node.parentElement ? {
                tagName: node.parentElement.tagName,
                className: typeof node.parentElement.className === 'string' ? node.parentElement.className : null,
                handlers: handlersOf(node.parentElement)
              } : null,
              popup: popup ? {
                id: popupId,
                tagName: popup.tagName,
                className: typeof popup.className === 'string' ? popup.className : null,
                textContent: (popup.textContent || '').trim().slice(0, 1000),
                items: popupItems
              } : null
            }
          })
      }
    })
    return execution?.[0]?.result ?? null
  } catch (error) {
    return [{ error: error instanceof Error ? error.message : String(error) }]
  }
}

function webGptShiftPageUrl(url) {
  const page = chatGptPageUrl(url)
  if (!page) return null
  const pathname = new URL(page).pathname
  return /^(?:\/|\/c\/[^/]+|\/g\/g-p-[^/]+\/(?:project|c\/[^/]+))$/.test(pathname) ? page : null
}

async function webGptShiftTest(params) {
  if (typeof params.target !== 'string' || !params.target.trim()) throw new Error('WebGPT shift target is required')
  const targetTabId = params.target_tab_id === undefined ? null : params.target_tab_id
  if (targetTabId !== null && (!Number.isInteger(targetTabId) || targetTabId < 0)) throw new Error('WebGPT shift target_tab_id must be an integer')
  if (params.target_tab_id === null) throw new Error('WebGPT shift target_tab_id must be an integer')
  const targetUrl = params.target_url === undefined ? null : webGptShiftPageUrl(params.target_url)
  if (params.target_url !== undefined && !targetUrl) throw new Error('WebGPT shift target_url must be a ChatGPT root, project, or conversation URL')
  let tab
  if (targetTabId !== null) {
    try { tab = await chrome.tabs.get(targetTabId) } catch { throw new Error('No matching ChatGPT tab was found for target_tab_id') }
    if (tab?.id !== targetTabId || !webGptShiftPageUrl(tabPageUrl(tab))) throw new Error('No matching ChatGPT tab was found for target_tab_id')
    if (targetUrl && pageIdentity(tabPageUrl(tab)) !== pageIdentity(targetUrl)) throw new Error('WebGPT shift target_tab_id does not match target_url')
  } else {
    const stored = await chrome.storage.local.get(null)
    const window0 = stored[WINDOW0_KEY]
    if (!Number.isInteger(window0?.windowId)) throw new Error('No existing Sidecar window is registered')
    const tabs = await chrome.tabs.query({ windowId: window0.windowId })
    const candidates = tabs.filter((tab) => Boolean(webGptShiftPageUrl(tabPageUrl(tab))))
    const managedTabIds = new Set(
      Object.entries(stored)
        .filter(([key, binding]) => key.startsWith(STORAGE_PREFIX) && Number.isInteger(binding?.tabId))
        .map(([, binding]) => binding.tabId)
    )
    const managedCandidates = candidates.filter((candidate) => managedTabIds.has(candidate.id))
    const eligible = managedCandidates.length ? managedCandidates : candidates
    tab = targetUrl
      ? eligible.find((candidate) => pageIdentity(tabPageUrl(candidate)) === pageIdentity(targetUrl))
      : (eligible.find((candidate) => candidate.active) || eligible[0])
    if (!tab || !Number.isInteger(tab.id)) {
      throw new Error(targetUrl ? 'No matching ChatGPT conversation tab was found' : 'No existing ChatGPT tab was found')
    }
  }
  await assertNoRetiredConversationWrite({ externalUrl: tabPageUrl(tab) })
  let result
  try {
    result = await boundedMessage(tab.id, { type: 'webgpt_shift_test', target: params.target }, 10_000, undefined, params)
  } catch (error) {
    if (error?.code === 'DELIVERY_UNCERTAIN') throw error
    const diagnostic = await webGptStrengthDomDiagnostic(tab.id)
    const detail = diagnostic ? `; diagnostic=${JSON.stringify(diagnostic)}` : ''
    throw new Error(`${error instanceof Error ? error.message : String(error)}${detail}`)
  }
  if (result?.switched !== true) {
    const diagnostic = await webGptStrengthDomDiagnostic(tab.id)
    const detail = diagnostic ? `; diagnostic=${JSON.stringify(diagnostic)}` : ''
    throw new Error(`${result?.error || 'WebGPT shift probe failed'}${detail}`)
  }
  return { ...result, tabId: tab.id, url: tabPageUrl(tab) }
}

async function readConversationSnapshot(params) {
  const conversationId = params?.conversationId
  if (typeof conversationId !== 'string' || !conversationId) throw new Error('conversation_snapshot requires conversationId')

  const stored = await loadConversation(conversationId)
  const expectedUrl = chooseConversationUrl(params?.externalUrl, stored?.url)
  if (!stored || !stableConversationUrl(expectedUrl)) return { found: false }

  let tab = await findRegisteredLiveTab(stored, expectedUrl)
  if (!tab && Number.isInteger(stored.windowId)) {
    tab = await findMatchingConversationTab(stored.windowId, expectedUrl)
  }
  if (!tab || !Number.isInteger(tab.id)) return { found: false }

  const snapshot = await boundedMessage(tab.id, { type: 'conversation_snapshot' }, 2000)
  const actualUrl = stableConversationUrl(snapshot?.url)
  if (!actualUrl || pageIdentity(actualUrl) !== pageIdentity(expectedUrl)) return { found: false }

  return {
    found: true,
    url: actualUrl,
    generating: snapshot?.generating === true,
    assistantText: typeof snapshot?.assistantText === 'string' ? snapshot.assistantText : ''
  }
}

function unreadableStateObservation(conversationId, target, turnId) {
  return {
    contractVersion: 1, source: 'browser', conversationId, target,
    observedAt: new Date().toISOString(), turnId,
    userMessageId: null, assistantMessageId: null, assistantText: null,
    readable: false, generating: null, terminal: null, body: 'unknown', humanGate: null,
    delivery: 'unknown', requestId: null
  }
}

async function readConversationStateObservation(params) {
  const conversationId = params?.conversationId
  const turnId = params?.turnId
  const expectedUserMessageId = params?.expectedUserMessageId
  if (typeof conversationId !== 'string' || !conversationId) throw new Error('conversation_state_observe requires conversationId')
  if (typeof turnId !== 'string' || !turnId) throw new Error('conversation_state_observe requires turnId')
  if (typeof expectedUserMessageId !== 'string' || !expectedUserMessageId) throw new Error('conversation_state_observe requires expectedUserMessageId')
  const stored = await loadConversation(conversationId)
  const expectedUrl = chooseConversationUrl(params?.externalUrl, stored?.url)
  if (!stored || !stableConversationUrl(expectedUrl)) return unreadableStateObservation(conversationId, expectedUrl || CHATGPT_URL, turnId)
  let tab
  if (stored.adopted === true) {
    const exact = (await chrome.tabs.query({})).filter(item => exactAdoptionUuid(tabPageUrl(item)) === exactAdoptionUuid(expectedUrl))
    if (exact.length === 1) tab = exact[0]
  } else {
    tab = await findRegisteredLiveTab(stored, expectedUrl)
    if (!tab && Number.isInteger(stored.windowId)) tab = await findMatchingConversationTab(stored.windowId, expectedUrl)
  }
  if (!tab || !Number.isInteger(tab.id)) return unreadableStateObservation(conversationId, expectedUrl, turnId)
  const allowLatestUser = params.allowLatestUser === true
  const snapshot = await boundedMessage(tab.id, {
    type: 'conversation_state_observe', expectedUserMessageId,
    ...(allowLatestUser ? { allowLatestUser: true } : {})
  }, 2000)
  const actualUrl = stableConversationUrl(snapshot?.url)
  const sameIdentity = stored.adopted === true
    ? exactAdoptionUuid(actualUrl) !== null && exactAdoptionUuid(actualUrl) === exactAdoptionUuid(expectedUrl)
    : pageIdentity(actualUrl) === pageIdentity(expectedUrl)
  if (allowLatestUser && actualUrl && sameIdentity && snapshot?.ready === true && snapshot?.readable === false &&
      snapshot.reason === 'human_turn_anchor_unavailable') {
    throw Object.assign(new Error('human_turn_anchor_unavailable'), { code: 'HUMAN_TURN_ANCHOR_UNAVAILABLE' })
  }
  const userMatches = allowLatestUser
    ? typeof snapshot?.userMessageId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(snapshot.userMessageId)
    : snapshot?.userMessageId === expectedUserMessageId
  const assistantMatches = !allowLatestUser || snapshot?.assistantMessageId == null ||
    (typeof snapshot.assistantMessageId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(snapshot.assistantMessageId))
  if (!actualUrl || !sameIdentity || snapshot?.ready !== true || snapshot?.readable !== true || !userMatches || !assistantMatches) {
    return unreadableStateObservation(conversationId, actualUrl || expectedUrl, turnId)
  }
  return {
    contractVersion: 1, source: 'browser', conversationId, target: actualUrl,
    observedAt: new Date().toISOString(), turnId,
    userMessageId: snapshot.userMessageId,
    assistantMessageId: typeof snapshot.assistantMessageId === 'string' && snapshot.assistantMessageId ? snapshot.assistantMessageId : null,
    assistantText: typeof snapshot.assistantText === 'string' ? snapshot.assistantText : '',
    readable: true,
    generating: typeof snapshot.generating === 'boolean' ? snapshot.generating : null,
    terminal: typeof snapshot.terminal === 'boolean' ? snapshot.terminal : null,
    body: ['unknown', 'empty', 'incomplete', 'substantive'].includes(snapshot.body) ? snapshot.body : 'unknown',
    humanGate: typeof snapshot.humanGate === 'boolean' ? snapshot.humanGate : null,
    delivery: 'unknown', requestId: null
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
    if (Object.hasOwn(stored, `pending-retirement:${pending.conversationId}`) ||
        Object.hasOwn(stored, `pending-retirement-staged:${pending.conversationId}`)) continue
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
    const writerAuthority = await loadWriterAuthority()
    const bindings = Object.entries(stored).filter(([key]) => key.startsWith(STORAGE_PREFIX))
    const tabs = await chrome.tabs.query({})
    const managedTabs = tabs.filter(tab => bindings.some(([, binding]) => binding?.tabId === tab.id))
      .map(tab => ({ tabId: tab.id, windowId: tab.windowId, url: tabPageUrl(tab), title: tab.title, status: tab.status, discarded: tab.discarded }))
    await Promise.all(managedTabs.map(async tab => {
      try { tab.page = await boundedMessage(tab.tabId, { type: 'sidecar_ping' }, 2000) }
      catch (error) { tab.pageError = error instanceof Error ? error.message : String(error) }
    }))
    return { ...await extensionLifecycle.status(), writerEpoch: writerAuthority?.epoch ?? null, operations: [...activeSends.values()], managedTabs }
  }
  if (message.method === 'extension_reload') {
    await assertNoPendingContentEffects()
    return extensionLifecycle.requestReload(message.params)
  }
  if (message.method === 'writer_epoch_claim') {
    return runWriterClaim(message.params ?? {})
  }
  if (message.method === 'writer_quiesce') return runWriterQuiesce(message.params ?? {})
  if (message.method === 'pending_retirement_inspect') return runPendingMaintenance(() => inspectPendingRetirement(message.params ?? {}))
  if (message.method === 'pending_retire') return runPendingMaintenance(() => retirePending(message.params ?? {}))
  if (message.method === 'webgpt_shift_test') return runWriterMutation(message.params ?? {}, () => webGptShiftTest(message.params ?? {}))
  if (message.method === 'project_find') return findProject(message.params ?? {})
  if (message.method === 'project_create') return runWriterMutation(message.params ?? {}, () => createProject(message.params ?? {}))
  if (message.method === 'conversation_create') return runWriterMutation(message.params ?? {}, () => createConversation(message.params ?? {}))
  if (message.method === 'conversation_observe') {
    const expectedUrl = message.params?.externalUrl
    if (!stableConversationUrl(expectedUrl)) throw new Error('exact conversation URL required')
    const matches = (await chrome.tabs.query({})).filter(tab => tabMatchesExpectedUrl(tab, expectedUrl))
    if (matches.length !== 1) return { found: false, reason: 'exact_tab_unavailable' }
    const tab = matches[0]
    const snapshot = await boundedMessage(tab.id, {
      type: 'conversation_observe',
      ...(message.params?.authoritativeState === true ? { authoritativeState: true } : {})
    }, 2000)
    if (snapshot?.ready !== true || !tabMatchesExpectedUrl({ url: snapshot.url }, expectedUrl)) return { found: false }
    return { ...snapshot, found: true }
  }
  if (message.method === 'conversation_supervision_inspect') return runWriterMutation(message.params ?? {}, () => inspectSupervision(message.params ?? {}))
  if (message.method === 'conversation_adoption_inspect') return runWriterMutation(message.params ?? {}, () => inspectAdoption(message.params ?? {}))
  if (message.method === 'conversation_adopt') return runWriterMutation(message.params ?? {}, () => adoptConversation(message.params ?? {}))
  if (message.method === 'conversation_snapshot') return readConversationSnapshot(message.params ?? {})
  if (message.method === 'conversation_state_observe') return readConversationStateObservation(message.params ?? {})
  if (message.method === 'conversation_effect_receipt') {
    const requestId = message.params?.requestId
    if (typeof requestId !== 'string' || !requestId || requestId.length > 256) throw new TypeError('valid requestId required')
    const receipt = await loadEffectReceipt(requestId)
    return receipt ? { found: true, receipt } : { found: false }
  }
  if (message.method === 'conversation_send') {
    return runWriterMutation(message.params ?? {}, () => sendConversation(message.params ?? {}))
  }
  if (message.method === 'conversation_stop') {
    return runWriterMutation(message.params ?? {}, () => stopConversation(message.params ?? {}))
  }
  if (message.method === 'conversation_refresh') {
    return runWriterMutation(message.params ?? {}, () => refreshConversation(message.params ?? {}))
  }
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
  let result
  try {
    result = await executeRequest(message)
    extensionLifecycle.afterResponse(message.method, result)
  } catch (error) {
    try {
      postNative({
        kind: 'response',
        requestId: message.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        errorCode: error?.code
      })
    } catch {
      scheduleReconnect()
    }
    return
  }

  try {
    postNative({ kind: 'response', requestId: message.requestId, ok: true, result })
  } catch {
    // The browser effect may already be durable. Never synthesize a business
    // rejection from response-channel loss; Sidecar will time out and reconcile.
    scheduleReconnect()
  }
}

function runContentMutation(action) {
  return recoveryReady.then(() => extensionLifecycle.runMutation(action))
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.kind === 'content_effect_document') {
    sendResponse(trustedContentSender(sender) && typeof message.token === 'string'
      ? { token: message.token, tabId: sender.tab.id, documentId: sender.documentId, url: sender.url || sender.tab.url }
      : { ready: false })
    return
  }
  if (message?.kind === 'content_effect_complete') {
    void settleContentEffect(message.effect, sender).then(sendResponse)
      .catch(() => sendResponse({ settled: false, reason: 'storage_error' }))
    return true
  }
  if (message?.kind === 'pending_turn_lookup') {
    void runContentMutation(() => claimPendingTurnForTab(sender.tab))
      .then((pending) => sendResponse(pending))
      .catch(() => sendResponse(null))
    return true
  }

  if (message?.kind !== 'conversation_event' || !message.event) return

  const event = message.event
  const isTerminal = event.type === 'response_completed' || event.type === 'need_continue' || event.type === 'error'
  if (isTerminal) {
    void runContentMutation(async () => {
      try { await assertNoRetiredConversationWrite(event) } catch {
        sendResponse({ durable: false, reason: 'retired_unknown' })
        return
      }
      const eventId = terminalEventId(event)
      const existing = await loadOutboxEvent(eventId)
      if (existing) {
        const pending = await loadPendingTurn(event.conversationId)
        if (pending?.turnId === event.turnId) await clearPendingTurn(event.conversationId)
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

  void runContentMutation(async () => {
    await assertNoRetiredConversationWrite(event)
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
  void runContentMutation(() => claimAndKickRecoveryMonitor(tabId, changeInfo, tab)).catch(() => {})
})

const recoveryReady = lifecycleReady.then(async () => {
  if ((await extensionLifecycle.status()).restoration.state === 'ready') {
    await extensionLifecycle.runMutation(reconcileClosedPreSubmitTurns)
  }
})
chrome.runtime.onInstalled.addListener(connectNative)
chrome.runtime.onStartup.addListener(connectNative)
connectNative()
