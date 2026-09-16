export const CONVERSATION_CONTRACT_VERSION = 1

const OBSERVATION_SOURCES = new Set(['browser', 'ledger', 'receipt', 'watchdog', 'human'])
const INTENT_SOURCES = new Set(['human', 'watchdog', 'coordinator'])
const BODY_STATES = new Set(['unknown', 'empty', 'incomplete', 'substantive'])
const OBSERVATION_DELIVERY = new Set(['unknown', 'none', 'pending', 'delivered', 'uncertain'])
const STATE_DELIVERY = new Set(['none', 'pending', 'delivered', 'uncertain'])
const PROGRESS = new Set(['idle', 'active', 'blocked', 'terminal', 'unknown'])
const GATES = new Set(['none', 'human_required'])
const WRITER_MODES = new Set(['managed', 'legacy'])
const INTENT_ACTIONS = new Set(['continue', 'open_child', 'stop'])
const ALLOCATIONS = new Set(['NEW', 'REUSE'])

const OBSERVATION_KEYS = [
  'contractVersion', 'source', 'conversationId', 'target', 'observedAt', 'turnId',
  'userMessageId', 'assistantMessageId', 'assistantText', 'readable', 'generating', 'terminal', 'body',
  'humanGate', 'delivery', 'requestId'
]
const STATE_KEYS = ['contractVersion', 'conversationId', 'target', 'stateVersion', 'turn', 'progress', 'body', 'delivery', 'gate', 'writer']
const TURN_KEYS = ['turnId', 'userMessageId', 'assistantMessageId']
const WRITER_KEYS = ['mode', 'epoch']
const INTENT_KEYS = [
  'contractVersion', 'intentId', 'source', 'conversationId', 'target',
  'expectedStateVersion', 'expectedWriterEpoch', 'action', 'allocation', 'text', 'expected'
]
const EXPECTED_KEYS = ['userMessageId', 'assistantMessageId']

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`)
  }
  return value
}

function exactKeys(value, keys, label) {
  plainObject(value, label)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has unexpected fields`)
  }
}

function version(value) {
  if (value !== CONVERSATION_CONTRACT_VERSION) throw new TypeError('unsupported contractVersion')
}

function enumValue(value, allowed, label) {
  if (!allowed.has(value)) throw new TypeError(`invalid ${label}`)
  return value
}

function requiredString(value, label, maxLength = 16_384) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new TypeError(`${label} must be a non-empty string`)
  return value
}

function nullableString(value, label, maxLength = 16_384) {
  if (value === null) return null
  return requiredString(value, label, maxLength)
}

function nullableText(value, label, maxLength) {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > maxLength) throw new TypeError(`${label} must be a string within its length bound`)
  return value
}

