#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { startProvider, createProviderServer } from './provider-server.mjs'

export const createServer = createProviderServer
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startProvider().catch((error) => {
    console.error(error.stack ?? String(error))
    process.exitCode = 1
  })
}
