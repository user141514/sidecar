import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { SendMailbox, canonicalTarget } from './send-mailbox.mjs'

const DEFAULT_CHATGPT_URL = 'https://chatgpt.com/'

function turnId() {
  return `turn_${Date.now()}_${randomUUID().slice(0, 8)}`
}

function normalizeProjectHomeUrl(value) {
  if (typeof value !== 'string' || !value) return null
  const parsed = new URL(value)
  if (parsed.origin !== 'https://chatgpt.com') {
    throw new Error('project_url must use https://chatgpt.com')
  }
  const path = parsed.pathname.replace(/\/+$/, '')
  if (!/^\/g\/g-p-[^/]+\/project$/.test(path)) {
    throw new Error('project_url must be a ChatGPT Project home URL')
  }
  return `${parsed.origin}${path}`
}

export class ChatGptConversationHost {
  constructor({ bridge, store, sendAdmission = null, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
    this.bridge = bridge
    this.store = store
    this.sendAdmission = sendAdmission
    this.sleep = sleep
    this.mailbox = new SendMailbox({ rootDir: store.rootDir ? join(store.rootDir, '.send-mailbox') : null })
    this.activeSends = new Set()
    this.terminalListeners = new Map()
    bridge.on('event', (event) => {
      void this.#handleExtensionEvent(event)
    })
  }

  onTerminal(conversationId, listener) {
    if (typeof conversationId !== 'string' || !conversationId) throw new TypeError('conversation id is required')
    if (typeof listener !== 'function') throw new TypeError('terminal listener must be a function')
    let listeners = this.terminalListeners.get(conversationId)
    if (!listeners) {
      listeners = new Set()
      this.terminalListeners.set(conversationId, listeners)
    }
    listeners.add(listener)
    return () => {
      const current = this.terminalListeners.get(conversationId)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) this.terminalListeners.delete(conversationId)
    }
  }

