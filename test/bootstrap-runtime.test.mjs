import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function loadModule() {
  try {
    return await import('../scripts/bootstrap-runtime.mjs')
  } catch {
    return {}
  }
}

const revision = 'c'.repeat(40)
const projectUrl = 'https://chatgpt.com/g/g-p-subagents-bootstrap/project'

test('source package exposes the repository bootstrap entrypoint', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.scripts.bootstrap, 'node scripts/bootstrap-runtime.mjs')
})

async function fixture(t, { activeRegistration = null, projectFindResult = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bootstrap-runtime-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourceRoot = join(root, 'source')
  const runtimeHome = join(root, 'runtime')
  await mkdir(sourceRoot, { recursive: true })
  const calls = { exports: 0, verifies: 0, launchers: 0, installs: [], projectFind: 0 }

  const deps = {
    platform: process.platform,
    sourceRoot,
    sourceRevision: revision,
    async exportRuntime(destination) {
      calls.exports += 1
      await mkdir(destination)
      await writeFile(join(destination, 'PROVENANCE.json'), JSON.stringify({ sourceRevision: revision }), 'utf8')
      return { output: destination, sourceRevision: revision, sourceDirty: false, sourceContentHash: 'd'.repeat(64) }
    },
    async verifyRuntime() {
      calls.verifies += 1
      return { verified: true, sourceRevision: revision, sourceDirty: false, sourceContentHash: 'd'.repeat(64), fileCount: 1 }
    },
    async installRuntimeLaunchers({ runtimeHome: home }) {
      calls.launchers += 1
      await mkdir(join(home, 'bin'), { recursive: true })
      return { runtimeHome: home, binDir: join(home, 'bin'), files: [] }
    },
    async readActiveRegistration() {
      return activeRegistration
    },
    async installNativeHost(options) {
      calls.installs.push(options)
      return options.manifestPath ?? join(runtimeHome, 'manifest.json')
    },
    async projectFind(name) {
      calls.projectFind += 1
      assert.equal(name, 'subagents')
      return projectFindResult
    },
    now: () => '2026-09-06T14:00:00.000Z',
    randomId: () => 'bootstrap-test-id'
  }
  return { root, sourceRoot, runtimeHome, calls, deps }
}

async function makeLegacyRoot(path, marker) {
  await mkdir(join(path, 'conversations'), { recursive: true })
  await writeFile(join(path, 'conversations', 'marker.txt'), marker, 'utf8')
}

test('bootstrap argument parser accepts only the V1 flags and rejects relative runtime homes', async () => {
  const { parseBootstrapArgs } = await loadModule()
  assert.equal(typeof parseBootstrapArgs, 'function')
  if (typeof parseBootstrapArgs !== 'function') return

  const parsed = parseBootstrapArgs([
    '--runtime-home', 'C:\\RuntimeHome',
    '--managed-project-url', projectUrl,
    '--migrate-data-from', 'C:\\LegacyData',
    '--activate', '--json', '--live-check'
  ], { platform: 'win32' })
  assert.equal(parsed.runtimeHome, 'C:\\RuntimeHome')
  assert.equal(parsed.managedProjectUrl, projectUrl)
  assert.equal(parsed.migrateDataFrom, 'C:\\LegacyData')
  assert.equal(parsed.activate, true)
  assert.equal(parsed.json, true)
  assert.equal(parsed.liveCheck, true)

  assert.throws(() => parseBootstrapArgs(['--runtime-home', 'relative'], { platform: 'win32' }), /absolute/i)
  assert.throws(() => parseBootstrapArgs(['--unknown'], { platform: 'win32' }), /unknown/i)
})

test('bootstrap reuses an already verified immutable release on rerun', async (t) => {
  const { bootstrapRuntime } = await loadModule()
  assert.equal(typeof bootstrapRuntime, 'function')
  if (typeof bootstrapRuntime !== 'function') return

  const f = await fixture(t)
  const options = { runtimeHome: f.runtimeHome, managedProjectUrl: projectUrl, activate: false }
  const first = await bootstrapRuntime(options, f.deps)
  const second = await bootstrapRuntime(options, f.deps)

  assert.equal(first.ok, true)
  assert.equal(first.state, 'ready')
  assert.equal(second.ok, true)
  assert.equal(second.state, 'ready')
  assert.equal(f.calls.exports, 1)
  assert.ok(f.calls.verifies >= 2)
})

test('bootstrap preserves an external active registration without --activate', async (t) => {
  const { bootstrapRuntime } = await loadModule()
  assert.equal(typeof bootstrapRuntime, 'function')
  if (typeof bootstrapRuntime !== 'function') return

  const f = await fixture(t, {
    activeRegistration: {
      manifestPath: join('C:\\Legacy', 'manifest.json'),
      hostPath: 'C:\\Legacy\\install\\conversation-sidecar-host.bat',
      dataRoot: null
    }
  })
  const result = await bootstrapRuntime({ runtimeHome: f.runtimeHome, managedProjectUrl: projectUrl }, f.deps)

  assert.equal(result.ok, true)
  assert.equal(result.state, 'ready')
  assert.equal(result.activation.status, 'prepared_not_activated')
  assert.equal(f.calls.installs.length, 0)
})

test('bootstrap fails closed when active and checkout legacy data roots are both non-empty', async (t) => {
  const { bootstrapRuntime } = await loadModule()
  assert.equal(typeof bootstrapRuntime, 'function')
  if (typeof bootstrapRuntime !== 'function') return

  const f = await fixture(t)
  const activeData = join(f.root, 'active-data')
  const sourceData = join(f.sourceRoot, 'data')
  await makeLegacyRoot(activeData, 'ACTIVE')
  await makeLegacyRoot(sourceData, 'SOURCE')
  f.deps.readActiveRegistration = async () => ({
    manifestPath: join(f.root, 'legacy-manifest.json'),
    hostPath: join(f.root, 'legacy', 'install', 'conversation-sidecar-host'),
    dataRoot: activeData
  })

  const result = await bootstrapRuntime({ runtimeHome: f.runtimeHome, managedProjectUrl: projectUrl }, f.deps)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'data_root_conflict')
})

