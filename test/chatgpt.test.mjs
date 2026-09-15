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
    const withUrl = [...this.events].reverse().find((event) => typeof event.externalUrl === 'string')
    return {
      id,
      externalUrl: withUrl?.externalUrl ?? this.created?.externalUrl ?? null,
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
    if (method === 'webgpt_shift_test') {
      return { switched: true, before: 'High', after: params.target }
    }
    throw new Error(`unexpected method ${method}`)
  }
}

test('webgpt shift probe forwards the target to the browser bridge', async () => {
  const { ChatGptConversationHost } = await loadChatGptModule()
  assert.equal(typeof ChatGptConversationHost, 'function')
  if (typeof ChatGptConversationHost !== 'function') return

  const bridge = new FakeBridge()
  const host = new ChatGptConversationHost({ bridge, store: new MemoryStore() })
  const result = await host.shiftTest('Extra High')

  assert.equal(result.after, 'Extra High')
  assert.equal(bridge.requests[0].method, 'webgpt_shift_test')
  assert.equal(bridge.requests[0].params.target, 'Extra High')
})

test('webgpt shift probe forwards an exact conversation URL to the browser bridge', async () => {
  const { ChatGptConversationHost } = await loadChatGptModule()
  assert.equal(typeof ChatGptConversationHost, 'function')
  if (typeof ChatGptConversationHost !== 'function') return

  const bridge = new FakeBridge()
  const host = new ChatGptConversationHost({ bridge, store: new MemoryStore() })
  const targetUrl = 'https://chatgpt.com/g/g-p-project/c/thread-target'
  await host.shiftTest('Medium', targetUrl)

  assert.equal(bridge.requests[0].method, 'webgpt_shift_test')
  assert.equal(bridge.requests[0].params.target, 'Medium')
  assert.equal(bridge.requests[0].params.target_url, targetUrl)
})

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

test('send forwards a per-message ChatGPT app selection to the browser bridge and ledger', async () => {
  const { ChatGptConversationHost } = await loadChatGptModule()
  assert.equal(typeof ChatGptConversationHost, 'function')
  if (typeof ChatGptConversationHost !== 'function') return

  const bridge = new FakeBridge()
  const store = new MemoryStore()
  const host = new ChatGptConversationHost({ bridge, store })
  const created = await host.create()

  await host.send(created.id, 'use the connected workspace', { app: 'DevSpace' })

  const sendRequest = bridge.requests.find((request) => request.method === 'conversation_send')
  assert.equal(sendRequest?.params.app, 'DevSpace')
  assert.equal(store.events.find((event) => event.type === 'send_intent')?.app, 'DevSpace')
})

test('manual send is denied before send intent when the shared admission owner is pacing', async () => {
  const { ChatGptConversationHost } = await loadChatGptModule()
  const bridge = new FakeBridge()
  const store = new MemoryStore()
  const admissions = []
  const host = new ChatGptConversationHost({
    bridge,
    store,
    sendAdmission: {
      async admit(request) {
        admissions.push(request)
        return { admitted: false, retryAfterMs: 42_000, lastAdmittedAt: 1 }
      }
    }
  })
  const created = await host.create()

  const result = await host.send(created.id, 'paced manual send')

  assert.deepEqual(result, {
    conversationId: created.id,
    accepted: false,
    reason: 'pacing',
    retryAfterMs: 42_000
  })
  assert.equal(store.events.some((event) => event.type === 'send_intent'), false)
  assert.equal(bridge.requests.some(({ method }) => method === 'conversation_send'), false)
  assert.equal(admissions[0].source, 'conversation_send')
})

