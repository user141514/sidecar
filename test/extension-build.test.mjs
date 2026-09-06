import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { extensionBuild, checkedExtensionBuild, extensionFiles, buildInfoSource } from '../scripts/extension-build.mjs'

test('extension build identity is unchanged by Windows CRLF checkout conversion', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'extension-build-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const expected = await checkedExtensionBuild()
  for (const file of extensionFiles) {
    const original = await readFile(new URL(`../extension/${file}`, import.meta.url), 'utf8')
    await writeFile(join(root, file), original.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'))
  }
  assert.deepEqual(await extensionBuild(root), expected)
})

test('disk source changes invalidate prepared metadata rather than silently claiming the new build is loaded', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'extension-stale-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const file of extensionFiles) await writeFile(join(root, file), await readFile(new URL(`../extension/${file}`, import.meta.url)))
  const before = await extensionBuild(root)
  await writeFile(join(root, 'build-info.js'), buildInfoSource(before.buildId))
  await writeFile(join(root, 'lifecycle.js'), '// deliberately changed candidate\n')
  await assert.rejects(checkedExtensionBuild(root), /stale/)
  assert.notEqual((await extensionBuild(root)).buildId, before.buildId)
})
