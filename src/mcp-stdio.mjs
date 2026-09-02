#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const DEFAULT_ENDPOINT = 'http://127.0.0.1:7337/mcp'

function transportError(message, error) {
  if (message?.id === undefined || message?.id === null) return null
  return {
    jsonrpc: '2.0',
    id: message.id,
    error: {
      code: -32000,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

async function forward(message, endpoint, fetchImpl) {
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message)
  })
  if (response.status === 204) return null
  const raw = await response.text()
  if (!response.ok) {
    throw new Error(`Local MCP returned HTTP ${response.status}${raw ? `: ${raw}` : ''}`)
  }
  return JSON.parse(raw)
}

export async function runStdioAdapter({
  input = process.stdin,
  output = process.stdout,
  endpoint = process.env.CONVERSATION_SIDECAR_MCP_URL ?? DEFAULT_ENDPOINT,
  fetchImpl = fetch
} = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.trim()) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`)
      continue
    }

    try {
      const response = await forward(message, endpoint, fetchImpl)
      if (response !== null) output.write(`${JSON.stringify(response)}\n`)
    } catch (error) {
      const response = transportError(message, error)
      if (response !== null) output.write(`${JSON.stringify(response)}\n`)
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runStdioAdapter().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error))
    process.exitCode = 1
  })
}
