import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { aggregateHashes, normalizedSha256 } from './verify-provider.mjs'

export async function verifyRuntime(directory = '.') {
  const root = resolve(directory)
  let provenance
  try {
    provenance = JSON.parse(await readFile(join(root, 'PROVENANCE.json'), 'utf8'))
  } catch (error) {
    throw new Error(`Runtime provenance unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!provenance || provenance.source !== 'conversation-sidecar full agent runtime export') {
    throw new Error('Runtime provenance source is invalid')
  }
  if (typeof provenance.fileHashes !== 'object' || provenance.fileHashes === null || Array.isArray(provenance.fileHashes)) {
    throw new Error('Runtime provenance does not contain file hashes')
  }

  const actual = {}
  for (const [path, expected] of Object.entries(provenance.fileHashes)) {
    let content
    try {
      content = await readFile(join(root, path))
    } catch {
      throw new Error(`Runtime drift: missing ${path}`)
    }
    const digest = normalizedSha256(content)
    if (digest !== expected) throw new Error(`Runtime drift: hash mismatch for ${path}`)
    actual[path] = digest
  }

  const aggregate = aggregateHashes(actual)
  if (aggregate !== provenance.sourceContentHash) throw new Error('Runtime provenance aggregate hash mismatch')
  return {
    verified: true,
    sourceRevision: provenance.sourceRevision,
    sourceDirty: provenance.sourceDirty === true,
    sourceContentHash: aggregate,
    fileCount: Object.keys(actual).length
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyRuntime(process.argv[2] ?? '.')
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
