import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function normalizedSha256(content) {
  const normalized = Buffer.isBuffer(content)
    ? content.toString('utf8').replace(/\r\n/g, '\n')
    : String(content).replace(/\r\n/g, '\n')
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

export function aggregateHashes(fileHashes) {
  const hash = createHash('sha256')
  for (const path of Object.keys(fileHashes).sort()) hash.update(`${path}\0${fileHashes[path]}\0`)
  return hash.digest('hex')
}

export async function verifyProvider(directory = '.') {
  const root = resolve(directory)
  let provenance
  try {
    provenance = JSON.parse(await readFile(join(root, 'PROVENANCE.json'), 'utf8'))
  } catch (error) {
    throw new Error(`Provider provenance unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!provenance || typeof provenance.fileHashes !== 'object' || Array.isArray(provenance.fileHashes)) {
    throw new Error('Provider provenance does not contain file hashes')
  }
  const actual = {}
  for (const [path, expected] of Object.entries(provenance.fileHashes)) {
    let content
    try { content = await readFile(join(root, path)) }
    catch { throw new Error(`Provider drift: missing ${path}`) }
    const digest = normalizedSha256(content)
    if (digest !== expected) throw new Error(`Provider drift: hash mismatch for ${path}`)
    actual[path] = digest
  }
  const aggregate = aggregateHashes(actual)
  if (aggregate !== provenance.sourceContentHash) throw new Error('Provider provenance aggregate hash mismatch')
  return {
    verified: true,
    sourceRevision: provenance.sourceRevision,
    sourceDirty: provenance.sourceDirty === true,
    sourceContentHash: aggregate,
    fileCount: Object.keys(actual).length
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyProvider(process.argv[2] ?? '.')
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
