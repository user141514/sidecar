import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { ChatGptConversationHost } from './chatgpt.mjs'
import { ExtensionBridge, NativeMessageChannel } from './native-messaging.mjs'
import { ConversationStore } from './store.mjs'
import { EXTENSION_TOOLS, dispatchExtensionTool } from './extension-control.mjs'
import { CONVERSATION_TOOLS, dispatchConversationTool } from './conversation-tools.mjs'

const tools = [...EXTENSION_TOOLS, ...CONVERSATION_TOOLS]
function rpcError(id, code, message) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } } }
function respond(res, code, value) {
  const text = JSON.stringify(value)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

export function createProviderServer({ conversationHost }) {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') { respond(res, 200, { ok: true }); return }
      if (req.method !== 'POST' || req.url !== '/mcp') { respond(res, 404, { error: 'not_found' }); return }
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 1024 * 1024) { respond(res, 413, rpcError(null, -32600, 'Request too large')); return }
        chunks.push(chunk)
      }
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') { respond(res, 400, rpcError(message?.id, -32600, 'Invalid Request')); return }
      if (message.method.startsWith('notifications/')) { res.writeHead(204); res.end(); return }
      const id = message.id
      let result
      if (message.method === 'initialize') result = {
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} },
        serverInfo: { name: 'chatgpt-conversation', version: '0.1.1' },
        instructions: 'Conversation transport only. No planning, memory or worker policy. extension_reload accepts an update request; independent CLI extension-update verifies reconnect and build.'
      }
      else if (message.method === 'ping') result = {}
      else if (message.method === 'tools/list') result = { tools }
      else if (message.method === 'tools/call') {
        const name = message.params?.name
        if (!tools.some((tool) => tool.name === name)) { respond(res, 200, rpcError(id, -32602, `Unknown tool: ${name}`)); return }
        try {
          const args = message.params.arguments ?? {}
          const value = name.startsWith('extension_')
            ? await dispatchExtensionTool(conversationHost.bridge, name, args)
            : await dispatchConversationTool(conversationHost, name, args)
          result = { content: [{ type: 'text', text: JSON.stringify(value) }] }
        } catch (error) {
          if (error instanceof TypeError) { respond(res, 200, rpcError(id, -32602, error.message)); return }
          result = { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
        }
      } else { respond(res, 200, rpcError(id, -32601, `Method not found: ${message.method}`)); return }
      respond(res, 200, { jsonrpc: '2.0', id, result })
    } catch (error) { respond(res, 400, rpcError(null, -32700, error instanceof Error ? error.message : String(error))) }
  })
  return {
    listen({ host = '127.0.0.1', port = 7337 } = {}) {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => { server.off('error', reject); resolve(server.address()) })
      })
    },
    close() { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
  }
}

export async function startProvider() {
  const channel = new NativeMessageChannel({ input: process.stdin, output: process.stdout })
  const bridge = new ExtensionBridge({ channel })
  bridge.on('error', (error) => console.error(error.stack ?? String(error)))
  const store = new ConversationStore(process.env.CHATGPT_CONVERSATION_DATA_DIR ?? process.env.SIDECAR_DATA_DIR ?? fileURLToPath(new URL('../data/conversations/', import.meta.url)))
  const app = createProviderServer({ conversationHost: new ChatGptConversationHost({ bridge, store }) })
  const address = await app.listen({ host: process.env.CHATGPT_CONVERSATION_HOST ?? process.env.SIDECAR_HOST ?? '127.0.0.1', port: Number(process.env.CHATGPT_CONVERSATION_PORT ?? process.env.SIDECAR_PORT ?? 7337) })
  console.error(JSON.stringify({ ok: true, service: 'chatgpt-conversation', host: address.address, port: address.port, mcp: '/mcp' }))
  channel.once('close', () => { void app.close().finally(() => { process.exitCode = 0 }) })
  return app
}
