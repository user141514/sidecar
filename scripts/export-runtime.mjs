import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { providerFiles } from './export-provider.mjs'
import { checkedExtensionBuild } from './extension-build.mjs'
import { aggregateHashes, normalizedSha256 } from './verify-provider.mjs'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))

export const runtimeFiles = [...new Set([
  ...providerFiles,
  'src/server.mjs',
  'src/work-ledger.mjs',
  'src/work-controller.mjs',
  'src/work-cli.mjs',
  'src/memory-pool.mjs',
  'scripts/verify-runtime.mjs',
  'test/work-ledger.test.mjs',
  'test/work-controller.test.mjs',
  'test/work-cli.test.mjs',
  'test/memory-pool.test.mjs',
  'test/server.test.mjs'
])]

async function sourceProvenance() {
  const git = async (...args) => (await execFileAsync('git', args, { cwd: root, encoding: 'utf8' })).stdout.trim()
  const sourceRevision = await git('rev-parse', 'HEAD')
  let sourceRepository = null
  try {
    sourceRepository = await git('remote', 'get-url', 'origin')
  } catch {}
  const status = await git(
    'status', '--porcelain', '--', ...runtimeFiles,
    'standalone/LICENSE', 'docs/extension-update.md', 'package.json'
  )
  return { sourceRevision, sourceRepository, sourceDirty: Boolean(status) }
}

async function fileHashes(rootDir, paths) {
  const hashes = {}
  for (const path of paths) hashes[path] = normalizedSha256(await readFile(join(rootDir, path)))
  return hashes
}

export async function exportRuntime(destination) {
  const build = await checkedExtensionBuild()
  const source = await sourceProvenance()
  const output = resolve(destination)
  if (output === resolve(root)) throw new Error('Runtime export requires a new empty directory, not the source checkout')
  await mkdir(output)

  for (const file of runtimeFiles) {
    const target = join(output, file)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(join(root, file), target)
  }

  await copyFile(join(root, 'standalone/LICENSE'), join(output, 'LICENSE'))
  await copyFile(join(root, 'docs/extension-update.md'), join(output, 'README.md'))
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  pkg.name = 'conversation-sidecar-agent-runtime'
  delete pkg.scripts['build:provider']
  delete pkg.scripts['build:runtime']
  delete pkg.scripts['verify:provider']
  pkg.scripts['verify:runtime'] = 'node scripts/verify-runtime.mjs'
  await writeFile(join(output, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  await writeFile(join(output, '.gitignore'), 'node_modules/\ndata/\n*.log\n')

  const artifactFiles = [...new Set([
    ...runtimeFiles,
    'LICENSE',
    'README.md',
    'package.json',
    '.gitignore'
  ])].sort()
  const hashes = await fileHashes(output, artifactFiles)
  const sourceContentHash = aggregateHashes(hashes)
  await writeFile(join(output, 'PROVENANCE.json'), `${JSON.stringify({
    source: 'conversation-sidecar full agent runtime export',
    ...source,
    ...build,
    sourceContentHash,
    fileHashes: hashes,
    files: artifactFiles
  }, null, 2)}\n`)

  return { output, ...build, ...source, sourceContentHash, fileCount: artifactFiles.length + 1 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) throw new Error('Usage: node scripts/export-runtime.mjs [new-output-directory]')
  const output = process.argv[2] ?? join(root, 'dist', 'agent-runtime')
  await mkdir(dirname(output), { recursive: true })
  console.log(JSON.stringify(await exportRuntime(output)))
}