test('pre-admitted send does not consume a second shared admission', async () => {
  const { ChatGptConversationHost } = await loadChatGptModule()
  const bridge = new FakeBridge()
  const store = new MemoryStore()
  let admissionCalls = 0
  const host = new ChatGptConversationHost({
    bridge,
    store,
    sendAdmission: { async admit() { admissionCalls += 1; return { admitted: true, admittedAt: 1 } } }
  })
  const created = await host.create()

  const sent = await host.send(created.id, 'managed send', { preAdmitted: true })

  assert.equal(sent.accepted, true)
  assert.equal(admissionCalls, 0)
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

test('completed reads recheck the exact live conversation after 60 seconds when the browser has more text', async () => {
  const { ChatGptConversationHost } = await loadChatGptModule()
  assert.equal(typeof ChatGptConversationHost, 'function')
  if (typeof ChatGptConversationHost !== 'function') return

  const bridge = new FakeBridge()
  const store = new MemoryStore()
  const targetUrl = 'https://chatgpt.com/g/g-p-project/c/thread-read-recheck'
  const host = new ChatGptConversationHost({
    bridge,
    store,
    sleep: async (ms) => waits.push(ms)
  })
  const waits = []
  const created = await host.create()
  await store.append(created.id, {
    type: 'response_completed',
    turnId: 'turn_read_recheck',
    text: 'PARTIAL',
    externalUrl: targetUrl
  })

  const snapshots = [
    { found: true, url: targetUrl, generating: true, assistantText: 'PARTIAL plus more' },
    { found: true, url: targetUrl, generating: false, assistantText: 'FULL RESPONSE' }
  ]
  bridge.request = async (method, params) => {
    bridge.requests.push({ method, params })
    if (method === 'conversation_snapshot') return snapshots.shift()
    throw new Error(`unexpected method ${method}`)
  }

  const state = await host.read(created.id)

  assert.deepEqual(waits, [60_000])
  assert.equal(state.status, 'completed')
  assert.equal(state.latestResponse, 'FULL RESPONSE')
  assert.deepEqual(
    bridge.requests
      .filter(({ method }) => method === 'conversation_snapshot')
      .map(({ method, params }) => [method, params.conversationId, params.externalUrl]),
    [
      ['conversation_snapshot', created.id, targetUrl],
      ['conversation_snapshot', created.id, targetUrl]
    ]
  )
})

test('only one concurrent send may enter the browser for the same conversation', async () => {
  const { ChatGptConversationHost } = await loadChatGptModule()
  assert.equal(typeof ChatGptConversationHost, 'function')
  if (typeof ChatGptConversationHost !== 'function') return

  const bridge = new FakeBridge()
  const releases = []
  bridge.request = async (method, params) => {
    bridge.requests.push({ method, params })
    if (method === 'conversation_create') {
      return { windowId: 101, tabId: 202, url: 'https://chatgpt.com/' }
    }
    if (method === 'conversation_send') {
      return new Promise((resolve) => {
        releases.push(() => resolve({ accepted: true, url: params.externalUrl || 'https://chatgpt.com/' }))
      })
    }
    throw new Error(`unexpected method ${method}`)
  }

  const store = new MemoryStore()
  const host = new ChatGptConversationHost({ bridge, store })
  const created = await host.create()

  const first = host.send(created.id, 'first')
  const second = host.send(created.id, 'second')
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve))
  for (const release of [...releases]) release()

  const results = await Promise.allSettled([first, second])
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1)
  assert.equal(results.filter((item) => item.status === 'rejected').length, 1)
  assert.match(results.find((item) => item.status === 'rejected').reason.message, /in flight|generating|submitted/i)
  assert.equal(bridge.requests.filter(({ method }) => method === 'conversation_send').length, 1)
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

test('need_continue extension events are durably recorded before acknowledgement', async () => {
  const { ChatGptConversationHost } = await loadChatGptModule()
  assert.equal(typeof ChatGptConversationHost, 'function')
  if (typeof ChatGptConversationHost !== 'function') return

  const bridge = new FakeBridge()
  const store = new MemoryStore()
  const host = new ChatGptConversationHost({ bridge, store })
  const created = await host.create()
  const event = {
    eventId: 'terminal:conv_test:turn_need:need_continue',
    type: 'need_continue',
    conversationId: created.id,
    turnId: 'turn_need',
    text: 'partial shell',
    reason: 'assistant_body_incomplete',
    externalUrl: 'https://chatgpt.com/c/test'
  }

  bridge.emit('event', event)
  await new Promise((resolve) => setImmediate(resolve))

  const recorded = store.events.find((item) => item.type === 'need_continue' && item.turnId === 'turn_need')
  assert.equal(recorded?.text, 'partial shell')
  assert.equal(recorded?.reason, 'assistant_body_incomplete')
  assert.deepEqual(bridge.ackedEvents, [event.eventId])
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

test('project navigation preserves the provided slug while create reports only local allocation', async () => {
  const { ChatGptConversationHost } = await loadChatGptModule()
  const host = new ChatGptConversationHost({ bridge: new FakeBridge(), store: new MemoryStore() })
  const url = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946/project'
  const navigationUrl = url.replace('/project', '-subagents/project')
  assert.equal((await host.pinProject(navigationUrl)).projectUrl, navigationUrl)
  const created = await host.create()
  assert.equal(created.phase, 'allocated')
  assert.equal(created.threadCreated, false)
})