test('explicit migration authority copies legacy bytes and outranks other discovered roots', async (t) => {
  const { bootstrapRuntime } = await loadModule()
  assert.equal(typeof bootstrapRuntime, 'function')
  if (typeof bootstrapRuntime !== 'function') return

  const f = await fixture(t)
  const explicitData = join(f.root, 'explicit-data')
  const sourceData = join(f.sourceRoot, 'data')
  await makeLegacyRoot(explicitData, 'EXPLICIT')
  await makeLegacyRoot(sourceData, 'SOURCE')

  const result = await bootstrapRuntime({
    runtimeHome: f.runtimeHome,
    migrateDataFrom: explicitData,
    managedProjectUrl: projectUrl
  }, f.deps)

  assert.equal(result.ok, true)
  assert.equal(await readFile(join(f.runtimeHome, 'data', 'conversations', 'marker.txt'), 'utf8'), 'EXPLICIT')
  assert.equal(await readFile(join(explicitData, 'conversations', 'marker.txt'), 'utf8'), 'EXPLICIT')
})

test('fresh bootstrap can stop in prepared state until extension trust or Project resolution is available', async (t) => {
  const { bootstrapRuntime } = await loadModule()
  assert.equal(typeof bootstrapRuntime, 'function')
  if (typeof bootstrapRuntime !== 'function') return

  const f = await fixture(t, { projectFindResult: null })
  const result = await bootstrapRuntime({ runtimeHome: f.runtimeHome }, f.deps)

  assert.equal(result.ok, false)
  assert.equal(result.state, 'prepared')
  assert.equal(result.error.code, 'extension_trust_required')
  const config = JSON.parse(await readFile(join(f.runtimeHome, 'runtime.json'), 'utf8'))
  assert.equal(config.state, 'prepared')
  assert.equal(config.managed_project, null)
})

