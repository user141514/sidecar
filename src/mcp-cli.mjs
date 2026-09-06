#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { McpHttpClient } from './mcp-client.mjs'

function usage() {
  return 'Usage: mcp-cli.mjs tools | project-pin <project-url> | create [project-url] | send <conversation-id> [--app <app-name>] <text> | read <conversation-id>'
}

function parseSendArgs(args) {
  if (args.length < 2) throw new TypeError(usage())
  const [conversationId, ...rest] = args
  let app
  let textParts = rest
  if (rest[0] === '--app') {
    if (rest.length < 3 || !rest[1]) throw new TypeError(usage())
    app = rest[1]
    textParts = rest.slice(2)
  }
  return { conversationId, text: textParts.join(' '), app }
}

export async function run(argv = process.argv.slice(2), client = new McpHttpClient()) {
  const [command, ...args] = argv
  let result
  if (command === 'tools' && args.length === 0) result = await client.toolsList()
  else if (command === 'project-pin' && args.length === 1) result = await client.projectPin(args[0])
  else if (command === 'create' && args.length <= 1) result = await client.conversationCreate(args[0])
  else if (command === 'send' && args.length >= 2) {
    const { conversationId, text, app } = parseSendArgs(args)
    result = await client.conversationSend(conversationId, text, { app })
  }
  else if (command === 'read' && args.length === 1) result = await client.conversationRead(args[0])
  else throw new TypeError(usage())
  return result
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    }
  )
}
