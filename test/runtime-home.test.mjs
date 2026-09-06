import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function loadModule() {
  try {
    return await import('../src/runtime-home.mjs')
  } catch {
    return {}
  }
}

const release = 'a'.repeat(40)
const projectUrl = 'https://chatgpt.com/g/g-p-runtime-test/project'

test('runtime home resolves platform-default roots with native path semantics', async () => {
  const { resolveDefaultRuntimeHome } = await loadModule()
  assert.equal(typeof resolveDefaultRuntimeHome, 'function')
  if (typeof resolveDefaultRuntimeHome !== 'function') return

  assert.equal(
    resolveDefaultRuntimeHome({ platform: 'linux', homeDirectory: '/home/ad' }),
    '/home/ad/.local/share/conversation-sidecar'
  )
  assert.equal(
    resolveDefaultRuntimeHome({ platform: 'linux', homeDirectory: '/home/ad', xdgDataHome: '/mnt/state' }),
    '/mnt/state/conversation-sidecar'
  )
  assert.equal(
    resolveDefaultRuntimeHome({ platform: 'win32', localAppData: 'C:\\Users\\14579\\AppData\\Local' }),
    'C:\\Users\\14579\\AppData\\Local\\Conversation Sidecar'
  )
})

test('runtime paths stay under one Runtime Home on Windows and Linux', async () => {
  const { resolveRuntimePaths } = await loadModule()
  assert.equal(typeof resolveRuntimePaths, 'function')
  if (typeof resolveRuntimePaths !== 'function') return

  assert.deepEqual(resolveRuntimePaths('/home/ad/.local/share/conversation-sidecar', { platform: 'linux' }), {
    runtimeHome: '/home/ad/.local/share/conversation-sidecar',
    config: '/home/ad/.local/share/conversation-sidecar/runtime.json',
    releases: '/home/ad/.local/share/conversation-sidecar/releases',
    bin: '/home/ad/.local/share/conversation-sidecar/bin',
    data: '/home/ad/.local/share/conversation-sidecar/data',
    conversations: '/home/ad/.local/share/conversation-sidecar/data/conversations',
    works: '/home/ad/.local/share/conversation-sidecar/data/works',
    memory: '/home/ad/.local/share/conversation-sidecar/data/memory',
    migrations: '/home/ad/.local/share/conversation-sidecar/migrations'
  })

  const win = resolveRuntimePaths('C:\\Users\\14579\\AppData\\Local\\Conversation Sidecar', { platform: 'win32' })
  assert.equal(win.config, 'C:\\Users\\14579\\AppData\\Local\\Conversation Sidecar\\runtime.json')
  assert.equal(win.memory, 'C:\\Users\\14579\\AppData\\Local\\Conversation Sidecar\\data\\memory')
})

test('runtime config validation enforces release containment and prepared/ready states', async () => {
  const { validateRuntimeConfig } = await loadModule()
  assert.equal(typeof validateRuntimeConfig, 'function')
  if (typeof validateRuntimeConfig !== 'function') return

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
  assert.equal(validateRuntimeConfig(prepared, runtimeHome, { platform: 'linux' }).state, 'prepared')

  const ready = {
    ...prepared,
    state: 'ready',
    managed_project: { name: 'subagents', url: projectUrl }
  }
  assert.equal(validateRuntimeConfig(ready, runtimeHome, { platform: 'linux' }).managed_project.url, projectUrl)

  await assert.rejects(
    async () => validateRuntimeConfig({ ...prepared, state: 'ready' }, runtimeHome, { platform: 'linux' }),
    /managed project/i
  )
  await assert.rejects(
    async () => validateRuntimeConfig({ ...prepared, current_release_dir: '/tmp/other' }, runtimeHome, { platform: 'linux' }),
    /release/i
  )
  await assert.rejects(
    async () => validateRuntimeConfig({ ...prepared, data_root: '/tmp/data' }, runtimeHome, { platform: 'linux' }),
    /data root/i
  )
})

test('loadRuntimeConfig parses and validates runtime.json', async (t) => {
  const { loadRuntimeConfig } = await loadModule()
  assert.equal(typeof loadRuntimeConfig, 'function')
  if (typeof loadRuntimeConfig !== 'function') return

  const runtimeHome = await mkdtemp(join(tmpdir(), 'runtime-home-'))
  t.after(() => rm(runtimeHome, { recursive: true, force: true }))
  const config = {
    schema_version: 1,
    state: 'prepared',
    current_release: release,
    current_release_dir: join(runtimeHome, 'releases', release),
    data_root: join(runtimeHome, 'data'),
    managed_project: null,
    extension: { id: 'cfifihieaffhniimpimnfmignbbdaalb' }
  }
  await writeFile(join(runtimeHome, 'runtime.json'), `${JSON.stringify(config)}\n`, 'utf8')
  assert.equal((await loadRuntimeConfig(runtimeHome)).current_release, release)
})
