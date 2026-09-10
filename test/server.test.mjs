import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkLedger } from '../src/work-ledger.mjs'
import { MemoryPool } from '../src/memory-pool.mjs'

async function loadServerModule() {
  try {
    return await import('../src/server.mjs')
  } catch {
    return {}
  }
}

class FakeWorkLedger {
  constructor() {
    this.calls = []
  }

  async create(goal) {
    this.calls.push({ method: 'create', goal })
    return { id: 'work_1', createdAt: '2026-09-03T00:00:00.000Z' }
  }

  async append(id, type, payload) {
    this.calls.push({ method: 'append', id, type, payload })
    return { at: '2026-09-03T00:00:01.000Z', type, payload }
  }

  async read(id) {
    this.calls.push({ method: 'read', id })
    return { id, events: [] }
  }
}

class FakeWorkController {
  constructor() {
    this.calls = []
  }

  async state(id) {
    this.calls.push({ method: 'state', id })
    return { id, frontiers: [] }
  }

  async decide(id, decision) {
    this.calls.push({ method: 'decide', id, decision })
    return { id, latestDecision: decision, frontiers: decision.frontiers ?? [] }
  }

  async checkpoint(id, checkpoint) {
    this.calls.push({ method: 'checkpoint', id, checkpoint })
    return { id, eventCount: checkpoint.based_on_event_count + 1, latestDecision: checkpoint.decision, frontiers: [] }
  }

  async dispatch(id, frontierId) {
    this.calls.push({ method: 'dispatch', id, frontierId })
    return { dispatched: true, frontierId, conversationId: 'conv_worker' }
  }

  async collect(id) {
    this.calls.push({ method: 'collect', id })
    return { collected: 1, state: { id, frontiers: [] } }
  }
}

class FakeMemoryPool {
  constructor() {
    this.calls = []
  }

  async publish(sourceWorkId) {
    this.calls.push({ method: 'publish', sourceWorkId })
    return { memory_id: 'mem_1', source_work_id: sourceWorkId, pool_revision: 1 }
  }

  async query(workId, query) {
    this.calls.push({ method: 'query', workId, query })
    return { retrievalId: 'retrieval_1', poolRevision: 1, matched: [] }
  }

  async read(workId, retrievalId, memoryId) {
    this.calls.push({ method: 'read', workId, retrievalId, memoryId })
    return { meta: { memory_id: memoryId }, events: [] }
  }
}

class FakeHost {
  constructor() {
    this.createCalls = []
    this.sendCalls = []
  }

  async createProject(name) {
    this.projectCreateName = name
    return {
      name,
      projectUrl: 'https://chatgpt.com/g/g-p-created-test/project',
      windowId: 10,
      tabId: 20
    }
  }

  async findProject(name) {
    this.projectFindName = name
    return {
      found: true,
      name,
      projectUrl: 'https://chatgpt.com/g/g-p-subagents-test/project'
    }
  }

  async create(options = {}) {
    this.createCalls.push(options)
    return {
      id: 'conv_1',
      status: 'idle',
      externalUrl: options.projectUrl || 'https://chatgpt.com/'
    }
  }

  async pinProject(projectUrl) {
    this.pinnedProjectUrl = projectUrl
    return { projectUrl }
  }

  async send(id, text, { app } = {}) {
    this.sendCalls.push({ id, text, app: app ?? null })
    return { conversationId: id, turnId: 'turn_1', accepted: true, text, app: app ?? null }
  }

  async read(id) {
    return { id, status: 'completed', latestResponse: 'done' }
  }
}

async function rpc(baseUrl, body) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: response.status, body: response.status === 204 ? null : await response.json() }
}

test('health reports the active Runtime Home release identity when provided', async () => {
  const { createSidecarServer } = await loadServerModule()
  assert.equal(typeof createSidecarServer, 'function')
  if (typeof createSidecarServer !== 'function') return

  const runtimeRelease = 'd'.repeat(40)
  const app = createSidecarServer({ conversationHost: new FakeHost(), runtimeRelease })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, runtimeRelease })
  } finally {
    await app.close()
  }
})

