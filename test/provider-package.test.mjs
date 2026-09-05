import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, access } from 'node:fs/promises'
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
  await assert.rejects(module.exportProvider(output), /exist|empty/i)
})
