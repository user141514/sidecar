import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { dirname, join, posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateRuntimeConfig } from '../src/runtime-home.mjs'

const templateDir = fileURLToPath(new URL('./runtime-templates/', import.meta.url))
const templateFiles = [
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
]
const posixExecutables = new Set(['conversation-sidecar-host', 'chatgpt-conversation', 'conversation-work'])

export function runtimeLauncherEnvironment(config) {
  if (!config || typeof config !== 'object' || typeof config.data_root !== 'string' || !config.data_root) {
    throw new TypeError('runtime config data root is required')
  }
  const env = {
    SIDECAR_DATA_ROOT: config.data_root,
    SIDECAR_RUNTIME_RELEASE: config.current_release
  }
  if (config.state === 'ready' && typeof config.managed_project?.url === 'string' && config.managed_project.url) {
    env.SIDECAR_MANAGED_PROJECT_URL = config.managed_project.url
  }
  return env
}

export function resolveRuntimeEntrypoint(config, runtimeHome, kind, { platform = process.platform } = {}) {
  const validated = validateRuntimeConfig(config, runtimeHome, { platform })
  const path = platform === 'win32' ? win32 : platform === 'linux' ? posix : null
  if (!path) throw new Error(`Unsupported platform: ${platform}`)
  const relative = {
    server: ['src', 'server.mjs'],
    conversation: ['src', 'cli.mjs'],
    work: ['src', 'work-cli.mjs']
  }[kind]
  if (!relative) throw new TypeError(`unsupported runtime entrypoint kind: ${kind}`)
  return path.join(validated.current_release_dir, ...relative)
}

export async function installRuntimeLaunchers({ runtimeHome, platform = process.platform, chmodFile = chmod } = {}) {
  if (typeof runtimeHome !== 'string' || !runtimeHome) throw new TypeError('runtime home is required')
  const binDir = join(runtimeHome, 'bin')
  await mkdir(binDir, { recursive: true })
  for (const name of templateFiles) {
    const target = join(binDir, name)
    await copyFile(join(templateDir, name), target)
    if (platform === 'linux' && posixExecutables.has(name)) await chmodFile(target, 0o755)
  }
  return { runtimeHome, binDir, files: [...templateFiles] }
}