test('bootstrap promotes prepared config to ready when project_find resolves subagents', async (t) => {
  const { bootstrapRuntime } = await loadModule()
  assert.equal(typeof bootstrapRuntime, 'function')
  if (typeof bootstrapRuntime !== 'function') return

  const f = await fixture(t, { projectFindResult: { found: true, projectUrl } })
  const result = await bootstrapRuntime({ runtimeHome: f.runtimeHome }, f.deps)

  assert.equal(result.ok, true)
  assert.equal(result.state, 'ready')
  assert.equal(result.managedProject.url, projectUrl)
  const config = JSON.parse(await readFile(join(f.runtimeHome, 'runtime.json'), 'utf8'))
  assert.equal(config.state, 'ready')
  assert.equal(config.managed_project.url, projectUrl)
})

test('runtime live-check exercises managed worker collection and memory consumption through MCP tools', async () => {
  const { runRuntimeLiveCheck } = await loadModule()
  assert.equal(typeof runRuntimeLiveCheck, 'function')
  if (typeof runRuntimeLiveCheck !== 'function') return

  const calls = []
  let workCreates = 0
  const callTool = async (name, args) => {
    calls.push({ name, args })
    if (name === 'work_create') {
      workCreates += 1
      return { id: workCreates === 1 ? 'work_source' : 'work_consumer' }
    }
    if (name === 'work_decide') return { id: args.work_id, latestDecision: args.decision }
    if (name === 'work_dispatch') {
      return { dispatched: true, frontierId: args.frontier_id, conversationId: 'conv_worker', turnId: 'turn_worker', accepted: true }
    }
    if (name === 'work_collect') {
      return {
        collected: 1,
        state: {
          id: args.work_id,
          frontiers: [{ id: 'runtime_live_check_frontier', status: 'completed', result: 'RUNTIME_LIVE_CHECK_OK' }]
        }
      }
    }
    if (name === 'conversation_read') {
      return {
        id: args.conversation_id,
        status: 'completed',
        latestTurnId: 'turn_worker',
        latestResponse: 'RUNTIME_LIVE_CHECK_OK',
        events: [{ type: 'conversation_created', externalUrl: projectUrl }]
      }
    }
    if (name === 'work_append') return { type: args.type, payload: args.payload }
    if (name === 'work_memory_publish') return { memory_id: 'mem_live_check' }
    if (name === 'work_memory_query') {
      return { retrievalId: 'retrieval_live_check', matched: [{ memory_id: 'mem_live_check' }] }
    }
    if (name === 'work_memory_read') return { meta: { memory_id: args.memory_id }, events: [] }
    if (name === 'work_read') {
      return { id: args.work_id, events: [{ type: 'memory_consumed', payload: { memory_id: 'mem_live_check' } }] }
    }
    throw new Error(`unexpected tool ${name}`)
  }

  const result = await runRuntimeLiveCheck({
    managedProjectUrl: projectUrl,
    callTool,
    randomId: () => 'test',
    sleep: async () => {},
    timeoutMs: 5_000
  })

  assert.equal(result.ok, true)
  assert.equal(result.workerResult, 'RUNTIME_LIVE_CHECK_OK')
  assert.equal(result.memoryId, 'mem_live_check')
  assert.deepEqual(calls.map(({ name }) => name), [
    'work_create',
    'work_decide',
    'work_dispatch',
    'work_collect',
    'conversation_read',
    'work_decide',
    'work_append',
    'work_memory_publish',
    'work_create',
    'work_memory_query',
    'work_memory_read',
    'work_read'
  ])
})