test('server exposes health, project pinning, and the three conversation tools', async () => {
  const { createSidecarServer } = await loadServerModule()
  assert.equal(typeof createSidecarServer, 'function')
  if (typeof createSidecarServer !== 'function') return

  const app = createSidecarServer({ conversationHost: new FakeHost() })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const baseUrl = `http://127.0.0.1:${address.port}`
  try {
    const health = await fetch(`${baseUrl}/healthz`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { ok: true })

    const initialized = await rpc(baseUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }
    })
    assert.equal(initialized.status, 200)
    assert.equal(initialized.body.result.serverInfo.name, 'conversation-sidecar')

    const listed = await rpc(baseUrl, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    assert.deepEqual(
      listed.body.result.tools.map((tool) => tool.name),
      ['extension_status', 'extension_reload', 'project_create', 'project_find', 'project_pin', 'conversation_create', 'conversation_send', 'conversation_read', 'work_create', 'work_append', 'work_read', 'work_state', 'work_decide', 'work_checkpoint', 'work_dispatch', 'work_collect', 'work_memory_publish', 'work_memory_query', 'work_memory_read']
    )
    const conversationSend = listed.body.result.tools.find((tool) => tool.name === 'conversation_send')
    assert.equal(conversationSend.inputSchema.properties.app.type, 'string')
    const workDecide = listed.body.result.tools.find((tool) => tool.name === 'work_decide')
    const decisionSchema = workDecide.inputSchema.properties.decision
    assert.equal(decisionSchema.properties.action.enum.includes('REVISE'), true)
    assert.deepEqual(decisionSchema.properties.evidence_event_indexes.items, { type: 'integer', minimum: 0 })
    assert.equal(decisionSchema.properties.evidence_event_indexes.minItems, 1)
    assert.equal(decisionSchema.properties.plan.properties.objective.type, 'string')
    assert.equal(decisionSchema.properties.orchestration.properties.mode.enum.includes('ADVERSARIAL'), true)
    assert.deepEqual(decisionSchema.allOf[0].if.properties.action, { const: 'REVISE' })
    assert.deepEqual(decisionSchema.allOf[0].then.required, ['evidence_event_indexes', 'plan', 'orchestration'])
    const checkpointTool = listed.body.result.tools.find((tool) => tool.name === 'work_checkpoint')
    assert.deepEqual(checkpointTool.inputSchema.required, ['work_id', 'based_on_event_count', 'evidence_event_indexes', 'decision'])
    assert.equal(checkpointTool.inputSchema.properties.evidence_event_indexes.minItems, 1)
    assert.equal(checkpointTool.inputSchema.properties.decision.properties.action.enum.includes('STOP'), true)
  } finally {
    await app.close()
  }
})

test('work tools persist structured coordinator events through WorkLedger', async () => {
  const { createSidecarServer } = await loadServerModule()
  assert.equal(typeof createSidecarServer, 'function')
  if (typeof createSidecarServer !== 'function') return

  const workLedger = new FakeWorkLedger()
  const app = createSidecarServer({ conversationHost: new FakeHost(), workLedger })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const baseUrl = `http://127.0.0.1:${address.port}`
  try {
    const created = await rpc(baseUrl, {
      jsonrpc: '2.0', id: 20, method: 'tools/call', params: {
        name: 'work_create', arguments: { goal: 'build work ledger' }
      }
    })
    assert.equal(JSON.parse(created.body.result.content[0].text).id, 'work_1')

    const appended = await rpc(baseUrl, {
      jsonrpc: '2.0', id: 21, method: 'tools/call', params: {
        name: 'work_append',
        arguments: {
          work_id: 'work_1',
          type: 'observation',
          payload: { fact: 'ledger wiring first' }
        }
      }
    })
    assert.equal(JSON.parse(appended.body.result.content[0].text).type, 'observation')

    const rejectedDecisionAppend = await rpc(baseUrl, {
      jsonrpc: '2.0', id: 221, method: 'tools/call', params: {
        name: 'work_append', arguments: {
          work_id: 'work_1', type: 'decision', payload: { action: 'SPLIT' }
        }
      }
    })
    assert.equal(rejectedDecisionAppend.body.error.code, -32602)

    const read = await rpc(baseUrl, {
      jsonrpc: '2.0', id: 22, method: 'tools/call', params: {
        name: 'work_read', arguments: { work_id: 'work_1' }
      }
    })
    assert.equal(JSON.parse(read.body.result.content[0].text).id, 'work_1')
    assert.deepEqual(workLedger.calls, [
      { method: 'create', goal: 'build work ledger' },
      {
        method: 'append',
        id: 'work_1',
        type: 'observation',
        payload: { fact: 'ledger wiring first' }
      },
      { method: 'read', id: 'work_1' }
    ])
  } finally {
    await app.close()
  }
})

