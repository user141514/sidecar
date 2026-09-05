#!/usr/bin/env node
import http from 'node:http'
import { EXTENSION_TOOLS, dispatchExtensionTool } from './extension-control.mjs'
import { CONVERSATION_TOOLS, dispatchConversationTool } from './conversation-tools.mjs'
import { fileURLToPath } from 'node:url'
import { ChatGptConversationHost } from './chatgpt.mjs'
import { ExtensionBridge, NativeMessageChannel } from './native-messaging.mjs'
import { ConversationStore } from './store.mjs'
import { WorkLedger } from './work-ledger.mjs'
import { WorkController } from './work-controller.mjs'
import { MemoryPool } from './memory-pool.mjs'

const TOOLS = [
  ...EXTENSION_TOOLS,
  ...CONVERSATION_TOOLS,
  {
    name: 'work_create',
    description: 'Create one local append-only work ledger for a coordinator goal.',
    inputSchema: {
      type: 'object',
      properties: { goal: { type: 'string' } },
      required: ['goal'],
      additionalProperties: false
    }
  },
  {
    name: 'work_append',
    description: 'Append one structured coordinator event to an existing work ledger.',
    inputSchema: {
      type: 'object',
      properties: {
        work_id: { type: 'string' },
        type: {
          type: 'string',
          enum: ['action', 'observation', 'completed']
        },
        payload: { type: 'object' }
      },
      required: ['work_id', 'type', 'payload'],
      additionalProperties: false
    }
  },
  {
    name: 'work_read',
    description: 'Read one local work ledger and its structured event trajectory.',
    inputSchema: {
      type: 'object',
      properties: { work_id: { type: 'string' } },
      required: ['work_id'],
      additionalProperties: false
    }
  },
  {
    name: 'work_state',
    description: 'Derive the current coordinator state and frontier statuses from one work ledger.',
    inputSchema: {
      type: 'object',
      properties: { work_id: { type: 'string' } },
      required: ['work_id'],
      additionalProperties: false
    }
  },
  {
    name: 'work_decide',
    description: 'Validate and persist one host-LLM control decision for the current work state.',
    inputSchema: {
      type: 'object',
      properties: {
        work_id: { type: 'string' },
        decision: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['CONTINUE', 'SPLIT', 'PRUNE', 'REVISE', 'STOP'] },
            reason: { type: 'string' },
            evidence_event_indexes: {
              type: 'array',
              minItems: 1,
              items: { type: 'integer', minimum: 0 }
            },
            plan: {
              type: 'object',
              properties: {
                objective: { type: 'string' },
                approach: { type: 'string' },
                current_focus: { type: 'string' },
                assumptions: { type: 'array', items: { type: 'string' } },
                open_questions: { type: 'array', items: { type: 'string' } }
              },
              required: ['objective', 'approach', 'current_focus', 'assumptions', 'open_questions'],
              additionalProperties: false
            },
            orchestration: {
              type: 'object',
              properties: {
                mode: { type: 'string', enum: ['EXPLORE', 'EXECUTE', 'ADVERSARIAL', 'SYNTHESIZE'] }
              },
              required: ['mode'],
              additionalProperties: false
            },
            frontiers: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  task: { type: 'string' },
                  prompt: { type: 'string' },
                  depends_on: { type: 'array', items: { type: 'string' } }
                },
                required: ['id', 'task'],
                additionalProperties: false
              }
            },
            frontier_ids: { type: 'array', items: { type: 'string' } }
          },
          required: ['action', 'reason'],
          allOf: [
            {
              if: { properties: { action: { const: 'REVISE' } }, required: ['action'] },
              then: { required: ['evidence_event_indexes', 'plan', 'orchestration'] }
            }
          ],
          additionalProperties: false
        }
      },
      required: ['work_id', 'decision'],
      additionalProperties: false
    }
  },
  {
    name: 'work_checkpoint',
    description: 'Optimistically commit one validated control decision against an exact Work Ledger event count and explicit evidence set.',
    inputSchema: {
      type: 'object',
      properties: {
        work_id: { type: 'string' },
        based_on_event_count: { type: 'integer', minimum: 0 },
        evidence_event_indexes: {
          type: 'array',
          minItems: 1,
          items: { type: 'integer', minimum: 0 }
        },
        decision: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['CONTINUE', 'SPLIT', 'PRUNE', 'REVISE', 'STOP'] },
            reason: { type: 'string' },
            plan: {
              type: 'object',
              properties: {
                objective: { type: 'string' },
                approach: { type: 'string' },
                current_focus: { type: 'string' },
                assumptions: { type: 'array', items: { type: 'string' } },
                open_questions: { type: 'array', items: { type: 'string' } }
              },
              required: ['objective', 'approach', 'current_focus', 'assumptions', 'open_questions'],
              additionalProperties: false
            },
            orchestration: {
              type: 'object',
              properties: {
                mode: { type: 'string', enum: ['EXPLORE', 'EXECUTE', 'ADVERSARIAL', 'SYNTHESIZE'] }
              },
              required: ['mode'],
              additionalProperties: false
            },
            frontiers: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  task: { type: 'string' },
                  prompt: { type: 'string' },
                  depends_on: { type: 'array', items: { type: 'string' } }
                },
                required: ['id', 'task'],
                additionalProperties: false
              }
            },
            frontier_ids: { type: 'array', items: { type: 'string' } }
          },
          required: ['action', 'reason'],
          allOf: [
            {
              if: { properties: { action: { const: 'REVISE' } }, required: ['action'] },
              then: { required: ['plan', 'orchestration'] }
            }
          ],
          additionalProperties: false
        }
      },
      required: ['work_id', 'based_on_event_count', 'evidence_event_indexes', 'decision'],
      additionalProperties: false
    }
  },
  {
    name: 'work_dispatch',
    description: 'Dispatch one ready frontier through the managed depth-1 worker path with dependency and pacing checks.',
    inputSchema: {
      type: 'object',
      properties: {
        work_id: { type: 'string' },
        frontier_id: { type: 'string' }
      },
      required: ['work_id', 'frontier_id'],
      additionalProperties: false
    }
  },
  {
    name: 'work_collect',
    description: 'Collect completed managed worker results into the work ledger without sending new prompts.',
    inputSchema: {
      type: 'object',
      properties: { work_id: { type: 'string' } },
      required: ['work_id'],
      additionalProperties: false
    }
  },
  {
    name: 'work_memory_publish',
    description: 'Explicitly publish one terminal STOP+completed Work Ledger as an immutable historical memory snapshot.',
    inputSchema: {
      type: 'object',
      properties: { source_work_id: { type: 'string' } },
      required: ['source_work_id'],
      additionalProperties: false
    }
  },
  {
    name: 'work_memory_query',
    description: 'Deterministically scan the frozen historical memory manifest and log available and matched records in the current Work Ledger.',
    inputSchema: {
      type: 'object',
      properties: {
        work_id: { type: 'string' },
        contains: { type: 'string' }
      },
      required: ['work_id'],
      additionalProperties: false
    }
  },
  {
    name: 'work_memory_read',
    description: 'Explicitly consume one memory matched by a prior retrieval in the same current Work Ledger.',
    inputSchema: {
      type: 'object',
      properties: {
        work_id: { type: 'string' },
        retrieval_id: { type: 'string' },
        memory_id: { type: 'string' }
      },
      required: ['work_id', 'retrieval_id', 'memory_id'],
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

function assertOnlyKeys(args, allowed, toolName) {
  const unexpected = Object.keys(args).find((key) => !allowed.includes(key))
  if (unexpected) throw new TypeError(`${toolName} does not accept ${unexpected}`)
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

async function dispatchTool(conversationHost, workLedger, workController, memoryPool, name, args = {}) {
  if (name === 'extension_status' || name === 'extension_reload') {
    return dispatchExtensionTool(conversationHost.bridge, name, args)
  }
  if (CONVERSATION_TOOLS.some((tool) => tool.name === name)) {
    return dispatchConversationTool(conversationHost, name, args)
  }
  if (name === 'work_create') {
    if (!workLedger) throw new Error('work ledger unavailable')
    if (typeof args.goal !== 'string') throw new TypeError('work_create requires goal')
    return workLedger.create(args.goal)
  }
  if (name === 'work_append') {
    if (!workLedger) throw new Error('work ledger unavailable')
    if (typeof args.work_id !== 'string' || typeof args.type !== 'string') {
      throw new TypeError('work_append requires work_id and type')
    }
    if (!args.payload || typeof args.payload !== 'object' || Array.isArray(args.payload)) {
      throw new TypeError('work_append requires structured payload')
    }
    if (!['action', 'observation', 'completed'].includes(args.type)) {
      throw new TypeError('work_append only accepts action, observation, or completed')
    }
    return workLedger.append(args.work_id, args.type, args.payload)
  }
  if (name === 'work_read') {
    if (!workLedger) throw new Error('work ledger unavailable')
    if (typeof args.work_id !== 'string') throw new TypeError('work_read requires work_id')
    return workLedger.read(args.work_id)
  }
  if (name === 'work_state') {
    if (!workController) throw new Error('work controller unavailable')
    if (typeof args.work_id !== 'string') throw new TypeError('work_state requires work_id')
    return workController.state(args.work_id)
  }
  if (name === 'work_decide') {
    if (!workController) throw new Error('work controller unavailable')
    if (typeof args.work_id !== 'string' || !args.decision || typeof args.decision !== 'object' || Array.isArray(args.decision)) {
      throw new TypeError('work_decide requires work_id and decision')
    }
    return workController.decide(args.work_id, args.decision)
  }
  if (name === 'work_checkpoint') {
    if (!workController) throw new Error('work controller unavailable')
    assertOnlyKeys(args, ['work_id', 'based_on_event_count', 'evidence_event_indexes', 'decision'], 'work_checkpoint')
    if (typeof args.work_id !== 'string' || !Number.isInteger(args.based_on_event_count) || args.based_on_event_count < 0) {
      throw new TypeError('work_checkpoint requires work_id and based_on_event_count')
    }
    if (!Array.isArray(args.evidence_event_indexes) || args.evidence_event_indexes.length === 0) {
      throw new TypeError('work_checkpoint requires evidence_event_indexes')
    }
    if (!args.decision || typeof args.decision !== 'object' || Array.isArray(args.decision)) {
      throw new TypeError('work_checkpoint requires decision')
    }
    assertOnlyKeys(args.decision, ['action', 'reason', 'plan', 'orchestration', 'frontiers', 'frontier_ids'], 'work_checkpoint decision')
    return workController.checkpoint(args.work_id, {
      based_on_event_count: args.based_on_event_count,
      evidence_event_indexes: args.evidence_event_indexes,
      decision: args.decision
    })
  }
  if (name === 'work_dispatch') {
    if (!workController) throw new Error('work controller unavailable')
    if (typeof args.work_id !== 'string' || typeof args.frontier_id !== 'string') {
      throw new TypeError('work_dispatch requires work_id and frontier_id')
    }
    return workController.dispatch(args.work_id, args.frontier_id)
  }
  if (name === 'work_collect') {
    if (!workController) throw new Error('work controller unavailable')
    if (typeof args.work_id !== 'string') throw new TypeError('work_collect requires work_id')
    return workController.collect(args.work_id)
  }
  if (name === 'work_memory_publish') {
    if (!memoryPool) throw new Error('memory pool unavailable')
    assertOnlyKeys(args, ['source_work_id'], name)
    if (typeof args.source_work_id !== 'string') throw new TypeError('work_memory_publish requires source_work_id')
    return memoryPool.publish(args.source_work_id)
  }
  if (name === 'work_memory_query') {
    if (!memoryPool) throw new Error('memory pool unavailable')
    assertOnlyKeys(args, ['work_id', 'contains'], name)
    if (typeof args.work_id !== 'string' || (args.contains !== undefined && typeof args.contains !== 'string')) {
      throw new TypeError('work_memory_query requires work_id and optional contains')
    }
    return memoryPool.query(args.work_id, args.contains === undefined ? {} : { contains: args.contains })
  }
  if (name === 'work_memory_read') {
    if (!memoryPool) throw new Error('memory pool unavailable')
    assertOnlyKeys(args, ['work_id', 'retrieval_id', 'memory_id'], name)
    if (typeof args.work_id !== 'string' || typeof args.retrieval_id !== 'string' || typeof args.memory_id !== 'string') {
      throw new TypeError('work_memory_read requires work_id, retrieval_id, and memory_id')
    }
    return memoryPool.read(args.work_id, args.retrieval_id, args.memory_id)
  }
  const error = new TypeError(`Unknown tool: ${name}`)
  error.code = -32602
  throw error
}

async function handleRpc(conversationHost, workLedger, workController, memoryPool, message) {
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
        instructions: 'Use project_create/project_pin for optional Project setup, conversation_create/conversation_send/conversation_read for conversations, work_* for structured coordinator trajectories, and work_memory_* only for explicit historical-memory publication/query/consumption. Historical memory is optional and never auto-injected. Raw local events are the source of truth. Reasoning effort is configured manually by the user in ChatGPT; the sidecar does not change it.'
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
      const value = await dispatchTool(conversationHost, workLedger, workController, memoryPool, name, message.params?.arguments ?? {})
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

export function createSidecarServer({ conversationHost, workLedger = null, workController = null, memoryPool = null }) {
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
      const result = await handleRpc(conversationHost, workLedger, workController, memoryPool, message)
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
  const workLedger = new WorkLedger(fileURLToPath(new URL('../data/works/', import.meta.url)))
  const workController = new WorkController({ ledger: workLedger, conversationHost })
  const memoryPool = new MemoryPool({ rootDir: fileURLToPath(new URL('../data/memory/', import.meta.url)), workLedger })
  const app = createSidecarServer({ conversationHost, workLedger, workController, memoryPool })
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
