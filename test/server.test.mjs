import test from 'node:test'
import assert from 'node:assert/strict'

async function loadServerModule() {
  try {
    return await import('../src/server.mjs')
  } catch {
    return {}
  }
}

class FakeHost {
  async create() {
    return { id: 'conv_1', status: 'idle', externalUrl: 'https://chatgpt.com/' }
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

test('server exposes health and exactly three conversation tools', async () => {
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
      ['conversation_create', 'conversation_send', 'conversation_read']
    )
  } finally {
    await app.close()
  }
})

test('tools/call dispatches create, send, and read to the conversation host', async () => {
  const { createSidecarServer } = await loadServerModule()
  assert.equal(typeof createSidecarServer, 'function')
  if (typeof createSidecarServer !== 'function') return

  const app = createSidecarServer({ conversationHost: new FakeHost() })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const baseUrl = `http://127.0.0.1:${address.port}`
  try {
    const created = await rpc(baseUrl, {
      jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'conversation_create', arguments: {} }
    })
    assert.equal(JSON.parse(created.body.result.content[0].text).id, 'conv_1')

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
