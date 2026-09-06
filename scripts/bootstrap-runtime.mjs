#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir, platform as currentPlatform } from 'node:os'
import { dirname, join, posix, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { exportRuntime as defaultExportRuntime } from './export-runtime.mjs'
import { verifyRuntime as defaultVerifyRuntime } from './verify-runtime.mjs'
import { installRuntimeLaunchers as defaultInstallRuntimeLaunchers } from '../install/runtime-launcher.mjs'
import { installNativeHost as defaultInstallNativeHost, resolveNativeHostManifestPath } from '../install/install-host.mjs'
import { resolveDefaultRuntimeHome, resolveRuntimePaths, validateRuntimeConfig } from '../src/runtime-home.mjs'

const execFileAsync = promisify(execFile)
const sourceRootDefault = fileURLToPath(new URL('../', import.meta.url))
const hostName = 'com.conversation_sidecar.host'
const extensionId = 'cfifihieaffhniimpimnfmignbbdaalb'
const recognizedDataDirs = ['conversations', 'works', 'memory']

function pathApi(platform) {
  if (platform === 'win32') return win32
  if (platform === 'linux') return posix
  throw new Error(`Unsupported platform: ${platform}`)
}

function canonicalProjectUrl(value) {
  if (typeof value !== 'string' || !value) return null
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (parsed.origin !== 'https://chatgpt.com') return null
  const pathname = parsed.pathname.replace(/\/+$/, '')
  if (!/^\/g\/g-p-[^/]+\/project$/.test(pathname)) return null
  return `${parsed.origin}${pathname}`
}

function requireAbsolute(value, platform, label) {
  const path = pathApi(platform)
  if (typeof value !== 'string' || !value || !path.isAbsolute(value)) throw new TypeError(`${label} must be an absolute path`)
  return path.normalize(value)
}

export function parseBootstrapArgs(argv, { platform = currentPlatform() } = {}) {
  const out = { activate: false, json: false, liveCheck: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--activate') { out.activate = true; continue }
    if (arg === '--json') { out.json = true; continue }
    if (arg === '--live-check') { out.liveCheck = true; continue }
    if (['--runtime-home', '--managed-project-url', '--migrate-data-from'].includes(arg)) {
      const value = argv[++index]
      if (!value) throw new TypeError(`${arg} requires a value`)
      if (arg === '--runtime-home') out.runtimeHome = requireAbsolute(value, platform, 'runtime home')
      if (arg === '--migrate-data-from') out.migrateDataFrom = requireAbsolute(value, platform, 'migration data root')
      if (arg === '--managed-project-url') {
        const url = canonicalProjectUrl(value)
        if (!url) throw new TypeError('--managed-project-url requires a canonical ChatGPT Project home URL')
        out.managedProjectUrl = url
      }
      continue
    }
    throw new TypeError(`unknown bootstrap option: ${arg}`)
  }
  return out
}

async function exists(path) {
  try {
    await readdir(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function dataRootIsNonEmpty(root) {
  if (!root) return false
  for (const name of recognizedDataDirs) {
    const dir = join(root, name)
    try {
      if ((await readdir(dir)).length > 0) return true
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return false
}

function deriveLegacyDataRoot(hostPath, platform) {
  if (typeof hostPath !== 'string' || !hostPath) return null
  const path = pathApi(platform)
  const parent = path.dirname(hostPath)
  const parentName = path.basename(parent).toLowerCase()
  if (parentName === 'install' || parentName === 'bin') return path.join(path.dirname(parent), 'data')
  return null
}

async function defaultReadActiveRegistration({ platform, homeDirectory = homedir(), localAppData = process.env.LOCALAPPDATA } = {}) {
  let manifestPath = null
  if (platform === 'linux') {
    manifestPath = resolveNativeHostManifestPath({ platform, homeDirectory })
  } else if (platform === 'win32') {
    try {
      const key = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`
      const { stdout } = await execFileAsync('reg', ['query', key, '/ve'], { encoding: 'utf8' })
      const line = stdout.split(/\r?\n/).find((item) => item.includes('REG_SZ'))
      manifestPath = line?.split('REG_SZ')[1]?.trim() ?? null
    } catch {
      manifestPath = null
    }
    if (!manifestPath && localAppData) manifestPath = resolveNativeHostManifestPath({ platform, runtimeConfigDirectory: localAppData })
  } else {
    throw new Error(`Unsupported platform: ${platform}`)
  }
  if (!manifestPath) return null
  const manifest = await readJsonIfExists(manifestPath)
  if (!manifest || manifest.name !== hostName || typeof manifest.path !== 'string') return null
  return {
    manifestPath,
    hostPath: manifest.path,
    dataRoot: deriveLegacyDataRoot(manifest.path, platform)
  }
}

async function defaultProjectFind(name) {
  try {
    const response = await fetch('http://127.0.0.1:7337/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(5_000),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'project_find', arguments: { name } }
      })
    })
    if (!response.ok) return null
    const body = await response.json()
    if (body.error || body.result?.isError) return null
    const text = body.result?.content?.[0]?.text
    if (typeof text !== 'string') return null
    const value = JSON.parse(text)
    return value?.found === true ? value : null
  } catch {
    return null
  }
}

async function defaultCallTool(name, args, timeoutMs = 30_000) {
  const response = await fetch('http://127.0.0.1:7337/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args }
    })
  })
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}`)
  const body = await response.json()
  if (body.error || body.result?.isError) {
    throw new Error(body.error?.message ?? body.result?.content?.[0]?.text ?? `tool failed: ${name}`)
  }
  const text = body.result?.content?.[0]?.text
  if (typeof text !== 'string') return body.result
  try { return JSON.parse(text) } catch { return text }
}

export async function runRuntimeLiveCheck({
  managedProjectUrl,
  callTool = defaultCallTool,
  randomId = randomUUID,
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  timeoutMs = 180_000
} = {}) {
  const projectUrl = canonicalProjectUrl(managedProjectUrl)
  if (!projectUrl) throw new Error('live-check requires canonical managed Project URL')
  const token = `RUNTIME_LIVE_CHECK_${randomId()}`
  const frontierId = 'runtime_live_check_frontier'
  const expectedReply = 'RUNTIME_LIVE_CHECK_OK'

  const sourceWork = await callTool('work_create', { goal: `${token}: scheduler and memory canary` })
  await callTool('work_decide', {
    work_id: sourceWork.id,
    decision: {
      action: 'SPLIT',
      reason: 'one bounded runtime live-check frontier',
      frontiers: [{
        id: frontierId,
        task: `Reply exactly ${expectedReply} and nothing else`,
        depends_on: []
      }]
    }
  })

  const dispatch = await callTool('work_dispatch', { work_id: sourceWork.id, frontier_id: frontierId })
  if (dispatch?.dispatched !== true || !dispatch.conversationId || !dispatch.turnId) {
    throw new Error('runtime live-check worker was not dispatched')
  }

  const deadline = Date.now() + timeoutMs
  let collected = null
  while (Date.now() < deadline) {
    collected = await callTool('work_collect', { work_id: sourceWork.id })
    const frontier = collected?.state?.frontiers?.find((item) => item.id === frontierId)
    if (frontier?.status === 'completed' || frontier?.status === 'error') break
    await sleep(2_000)
  }
  const frontier = collected?.state?.frontiers?.find((item) => item.id === frontierId)
  if (frontier?.status !== 'completed') throw new Error(`runtime live-check worker did not complete: ${frontier?.status ?? 'timeout'}`)

  const conversation = await callTool('conversation_read', { conversation_id: dispatch.conversationId })
  if (conversation?.latestTurnId !== dispatch.turnId) throw new Error('runtime live-check collected the wrong turn')
  const creation = conversation?.events?.find((event) => event.type === 'conversation_created')
  if (creation?.externalUrl !== projectUrl) throw new Error('runtime live-check worker was not created in configured subagents Project')
  const workerResult = frontier.result ?? conversation.latestResponse ?? null
  if (workerResult !== expectedReply) throw new Error(`runtime live-check worker returned unexpected result: ${workerResult}`)

  await callTool('work_decide', {
    work_id: sourceWork.id,
    decision: { action: 'STOP', reason: 'runtime live-check worker completed successfully' }
  })
  await callTool('work_append', {
    work_id: sourceWork.id,
    type: 'completed',
    payload: { outcome: workerResult, canary: token }
  })
  const memory = await callTool('work_memory_publish', { source_work_id: sourceWork.id })
  if (!memory?.memory_id) throw new Error('runtime live-check memory publish failed')

  const consumerWork = await callTool('work_create', { goal: `${token}: memory consumption canary` })
  const retrieval = await callTool('work_memory_query', { work_id: consumerWork.id, contains: workerResult })
  const matched = retrieval?.matched?.find((item) => item.memory_id === memory.memory_id)
  if (!retrieval?.retrievalId || !matched) throw new Error('runtime live-check memory query did not match published memory')
  await callTool('work_memory_read', {
    work_id: consumerWork.id,
    retrieval_id: retrieval.retrievalId,
    memory_id: memory.memory_id
  })
  const consumerLedger = await callTool('work_read', { work_id: consumerWork.id })
  const consumed = consumerLedger?.events?.some((event) => event.type === 'memory_consumed' && event.payload?.memory_id === memory.memory_id)
  if (!consumed) throw new Error('runtime live-check memory consumption was not recorded')

  return {
    ok: true,
    token,
    sourceWorkId: sourceWork.id,
    consumerWorkId: consumerWork.id,
    conversationId: dispatch.conversationId,
    turnId: dispatch.turnId,
    workerResult,
    memoryId: memory.memory_id,
    retrievalId: retrieval.retrievalId
  }
}

async function currentSourceRevision(sourceRoot) {
  return (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' })).stdout.trim()
}

async function atomicWriteConfig(runtimeHome, config, { platform, randomId }) {
  const paths = resolveRuntimePaths(runtimeHome, { platform })
  const validated = validateRuntimeConfig(config, runtimeHome, { platform })
  await mkdir(dirname(paths.config), { recursive: true })
  const temp = `${paths.config}.tmp-${randomId()}`
  await writeFile(temp, `${JSON.stringify(validated, null, 2)}\n`, 'utf8')
  await rename(temp, paths.config)
  return validated
}

async function readRuntimeConfigIfPresent(runtimeHome, platform) {
  const paths = resolveRuntimePaths(runtimeHome, { platform })
  const raw = await readJsonIfExists(paths.config)
  return raw ? validateRuntimeConfig(raw, runtimeHome, { platform }) : null
}

async function installOrReuseRelease({ runtimeHome, revision, deps, paths }) {
  await mkdir(paths.releases, { recursive: true })
  const releaseDir = pathApi(deps.platform).join(paths.releases, revision)
  if (await exists(releaseDir)) {
    const verified = await deps.verifyRuntime(releaseDir)
    if (!verified.verified || verified.sourceRevision !== revision) throw new Error('existing runtime release failed integrity verification')
    return { releaseDir, reused: true, verification: verified }
  }

  const staging = pathApi(deps.platform).join(paths.releases, `.staging-${revision}-${deps.randomId()}`)
  try {
    const exported = await deps.exportRuntime(staging)
    if (exported.sourceRevision !== revision || exported.sourceDirty === true) throw new Error('runtime source provenance is dirty or does not match HEAD')
    const verified = await deps.verifyRuntime(staging)
    if (!verified.verified || verified.sourceRevision !== revision || verified.sourceDirty === true) throw new Error('runtime release failed provenance verification')
    await rename(staging, releaseDir)
    return { releaseDir, reused: false, verification: verified }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function migrateLegacyData({ options, deps, paths, activeRegistration }) {
  await mkdir(paths.data, { recursive: true })
  if (await dataRootIsNonEmpty(paths.data)) return { status: 'existing', source: null, directories: [] }

  const sourceDataRoot = pathApi(deps.platform).join(deps.sourceRoot, 'data')
  let selected = null
  let authority = null
  if (options.migrateDataFrom) {
    selected = options.migrateDataFrom
    authority = 'explicit'
    if (!(await dataRootIsNonEmpty(selected))) throw new Error('explicit migration data root is empty or unrecognized')
  } else {
    const candidates = []
    if (activeRegistration?.dataRoot && await dataRootIsNonEmpty(activeRegistration.dataRoot)) {
      candidates.push({ path: activeRegistration.dataRoot, authority: 'active_registration' })
    }
    if (await dataRootIsNonEmpty(sourceDataRoot)) candidates.push({ path: sourceDataRoot, authority: 'source_checkout' })
    const distinct = []
    for (const candidate of candidates) {
      const normalized = pathApi(deps.platform).normalize(candidate.path)
      if (!distinct.some((item) => pathApi(deps.platform).normalize(item.path) === normalized)) distinct.push(candidate)
    }
    if (distinct.length > 1) {
      const error = new Error('multiple non-empty legacy data roots require explicit migration authority')
      error.code = 'data_root_conflict'
      throw error
    }
    if (distinct.length === 1) {
      selected = distinct[0].path
      authority = distinct[0].authority
    }
  }

  const copied = []
  if (selected) {
    for (const name of recognizedDataDirs) {
      const source = pathApi(deps.platform).join(selected, name)
      try {
        await readdir(source)
      } catch (error) {
        if (error?.code === 'ENOENT') continue
        throw error
      }
      await cp(source, pathApi(deps.platform).join(paths.data, name), { recursive: true, errorOnExist: true, force: false })
      copied.push(name)
    }
    await mkdir(paths.migrations, { recursive: true })
    const stamp = deps.now().replace(/[:.]/g, '-')
    await writeFile(
      pathApi(deps.platform).join(paths.migrations, `${stamp}-${deps.randomId()}-legacy-data.json`),
      `${JSON.stringify({ source: selected, authority, copied_at: deps.now(), directories: copied }, null, 2)}\n`,
      'utf8'
    )
  }

  for (const name of recognizedDataDirs) await mkdir(pathApi(deps.platform).join(paths.data, name), { recursive: true })
  return { status: selected ? 'migrated' : 'empty', source: selected, authority, directories: copied }
}

async function legacyManagedProjectUrl(paths, platform) {
  const config = await readJsonIfExists(pathApi(platform).join(paths.conversations, 'config.json'))
  return canonicalProjectUrl(config?.defaultProjectUrl)
}

function stableHostPath(paths, platform) {
  return pathApi(platform).join(paths.bin, platform === 'win32' ? 'conversation-sidecar-host.bat' : 'conversation-sidecar-host')
}

function samePath(a, b, platform) {
  if (!a || !b) return false
  return pathApi(platform).normalize(a).toLowerCase() === pathApi(platform).normalize(b).toLowerCase()
}

async function applyRegistration({ options, deps, paths, activeRegistration }) {
  const hostPath = stableHostPath(paths, deps.platform)
  if (activeRegistration && !samePath(activeRegistration.hostPath, hostPath, deps.platform) && !options.activate) {
    return { status: 'prepared_not_activated', changed: false, hostPath: activeRegistration.hostPath }
  }
  if (activeRegistration && samePath(activeRegistration.hostPath, hostPath, deps.platform)) {
    return { status: 'already_active', changed: false, hostPath }
  }
  await deps.installNativeHost({ platform: deps.platform, hostPath })
  return { status: activeRegistration ? 'activated' : 'installed', changed: true, hostPath }
}

function resultError(code, message) {
  return { code, message }
}

export async function bootstrapRuntime(options = {}, overrides = {}) {
  const deps = {
    platform: currentPlatform(),
    sourceRoot: sourceRootDefault,
    exportRuntime: defaultExportRuntime,
    verifyRuntime: defaultVerifyRuntime,
    installRuntimeLaunchers: defaultInstallRuntimeLaunchers,
    readActiveRegistration: defaultReadActiveRegistration,
    installNativeHost: defaultInstallNativeHost,
    projectFind: defaultProjectFind,
    liveCheck: runRuntimeLiveCheck,
    now: () => new Date().toISOString(),
    randomId: randomUUID,
    ...overrides
  }

  let runtimeHome
  let revision
  try {
    runtimeHome = options.runtimeHome
      ? requireAbsolute(options.runtimeHome, deps.platform, 'runtime home')
      : resolveDefaultRuntimeHome({ platform: deps.platform })
    revision = typeof deps.sourceRevision === 'string'
      ? deps.sourceRevision
      : typeof deps.sourceRevision === 'function'
        ? await deps.sourceRevision()
        : await currentSourceRevision(deps.sourceRoot)
    if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('source revision is not a full git sha')
  } catch (error) {
    return { ok: false, state: null, runtimeHome: runtimeHome ?? null, error: resultError('preflight_failed', error.message) }
  }

  const paths = resolveRuntimePaths(runtimeHome, { platform: deps.platform })
  let existingConfig = null
  let release
  let migration
  let activeRegistration
  try {
    existingConfig = await readRuntimeConfigIfPresent(runtimeHome, deps.platform)
    release = await installOrReuseRelease({ runtimeHome, revision, deps, paths })
    await deps.installRuntimeLaunchers({ runtimeHome, platform: deps.platform })
    activeRegistration = await deps.readActiveRegistration({ platform: deps.platform, runtimeHome })
    migration = await migrateLegacyData({ options, deps, paths, activeRegistration })
  } catch (error) {
    const code = error.code === 'data_root_conflict' ? 'data_root_conflict' : 'release_integrity_failed'
    return { ok: false, state: existingConfig?.state ?? null, runtimeHome, sourceRevision: revision, error: resultError(code, error.message) }
  }

  let managedProjectUrl = existingConfig?.managed_project?.url ?? null
  if (!managedProjectUrl) managedProjectUrl = await legacyManagedProjectUrl(paths, deps.platform)
  if (options.managedProjectUrl) managedProjectUrl = canonicalProjectUrl(options.managedProjectUrl)

  const preparedConfig = {
    schema_version: 1,
    state: 'prepared',
    current_release: revision,
    current_release_dir: release.releaseDir,
    data_root: paths.data,
    managed_project: null,
    extension: { id: extensionId }
  }

  try {
    if (!existingConfig || existingConfig.state !== 'ready') {
      await atomicWriteConfig(runtimeHome, preparedConfig, deps)
    }
  } catch (error) {
    return { ok: false, state: existingConfig?.state ?? null, runtimeHome, sourceRevision: revision, error: resultError('self_check_failed', error.message) }
  }

  let activation
  try {
    activation = await applyRegistration({ options, deps, paths, activeRegistration })
  } catch (error) {
    return { ok: false, state: existingConfig?.state ?? 'prepared', runtimeHome, sourceRevision: revision, error: resultError('native_host_registration_failed', error.message) }
  }

  if (!managedProjectUrl) {
    const found = await deps.projectFind('subagents')
    managedProjectUrl = canonicalProjectUrl(found?.projectUrl)
  }

  if (!managedProjectUrl) {
    if (existingConfig?.state === 'ready') {
      return {
        ok: true,
        state: 'ready',
        runtimeHome,
        sourceRevision: revision,
        currentRelease: existingConfig.current_release,
        managedProject: existingConfig.managed_project,
        activation,
        migration,
        checks: { release: true, launchers: true, dataRoot: true, managedProject: true }
      }
    }
    return {
      ok: false,
      state: 'prepared',
      runtimeHome,
      sourceRevision: revision,
      currentRelease: revision,
      managedProject: null,
      activation,
      migration,
      checks: { release: true, launchers: true, dataRoot: true, managedProject: false },
      error: resultError(activeRegistration ? 'managed_project_unresolved' : 'extension_trust_required', 'subagents Project identity is not yet available')
    }
  }

  const readyConfig = {
    ...preparedConfig,
    state: 'ready',
    managed_project: { name: 'subagents', url: managedProjectUrl }
  }
  let validatedReady
  try {
    validatedReady = await atomicWriteConfig(runtimeHome, readyConfig, deps)
  } catch (error) {
    return { ok: false, state: existingConfig?.state ?? 'prepared', runtimeHome, sourceRevision: revision, error: resultError('self_check_failed', error.message) }
  }

  const checks = { release: true, launchers: true, dataRoot: true, managedProject: true }
  let liveCheck = null
  if (options.liveCheck) {
    if (activation.status === 'prepared_not_activated') {
      return {
        ok: false,
        state: 'ready',
        runtimeHome,
        sourceRevision: revision,
        currentRelease: revision,
        managedProject: validatedReady.managed_project,
        activation,
        migration,
        checks,
        error: resultError('activation_required', 'runtime live-check requires the Runtime Home Native Messaging registration to be active')
      }
    }
    try {
      liveCheck = await deps.liveCheck({
        managedProjectUrl: validatedReady.managed_project.url,
        callTool: overrides.callTool,
        randomId: deps.randomId
      })
    } catch (error) {
      return {
        ok: false,
        state: 'ready',
        runtimeHome,
        sourceRevision: revision,
        currentRelease: revision,
        managedProject: validatedReady.managed_project,
        activation,
        migration,
        checks,
        error: resultError('live_check_failed', error instanceof Error ? error.message : String(error))
      }
    }
  }

  return {
    ok: true,
    state: 'ready',
    runtimeHome,
    sourceRevision: revision,
    currentRelease: revision,
    managedProject: validatedReady.managed_project,
    activation,
    migration,
    checks,
    ...(liveCheck ? { liveCheck } : {})
  }
}

function printHuman(result) {
  const lines = [
    `Agent Runtime: ${result.ok ? 'OK' : 'NOT READY'}`,
    `state: ${result.state ?? 'none'}`,
    `runtime-home: ${result.runtimeHome ?? 'unknown'}`,
    `release: ${result.currentRelease ?? result.sourceRevision ?? 'unknown'}`,
    `managed-project: ${result.managedProject?.url ?? 'unresolved'}`
  ]
  if (result.error) lines.push(`error: ${result.error.code}: ${result.error.message}`)
  return lines.join('\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseBootstrapArgs(process.argv.slice(2))
    const result = await bootstrapRuntime(options)
    process.stdout.write(`${options.json ? JSON.stringify(result) : printHuman(result)}\n`)
    if (!result.ok) process.exitCode = 1
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
