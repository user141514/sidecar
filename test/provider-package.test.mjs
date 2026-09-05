import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('standalone artifact contains the identical extension, CLI, MCP schemas, Skill and platform links', async (t) => {
  const module = await import('../scripts/export-provider.mjs').catch(() => ({}))
  assert.equal(typeof module.exportProvider, 'function', 'standalone export must exist')
  const root = await mkdtemp(join(tmpdir(), 'provider bundle '))
  t.after(() => rm(root, { recursive: true, force: true }))
  const output = join(root, 'provider')
  await module.exportProvider(output)
  for (const path of ['extension/manifest.json', 'extension/build-info.js', 'extension/service-worker.js', 'extension/content-script.js', 'extension/lifecycle.js', 'src/cli.mjs', 'src/extension-control.mjs', 'src/conversation-tools.mjs', 'skills/chatgpt-subagents/SKILL.md', 'install/platform-link.mjs']) {
    assert.equal(await readFile(join(output, path), 'utf8'), await readFile(new URL(`../${path}`, import.meta.url), 'utf8'), path)
  }
  for (const path of ['src/work-controller.mjs', 'src/memory-pool.mjs', 'data', '.git']) await assert.rejects(access(join(output, path)))
  const pkg = JSON.parse(await readFile(join(output, 'package.json'), 'utf8'))
  assert.equal(pkg.bin['chatgpt-conversation'], 'src/cli.mjs')
  assert.equal(pkg.scripts['install:host'], 'node install/install-host.mjs')
  assert.equal(pkg.scripts['verify:provider'], 'node scripts/verify-provider.mjs')

  const provenance = JSON.parse(await readFile(join(output, 'PROVENANCE.json'), 'utf8'))
  assert.match(provenance.sourceRevision, /^[0-9a-f]{40}$/)
  assert.match(provenance.sourceContentHash, /^[0-9a-f]{64}$/)
  assert.equal(typeof provenance.fileHashes, 'object')
  assert.match(provenance.fileHashes['extension/service-worker.js'], /^[0-9a-f]{64}$/)
  assert.match(provenance.fileHashes['src/cli.mjs'], /^[0-9a-f]{64}$/)

  const verifier = await import('../scripts/verify-provider.mjs').catch(() => ({}))
  assert.equal(typeof verifier.verifyProvider, 'function', 'standalone provenance verifier must exist')
  assert.equal((await verifier.verifyProvider(output)).verified, true)
  await writeFile(join(output, 'src/cli.mjs'), `${await readFile(join(output, 'src/cli.mjs'), 'utf8')}\n// drift\n`)
  await assert.rejects(verifier.verifyProvider(output), /provenance|hash|drift/i)

  const workflow = await readFile(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8')
  assert.match(workflow, /runner\.os\s*==\s*'Windows'/)
  assert.match(workflow, /test\/native-host-installer\.test\.mjs\s+test\/windows-runtime\.test\.mjs/)

  await assert.rejects(module.exportProvider(output), /exist|empty/i)
})
