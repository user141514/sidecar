import { randomUUID } from 'node:crypto'

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
  constructor({ bridge, store, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
    this.bridge = bridge
    this.store = store
    this.sleep = sleep
    this.sendQueues = new Map()
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

  async send(conversationId, text, { app } = {}) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('text is required')
    if (app !== undefined && (typeof app !== 'string' || !app.trim())) {
      throw new Error('app must be a non-empty string')
    }
    const previous = this.sendQueues.get(conversationId) ?? Promise.resolve()
    const run = previous.then(() => this.#send(conversationId, text, { app }))
    this.sendQueues.set(conversationId, run.catch(() => {}))
    return run
  }

  async #send(conversationId, text, { app } = {}) {
    this.activeSends.add(conversationId)
    try {
      return await this.#sendActive(conversationId, text, { app })
    } finally {
      this.activeSends.delete(conversationId)
    }
  }

  async #sendActive(conversationId, text, { app } = {}) {
    const conversation = await this.#loadConversation(conversationId)
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} does not exist in the local ledger`)
    }
    if (['sending', 'submitted', 'generating', 'delivery_uncertain'].includes(conversation.status)) {
      throw new Error(`Conversation ${conversationId} already has a turn in flight`)
    }

    const id = turnId()
    await this.store.append(conversationId, {
      type: 'send_intent',
      turnId: id,
      text,
      ...(app ? { app } : {})
    })
    try {
      const result = await this.bridge.request('conversation_send', {
        conversationId,
        turnId: id,
        text,
        ...(app ? { app } : {}),
        externalUrl: conversation.externalUrl || DEFAULT_CHATGPT_URL
      })
      if (result.accepted !== true) throw new Error('Chrome extension did not accept the prompt')
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
    const stored = await this.store.read(conversationId)
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
