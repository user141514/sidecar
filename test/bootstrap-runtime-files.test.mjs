import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrapRuntime, installStableExtension } from '../scripts/bootstrap-runtime.mjs'
import { verifyRuntime } from '../scripts/verify-runtime.mjs'

const projectUrl = 'https://chatgpt.com/g/g-p-subagents-bootstrap/project'
const sourceRoot = fileURLToPath(new URL('../', import.meta.url))

test('real Windows bootstrap prepares a disposable Runtime Home without changing external registration', async (t) => {
  const runtimeHome = await mkdtemp(join(tmpdir(), 'conversation-sidecar-runtime-home-'))
  t.after(() => rm(runtimeHome, { recursive: true, force: true }))
  let registrationWrites = 0
  let userInstallWrites = 0

  const result = await bootstrapRuntime({
    runtimeHome,
    managedProjectUrl: projectUrl,
    activate: false
  }, {
    readActiveRegistration: async () => ({
      manifestPath: 'C:\\KnownGood\\com.conversation_sidecar.host.json',
      hostPath: 'C:\\KnownGood\\conversation-sidecar-host.bat',
      dataRoot: null
    }),
    installNativeHost: async () => {
      registrationWrites += 1
      throw new Error('external registration must not be changed')
    },
    installRuntimeUserEntrypoints: async ({ dryRun }) => {
      if (!dryRun) userInstallWrites += 1
      return {
        status: dryRun ? 'ready' : 'installed',
        commandDir: 'C:\\Users\\14579\\AppData\\Roaming\\npm',
        skillDir: 'C:\\Users\\14579\\.agents\\skills\\chatgpt-subagents',
        pathReady: true
      }
    }
  })

  assert.equal(result.ok, true)
  assert.equal(result.state, 'ready')
  assert.equal(result.activation.status, 'prepared_not_activated')
  assert.equal(registrationWrites, 0)
  assert.equal(userInstallWrites, 0)
  assert.equal(result.userInstall.status, 'deferred_activation')
  assert.equal(result.managedProject.url, projectUrl)

  const config = JSON.parse(await readFile(join(runtimeHome, 'runtime.json'), 'utf8'))
  assert.equal(config.state, 'ready')
  assert.equal(config.current_release, result.sourceRevision)
  assert.equal(config.data_root, join(runtimeHome, 'data'))
  assert.equal(config.managed_project.url, projectUrl)

  for (const path of [
    join(runtimeHome, 'bin', 'native-host.mjs'),
    join(runtimeHome, 'bin', 'chatgpt-conversation.cmd'),
    join(runtimeHome, 'bin', 'conversation-work.cmd'),
    join(runtimeHome, 'data', 'conversations'),
    join(runtimeHome, 'data', 'works'),
    join(runtimeHome, 'data', 'memory'),
    join(runtimeHome, 'releases', result.sourceRevision, 'PROVENANCE.json')
  ]) await access(path)

  const verified = await verifyRuntime(join(runtimeHome, 'releases', result.sourceRevision))
  assert.equal(verified.verified, true)
  assert.equal(verified.sourceRevision, result.sourceRevision)
  assert.equal(verified.sourceDirty, false)
})

test('stable extension publishing copies the verified extension once and is idempotent for the same build', async (t) => {
  const runtimeHome = await mkdtemp(join(tmpdir(), 'conversation-sidecar-extension-home-'))
  t.after(() => rm(runtimeHome, { recursive: true, force: true }))
  let nonce = 0

  const first = await installStableExtension({
    runtimeHome,
    releaseDir: sourceRoot,
    platform: process.platform,
    randomId: () => `stable-extension-${++nonce}`
  })
  assert.equal(first.changed, true)
  assert.equal(first.extensionPath, join(runtimeHome, 'extension-current'))
  assert.equal(
    await readFile(join(runtimeHome, 'extension-current', 'build-info.js'), 'utf8'),
    await readFile(join(sourceRoot, 'extension', 'build-info.js'), 'utf8')
  )

  const second = await installStableExtension({
    runtimeHome,
    releaseDir: sourceRoot,
    platform: process.platform,
    randomId: () => `stable-extension-${++nonce}`
  })
  assert.equal(second.changed, false)
})