test('bootstrap live-check refuses to run while an external registration is only prepared', async (t) => {
  const { bootstrapRuntime } = await loadModule()
  assert.equal(typeof bootstrapRuntime, 'function')
  if (typeof bootstrapRuntime !== 'function') return

  const f = await fixture(t, {
    activeRegistration: {
      manifestPath: join(fixture.name ?? 'C:\\Legacy', 'manifest.json'),
      hostPath: 'C:\\Legacy\\install\\conversation-sidecar-host.bat',
      dataRoot: null
    }
  })
  let liveCheckCalls = 0
  f.deps.liveCheck = async () => {
    liveCheckCalls += 1
    return { ok: true }
  }

  const result = await bootstrapRuntime({
    runtimeHome: f.runtimeHome,
    managedProjectUrl: projectUrl,
    liveCheck: true
  }, f.deps)

  assert.equal(result.ok, false)
  assert.equal(result.state, 'ready')
  assert.equal(result.error.code, 'activation_required')
  assert.equal(liveCheckCalls, 0)
})

test('bootstrap runs live-check after an installed Runtime Home becomes ready', async (t) => {
  const { bootstrapRuntime } = await loadModule()
  assert.equal(typeof bootstrapRuntime, 'function')
  if (typeof bootstrapRuntime !== 'function') return

  const f = await fixture(t)
  f.deps.runtimeHealth = async () => ({ ok: true, runtimeRelease: revision })
  let liveCheckArgs = null
  f.deps.liveCheck = async (args) => {
    liveCheckArgs = args
    return { ok: true, workerResult: 'RUNTIME_LIVE_CHECK_OK', memoryId: 'mem_test' }
  }

  const result = await bootstrapRuntime({
    runtimeHome: f.runtimeHome,
    managedProjectUrl: projectUrl,
    liveCheck: true
  }, f.deps)

  assert.equal(result.ok, true)
  assert.equal(result.state, 'ready')
  assert.equal(result.activation.status, 'installed')
  assert.equal(result.liveCheck.workerResult, 'RUNTIME_LIVE_CHECK_OK')
  assert.equal(liveCheckArgs.managedProjectUrl, projectUrl)
})

test('bootstrap refuses live-check when registration changed but an old runtime is still listening', async (t) => {
  const { bootstrapRuntime } = await loadModule()
  assert.equal(typeof bootstrapRuntime, 'function')
  if (typeof bootstrapRuntime !== 'function') return

  const f = await fixture(t)
  f.deps.runtimeHealth = async () => ({ ok: true, runtimeRelease: 'e'.repeat(40) })
  let liveCheckCalls = 0
  f.deps.liveCheck = async () => {
    liveCheckCalls += 1
    return { ok: true }
  }

  const result = await bootstrapRuntime({
    runtimeHome: f.runtimeHome,
    managedProjectUrl: projectUrl,
    liveCheck: true
  }, f.deps)

  assert.equal(result.ok, false)
  assert.equal(result.state, 'ready')
  assert.equal(result.error.code, 'activation_required')
  assert.equal(liveCheckCalls, 0)
})

test('bootstrap classifies an active live-check failure without rolling back ready config', async (t) => {
  const { bootstrapRuntime } = await loadModule()
  assert.equal(typeof bootstrapRuntime, 'function')
  if (typeof bootstrapRuntime !== 'function') return

  const f = await fixture(t)
  f.deps.runtimeHealth = async () => ({ ok: true, runtimeRelease: revision })
  f.deps.liveCheck = async () => {
    throw new Error('canary failed')
  }

  const result = await bootstrapRuntime({
    runtimeHome: f.runtimeHome,
    managedProjectUrl: projectUrl,
    liveCheck: true
  }, f.deps)

  assert.equal(result.ok, false)
  assert.equal(result.state, 'ready')
  assert.equal(result.error.code, 'live_check_failed')
  const config = JSON.parse(await readFile(join(f.runtimeHome, 'runtime.json'), 'utf8'))
  assert.equal(config.state, 'ready')
  assert.equal(config.managed_project.url, projectUrl)
})
