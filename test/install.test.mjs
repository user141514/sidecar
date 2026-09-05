import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// A real registry write is not a safe portable unit test. Windows registration
// arguments and manifest behavior are covered by native-host-installer.test.mjs.
test('legacy native-host installer uses shared registration without touching the real user profile', { skip: process.platform !== 'linux' }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'chatgpt-conversation-home-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const root = fileURLToPath(new URL('../', import.meta.url))
  const script = join(root, 'scripts', 'install-native-host.mjs')
  const result = spawnSync(process.execPath, [script], { cwd: root, env: { ...process.env, HOME: home }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const manifestPath = join(home, '.config', 'google-chrome', 'NativeMessagingHosts', 'com.conversation_sidecar.host.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.equal(manifest.name, 'com.conversation_sidecar.host')
  assert.equal(manifest.path, join(root, 'install', 'conversation-sidecar-host'))
  assert.deepEqual(manifest.allowed_origins, ['chrome-extension://cfifihieaffhniimpimnfmignbbdaalb/'])
  assert.equal(result.stdout.trim(), manifestPath)
})
