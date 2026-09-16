import { parseConversationState, parseObservation } from './conversation-contract.mjs'

const revFind = (items, fn) => [...items].reverse().find(fn) ?? null
const turnOf = ledger => ledger.latestTurnId || revFind(ledger.events, e => e.type === 'send_intent' && e.turnId)?.turnId || null
const intentOf = (ledger, turnId) => revFind(ledger.events, e => e.type === 'send_intent' && e.turnId === turnId)

function sameTarget(a, b) {
  if (a === b) return true
  try {
    const pa = new URL(a).pathname, pb = new URL(b).pathname
    const ca = pa.match(/\/c\/([0-9a-f-]+)\/?$/i)?.[1]?.toLowerCase()
    const cb = pb.match(/\/c\/([0-9a-f-]+)\/?$/i)?.[1]?.toLowerCase()
    if (ca && cb) return ca === cb
    const ga = pa.match(/^\/g\/g-p-([0-9a-f]{32})(?:-[^/]+)?\//i)?.[1]?.toLowerCase()
    const gb = pb.match(/^\/g\/g-p-([0-9a-f]{32})(?:-[^/]+)?\//i)?.[1]?.toLowerCase()
    return Boolean(ga && gb && ga === gb)
  } catch { return false }
}

function previous(ledger) {
  const event = revFind(ledger.events, e => e.type === 'conversation_state' && e.state)
  return event ? parseConversationState(event.state) : null
}

function latestObservation(ledger, observations, turnId, source) {
  return observations.map(parseObservation)
    .filter(o => o.source === source && o.conversationId === ledger.id && o.turnId === turnId && sameTarget(ledger.externalUrl, o.target))
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt)).at(-1) ?? null
}

function has(ledger, turnId, ...types) {
  return ledger.events.some(e => e.turnId === turnId && types.includes(e.type))
}

function baseDelivery(ledger, turnId) {
  if (!turnId) return 'none'
  if (ledger.status === 'delivery_uncertain' || has(ledger, turnId, 'delivery_uncertain')) return 'uncertain'
  if (has(ledger, turnId, 'generation_started', 'response_completed', 'need_continue')) return 'delivered'
  if (has(ledger, turnId, 'send_intent', 'prompt_sent')) return 'pending'
  return 'none'
}

function durable(ledger, turnId) {
  if (!turnId) return ['idle', 'unknown']
  if (ledger.status === 'completed') return ['terminal', 'substantive']
  if (ledger.status === 'need_continue') return ['blocked', 'incomplete']
  if (ledger.status === 'error') return ['blocked', 'unknown']
  return ['unknown', 'unknown']
}

function semantic(state) {
  const { stateVersion, ...rest } = state
  return JSON.stringify(rest)
}

export function reduceConversationState({ ledger, observations = [], writer }) {
  if (!ledger || typeof ledger !== 'object' || !Array.isArray(ledger.events)) throw new TypeError('ledger is required')
  if (typeof ledger.id !== 'string' || !ledger.id || typeof ledger.externalUrl !== 'string' || !ledger.externalUrl) throw new TypeError('ledger identity is required')
  if (!writer || typeof writer !== 'object') throw new TypeError('writer is required')

  const turnId = turnOf(ledger)
  const prior = previous(ledger)
  const intent = turnId ? intentOf(ledger, turnId) : null
  const browser = turnId ? latestObservation(ledger, observations, turnId, 'browser') : null
  const receipt = turnId ? latestObservation(ledger, observations, turnId, 'receipt') : null
  let [progress, body] = durable(ledger, turnId)
  let delivery = baseDelivery(ledger, turnId)
  let gate = prior?.gate ?? 'none'
  let userMessageId = prior?.turn.turnId === turnId ? prior.turn.userMessageId : null
  let assistantMessageId = prior?.turn.turnId === turnId ? prior.turn.assistantMessageId : null
  let target = ledger.externalUrl

  if (receipt?.requestId === intent?.requestId && receipt.delivery === 'delivered') {
    delivery = 'delivered'
    userMessageId = receipt.userMessageId ?? userMessageId
    target = receipt.target
  }

  if (browser?.readable === true) {
    target = browser.target
    userMessageId = browser.userMessageId ?? userMessageId
    assistantMessageId = browser.assistantMessageId ?? assistantMessageId
    if (browser.humanGate === true) gate = 'human_required'
    body = browser.body
    if (browser.generating === true) progress = 'active'
    else if (browser.generating === false && browser.terminal === true && body === 'substantive') progress = 'terminal'
    else if (browser.generating === false && browser.assistantMessageId) progress = 'blocked'
    else progress = 'unknown'
  } else if (!['terminal', 'blocked', 'idle'].includes(progress)) {
    progress = 'unknown'; body = 'unknown'
  }

  const draft = { contractVersion: 1, conversationId: ledger.id, target, stateVersion: 0,
    turn: { turnId, userMessageId, assistantMessageId }, progress, body, delivery, gate,
    writer: { mode: writer.mode, epoch: writer.epoch } }
  const stateVersion = prior && semantic({ ...draft, stateVersion: prior.stateVersion }) === semantic(prior)
    ? prior.stateVersion : (prior?.stateVersion ?? 0) + 1
  return parseConversationState({ ...draft, stateVersion })
}