test('dynamic work tools expose structured decision and deterministic dispatch control', async () => {
  const { createSidecarServer } = await loadServerModule()
  assert.equal(typeof createSidecarServer, 'function')
  if (typeof createSidecarServer !== 'function') return

  const workController = new FakeWorkController()
  const app = createSidecarServer({ conversationHost: new FakeHost(), workController })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const baseUrl = `http://127.0.0.1:${address.port}`
  try {
    const state = await rpc(baseUrl, {
      jsonrpc: '2.0', id: 30, method: 'tools/call', params: {
        name: 'work_state', arguments: { work_id: 'work_1' }
      }
    })
    assert.equal(JSON.parse(state.body.result.content[0].text).id, 'work_1')

    const checkpoint = {
      based_on_event_count: 2,
      evidence_event_indexes: [1],
      decision: { action: 'CONTINUE', reason: 'commit current interpretation' }
    }
    const checkpointed = await rpc(baseUrl, {
      jsonrpc: '2.0', id: 301, method: 'tools/call', params: {
        name: 'work_checkpoint', arguments: { work_id: 'work_1', ...checkpoint }
      }
    })
    assert.equal(JSON.parse(checkpointed.body.result.content[0].text).eventCount, 3)

    const decision = {
      action: 'SPLIT',
      reason: 'two independent frontiers emerged',
      frontiers: [{ id: 'f1', task: 'inspect recovery', depends_on: [] }]
    }
    const decided = await rpc(baseUrl, {
      jsonrpc: '2.0', id: 31, method: 'tools/call', params: {
        name: 'work_decide', arguments: { work_id: 'work_1', decision }
      }
    })
    assert.equal(JSON.parse(decided.body.result.content[0].text).latestDecision.action, 'SPLIT')

    const dispatched = await rpc(baseUrl, {
      jsonrpc: '2.0', id: 32, method: 'tools/call', params: {
        name: 'work_dispatch', arguments: { work_id: 'work_1', frontier_id: 'f1' }
      }
    })
    assert.equal(JSON.parse(dispatched.body.result.content[0].text).dispatched, true)

    const collected = await rpc(baseUrl, {
      jsonrpc: '2.0', id: 33, method: 'tools/call', params: {
        name: 'work_collect', arguments: { work_id: 'work_1' }
      }
    })
    assert.equal(JSON.parse(collected.body.result.content[0].text).collected, 1)
    assert.deepEqual(workController.calls, [
      { method: 'state', id: 'work_1' },
      { method: 'checkpoint', id: 'work_1', checkpoint },
      { method: 'decide', id: 'work_1', decision },
      { method: 'dispatch', id: 'work_1', frontierId: 'f1' },
      { method: 'collect', id: 'work_1' }
    ])
  } finally {
    await app.close()
  }
})

