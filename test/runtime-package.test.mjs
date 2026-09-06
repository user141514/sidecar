import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('full runtime artifact contains scheduler and memory while remaining independently verifiable', async (t) => {
  const exporter = await import('../scripts/export-runtime.mjs').catch(() => ({}))
  const verifier = await import('../scripts/verify-runtime.mjs').catch(() => ({}))
  assert.equal(typeof exporter.exportRuntime, 'function', 'runtime export must exist')
  assert.equal(typeof verifier.verifyRuntime, 'function', 'runtime verifier must exist')
  if (typeof exporter.exportRuntime !== 'function' || typeof verifier.verifyRuntime !== 'function') return

  const root = await mkdtemp(join(tmpdir(), 'agent runtime bundle '))
  t.after(() => rm(root, { recursive: true, force: true }))
  const output = join(root, 'runtime')

  const exported = await exporter.exportRuntime(output)
  assert.equal(exported.output, output)

  for (const path of [
    'src/server.mjs',
    'src/work-ledger.mjs',
    'src/work-controller.mjs',
    'src/work-cli.mjs',
    'src/memory-pool.mjs',
    'src/chatgpt.mjs',
    'extension/manifest.json',
    'install/platform-link.mjs',
    'skills/chatgpt-subagents/SKILL.md'
  ]) {
    await access(join(output, path))
  }

  for (const path of ['data', '.git']) await assert.rejects(access(join(output, path)))

  const pkg = JSON.parse(await readFile(join(output, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts['verify:runtime'], 'node scripts/verify-runtime.mjs')
  assert.equal(pkg.scripts.bootstrap, undefined)

  const provenance = JSON.parse(await readFile(join(output, 'PROVENANCE.json'), 'utf8'))
  assert.equal(provenance.source, 'conversation-sidecar full agent runtime export')
  assert.match(provenance.sourceRevision, /^[0-9a-f]{40}$/)
  assert.match(provenance.sourceContentHash, /^[0-9a-f]{64}$/)
  assert.match(provenance.fileHashes['src/work-controller.mjs'], /^[0-9a-f]{64}$/)
  assert.match(provenance.fileHashes['src/memory-pool.mjs'], /^[0-9a-f]{64}$/)

  const verified = await verifier.verifyRuntime(output)
  assert.equal(verified.verified, true)
  assert.equal(verified.sourceRevision, provenance.sourceRevision)
  assert.equal(verified.sourceContentHash, provenance.sourceContentHash)

  await writeFile(
    join(output, 'src/work-controller.mjs'),
    `${await readFile(join(output, 'src/work-controller.mjs'), 'utf8')}\n// runtime drift\n`
  )
  await assert.rejects(verifier.verifyRuntime(output), /runtime drift|hash mismatch/i)
  await assert.rejects(exporter.exportRuntime(output), /exist|empty/i)
})
