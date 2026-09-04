#!/usr/bin/env node
import { fileURLToPath } from 'node:url'

const DEFAULT_MCP_URL = 'http://127.0.0.1:7337/mcp'

function parseJson(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    throw new TypeError('invalid JSON')
  }
}

function usage() {
  return [
    'conversation-work create <goal...>',
    'conversation-work append <work_id> <type> <payload_json>',
    'conversation-work state <work_id>',
    'conversation-work decide <work_id> <decision_json>',
    'conversation-work checkpoint <work_id> <checkpoint_json>',
    'conversation-work dispatch <work_id> <frontier_id>',
    'conversation-work collect <work_id>',
    'conversation-work read <work_id>',
    'conversation-work memory-publish <source_work_id>',
    'conversation-work memory-query <work_id> <query_json>',
    'conversation-work memory-read <work_id> <retrieval_id> <memory_id>'
  ].join('\n')
}

function commandToCall(argv) {
  const [command, ...args] = argv
  if (!command || command === 'help' || command === '--help' || command === '-h') return null

  if (command === 'create') {
    const goal = args.join(' ').trim()
    if (!goal) throw new TypeError('create requires goal')
    return ['work_create', { goal }]
  }
  if (command === 'append') {
    const [workId, type, payload] = args
    if (args.length !== 3 || !workId || !type || payload === undefined) throw new TypeError('append requires work_id, type and payload_json')
    return ['work_append', { work_id: workId, type, payload: parseJson(payload) }]
  }
  if (command === 'state') {
    if (args.length !== 1 || !args[0]?.trim()) throw new TypeError('state requires work_id')
    return ['work_state', { work_id: args[0] }]
  }
  if (command === 'decide') {
    const [workId, decision] = args
    if (args.length !== 2 || !workId || decision === undefined) throw new TypeError('decide requires work_id and decision_json')
    return ['work_decide', { work_id: workId, decision: parseJson(decision) }]
  }
  if (command === 'checkpoint') {
    const [workId, checkpointRaw] = args
    if (args.length !== 2 || !workId?.trim() || checkpointRaw === undefined) {
      throw new TypeError('checkpoint requires work_id and checkpoint_json')
    }
    const checkpoint = parseJson(checkpointRaw)
    if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) {
      throw new TypeError('checkpoint requires checkpoint_json object')
    }
    const allowed = new Set(['based_on_event_count', 'evidence_event_indexes', 'decision'])
    const unsupported = Object.keys(checkpoint).find((key) => !allowed.has(key))
    if (unsupported) throw new TypeError(`unsupported checkpoint field: ${unsupported}`)
    return ['work_checkpoint', { work_id: workId, ...checkpoint }]
  }
  if (command === 'dispatch') {
    if (args.length !== 2 || !args[0]?.trim() || !args[1]?.trim()) throw new TypeError('dispatch requires work_id and frontier_id')
    return ['work_dispatch', { work_id: args[0], frontier_id: args[1] }]
  }
  if (command === 'collect') {
    if (args.length !== 1 || !args[0]?.trim()) throw new TypeError('collect requires work_id')
    return ['work_collect', { work_id: args[0] }]
  }
  if (command === 'read') {
    if (args.length !== 1 || !args[0]?.trim()) throw new TypeError('read requires work_id')
    return ['work_read', { work_id: args[0] }]
  }
  if (command === 'memory-publish') {
    if (args.length !== 1 || !args[0]?.trim()) throw new TypeError('memory-publish requires source_work_id')
    return ['work_memory_publish', { source_work_id: args[0] }]
  }
  if (command === 'memory-query') {
    if (args.length !== 2 || !args[0]?.trim()) throw new TypeError('memory-query requires work_id and query_json')
    const query = parseJson(args[1])
    if (!query || typeof query !== 'object' || Array.isArray(query)) throw new TypeError('memory-query requires query_json object')
    const unsupported = Object.keys(query).find((key) => key !== 'contains')
    if (unsupported) throw new TypeError(`unsupported memory query field: ${unsupported}`)
    return ['work_memory_query', { work_id: args[0], ...query }]
  }
  if (command === 'memory-read') {
    if (args.length !== 3 || args.some((value) => !value?.trim())) {
      throw new TypeError('memory-read requires work_id, retrieval_id, and memory_id')
    }
    return ['work_memory_read', { work_id: args[0], retrieval_id: args[1], memory_id: args[2] }]
  }

  throw new TypeError(`unknown command: ${command}`)
}

async function callTool(fetchImpl, url, name, args) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args }
    })
  })
  const body = await response.json()
  if (body.error) throw new Error(body.error.message ?? 'sidecar MCP error')
  const result = body.result
  if (result?.isError) throw new Error(result.content?.[0]?.text ?? 'sidecar tool error')
  const text = result?.content?.[0]?.text
  if (typeof text !== 'string') return result
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export async function runCli(argv, {
  fetchImpl = fetch,
  url = process.env.CONVERSATION_SIDECAR_MCP_URL ?? DEFAULT_MCP_URL,
  write = () => {}
} = {}) {
  const call = commandToCall(argv)
  if (!call) {
    write(usage())
    return { help: true }
  }
  const [name, args] = call
  const result = await callTool(fetchImpl, url, name, args)
  write(JSON.stringify(result))
  return result
}

async function main() {
  try {
    await runCli(process.argv.slice(2), { write: (value) => process.stdout.write(`${value}\n`) })
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main()
}