function nullableBoolean(value, label) {
  if (value === null || typeof value === 'boolean') return value
  throw new TypeError(`${label} must be boolean or null`)
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`)
  return value
}

function nullableNonNegativeInteger(value, label) {
  if (value === null) return null
  return nonNegativeInteger(value, label)
}

function chatGptUrl(value, label) {
  const text = requiredString(value, label, 4096)
  let url
  try { url = new URL(text) } catch { throw new TypeError(`${label} must be a ChatGPT URL`) }
  if (url.origin !== 'https://chatgpt.com' || url.username || url.password || url.search || url.hash) {
    throw new TypeError(`${label} must be a ChatGPT URL`)
  }
  return text
}

function exactConversationUrl(value, label) {
  const text = chatGptUrl(value, label)
  const url = new URL(text)
  if (!/\/c\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/?$/i.test(url.pathname)) {
    throw new TypeError(`${label} must identify an exact conversation`)
  }
  return text
}

function nullableChatGptUrl(value, label) {
  if (value === null) return null
  return chatGptUrl(value, label)
}

function isoInstant(value) {
  const text = requiredString(value, 'observedAt', 128)
  const parsed = Date.parse(text)
  if (!Number.isFinite(parsed) || !/[zZ]|[+-]\d\d:\d\d$/.test(text)) throw new TypeError('observedAt must be an offset-aware ISO instant')
  return text
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, clone(nested)]))
  return value
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function normalized(value) {
  return deepFreeze(clone(value))
}

export function parseObservation(value) {
  exactKeys(value, OBSERVATION_KEYS, 'observation')
  version(value.contractVersion)
  enumValue(value.source, OBSERVATION_SOURCES, 'observation source')
  requiredString(value.conversationId, 'conversationId', 256)
  chatGptUrl(value.target, 'target')
  isoInstant(value.observedAt)
  nullableString(value.turnId, 'turnId', 256)
  nullableString(value.userMessageId, 'userMessageId', 256)
  nullableString(value.assistantMessageId, 'assistantMessageId', 256)
  nullableText(value.assistantText, 'assistantText', 1_000_000)
  if (typeof value.readable !== 'boolean') throw new TypeError('readable must be boolean')
  nullableBoolean(value.generating, 'generating')
  nullableBoolean(value.terminal, 'terminal')
  enumValue(value.body, BODY_STATES, 'body')
  nullableBoolean(value.humanGate, 'humanGate')
  enumValue(value.delivery, OBSERVATION_DELIVERY, 'delivery')
  nullableString(value.requestId, 'requestId', 256)
  return normalized(value)
}

export function parseConversationState(value) {
  exactKeys(value, STATE_KEYS, 'conversation state')
  exactKeys(value.turn, TURN_KEYS, 'conversation state turn')
  exactKeys(value.writer, WRITER_KEYS, 'conversation state writer')
  version(value.contractVersion)
  requiredString(value.conversationId, 'conversationId', 256)
  chatGptUrl(value.target, 'target')
  nonNegativeInteger(value.stateVersion, 'stateVersion')
  nullableString(value.turn.turnId, 'turnId', 256)
  nullableString(value.turn.userMessageId, 'userMessageId', 256)
  nullableString(value.turn.assistantMessageId, 'assistantMessageId', 256)
  enumValue(value.progress, PROGRESS, 'progress')
  enumValue(value.body, BODY_STATES, 'body')
  enumValue(value.delivery, STATE_DELIVERY, 'delivery')
  enumValue(value.gate, GATES, 'gate')
  enumValue(value.writer.mode, WRITER_MODES, 'writer mode')
  nonNegativeInteger(value.writer.epoch, 'writer epoch')
  return normalized(value)
}

function validateExistingIntent(value, { requireMessageIdentity }) {
  requiredString(value.conversationId, 'conversationId', 256)
  exactConversationUrl(value.target, 'target')
  nonNegativeInteger(value.expectedStateVersion, 'expectedStateVersion')
  nonNegativeInteger(value.expectedWriterEpoch, 'expectedWriterEpoch')
  if (requireMessageIdentity) {
    requiredString(value.expected.userMessageId, 'expected user message identity', 256)
    requiredString(value.expected.assistantMessageId, 'expected assistant message identity', 256)
  } else {
    nullableString(value.expected.userMessageId, 'expected user message identity', 256)
    nullableString(value.expected.assistantMessageId, 'expected assistant message identity', 256)
  }
}

export function parseIntentEnvelope(value) {
  exactKeys(value, INTENT_KEYS, 'intent')
  exactKeys(value.expected, EXPECTED_KEYS, 'intent expected')
  version(value.contractVersion)
  requiredString(value.intentId, 'intentId', 256)
  enumValue(value.source, INTENT_SOURCES, 'intent source')
  if (value.conversationId !== null) requiredString(value.conversationId, 'conversationId', 256)
  nullableChatGptUrl(value.target, 'target')
  nullableNonNegativeInteger(value.expectedStateVersion, 'expectedStateVersion')
  nullableNonNegativeInteger(value.expectedWriterEpoch, 'expectedWriterEpoch')
  enumValue(value.action, INTENT_ACTIONS, 'intent action')
  if (value.allocation !== null) enumValue(value.allocation, ALLOCATIONS, 'allocation')
  nullableString(value.text, 'text')

  if (value.action === 'open_child' && value.allocation === 'NEW') {
    if (value.conversationId !== null || value.target !== null || value.expectedStateVersion !== null || value.expectedWriterEpoch !== null ||
        value.expected.userMessageId !== null || value.expected.assistantMessageId !== null) {
      throw new TypeError('NEW child intent cannot target an existing conversation')
    }
    requiredString(value.text, 'text')
    return normalized(value)
  }

  if (value.action === 'open_child' && value.allocation === 'REUSE') {
    validateExistingIntent(value, { requireMessageIdentity: true })
    requiredString(value.text, 'text')
    return normalized(value)
  }

  if (value.action === 'open_child') throw new TypeError('open_child requires NEW or REUSE allocation')
  if (value.allocation !== null) throw new TypeError(`${value.action} intent allocation must be null`)

  if (value.action === 'continue') {
    validateExistingIntent(value, { requireMessageIdentity: true })
    requiredString(value.text, 'text')
    return normalized(value)
  }

  validateExistingIntent(value, { requireMessageIdentity: false })
  if (value.text !== null) throw new TypeError('stop intent text must be null')
  return normalized(value)
}
