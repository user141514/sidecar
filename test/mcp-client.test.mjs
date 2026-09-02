import test from 'node:test'
import assert from 'node:assert/strict'

async function loadClientModule() {
  try {
    return await import('../src/mcp-client.mjs')
  } catch {
    return {}
  }
}

async function loadServerModule() {
  return import('../src/server.mjs')
}

class FakeHost {
  async pinProject(projectUrl) {
    return { projectUrl }
  }

  async create({ projectUrl } = {}) {
    return { id: 'conv_1', projectUrl: projectUrl ?? null }
  }

  async send(conversationId, text) {
    return { conversationId, text, accepted: true }
  }

  async read(conversationId) {
    return { id: conversationId, latestResponse: 'done' }
  }
}

test('MCP HTTP client makes live JSON calls for discovery and every conversation tool', async () => {
  const { McpHttpClient } = await loadClientModule()
  assert.equal(typeof McpHttpClient, 'function')
  if (typeof McpHttpClient !== 'function') return

  const { createSidecarServer } = await loadServerModule()
  const app = createSidecarServer({ conversationHost: new FakeHost() })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const client = new McpHttpClient({ endpoint: `http://127.0.0.1:${address.port}/mcp` })
  const projectUrl = 'https://chatgpt.com/g/g-p-project123-agent/project'

  try {
    assert.deepEqual(
      (await client.toolsList()).map((tool) => tool.name),
      ['project_pin', 'conversation_create', 'conversation_send', 'conversation_read']
    )
    assert.deepEqual(await client.projectPin(projectUrl), { projectUrl })
    assert.deepEqual(await client.conversationCreate(projectUrl), { id: 'conv_1', projectUrl })
    assert.deepEqual(await client.conversationSend('conv_1', 'hello'), { conversationId: 'conv_1', text: 'hello', accepted: true })
    assert.deepEqual(await client.conversationRead('conv_1'), { id: 'conv_1', latestResponse: 'done' })
  } finally {
    await app.close()
  }
})
