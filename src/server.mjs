#!/usr/bin/env node
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { ChatGptConversationHost } from './chatgpt.mjs'
import { ExtensionBridge, NativeMessageChannel } from './native-messaging.mjs'
import { ConversationStore } from './store.mjs'

const TOOLS = [
  {
    name: 'project_pin',
    description: 'Persist one ChatGPT Project home as the default destination for future conversation_create calls.',
    inputSchema: {
      type: 'object',
      properties: { project_url: { type: 'string' } },
      required: ['project_url'],
      additionalProperties: false
    }
  },
  {
    name: 'conversation_create',
    description: 'Create a new ChatGPT conversation in the already-running signed-in Chrome profile, optionally inside a specific ChatGPT Project.',
    inputSchema: {
      type: 'object',
      properties: { project_url: { type: 'string' } },
      additionalProperties: false
    }
  },
  {
    name: 'conversation_send',
    description: 'Submit one prompt to a conversation. Returns after submission while monitoring continues in the sidecar.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string' },
        text: { type: 'string' }
      },
      required: ['conversation_id', 'text'],
      additionalProperties: false
    }
  },
  {
    name: 'conversation_read',
    description: 'Read the latest durable state and raw response for a conversation from the local ledger.',
    inputSchema: {
      type: 'object',
      properties: { conversation_id: { type: 'string' } },
      required: ['conversation_id'],
      additionalProperties: false
    }
  }
]

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

function toolResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }]
  }
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return null
  return JSON.parse(raw)
}

function writeJson(res, statusCode, body) {
  const payload = JSON.stringify(body)
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

async function dispatchTool(conversationHost, name, args = {}) {
  if (name === 'project_pin') {
    if (typeof args.project_url !== 'string') {
      throw new TypeError('project_pin requires project_url')
    }
    return conversationHost.pinProject(args.project_url)
  }
  if (name === 'conversation_create') {
    return conversationHost.create({ projectUrl: args.project_url })
  }
  if (name === 'conversation_send') {
    if (typeof args.conversation_id !== 'string' || typeof args.text !== 'string') {
      throw new TypeError('conversation_send requires conversation_id and text')
    }
    return conversationHost.send(args.conversation_id, args.text)
  }
  if (name === 'conversation_read') {
    if (typeof args.conversation_id !== 'string') {
      throw new TypeError('conversation_read requires conversation_id')
    }
    return conversationHost.read(args.conversation_id)
  }
  const error = new TypeError(`Unknown tool: ${name}`)
  error.code = -32602
  throw error
}

async function handleRpc(conversationHost, message) {
  const id = message?.id
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return { status: 400, body: jsonRpcError(id, -32600, 'Invalid Request') }
  }

  if (message.method.startsWith('notifications/')) {
    return { status: 204, body: null }
  }

  if (message.method === 'initialize') {
    return {
      status: 200,
      body: jsonRpcResult(id, {
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'conversation-sidecar', version: '0.0.2' },
        instructions: 'Use conversation_create, conversation_send, and conversation_read. Raw local events are the source of truth.'
      })
    }
  }

  if (message.method === 'ping') {
    return { status: 200, body: jsonRpcResult(id, {}) }
  }

  if (message.method === 'tools/list') {
    return { status: 200, body: jsonRpcResult(id, { tools: TOOLS }) }
  }

  if (message.method === 'tools/call') {
    const name = message.params?.name
    if (typeof name !== 'string') {
      return { status: 200, body: jsonRpcError(id, -32602, 'tools/call requires a tool name') }
    }
    try {
      const value = await dispatchTool(conversationHost, name, message.params?.arguments ?? {})
      return { status: 200, body: jsonRpcResult(id, toolResult(value)) }
    } catch (error) {
      if (error?.code === -32602 || error instanceof TypeError) {
        return { status: 200, body: jsonRpcError(id, -32602, error.message) }
      }
      return {
        status: 200,
        body: jsonRpcResult(id, {
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          isError: true
        })
      }
    }
  }

  return { status: 200, body: jsonRpcError(id, -32601, `Method not found: ${message.method}`) }
}

export function createSidecarServer({ conversationHost }) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method === 'GET' && url.pathname === '/healthz') {
        writeJson(res, 200, { ok: true })
        return
      }
      if (req.method !== 'POST' || url.pathname !== '/mcp') {
        writeJson(res, 404, { error: 'not_found' })
        return
      }

      const message = await readJson(req)
      const result = await handleRpc(conversationHost, message)
      if (result.status === 204) {
        res.writeHead(204)
        res.end()
      } else {
        writeJson(res, result.status, result.body)
      }
    } catch (error) {
      writeJson(res, 400, jsonRpcError(null, -32700, error instanceof Error ? error.message : String(error)))
    }
  })

  return {
    listen({ host = '127.0.0.1', port = 7337 } = {}) {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.off('error', reject)
          resolve(server.address())
        })
      })
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  }
}

async function startDefault() {
  const channel = new NativeMessageChannel({ input: process.stdin, output: process.stdout })
  const bridge = new ExtensionBridge({ channel })
  bridge.on('error', (error) => console.error(error instanceof Error ? error.stack : String(error)))

  const defaultDataRoot = fileURLToPath(new URL('../data/conversations/', import.meta.url))
  const store = new ConversationStore(process.env.SIDECAR_DATA_DIR ?? defaultDataRoot)
  const conversationHost = new ChatGptConversationHost({ bridge, store })
  const app = createSidecarServer({ conversationHost })
  const host = process.env.SIDECAR_HOST ?? '127.0.0.1'
  const port = Number(process.env.SIDECAR_PORT ?? 7337)
  const address = await app.listen({ host, port })
  console.error(JSON.stringify({ ok: true, service: 'conversation-sidecar', host: address.address, port: address.port, mcp: '/mcp' }))

  channel.once('close', () => {
    void app.close().finally(() => {
      process.exitCode = 0
    })
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startDefault().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error))
    process.exitCode = 1
  })
}
