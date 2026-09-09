#!/usr/bin/env node

import { loadDecisionReplayDirectory } from '../src/decision-replay.mjs'

const args = process.argv.slice(2)
if (args.length !== 1 || !args[0]?.trim()) {
  process.stderr.write('usage: export-decision-replay <work-ledger-root>\n')
  process.exitCode = 2
} else {
  try {
    const dataset = await loadDecisionReplayDirectory(args[0])
    if (dataset.length > 0) {
      process.stdout.write(`${dataset.map((record) => JSON.stringify(record)).join('\n')}\n`)
    }
  } catch (error) {
    process.stderr.write(`${error?.message ?? String(error)}\n`)
    process.exitCode = 1
  }
}
