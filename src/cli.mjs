#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DEFAULT_EXTENSION_REQUEST_TIMEOUT_MS } from './native-messaging.mjs'
import { DEFAULT_EXTENSION_UPDATE_TIMEOUT_MS, updateExtension } from './extension-control.mjs'
import { checkedExtensionBuild } from '../scripts/extension-build.mjs'
import { validateRetirementRequest } from './pending-retirement.mjs'

const DEFAULT_MCP_URL = 'http://127.0.0.1:7337/mcp'
function usage() {
  return [
    'chatgpt-conversation project-create <name...>',
    'chatgpt-conversation project-find <name...>',
    'chatgpt-conversation project-pin <project_url>',
    'chatgpt-conversation create [--project <project_url>] [--mode <chat|work>]',
    'chatgpt-conversation send <conversation_id> [--app <app_name>] [--request-id <id>] <prompt...>',
    'chatgpt-conversation read <conversation_id>',
    'chatgpt-conversation extension-status',
    'chatgpt-conversation extension-pending-inspect <conversation_id> <request_id>',
    'chatgpt-conversation extension-pending-retire <conversation_id> <request_id> --operation-id <uuid> --expected-instance-id <uuid> --expected-build-id <sha256> --pending-digest <sha256> [--reason <closed_target_after_quiesce|closed_manual_owner_after_quiesce>]',
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
    const fields = { '--project': 'project_url', '--mode': 'mode' }
    const payload = {}
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index]
      if (!Object.hasOwn(fields, flag)) throw new TypeError('create accepts only --project <project_url> and --mode <chat|work>')
      const field = fields[flag]
      if (Object.hasOwn(payload, field)) throw new TypeError(`create ${flag} cannot be repeated`)
      const value = args[index + 1]?.trim()
      if (!value || value.startsWith('--')) throw new TypeError(`create ${flag} requires ${field}`)
      if (field === 'mode' && !['chat', 'work'].includes(value)) throw new TypeError('create --mode requires chat or work')
      payload[field] = value
    }
    return ['conversation_create', payload]
  }
  if (command === 'send') {
    const [conversationId, ...rest] = args
    if (!conversationId?.trim()) throw new TypeError('send requires conversation_id and text')
    let app
    let requestId
    const textParts = []
    for (let index = 0; index < rest.length; index += 1) {
      const value = rest[index]
      if (value === '--app') {
        const next = rest[index + 1]
        if (!next?.trim()) throw new TypeError('send --app requires app_name')
        app = next.trim()
        index += 1
        continue
      }
      if (value === '--request-id') {
        const next = rest[index + 1]
        if (!next?.trim()) throw new TypeError('send --request-id requires id')
        requestId = next.trim()
        index += 1
        continue
      }
      textParts.push(value)
    }
    const text = textParts.join(' ').trim()
    if (!text) throw new TypeError('send requires conversation_id and text')
    return ['conversation_send', {
      conversation_id: conversationId,
      text,
      ...(app ? { app } : {}),
      ...(requestId ? { request_id: requestId } : {})
    }]
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

async function callTool(fetchImpl, url, name, args, timeoutMs = DEFAULT_EXTENSION_REQUEST_TIMEOUT_MS + 10_000) {
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
  write = () => {},
  checkedExtensionBuildImpl = checkedExtensionBuild,
  updateExtensionImpl = updateExtension
} = {}) {
  let result
  if (['extension-pending-inspect', 'extension-pending-retire'].includes(argv[0])) {
    const retire = argv[0] === 'extension-pending-retire'
    const [conversationId, requestId, ...args] = argv.slice(1)
    const payload = { conversationId, requestId }
    const flags = { '--operation-id': 'operationId', '--expected-instance-id': 'expectedInstanceId',
      '--expected-build-id': 'expectedBuildId', '--pending-digest': 'expectedPendingDigest', '--reason': 'reason' }
    if (!retire && args.length) throw new TypeError('inspection accepts only conversation_id and request_id')
    if (retire) {
      if (![8, 10].includes(args.length)) throw new TypeError('retirement requires all four snapshot flags and optional --reason')
      for (let index = 0; index < args.length; index += 2) {
        const key = flags[args[index]]
        if (!key || Object.hasOwn(payload, key) || !args[index + 1]) throw new TypeError('unknown or duplicate retirement flag')
        payload[key] = args[index + 1]
      }
      payload.reason ??= 'closed_target_after_quiesce'
    }
    validateRetirementRequest(payload, retire)
    const endpoint = new URL(url)
    if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
        endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Pending retirement requires the local HTTP MCP endpoint')
    endpoint.pathname = retire ? '/internal/pending-retire' : '/internal/pending-retirement-inspect'
    const response = await fetchImpl(endpoint.href, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(DEFAULT_EXTENSION_REQUEST_TIMEOUT_MS + 10_000),
      body: JSON.stringify(payload) })
    result = await response.json()
    if (response.ok === false || result?.accepted === false) throw new Error(result?.reason ?? `Retirement HTTP ${response.status}`)
  } else if (['extension-update', 'extension-reload'].includes(argv[0])) {
    const args = argv.slice(1)
    if (args.length && (args.length !== 2 || args[0] !== '--timeout-ms' || !/^\d+$/.test(args[1]))) throw new TypeError('extension-update accepts only --timeout-ms <100..300000>')
    const timeoutMs = args.length ? Number(args[1]) : DEFAULT_EXTENSION_UPDATE_TIMEOUT_MS
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) throw new TypeError('timeout-ms must be between 100 and 300000')
    const endpoint = new URL(url)
    if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password) throw new Error('Extension update requires the local HTTP MCP endpoint')
    const build = await checkedExtensionBuildImpl()
    result = await updateExtensionImpl((name, params, budget) => callTool(fetchImpl, url, name, params, budget), { expectedBuildId: build.buildId, expectedExtensionId: build.extensionId, timeoutMs })
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
