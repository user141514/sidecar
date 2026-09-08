import { readFile } from 'node:fs/promises'
import { homedir, platform as currentPlatform } from 'node:os'
import { posix, win32 } from 'node:path'

const EXTENSION_ID = 'cfifihieaffhniimpimnfmignbbdaalb'
const RELEASE_RE = /^[0-9a-f]{40}$/

function pathApi(platform) {
  if (platform === 'linux') return posix
  if (platform === 'win32') return win32
  throw new Error(`Unsupported platform: ${platform}`)
}

function normalizeAbsolute(value, path, label) {
  if (typeof value !== 'string' || !value || !path.isAbsolute(value)) throw new TypeError(`${label} must be absolute`)
  return path.normalize(value)
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

export function resolveDefaultRuntimeHome({
  platform = currentPlatform(),
  homeDirectory = homedir(),
  xdgDataHome = process.env.XDG_DATA_HOME,
  localAppData = process.env.LOCALAPPDATA
} = {}) {
  if (platform === 'linux') return posix.join(xdgDataHome || posix.join(homeDirectory, '.local', 'share'), 'conversation-sidecar')
  if (platform === 'win32') {
    if (!localAppData) throw new Error('LOCALAPPDATA is required on Windows')
    return win32.join(localAppData, 'Conversation Sidecar')
  }
  throw new Error(`Unsupported platform: ${platform}`)
}

export function resolveRuntimePaths(runtimeHome, { platform = currentPlatform() } = {}) {
  const path = pathApi(platform)
  const root = normalizeAbsolute(runtimeHome, path, 'runtime home')
  const releases = path.join(root, 'releases')
  const extensionCurrent = path.join(root, 'extension-current')
  const bin = path.join(root, 'bin')
  const data = path.join(root, 'data')
  return {
    runtimeHome: root,
    config: path.join(root, 'runtime.json'),
    releases,
    extensionCurrent,
    bin,
    data,
    conversations: path.join(data, 'conversations'),
    works: path.join(data, 'works'),
    memory: path.join(data, 'memory'),
    migrations: path.join(root, 'migrations')
  }
}

export function validateRuntimeConfig(config, runtimeHome, { platform = currentPlatform() } = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('runtime config must be an object')
  const paths = resolveRuntimePaths(runtimeHome, { platform })
  const path = pathApi(platform)
  if (config.schema_version !== 1) throw new TypeError('runtime config schema_version must be 1')
  if (config.state !== 'prepared' && config.state !== 'ready') throw new TypeError('runtime config state must be prepared or ready')
  if (typeof config.current_release !== 'string' || !RELEASE_RE.test(config.current_release)) throw new TypeError('runtime release must be a 40-character lowercase git sha')

  const expectedReleaseDir = path.join(paths.releases, config.current_release)
  const releaseDir = normalizeAbsolute(config.current_release_dir, path, 'current release directory')
  if (releaseDir !== expectedReleaseDir) throw new TypeError('current release directory must match runtime release')
  const dataRoot = normalizeAbsolute(config.data_root, path, 'data root')
  if (dataRoot !== paths.data) throw new TypeError('data root must match Runtime Home data directory')

  if (!config.extension || config.extension.id !== EXTENSION_ID) throw new TypeError('runtime extension id is invalid')
  let managedProject = null
  if (config.managed_project !== null && config.managed_project !== undefined) {
    if (config.managed_project?.name !== 'subagents') throw new TypeError('managed project name must be subagents')
    const url = canonicalProjectUrl(config.managed_project.url)
    if (!url) throw new TypeError('managed project url must be a canonical ChatGPT Project home URL')
    managedProject = { name: 'subagents', url }
  }
  if (config.state === 'ready' && !managedProject) throw new TypeError('ready runtime requires managed project identity')

  return {
    schema_version: 1,
    state: config.state,
    current_release: config.current_release,
    current_release_dir: expectedReleaseDir,
    data_root: paths.data,
    managed_project: managedProject,
    extension: { id: EXTENSION_ID }
  }
}

export async function loadRuntimeConfig(runtimeHome, { platform = currentPlatform() } = {}) {
  const paths = resolveRuntimePaths(runtimeHome, { platform })
  const config = JSON.parse(await readFile(paths.config, 'utf8'))
  return validateRuntimeConfig(config, runtimeHome, { platform })
}
