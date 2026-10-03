import { isDeepStrictEqual } from 'node:util'
import { exactConversationUuid } from './conversation-adoption.mjs'

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const SHA = /^[a-f0-9]{64}$/
const queues = new WeakMap()
const fail = reason => { throw Object.assign(new Error(reason), { code: reason }) }
const targetOf = target => 'https://chatgpt.com/c/' + exactConversationUuid(target)

export function validateRetirementRequest(payload, retire = false) {
  const keys = retire
    ? ['conversationId', 'requestId', 'operationId', 'expectedPendingDigest', 'expectedInstanceId', 'expectedBuildId', 'reason']
    : ['conversationId', 'requestId']
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== keys.length ||
      Object.keys(payload).some(key => !keys.includes(key)) ||
      ['conversationId', 'requestId'].some(key => typeof payload[key] !== 'string' || !payload[key] || payload[key].length > 256)) {
    throw new TypeError('exact pending retirement fields required')
  }
  if (retire && (!UUID.test(payload.operationId ?? '') || !UUID.test(payload.expectedInstanceId ?? '') ||
      !SHA.test(payload.expectedPendingDigest ?? '') || !SHA.test(payload.expectedBuildId ?? '') ||
      payload.reason !== 'closed_target_after_quiesce')) throw new TypeError('invalid pending retirement snapshot')
}

async function identity(host, payload, record = null) {
  record ??= await host.store.read(payload.conversationId)
  const intents = record.events.filter(event => event.type === 'send_intent' && event.requestId === payload.requestId)
  if (record.id !== payload.conversationId || record.status !== 'delivery_uncertain' || intents.length !== 1 ||
      intents[0].turnId !== record.latestTurnId || intents[0].source !== 'watchdog' ||
      !UUID.test(intents[0].registrationId ?? '')) fail('unknown_watchdog_attempt_required')
  const intent = intents[0]
  const target = targetOf(record.externalUrl)
  if (intent.target !== undefined && targetOf(intent.target) !== target) fail('registration_target_mismatch')
  const registrationId = intent.registrationId.toLowerCase()
  const authority = await host.watchdogAuthority.assertRevoked({ registrationId, target })
  if (authority?.accepted !== true) fail(authority?.reason ?? 'durable_revocation_required')
  if (!Number.isSafeInteger(host.writer.epoch) || host.writer.epoch <= 0) fail('writer_epoch_required')
  return { conversationId: record.id, requestId: payload.requestId, turnId: intent.turnId,
    registrationId, target, writerEpoch: host.writer.epoch }
}

function matches(result, expected) {
  return result && Object.entries(expected).every(([key, value]) => result[key] === value)
}

export function verifiedRetirementReceipt(receipt, expected) {
  return Boolean(matches(receipt, expected) && receipt.version === 1 && receipt.state === 'retired' &&
    receipt.delivery === 'unknown' && Number.isInteger(receipt.tabId) && receipt.tabId >= 0 &&
    Number.isFinite(receipt.retiredAt) && receipt.retiredAt > 0 &&
    receipt.proof?.originalTabAbsent === true && receipt.proof?.targetAbsent === true &&
    receipt.proof?.writerDrained === true && receipt.proof?.contentDrained === true &&
    receipt.proof?.contentEffectCount === 0 && receipt.proof?.outboxCount === 0 &&
    receipt.proof?.revokedRegistration === true &&
    ['native_pending', 'host_ledger'].includes(receipt.proof?.generationSource))
}

export async function inspectPendingRetirement(host, payload) {
  validateRetirementRequest(payload)
  const expected = await identity(host, payload)
  const result = await host.bridge.request('pending_retirement_inspect', expected)
  if (result?.found !== true) return { found: false, retirable: false, reason: result?.reason ?? 'pending_not_found' }
  if (!matches(result, expected) || !SHA.test(result.pendingDigest ?? '') ||
      typeof result.instanceId !== 'string' || !UUID.test(result.instanceId) || !SHA.test(result.buildId ?? '') ||
      !Number.isInteger(result.tabId)) fail('native_inspection_identity_mismatch')
  return result
}

export function retirePendingAttempt(host, payload) {
  validateRetirementRequest(payload, true)
  let byConversation = queues.get(host)
  if (!byConversation) queues.set(host, byConversation = new Map())
  const previous = byConversation.get(payload.conversationId) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(async () => {
    const expected = await identity(host, payload)
    const quiescence = await host.bridge.request('writer_quiesce', {
      writerEpoch: expected.writerEpoch, registrationId: expected.registrationId, target: expected.target
    })
    if (quiescence?.quiescent !== true || quiescence.registrationId !== expected.registrationId ||
        quiescence.currentWriterEpoch !== expected.writerEpoch || quiescence.target !== expected.target) fail('writer_not_quiescent')
    const result = await host.bridge.request('pending_retire', { ...expected, ...payload })
    const receiptExpected = { ...expected, writerEpoch: result?.receipt?.writerEpoch, operationId: payload.operationId, pendingDigest: payload.expectedPendingDigest,
      instanceId: payload.expectedInstanceId, buildId: payload.expectedBuildId, reason: payload.reason }
    if (result?.accepted !== true || result.retired !== true || result.delivery !== 'unknown' ||
        !Number.isSafeInteger(result.receipt?.writerEpoch) || result.receipt.writerEpoch <= 0 || result.receipt.writerEpoch > expected.writerEpoch ||
        !verifiedRetirementReceipt(result.receipt, receiptExpected)) fail('native_retirement_receipt_mismatch')
    // Audit only; the reducer intentionally keeps the original unknown result.
    await host.store.recordPendingRetirement(payload.conversationId, { type: 'pending_retired', source: 'local-operator',
        turnId: expected.turnId, requestId: expected.requestId, operationId: payload.operationId,
        registrationId: expected.registrationId, reason: payload.reason, delivery: 'unknown', receipt: result.receipt }, async current => {
      const finalIdentity = await identity(host, payload, current)
      if (!isDeepStrictEqual(finalIdentity, expected)) fail('retirement_identity_changed')
    })
    return result
  })
  const tail = run.catch(() => {})
  byConversation.set(payload.conversationId, tail)
  void tail.then(() => { if (byConversation.get(payload.conversationId) === tail) byConversation.delete(payload.conversationId) })
  return run
}