test('completed work is durably published to MemoryPool before completion returns success', async () => {
  const { createSidecarServer } = await loadServerModule()
  assert.equal(typeof createSidecarServer, 'function')
  if (typeof createSidecarServer !== 'function') return

  const root = await mkdtemp(join(tmpdir(), 'conversation-sidecar-terminal-memory-'))
  const workLedger = new WorkLedger(join(root, 'works'))
  const memoryPool = new MemoryPool({ rootDir: join(root, 'memory'), workLedger })
  const source = await workLedger.create('persist terminal work automatically')
  await workLedger.append(source.id, 'observation', { fact: 'authoritative evidence' })
  await workLedger.append(source.id, 'decision', { action: 'STOP', reason: 'done' })

  const app = createSidecarServer({ conversationHost: new FakeHost(), workLedger, memoryPool })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const baseUrl = `http://127.0.0.1:${address.port}`
  try {
    const completed = await rpc(baseUrl, {
      jsonrpc: '2.0', id: 39, method: 'tools/call', params: {
        name: 'work_append',
        arguments: { work_id: source.id, type: 'completed', payload: { outcome: 'done' } }
      }
    })
    assert.equal(completed.status, 200)
    assert.equal(JSON.parse(completed.body.result.content[0].text).type, 'completed')

    const manifest = (await readFile(join(root, 'memory', 'manifest.jsonl'), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(manifest.length, 1)
    assert.equal(manifest[0].source_work_id, source.id)

    const current = await workLedger.create('read persisted terminal memory')
    const retrieval = await memoryPool.query(current.id, { contains: 'persist terminal work automatically' })
    assert.equal(retrieval.matched.length, 1)
    const consumed = await memoryPool.read(current.id, retrieval.retrievalId, manifest[0].memory_id)
    assert.equal(consumed.meta.source_work_id, source.id)
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('completed work is rejected before ledger mutation when MemoryPool is unavailable', async () => {
  const { createSidecarServer } = await loadServerModule()
  assert.equal(typeof createSidecarServer, 'function')
  if (typeof createSidecarServer !== 'function') return

  const workLedger = new FakeWorkLedger()
  const app = createSidecarServer({ conversationHost: new FakeHost(), workLedger })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const baseUrl = `http://127.0.0.1:${address.port}`
  try {
    const completed = await rpc(baseUrl, {
      jsonrpc: '2.0', id: 391, method: 'tools/call', params: {
        name: 'work_append',
        arguments: { work_id: 'work_1', type: 'completed', payload: { outcome: 'done' } }
      }
    })
    const result = completed.body.result
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /memory pool unavailable/)
    assert.deepEqual(workLedger.calls, [])
  } finally {
    await app.close()
  }
})

test('completed work without terminal STOP is rejected before completed is appended', async () => {
  const { createSidecarServer } = await loadServerModule()
  assert.equal(typeof createSidecarServer, 'function')
  if (typeof createSidecarServer !== 'function') return

  const root = await mkdtemp(join(tmpdir(), 'conversation-sidecar-terminal-guard-'))
  const workLedger = new WorkLedger(join(root, 'works'))
  const memoryPool = new MemoryPool({ rootDir: join(root, 'memory'), workLedger })
  const source = await workLedger.create('do not strand an unpublished completion')
  const app = createSidecarServer({ conversationHost: new FakeHost(), workLedger, memoryPool })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const baseUrl = `http://127.0.0.1:${address.port}`
  try {
    const completed = await rpc(baseUrl, {
      jsonrpc: '2.0', id: 392, method: 'tools/call', params: {
        name: 'work_append',
        arguments: { work_id: source.id, type: 'completed', payload: { outcome: 'done' } }
      }
    })
    assert.equal(completed.body.result.isError, true)
    assert.match(completed.body.result.content[0].text, /terminal STOP/)
    const state = await workLedger.read(source.id)
    assert.deepEqual(state.events.map((event) => event.type), ['goal'])
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('retry after memory publication failure does not append a second completed event', async () => {
  const { createSidecarServer } = await loadServerModule()
  assert.equal(typeof createSidecarServer, 'function')
  if (typeof createSidecarServer !== 'function') return

  const root = await mkdtemp(join(tmpdir(), 'conversation-sidecar-terminal-retry-'))
  const workLedger = new WorkLedger(join(root, 'works'))
  const realMemoryPool = new MemoryPool({ rootDir: join(root, 'memory'), workLedger })
  const source = await workLedger.create('retry terminal memory commit')
  await workLedger.append(source.id, 'decision', { action: 'STOP', reason: 'done' })
  let attempts = 0
  const flakyMemoryPool = {
    async publish(workId) {
      attempts += 1
      if (attempts === 1) throw new Error('simulated memory write failure')
      return realMemoryPool.publish(workId)
    }
  }
  const app = createSidecarServer({ conversationHost: new FakeHost(), workLedger, memoryPool: flakyMemoryPool })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const baseUrl = `http://127.0.0.1:${address.port}`
  const request = {
    jsonrpc: '2.0', id: 393, method: 'tools/call', params: {
      name: 'work_append',
      arguments: { work_id: source.id, type: 'completed', payload: { outcome: 'done' } }
    }
  }
  try {
    const first = await rpc(baseUrl, request)
    assert.equal(first.body.result.isError, true)
    assert.match(first.body.result.content[0].text, /simulated memory write failure/)

    const second = await rpc(baseUrl, { ...request, id: 394 })
    assert.equal(second.body.result.isError, undefined)
    assert.equal(JSON.parse(second.body.result.content[0].text).type, 'completed')
    assert.equal(attempts, 2)

    const state = await workLedger.read(source.id)
    assert.equal(state.events.filter((event) => event.type === 'completed').length, 1)
    const manifest = (await readFile(join(root, 'memory', 'manifest.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(manifest.length, 1)
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('memory tools dispatch explicit publish, query, and read through MemoryPool', async () => {
  const { createSidecarServer } = await loadServerModule()
  assert.equal(typeof createSidecarServer, 'function')
  if (typeof createSidecarServer !== 'function') return

  const memoryPool = new FakeMemoryPool()
  const app = createSidecarServer({ conversationHost: new FakeHost(), memoryPool })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const baseUrl = `http://127.0.0.1:${address.port}`
  try {
    const published = await rpc(baseUrl, {
      jsonrpc: '2.0', id: 40, method: 'tools/call', params: {
        name: 'work_memory_publish', arguments: { source_work_id: 'work_done' }
      }
    })
    assert.equal(JSON.parse(published.body.result.content[0].text).memory_id, 'mem_1')

    const queried = await rpc(baseUrl, {
      jsonrpc: '2.0', id: 41, method: 'tools/call', params: {
        name: 'work_memory_query', arguments: { work_id: 'work_current', contains: 'completion' }
      }
    })
    assert.equal(JSON.parse(queried.body.result.content[0].text).retrievalId, 'retrieval_1')

    const read = await rpc(baseUrl, {
      jsonrpc: '2.0', id: 42, method: 'tools/call', params: {
        name: 'work_memory_read', arguments: {
          work_id: 'work_current', retrieval_id: 'retrieval_1', memory_id: 'mem_1'
        }
      }
    })
    assert.equal(JSON.parse(read.body.result.content[0].text).meta.memory_id, 'mem_1')

    const rejectedExtra = await rpc(baseUrl, {
      jsonrpc: '2.0', id: 43, method: 'tools/call', params: {
        name: 'work_memory_query', arguments: { work_id: 'work_current', similarity: 0.8 }
      }
    })
    assert.equal(rejectedExtra.body.error.code, -32602)

    assert.deepEqual(memoryPool.calls, [
      { method: 'publish', sourceWorkId: 'work_done' },
      { method: 'query', workId: 'work_current', query: { contains: 'completion' } },
      { method: 'read', workId: 'work_current', retrievalId: 'retrieval_1', memoryId: 'mem_1' }
    ])
  } finally {
    await app.close()
  }
})

test('runtime wiring kicks memory sync at startup and after durable MemoryPool publish without awaiting it', async () => {
  const { createRuntimeComponents, createSidecarServer } = await loadServerModule()
  assert.equal(typeof createRuntimeComponents, 'function')
  assert.equal(typeof createSidecarServer, 'function')
  if (typeof createRuntimeComponents !== 'function' || typeof createSidecarServer !== 'function') return

  const root = await mkdtemp(join(tmpdir(), 'conversation-sidecar-memory-sync-wiring-'))
  let kicks = 0
  const never = new Promise(() => {})
  const memorySyncBridge = {
    kick() {
      kicks += 1
      return never
    }
  }
  const components = createRuntimeComponents({
    bridge: new EventEmitter(),
    dataRoot: root,
    memorySyncBridge
  })
  const source = await components.workLedger.create('auto sync wiring')
  await components.workLedger.append(source.id, 'decision', { action: 'STOP', reason: 'done' })
  const app = createSidecarServer({ ...components })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const baseUrl = `http://127.0.0.1:${address.port}`
  try {
    assert.equal(kicks, 1)
    const completed = await rpc(baseUrl, {
      jsonrpc: '2.0', id: 495, method: 'tools/call', params: {
        name: 'work_append',
        arguments: { work_id: source.id, type: 'completed', payload: { outcome: 'done' } }
      }
    })
    assert.equal(completed.body.result.isError, undefined)
    assert.equal(JSON.parse(completed.body.result.content[0].text).type, 'completed')
    assert.equal(kicks, 2)
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('runtime components place conversations, works, and memory under one stable data root', async () => {
  const { createRuntimeComponents } = await loadServerModule()
  assert.equal(typeof createRuntimeComponents, 'function')
  if (typeof createRuntimeComponents !== 'function') return

  const dataRoot = join('C:\\runtime-home', 'data')
  const bridge = new EventEmitter()
  const memorySyncBridge = { kick() {} }
  const components = createRuntimeComponents({ bridge, dataRoot, memorySyncBridge })

  assert.equal(components.store.rootDir, join(dataRoot, 'conversations'))
  assert.equal(components.workLedger.rootDir, join(dataRoot, 'works'))
  assert.equal(components.memoryPool.rootDir, join(dataRoot, 'memory'))
  assert.equal(components.memorySyncBridge, memorySyncBridge)
  assert.equal(components.workController.ledger, components.workLedger)
  assert.equal(components.workController.conversationHost, components.conversationHost)
})

test('tools/call dispatches create, send, and read to the conversation host', async () => {
  const { createSidecarServer } = await loadServerModule()
  assert.equal(typeof createSidecarServer, 'function')
  if (typeof createSidecarServer !== 'function') return

  const host = new FakeHost()
  const app = createSidecarServer({ conversationHost: host })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const baseUrl = `http://127.0.0.1:${address.port}`
  try {
    const projectCreated = await rpc(baseUrl, {
      jsonrpc: '2.0', id: 8, method: 'tools/call', params: {
        name: 'project_create',
        arguments: { name: 'subagents' }
      }
    })
    assert.equal(
      JSON.parse(projectCreated.body.result.content[0].text).projectUrl,
      'https://chatgpt.com/g/g-p-created-test/project'
    )
    assert.equal(host.projectCreateName, 'subagents')

    const found = await rpc(baseUrl, {
      jsonrpc: '2.0', id: 81, method: 'tools/call', params: {
        name: 'project_find',
        arguments: { name: 'subagents' }
      }
    })
    assert.equal(
      JSON.parse(found.body.result.content[0].text).projectUrl,
      'https://chatgpt.com/g/g-p-subagents-test/project'
    )
    assert.equal(host.projectFindName, 'subagents')

    const projectUrl = 'https://chatgpt.com/g/g-p-project123-agent/project'
    const pinned = await rpc(baseUrl, {
      jsonrpc: '2.0', id: 9, method: 'tools/call', params: {
        name: 'project_pin',
        arguments: { project_url: projectUrl }
      }
    })
    assert.equal(JSON.parse(pinned.body.result.content[0].text).projectUrl, projectUrl)
    assert.equal(host.pinnedProjectUrl, projectUrl)

    const created = await rpc(baseUrl, {
      jsonrpc: '2.0', id: 10, method: 'tools/call', params: {
        name: 'conversation_create',
        arguments: { project_url: projectUrl }
      }
    })
    assert.equal(JSON.parse(created.body.result.content[0].text).id, 'conv_1')
    assert.deepEqual(host.createCalls, [{ projectUrl }])

    const sent = await rpc(baseUrl, {
      jsonrpc: '2.0', id: 11, method: 'tools/call', params: {
        name: 'conversation_send', arguments: { conversation_id: 'conv_1', text: 'hello', app: 'DevSpace' }
      }
    })
    assert.equal(JSON.parse(sent.body.result.content[0].text).accepted, true)
    assert.deepEqual(host.sendCalls, [{ id: 'conv_1', text: 'hello', app: 'DevSpace' }])

    const read = await rpc(baseUrl, {
      jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'conversation_read', arguments: { conversation_id: 'conv_1' } }
    })
    assert.equal(JSON.parse(read.body.result.content[0].text).latestResponse, 'done')

    const invalid = await rpc(baseUrl, {
      jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'unknown', arguments: {} }
    })
    assert.equal(invalid.body.error.code, -32602)
  } finally {
    await app.close()
  }
})
