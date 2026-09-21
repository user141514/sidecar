import { createHash } from 'node:crypto'
import { canonicalTarget } from './send-mailbox.mjs'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

export function exactConversationUuid(target) {
  let url
  try { url = new URL(target) } catch { throw new TypeError('exact ChatGPT conversation URL required') }
  const match = url.pathname.match(/^\/(?:g\/g-p-[^/]+\/)?c\/([^/]+)\/?$/)
  if (url.origin !== 'https://chatgpt.com' || url.username || url.password || url.search || url.hash || !match || !UUID.test(match[1])) {
    throw new TypeError('exact ChatGPT conversation UUID required')
  }
  return match[1].toLowerCase()
}

// Operator-only adoption. It never creates a browser tab, navigates, sends,
// stops, changes the managed Project, or infers identity from a title/index.
export async function adoptExistingConversation(host, payload) {
  const keys = ['target', 'expectedUserMessageId', 'expectedWriterEpoch', 'source']
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).length !== keys.length || Object.keys(payload).some(key => !keys.includes(key))) {
    throw new TypeError('explicit adoption fields are required')
  }
  const { target, expectedUserMessageId, expectedWriterEpoch, source } = payload
  const uuid = exactConversationUuid(target)
  if (source !== 'human') throw new TypeError('adoption requires explicit human authority')
  if (typeof expectedUserMessageId !== 'string' || !UUID.test(expectedUserMessageId)) throw new TypeError('explicit persistent user message UUID required')
  if (!Number.isSafeInteger(expectedWriterEpoch) || expectedWriterEpoch <= 0) throw new TypeError('expected writer epoch required')
  if (host.writer.mode !== 'managed') return { accepted: false, reason: 'writer_mode_mismatch' }
  if (expectedWriterEpoch !== host.writer.epoch) return { accepted: false, reason: 'writer_epoch_mismatch' }

  const key = canonicalTarget(target)
  const requestId = hash(['adopt-existing/v1', key, expectedUserMessageId])
  const turnId = `adopted_${hash([uuid, expectedUserMessageId])}`
  const allocationIntentId = `adopt-existing:${uuid}`
  const inspect = await host.bridge.request('conversation_adoption_inspect', { externalUrl: target, expectedUserMessageId })
  if (inspect?.found !== true) return { accepted: false, reason: inspect?.reason || 'target_unavailable' }
  if (typeof inspect.url !== 'string' || canonicalTarget(inspect.url) !== key || inspect.readable !== true || inspect.userMessageId !== expectedUserMessageId) {
    return { accepted: false, reason: 'adoption_identity_mismatch' }
  }

  const known = await host.store.findByExternalUrl(target)
  if (known.length > 1) return { accepted: false, reason: 'ambiguous_local_binding' }
  const validateReceipt = (receipt, record) => Boolean(receipt && receipt.action === 'adopt' &&
    receipt.requestId === requestId && receipt.conversationId === record.id && receipt.turnId === turnId &&
    receipt.userMessageId === expectedUserMessageId && typeof receipt.externalUrl === 'string' &&
    canonicalTarget(receipt.externalUrl) === key && Number.isInteger(receipt.tabId) && Number.isInteger(receipt.windowId) &&
    Number.isInteger(receipt.expectedWriterEpoch) && receipt.expectedWriterEpoch > 0 && typeof receipt.generating === 'boolean')

  // A lost ACK is reconciled from a durable effect receipt. It is never a
  // reason to replay a browser mutation, even though binding is idempotent.
  let settled = null
  if (known.length === 1 && known[0].allocationIntentId === allocationIntentId) {
    let lookup
    try { lookup = await host.bridge.request('conversation_effect_receipt', { requestId }) } catch {}
    if (lookup?.found === true && validateReceipt(lookup.receipt, known[0])) {
      try {
        settled = await host.mailbox.reconcile(target, requestId, {
          accepted: true, conversationId: known[0].id, conversationUuid: uuid, turnId
        }, known[0].id)
      } catch {}
      if (settled?.accepted === true) await host.store.recordAdoption(known[0].id, lookup.receipt)
    }
  }

  if (settled?.accepted !== true) {
    settled = await host.mailbox.run(target, requestId, { action: 'adopt', source, target: key, expectedUserMessageId }, async markDispatching => {
      const matches = await host.store.findByExternalUrl(target)
      if (matches.length > 1) return { accepted: false, reason: 'ambiguous_local_binding' }
      if (matches[0] && matches[0].allocationIntentId !== allocationIntentId) {
        // Existing Sidecar-owned turns stay owned by their original record.
        if (!matches[0].latestTurnId) return { accepted: false, reason: 'existing_binding_not_adoptable' }
        return { accepted: true, conversationId: matches[0].id, conversationUuid: uuid, alreadyManaged: true }
      }
      const record = matches[0] ?? await host.store.allocate({
        backend: 'chatgpt-web-extension', externalUrl: inspect.url,
        intentId: allocationIntentId, intentDigest: hash(['adopt-existing/v1', key])
      })
      const adopted = record.events?.find(event => event.type === 'conversation_adopted')
      if (adopted) return { accepted: true, conversationId: record.id, conversationUuid: uuid, alreadyManaged: true }
      await markDispatching({ action: 'adopt', conversationId: record.id, turnId })
      const result = await host.bridge.request('conversation_adopt', {
        conversationId: record.id, externalUrl: inspect.url, turnId, requestId,
        expectedUserMessageId, writerEpoch: host.writer.epoch
      })
      if (result?.accepted !== true || !validateReceipt(result.receipt, record)) {
        throw new Error('adoption binding outcome unconfirmed; receipt reconciliation required')
      }
      await host.store.recordAdoption(record.id, result.receipt)
      return { accepted: true, conversationId: record.id, conversationUuid: uuid, turnId }
    })
  }
  if (settled?.accepted !== true) return settled
  const current = await host.stateByTarget(target)
  if (current?.found !== true) return { accepted: false, reason: current?.reason || 'adoption_state_unavailable', conversationId: settled.conversationId }
  return { ...settled, state: current.state }
}
