import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { PassThrough } from 'node:stream'

async function loadModule() {
  try {
    return await import('../src/mcp-stdio.mjs')
  } catch {
    return {}
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(server.address())
    })
  })
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

test('stdio adapter forwards one JSON-RPC line to localhost MCP and writes one response line', async () => {
  const { runStdioAdapter } = await loadModule()
  assert.equal(typeof runStdioAdapter, 'function')
  if (typeof runStdioAdapter !== 'function') return

  let seenBody = null
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    seenBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const body = JSON.stringify({ jsonrpc: '2.0', id: seenBody.id, result: { tools: [] } })
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  })
  const address = await listen(server)
  const input = new PassThrough()
  const output = new PassThrough()
  let rendered = ''
  output.on('data', (chunk) => { rendered += chunk.toString('utf8') })

  try {
    const running = runStdioAdapter({
      input,
      output,
      endpoint: `http://127.0.0.1:${address.port}/mcp`
    })
    input.end(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} })}\n`)
    await running

    assert.equal(seenBody.method, 'tools/list')
    assert.deepEqual(JSON.parse(rendered.trim()), {
      jsonrpc: '2.0',
      id: 7,
      result: { tools: [] }
    })
  } finally {
    await close(server)
  }
})

test('stdio adapter preserves the standalone provider endpoint environment variable', async (t) => {
  const { runStdioAdapter } = await loadModule()
  const previous = process.env.CHATGPT_CONVERSATION_MCP_URL
  process.env.CHATGPT_CONVERSATION_MCP_URL = 'http://127.0.0.1:17337/mcp'
  t.after(() => {
    if (previous === undefined) delete process.env.CHATGPT_CONVERSATION_MCP_URL
    else process.env.CHATGPT_CONVERSATION_MCP_URL = previous
  })
  const input = new PassThrough()
  const output = new PassThrough()
  output.resume()
  let seenUrl
  const running = runStdioAdapter({ input, output, fetchImpl: async (url) => {
    seenUrl = url
    return { status: 200, async json() { return { jsonrpc: '2.0', id: 1, result: {} } } }
  } })
  input.end('{"jsonrpc":"2.0","id":1,"method":"ping"}\n')
  await running
  assert.equal(seenUrl, 'http://127.0.0.1:17337/mcp')
})

test('stdio adapter emits nothing for a notification acknowledged with HTTP 204', async () => {
  const { runStdioAdapter } = await loadModule()
  assert.equal(typeof runStdioAdapter, 'function')
  if (typeof runStdioAdapter !== 'function') return

  const server = http.createServer(async (_req, res) => {
    res.writeHead(204)
    res.end()
  })
  const address = await listen(server)
  const input = new PassThrough()
  const output = new PassThrough()
  let rendered = ''
  output.on('data', (chunk) => { rendered += chunk.toString('utf8') })

  try {
    const running = runStdioAdapter({ input, output, endpoint: `http://127.0.0.1:${address.port}/mcp` })
    input.end(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`)
    await running
    assert.equal(rendered, '')
  } finally {
    await close(server)
  }
})
