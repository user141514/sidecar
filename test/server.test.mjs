import test from 'node:test'
import assert from 'node:assert/strict'

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

  async send(id, text) {
    return { conversationId: id, turnId: 'turn_1', accepted: true, text }
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
      ['project_create', 'project_find', 'project_pin', 'conversation_create', 'conversation_send', 'conversation_read', 'work_create', 'work_append', 'work_read', 'work_state', 'work_decide', 'work_dispatch', 'work_collect', 'work_memory_publish', 'work_memory_query', 'work_memory_read']
    )
    const workDecide = listed.body.result.tools.find((tool) => tool.name === 'work_decide')
    const decisionSchema = workDecide.inputSchema.properties.decision
    assert.equal(decisionSchema.properties.action.enum.includes('REVISE'), true)
    assert.deepEqual(decisionSchema.properties.evidence_event_indexes.items, { type: 'integer', minimum: 0 })
    assert.equal(decisionSchema.properties.evidence_event_indexes.minItems, 1)
    assert.equal(decisionSchema.properties.plan.properties.objective.type, 'string')
    assert.equal(decisionSchema.properties.orchestration.properties.mode.enum.includes('ADVERSARIAL'), true)
    assert.deepEqual(decisionSchema.allOf[0].if.properties.action, { const: 'REVISE' })
    assert.deepEqual(decisionSchema.allOf[0].then.required, ['evidence_event_indexes', 'plan', 'orchestration'])
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
      { method: 'decide', id: 'work_1', decision },
      { method: 'dispatch', id: 'work_1', frontierId: 'f1' },
      { method: 'collect', id: 'work_1' }
    ])
  } finally {
    await app.close()
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
      jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'conversation_send', arguments: { conversation_id: 'conv_1', text: 'hello' } }
    })
    assert.equal(JSON.parse(sent.body.result.content[0].text).accepted, true)

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
