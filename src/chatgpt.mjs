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
  constructor({ bridge, store }) {
    this.bridge = bridge
    this.store = store
    bridge.on('event', (event) => {
      void this.#handleExtensionEvent(event)
    })
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

  async pinProject(projectUrl) {
    const normalized = normalizeProjectHomeUrl(projectUrl)
    await this.store.setDefaultProjectUrl(normalized)
    return { projectUrl: normalized }
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
      return { ...created, windowId: browser.windowId, tabId: browser.tabId }
    } catch (error) {
      await this.store.append(created.id, {
        type: 'error',
        message: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }

  async send(conversationId, text) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('text is required')
    const conversation = await this.#loadConversation(conversationId)
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} does not exist in the local ledger`)
    }

    const id = turnId()
    await this.store.append(conversationId, { type: 'prompt_sent', turnId: id, text })
    try {
      const result = await this.bridge.request('conversation_send', {
        conversationId,
        turnId: id,
        text,
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
      await this.store.append(conversationId, {
        type: 'error',
        turnId: id,
        message: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }

  async read(conversationId) {
    return this.store.read(conversationId)
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
      return true
    }

    return false
  }
}
