#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { updateExtension } from './extension-control.mjs'
import { checkedExtensionBuild } from '../scripts/extension-build.mjs'

const DEFAULT_MCP_URL = 'http://127.0.0.1:7337/mcp'
function usage() {
  return [
    'chatgpt-conversation project-create <name...>',
    'chatgpt-conversation project-find <name...>',
    'chatgpt-conversation project-pin <project_url>',
    'chatgpt-conversation create [--project <project_url>]',
    'chatgpt-conversation send <conversation_id> <prompt...>',
    'chatgpt-conversation read <conversation_id>',
    'chatgpt-conversation extension-status',
    'chatgpt-conversation extension-update [--timeout-ms <100..300000>]',
    'chatgpt-conversation extension-reload [--timeout-ms <100..300000>]'
  ].join('\n')
}

function commandToCall(argv) {
  const [command, ...args] = argv
  if (!command || ['help', '--help', '-h'].includes(command)) return null
  if (command === 'project-create' || command === 'project-find') {
    const name = args.join(' ').trim()
    if (!name) throw new TypeError(`${command} requires name`)
    return [command === 'project-create' ? 'project_create' : 'project_find', { name }]
  }
  if (command === 'project-pin') {
    if (args.length !== 1 || !args[0].trim()) throw new TypeError('project-pin requires project_url')
    return ['project_pin', { project_url: args[0].trim() }]
  }
  if (command === 'create') {
    if (!args.length) return ['conversation_create', {}]
    if (args.length === 2 && args[0] === '--project' && args[1].trim()) return ['conversation_create', { project_url: args[1].trim() }]
    throw new TypeError(args[0] === '--project' ? 'create --project requires project_url' : 'create accepts only --project <project_url>')
  }
  if (command === 'send') {
    const [conversationId, ...textParts] = args
    const text = textParts.join(' ').trim()
    if (!conversationId?.trim() || !text) throw new TypeError('send requires conversation_id and text')
    return ['conversation_send', { conversation_id: conversationId, text }]
  }
  if (command === 'read') {
    if (args.length !== 1 || !args[0].trim()) throw new TypeError('read requires conversation_id')
    return ['conversation_read', { conversation_id: args[0] }]
  }
  if (command === 'extension-status') {
    if (args.length) throw new TypeError('extension-status accepts no arguments')
    return ['extension_status', {}]
  }
  throw new TypeError(`unknown command: ${command}`)
}

async function callTool(fetchImpl, url, name, args, timeoutMs = 30_000) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  })
  if (response.ok === false) throw new Error(`MCP HTTP ${response.status}`)
  const body = await response.json()
  if (body.error || body.result?.isError) {
    const error = new Error(body.error?.message ?? body.result?.content?.[0]?.text ?? 'Provider tool error')
    error.code = 'TOOL_ERROR'
    throw error
  }
  const text = body.result?.content?.[0]?.text
  if (typeof text !== 'string') return body.result
  try { return JSON.parse(text) } catch { return text }
}

export async function runCli(argv, {
  fetchImpl = fetch,
  url = process.env.CHATGPT_CONVERSATION_MCP_URL ?? process.env.CONVERSATION_SIDECAR_MCP_URL ?? DEFAULT_MCP_URL,
  write = () => {}
} = {}) {
  let result
  if (['extension-update', 'extension-reload'].includes(argv[0])) {
    const args = argv.slice(1)
    if (args.length && (args.length !== 2 || args[0] !== '--timeout-ms' || !/^\d+$/.test(args[1]))) throw new TypeError('extension-update accepts only --timeout-ms <100..300000>')
    const timeoutMs = args.length ? Number(args[1]) : 30_000
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) throw new TypeError('timeout-ms must be between 100 and 300000')
    const endpoint = new URL(url)
    if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password) throw new Error('Extension update requires the local HTTP MCP endpoint')
    const build = await checkedExtensionBuild()
    result = await updateExtension((name, params, budget) => callTool(fetchImpl, url, name, params, budget), { expectedBuildId: build.buildId, expectedExtensionId: build.extensionId, timeoutMs })
  } else {
    const call = commandToCall(argv)
    if (!call) { write(usage()); return { help: true } }
    result = await callTool(fetchImpl, url, ...call)
  }
  write(JSON.stringify(result))
  return result
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2), { write: (value) => process.stdout.write(`${value}\n`) }).catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
