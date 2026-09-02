import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { createSidecarServer } from '../src/server.mjs'

const execFile = promisify(execFileCallback)

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

async function cli(endpoint, ...args) {
  const { stdout } = await execFile(process.execPath, ['src/mcp-cli.mjs', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, CONVERSATION_SIDECAR_MCP_URL: endpoint }
  })
  return JSON.parse(stdout)
}

test('argv MCP CLI calls every subcommand against a live local sidecar', async () => {
  const app = createSidecarServer({ conversationHost: new FakeHost() })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const endpoint = `http://127.0.0.1:${address.port}/mcp`
  const projectUrl = 'https://chatgpt.com/g/g-p-project123-agent/project'

  try {
    assert.deepEqual(
      (await cli(endpoint, 'tools')).map((tool) => tool.name),
      ['project_pin', 'conversation_create', 'conversation_send', 'conversation_read']
    )
    assert.deepEqual(await cli(endpoint, 'project-pin', projectUrl), { projectUrl })
    assert.deepEqual(await cli(endpoint, 'create', projectUrl), { id: 'conv_1', projectUrl })
    assert.deepEqual(await cli(endpoint, 'send', 'conv_1', 'hello world'), { conversationId: 'conv_1', text: 'hello world', accepted: true })
    assert.deepEqual(await cli(endpoint, 'read', 'conv_1'), { id: 'conv_1', latestResponse: 'done' })
  } finally {
    await app.close()
  }
})