  async #notifyTerminal(conversationId, event) {
    const listeners = this.terminalListeners.get(conversationId)
    if (!listeners) return
    this.terminalListeners.delete(conversationId)
    for (const listener of listeners) {
      try { await listener(event) } catch {}
    }
  }

  async createProject(name) {
    const normalizedName = typeof name === 'string' ? name.trim() : ''
    if (!normalizedName) throw new TypeError('project name is required')

    const result = await this.bridge.request('project_create', { name: normalizedName })
    return {
      name: normalizedName,
      projectUrl: normalizeProjectHomeUrl(result.projectUrl),
      windowId: result.windowId,
      tabId: result.tabId
    }
  }

  async findProject(name) {
    const normalizedName = typeof name === 'string' ? name.trim() : ''
    if (!normalizedName) throw new TypeError('project name is required')

    const result = await this.bridge.request('project_find', { name: normalizedName })
    if (result.found !== true) return { found: false, name: normalizedName }
    return {
      found: true,
      name: normalizedName,
      projectUrl: normalizeProjectHomeUrl(result.projectUrl)
    }
  }

  async pinProject(projectUrl) {
    const normalized = normalizeProjectHomeUrl(projectUrl)
    await this.store.setDefaultProjectUrl(normalized)
    return { projectUrl: normalized }
  }

  async shiftTest(target, targetUrl = null) {
    if (typeof target !== 'string' || !target.trim()) throw new Error('WebGPT shift target is required')
    if (targetUrl !== null && (typeof targetUrl !== 'string' || !targetUrl.trim())) throw new Error('WebGPT shift target URL is invalid')
    return this.bridge.request('webgpt_shift_test', {
      target: target.trim(),
      ...(targetUrl ? { target_url: targetUrl.trim() } : {})
    })
  }

  async create({ projectUrl } = {}) {
    const pinnedProjectUrl = projectUrl ? null : await this.store.getDefaultProjectUrl()
    const createUrl = normalizeProjectHomeUrl(projectUrl || pinnedProjectUrl) || DEFAULT_CHATGPT_URL
    const created = await this.store.create({
      backend: 'chatgpt-web-extension',
      externalUrl: createUrl
    })

    try {
      const browser = await this.bridge.request('conversation_create', {
        conversationId: created.id,
        url: createUrl
      })
      await this.store.append(created.id, {
        type: 'browser_attached',
        windowId: browser.windowId,
        tabId: browser.tabId,
        externalUrl: browser.url || createUrl
      })
      return { ...created, phase: 'allocated', threadCreated: false, windowId: browser.windowId, tabId: browser.tabId }
    } catch (error) {
      await this.store.append(created.id, {
        type: 'error',
        message: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }

  async admitSend({ source, target }) {
    if (source === 'watchdog') return { admitted: false, reason: 'mailbox_required' }
    if (!this.sendAdmission) return { admitted: true, admittedAt: Date.now() }
    return this.sendAdmission.admit({ source, target })
  }

  async send(conversationId, text, { app, preAdmitted = false, requestId = randomUUID() } = {}) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('text is required')
    if (app !== undefined && (typeof app !== 'string' || !app.trim())) {
      throw new Error('app must be a non-empty string')
    }
    const conversation = await this.#loadConversation(conversationId)
    if (!conversation) throw new Error(`Conversation ${conversationId} does not exist in the local ledger`)
    const prior = (conversation.events || []).find(event => event.type === 'send_intent' && event.requestId === requestId)
    if (prior) {
      if (prior.text !== text || prior.app !== app) throw new Error('request identity conflict')
      let current = conversation
      let accepted = current.events.some(event => event.turnId === prior.turnId && ['generation_started', 'response_completed', 'need_continue'].includes(event.type))
      if (!accepted) current = await this.#reconcileDelivery(current, requestId) ?? current
      accepted = current.events.some(event => event.turnId === prior.turnId && ['generation_started', 'response_completed', 'need_continue'].includes(event.type))
      if (accepted) return { conversationId, turnId: prior.turnId, accepted: true, ...(current.status === 'generating' ? { reconciled: true } : {}) }
      throw Object.assign(new Error('prior request delivery uncertain; read and reconcile before retry'), { code: 'DELIVERY_UNCERTAIN', conversationId, turnId: prior.turnId })
    }
    const result = await this.mailbox.run(conversation.externalUrl, requestId, { source: 'coordinator', conversationId, text, app },
      markDispatching => this.#send(conversationId, text, { app, preAdmitted, requestId, markDispatching }), conversationId)
    if (result?.deliveryUncertain === true) throw Object.assign(new Error(`delivery uncertain; reconciliation required: ${result.message || 'unknown outcome'}`), { code: 'DELIVERY_UNCERTAIN', conversationId, turnId: result.turnId })
    return result
  }

  async proposeContinuation(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        Object.keys(payload).some(key => !['kind', 'target', 'expected', 'text'].includes(key))) throw new TypeError('invalid intent fields')
    const { kind, target, expected, text } = payload
    const url = new URL(target)
    if (url.origin !== 'https://chatgpt.com' || url.username || url.password || url.search || url.hash ||
        !/\/c\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/?$/i.test(url.pathname)) throw new TypeError('exact conversation URL required')
    if (!expected || typeof expected !== 'object' || Array.isArray(expected) ||
        Object.keys(expected).some(key => !['userMessageId', 'assistantMessageId'].includes(key)) ||
        !['userMessageId', 'assistantMessageId'].every(key => typeof expected[key] === 'string' && expected[key].length > 0 && expected[key].length <= 256)) throw new TypeError('expected user and assistant message IDs required')
    if (kind !== 'continue') return { accepted: false, reason: 'recovery_requires_reconciliation' }
    if (typeof text !== 'string' || !text.trim() || text.length > 16_384) throw new TypeError('bounded continuation text required')
    const requestId = createHash('sha256').update(JSON.stringify([canonicalTarget(target), kind, expected.userMessageId, expected.assistantMessageId])).digest('hex')
    const known = await this.store.findByExternalUrl(target)
    for (const conversation of known) {
      if (conversation.status !== 'delivery_uncertain') continue
      await this.#reconcileDelivery(conversation, requestId)
    }
    return this.mailbox.run(target, requestId, { kind, userMessageId: expected.userMessageId, assistantMessageId: expected.assistantMessageId, text }, async markDispatching => {
      const live = await this.bridge.request('conversation_observe', { externalUrl: target })
      if (live?.found !== true || canonicalTarget(live.url) !== canonicalTarget(target)) return { accepted: false, reason: 'target_unavailable' }
      if (live.userMessageId !== expected.userMessageId || live.assistantMessageId !== expected.assistantMessageId) return { accepted: false, reason: 'stale_intent' }
      if (live.allowed !== true) return { accepted: false, reason: live.reason || 'blocked' }
      const matches = await this.store.findByExternalUrl(target)
      if (matches.some(item => ['sending', 'submitted', 'generating', 'delivery_uncertain'].includes(item.status))) return { accepted: false, reason: 'busy' }
      if (matches.length > 1) return { accepted: false, reason: 'ambiguous_local_binding' }
      const conversation = matches[0] ?? await this.store.create({ backend: 'chatgpt-web-extension', externalUrl: target })
      return this.#send(conversation.id, text, { expected, existingOnly: true, requestId, markDispatching })
    })
  }

  async #send(conversationId, text, options = {}) {
    this.activeSends.add(conversationId)
    try {
      return await this.#sendActive(conversationId, text, options)
    } finally {
      this.activeSends.delete(conversationId)
    }
  }

  async #sendActive(conversationId, text, { app, preAdmitted = false, expected, existingOnly = false, requestId, markDispatching } = {}) {
    const conversation = await this.#loadConversation(conversationId)
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} does not exist in the local ledger`)
    }
    if (['sending', 'submitted', 'generating', 'delivery_uncertain'].includes(conversation.status)) {
      throw new Error(`Conversation ${conversationId} already has a turn in flight`)
    }

    if (!preAdmitted) {
      const admission = await this.admitSend({
        source: 'conversation_send',
        target: conversation.externalUrl || DEFAULT_CHATGPT_URL
      })
      if (admission?.admitted !== true) {
        return {
          conversationId,
          accepted: false,
          reason: 'pacing',
          retryAfterMs: admission?.retryAfterMs ?? null
        }
      }
    }

    const id = turnId()
    await this.store.append(conversationId, {
      type: 'send_intent',
      turnId: id,
      text,
      ...(requestId ? { requestId } : {}),
      ...(expected ? { source: 'watchdog', continuationOf: conversation.latestTurnId ?? null } : {}),
      ...(app ? { app } : {})
    })
    try {
      await markDispatching?.({ conversationId, turnId: id })
      const result = await this.bridge.request('conversation_send', {
        conversationId,
        turnId: id,
        requestId,
        text,
        ...(app ? { app } : {}),
        ...(expected ? { expected } : {}),
        ...(existingOnly ? { existingOnly: true } : {}),
        externalUrl: conversation.externalUrl || DEFAULT_CHATGPT_URL
      })
      if (!result || typeof result.accepted !== 'boolean') throw Object.assign(new Error('invalid browser submission receipt; delivery uncertain'), { code: 'DELIVERY_UNCERTAIN' })
      if (result.accepted !== true) {
        await this.store.append(conversationId, { type: 'error', turnId: id, message: result.reason || 'Browser rejected before submission' })
        return { conversationId, turnId: id, accepted: false, reason: result.reason || 'blocked' }
      }
      if (result.reattached === true) {
        await this.store.append(conversationId, {
          type: 'browser_attached',
          windowId: result.windowId,
          tabId: result.tabId,
          externalUrl: result.url || conversation.externalUrl || DEFAULT_CHATGPT_URL
        })
      }
      await this.store.append(conversationId, {
        type: 'generation_started',
        turnId: id,
        externalUrl: result.url
      })
      return { conversationId, turnId: id, accepted: true }
    } catch (error) {
      error.conversationId = conversationId
      error.turnId = id
      await this.store.append(conversationId, {
        type: error?.code === 'DELIVERY_UNCERTAIN' ? 'delivery_uncertain' : 'error',
        turnId: id,
        message: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }

  async read(conversationId) {
    let stored = await this.store.read(conversationId)
    if (stored.status === 'delivery_uncertain') {
      stored = await this.#reconcileDelivery(stored) ?? stored
    }
    if (stored.status !== 'completed' || this.activeSends.has(conversationId) || typeof stored.externalUrl !== 'string' || !stored.externalUrl) return stored

    const readLive = async () => {
      try {
        const snapshot = await this.bridge.request('conversation_snapshot', {
          conversationId,
          externalUrl: stored.externalUrl
        })
        if (snapshot?.found !== true) return null
        return {
          generating: snapshot.generating === true,
          assistantText: typeof snapshot.assistantText === 'string' ? snapshot.assistantText.trim() : ''
        }
      } catch {
        return null
      }
    }

    const first = await readLive()
    if (!first) return stored
    const firstDiffers = first.assistantText !== (stored.latestResponse ?? '')
    if (!first.generating && !firstDiffers && first.assistantText) return stored

    await this.sleep(60_000)
    const second = await readLive()
    if (!second) return stored

    return {
      ...stored,
      status: second.generating ? 'generating' : 'completed',
      latestResponse: second.assistantText || first.assistantText || stored.latestResponse
    }
  }

  async #reconcileDelivery(conversation, expectedRequestId = null) {
    const intent = [...(conversation.events || [])].reverse().find(event =>
      event.type === 'send_intent' &&
      typeof event.requestId === 'string' && event.requestId &&
      (!expectedRequestId || event.requestId === expectedRequestId)
    )
    if (!intent) return null

    let lookup
    try {
      lookup = await this.bridge.request('conversation_effect_receipt', { requestId: intent.requestId })
    } catch {
      return null
    }
    const receipt = lookup?.found === true ? lookup.receipt : null
    if (!receipt || receipt.requestId !== intent.requestId || receipt.conversationId !== conversation.id ||
        receipt.turnId !== intent.turnId || typeof receipt.userMessageId !== 'string' || !receipt.userMessageId) return null

    const result = {
      conversationId: conversation.id,
      turnId: intent.turnId,
      accepted: true,
      reconciled: true,
      userMessageId: receipt.userMessageId
    }
    const settled = await this.mailbox.reconcile(
      conversation.externalUrl,
      intent.requestId,
      result,
      conversation.id
    )
    if (settled?.accepted !== true) return null

    const current = await this.store.read(conversation.id)
    const alreadyAccepted = current.events.some(event =>
      event.turnId === intent.turnId && ['generation_started', 'response_completed', 'need_continue'].includes(event.type)
    )
    if (!alreadyAccepted) {
      await this.store.append(conversation.id, {
        type: 'generation_started',
        turnId: intent.turnId,
        externalUrl: typeof receipt.externalUrl === 'string' && receipt.externalUrl ? receipt.externalUrl : conversation.externalUrl,
        effectRequestId: intent.requestId,
        effectUserMessageId: receipt.userMessageId,
        reconciled: true
      })
    }
    return this.store.read(conversation.id)
  }

  async #loadConversation(conversationId) {
    if (typeof conversationId !== 'string' || !conversationId) return null
    try {
      return await this.store.read(conversationId)
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  async #handleExtensionEvent(event) {
    const recorded = await this.#recordExtensionEvent(event)
    if (!recorded || typeof event?.eventId !== 'string' || !event.eventId) return
    try {
      this.bridge.ackEvent(event.eventId)
    } catch {
      // The extension keeps the event in its durable outbox and will replay it.
    }
  }

  async #recordExtensionEvent(event) {
    const conversationId = event?.conversationId
    if (typeof conversationId !== 'string') return false
    const conversation = await this.#loadConversation(conversationId)
    if (!conversation) return false
    if (typeof event.eventId === 'string' && conversation.events?.some((item) => item.eventId === event.eventId)) {
      return true
    }

    if (event.type === 'response_completed') {
      await this.store.append(conversationId, {
        eventId: event.eventId,
        type: 'response_completed',
        turnId: event.turnId,
        text: event.text ?? '',
        externalUrl: event.externalUrl
      })
      await this.#notifyTerminal(conversationId, event)
      return true
    }

    if (event.type === 'need_continue') {
      await this.store.append(conversationId, {
        eventId: event.eventId,
        type: 'need_continue',
        turnId: event.turnId,
        text: event.text ?? '',
        reason: event.reason ?? 'assistant_body_incomplete',
        externalUrl: event.externalUrl
      })
      return true
    }

    if (event.type === 'error') {
      await this.store.append(conversationId, {
        eventId: event.eventId,
        type: 'error',
        turnId: event.turnId,
        message: event.message ?? 'Chrome extension error',
        externalUrl: event.externalUrl
      })
      await this.#notifyTerminal(conversationId, event)
      return true
    }

    return false
  }
}
