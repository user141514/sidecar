import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../src/store.mjs'

async function loadChatGptModule() {
  try {
    return await import('../src/chatgpt.mjs')
  } catch {
    return {}
  }
}

class MemoryStore {
  constructor() {
    this.events = []
    this.defaultProjectUrl = null
  }

  async create({ backend, externalUrl }) {
    this.created = { id: 'conv_test', backend, externalUrl, status: 'idle' }
    this.events.push({ type: 'conversation_created', externalUrl })
    return this.created
  }

  async append(_id, event) {
    this.events.push(event)
  }

  async setDefaultProjectUrl(projectUrl) {
    this.defaultProjectUrl = projectUrl
  }

  async getDefaultProjectUrl() {
    return this.defaultProjectUrl
  }

  async read(id) {
    const completed = [...this.events].reverse().find((event) => event.type === 'response_completed')
    const error = [...this.events].reverse().find((event) => event.type === 'error')
    return {
      id,
      status: error ? 'error' : completed ? 'completed' : this.events.some((e) => e.type === 'generation_started') ? 'generating' : 'idle',
      latestResponse: completed?.text ?? null,
      latestTurnId: completed?.turnId ?? null,
      events: [...this.events]
    }
  }
}

async function waitForConversationStatus(host, conversationId, expectedStatus) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = await host.read(conversationId)
    if (state.status === expectedStatus) return state
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Conversation ${conversationId} did not reach ${expectedStatus}`)
}

class FakeBridge extends EventEmitter {
  constructor() {
    super()
    this.requests = []
    this.ackedEvents = []
  }

  ackEvent(eventId) {
    this.ackedEvents.push(eventId)
  }

  async request(method, params) {
    this.requests.push({ method, params })
    if (method === 'project_create') {
      return {
        name: params.name,
        projectUrl: 'https://chatgpt.com/g/g-p-created-test/project',
        windowId: 111,
        tabId: 222
      }
    }
    if (method === 'project_find') {
      return {
        found: true,
        name: params.name,
        projectUrl: 'https://chatgpt.com/g/g-p-subagents-test/project'
      }
    }
    if (method === 'conversation_create') {
      return { windowId: 101, tabId: 202, url: 'https://chatgpt.com/' }
    }
    if (method === 'conversation_send') {
      return { accepted: true, url: params.externalUrl || 'https://chatgpt.com/' }
    }
    throw new Error(`unexpected method ${method}`)
  }
}

test('project_find returns a canonical current-page Project URL without changing the pinned default', async () => {
  const { ChatGptConversationHost } = await loadChatGptModule()
  assert.equal(typeof ChatGptConversationHost, 'function')
  if (typeof ChatGptConversationHost !== 'function') return

  const bridge = new FakeBridge()
  const store = new MemoryStore()
  const host = new ChatGptConversationHost({ bridge, store })

  const result = await host.findProject('  subagents  ')

  assert.deepEqual(result, {
    found: true,
    name: 'subagents',
    projectUrl: 'https://chatgpt.com/g/g-p-subagents-test/project'
  })
  assert.deepEqual(bridge.requests[0], {
    method: 'project_find',
    params: { name: 'subagents' }
  })
  assert.equal(await store.getDefaultProjectUrl(), null)
})

test('project_create returns a created Project URL without changing the pinned default', async () => {
  const { ChatGptConversationHost } = await loadChatGptModule()
  assert.equal(typeof ChatGptConversationHost, 'function')
  if (typeof ChatGptConversationHost !== 'function') return

  const bridge = new FakeBridge()
  const store = new MemoryStore()
  const host = new ChatGptConversationHost({ bridge, store })

  const result = await host.createProject('  subagents  ')

  assert.deepEqual(result, {
    name: 'subagents',
    projectUrl: 'https://chatgpt.com/g/g-p-created-test/project',
    windowId: 111,
    tabId: 222
  })
  assert.deepEqual(bridge.requests[0], {
    method: 'project_create',
    params: { name: 'subagents' }
  })
  assert.equal(await store.getDefaultProjectUrl(), null)
})

test('project_create rejects a noncanonical Project URL returned by the browser', async () => {
  const { ChatGptConversationHost } = await loadChatGptModule()
  assert.equal(typeof ChatGptConversationHost, 'function')
  if (typeof ChatGptConversationHost !== 'function') return

  const bridge = new FakeBridge()
  bridge.request = async (method, params) => {
    bridge.requests.push({ method, params })
    return {
      name: params.name,
      projectUrl: 'https://chatgpt.com/',
      windowId: 111,
      tabId: 222
    }
  }
  const host = new ChatGptConversationHost({ bridge, store: new MemoryStore() })

  await assert.rejects(host.createProject('subagents'), /Project home URL/)
})

test('create can target a specific ChatGPT Project home', async () => {
  const { ChatGptConversationHost } = await loadChatGptModule()
  assert.equal(typeof ChatGptConversationHost, 'function')
  if (typeof ChatGptConversationHost !== 'function') return

  const bridge = new FakeBridge()
  const store = new MemoryStore()
  const host = new ChatGptConversationHost({ bridge, store })
  const projectUrl = 'https://chatgpt.com/g/g-p-project123-agent/project'

  const created = await host.create({ projectUrl })

  assert.equal(created.externalUrl, projectUrl)
  assert.equal(bridge.requests[0].method, 'conversation_create')
  assert.equal(bridge.requests[0].params.url, projectUrl)
})

test('a pinned Project becomes the default target for later conversation_create calls', async () => {
  const { ChatGptConversationHost } = await loadChatGptModule()
  assert.equal(typeof ChatGptConversationHost, 'function')
  if (typeof ChatGptConversationHost !== 'function') return

  const bridge = new FakeBridge()
  const store = new MemoryStore()
  const host = new ChatGptConversationHost({ bridge, store })
  const projectUrl = 'https://chatgpt.com/g/g-p-project123-agent/project'

  const pinned = await host.pinProject(projectUrl)
  const created = await host.create()

  assert.equal(pinned.projectUrl, projectUrl)
  assert.equal(created.externalUrl, projectUrl)
  assert.equal(bridge.requests[0].params.url, projectUrl)
})

test('a fresh sidecar process sends to a ledger-backed conversation and records its later completion', async (t) => {
  const { ChatGptConversationHost } = await loadChatGptModule()
  assert.equal(typeof ChatGptConversationHost, 'function')
  if (typeof ChatGptConversationHost !== 'function') return

  const rootDir = await mkdtemp(join(tmpdir(), 'conversation-sidecar-restart-'))
  t.after(async () => rm(rootDir, { recursive: true, force: true }))

  const firstBridge = new FakeBridge()
  const firstHost = new ChatGptConversationHost({
    bridge: firstBridge,
    store: new ConversationStore(rootDir)
  })
  const created = await firstHost.create()
  await firstHost.store.append(created.id, {
    type: 'response_completed',
    turnId: 'turn_previous',
    text: 'PREVIOUS_RESPONSE',
    externalUrl: 'https://chatgpt.com/c/persistent-test'
  })

  const restartedBridge = new FakeBridge()
  const restartedHost = new ChatGptConversationHost({
    bridge: restartedBridge,
    store: new ConversationStore(rootDir)
  })
  const sent = await restartedHost.send(created.id, 'continue the same conversation')

  assert.equal(sent.accepted, true)
  assert.equal(restartedBridge.requests[0].method, 'conversation_send')
  assert.equal(restartedBridge.requests[0].params.conversationId, created.id)
  assert.equal(restartedBridge.requests[0].params.externalUrl, 'https://chatgpt.com/c/persistent-test')

  restartedBridge.emit('event', {
    type: 'response_completed',
    conversationId: created.id,
    turnId: sent.turnId,
    text: 'AFTER_RESTART',
    externalUrl: 'https://chatgpt.com/c/persistent-test'
  })
  const state = await waitForConversationStatus(restartedHost, created.id, 'completed')
  assert.equal(state.status, 'completed')
  assert.equal(state.latestResponse, 'AFTER_RESTART')
})

test('terminal extension events are durably recorded once before acknowledgement', async () => {
  const { ChatGptConversationHost } = await loadChatGptModule()
  assert.equal(typeof ChatGptConversationHost, 'function')
  if (typeof ChatGptConversationHost !== 'function') return

  const bridge = new FakeBridge()
  const store = new MemoryStore()
  const host = new ChatGptConversationHost({ bridge, store })
  const created = await host.create()
  const event = {
    eventId: 'terminal:conv_test:turn_once:response_completed',
    type: 'response_completed',
    conversationId: created.id,
    turnId: 'turn_once',
    text: 'ONCE',
    externalUrl: 'https://chatgpt.com/c/test'
  }

  bridge.emit('event', event)
  await new Promise((resolve) => setImmediate(resolve))
  bridge.emit('event', event)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(
    store.events.filter((item) => item.type === 'response_completed' && item.turnId === 'turn_once').length,
    1
  )
  assert.deepEqual(bridge.ackedEvents, [event.eventId, event.eventId])
})

test('extension-backed host creates a dedicated window, returns after send, and persists later completion events', async () => {
  const { ChatGptConversationHost } = await loadChatGptModule()
  assert.equal(typeof ChatGptConversationHost, 'function')
  if (typeof ChatGptConversationHost !== 'function') return

  const bridge = new FakeBridge()
  const store = new MemoryStore()
  const host = new ChatGptConversationHost({ bridge, store })

  const created = await host.create()
  assert.equal(created.id, 'conv_test')
  assert.equal(created.backend, 'chatgpt-web-extension')
  assert.equal(bridge.requests[0].method, 'conversation_create')
  assert.equal(bridge.requests[0].params.conversationId, 'conv_test')
  assert.equal(store.events.some((event) => event.type === 'browser_attached' && event.windowId === 101), true)

  const sent = await host.send(created.id, 'hello')
  assert.match(sent.turnId, /^turn_/)
  assert.equal(sent.accepted, true)
  assert.equal(bridge.requests[1].method, 'conversation_send')
  assert.equal(bridge.requests[1].params.turnId, sent.turnId)
  assert.equal(store.events.at(-1).type, 'generation_started')
  assert.equal(store.events.some((event) => event.type === 'response_completed'), false)

  bridge.emit('event', {
    type: 'response_completed',
    conversationId: created.id,
    turnId: sent.turnId,
    text: 'FINAL_RESPONSE',
    externalUrl: 'https://chatgpt.com/c/test'
  })
  await new Promise((resolve) => setImmediate(resolve))

  const state = await host.read(created.id)
  assert.equal(state.status, 'completed')
  assert.equal(state.latestResponse, 'FINAL_RESPONSE')
})
