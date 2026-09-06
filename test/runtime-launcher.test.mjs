import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function loadModule() {
  try {
    return await import('../install/runtime-launcher.mjs')
  } catch {
    return {}
  }
}

const release = 'b'.repeat(40)
const projectUrl = 'https://chatgpt.com/g/g-p-subagents-test/project'

function config(runtimeHome, state = 'prepared') {
  return {
    schema_version: 1,
    state,
    current_release: release,
    current_release_dir: join(runtimeHome, 'releases', release),
    data_root: join(runtimeHome, 'data'),
    managed_project: state === 'ready' ? { name: 'subagents', url: projectUrl } : null,
    extension: { id: 'cfifihieaffhniimpimnfmignbbdaalb' }
  }
}

test('launcher environment always sets stable data root and only exposes managed Project when ready', async () => {
  const { runtimeLauncherEnvironment } = await loadModule()
  assert.equal(typeof runtimeLauncherEnvironment, 'function')
  if (typeof runtimeLauncherEnvironment !== 'function') return

  const runtimeHome = 'C:\\Users\\14579\\AppData\\Local\\Conversation Sidecar'
  const prepared = {
    schema_version: 1,
    state: 'prepared',
    current_release: release,
    current_release_dir: `${runtimeHome}\\releases\\${release}`,
    data_root: `${runtimeHome}\\data`,
    managed_project: null,
    extension: { id: 'cfifihieaffhniimpimnfmignbbdaalb' }
  }
  assert.deepEqual(runtimeLauncherEnvironment(prepared), {
    SIDECAR_DATA_ROOT: `${runtimeHome}\\data`
  })

  assert.deepEqual(runtimeLauncherEnvironment({
    ...prepared,
    state: 'ready',
    managed_project: { name: 'subagents', url: projectUrl }
  }), {
    SIDECAR_DATA_ROOT: `${runtimeHome}\\data`,
    SIDECAR_MANAGED_PROJECT_URL: projectUrl
  })
})

test('runtime entrypoint resolution refuses release directories outside Runtime Home', async () => {
  const { resolveRuntimeEntrypoint } = await loadModule()
  assert.equal(typeof resolveRuntimeEntrypoint, 'function')
  if (typeof resolveRuntimeEntrypoint !== 'function') return

  const runtimeHome = '/home/ad/.local/share/conversation-sidecar'
  const prepared = {
    schema_version: 1,
    state: 'prepared',
    current_release: release,
    current_release_dir: `${runtimeHome}/releases/${release}`,
    data_root: `${runtimeHome}/data`,
    managed_project: null,
    extension: { id: 'cfifihieaffhniimpimnfmignbbdaalb' }
  }
  assert.equal(
    resolveRuntimeEntrypoint(prepared, runtimeHome, 'server', { platform: 'linux' }),
    `${runtimeHome}/releases/${release}/src/server.mjs`
  )
  assert.throws(
    () => resolveRuntimeEntrypoint({ ...prepared, current_release_dir: '/tmp/outside' }, runtimeHome, 'server', { platform: 'linux' }),
    /release/i
  )
})

test('runtime launcher installation creates stable bin entrypoints without embedding a release SHA', async (t) => {
  const { installRuntimeLaunchers } = await loadModule()
  assert.equal(typeof installRuntimeLaunchers, 'function')
  if (typeof installRuntimeLaunchers !== 'function') return

  const runtimeHome = await mkdtemp(join(tmpdir(), 'runtime launchers '))
  t.after(() => rm(runtimeHome, { recursive: true, force: true }))
  const installed = await installRuntimeLaunchers({ runtimeHome, platform: process.platform })

  for (const name of [
    'runtime-launcher.mjs',
    'native-host.mjs',
    'conversation-cli.mjs',
    'work-cli.mjs',
    'conversation-sidecar-host',
    'conversation-sidecar-host.bat',
    'chatgpt-conversation',
    'chatgpt-conversation.cmd',
    'conversation-work',
    'conversation-work.cmd'
  ]) {
    await access(join(runtimeHome, 'bin', name))
  }

  assert.equal(installed.binDir, join(runtimeHome, 'bin'))
  const nativeHost = await readFile(join(runtimeHome, 'bin', 'native-host.mjs'), 'utf8')
  assert.doesNotMatch(nativeHost, new RegExp(release))
  assert.match(nativeHost, /runtime-launcher\.mjs/)
})
