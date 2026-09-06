import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const files = readdirSync(new URL('../test/', import.meta.url))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => new URL(`../test/${name}`, import.meta.url))
const { fileURLToPath } = await import('node:url')
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files.map(fileURLToPath)], { stdio: 'inherit' })
if (result.error) console.error(result.error.message)
process.exitCode = result.status ?? 1
