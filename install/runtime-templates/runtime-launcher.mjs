import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function runtimeHomeFromLauncher() {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

function validateConfig(config, runtimeHome) {
  if (!config || config.schema_version !== 1) throw new Error('Invalid Runtime Home config schema')
  if (config.state !== 'prepared' && config.state !== 'ready') throw new Error('Invalid Runtime Home state')
  if (typeof config.current_release !== 'string' || !/^[0-9a-f]{40}$/.test(config.current_release)) throw new Error('Invalid Runtime Home release')
  const expectedReleaseDir = resolve(runtimeHome, 'releases', config.current_release)
  if (resolve(config.current_release_dir) !== expectedReleaseDir) throw new Error('Runtime release escapes Runtime Home')
  const expectedDataRoot = resolve(runtimeHome, 'data')
  if (resolve(config.data_root) !== expectedDataRoot) throw new Error('Runtime data root escapes Runtime Home')
  if (config.state === 'ready' && typeof config.managed_project?.url !== 'string') throw new Error('Ready runtime requires managed Project')
  return config
}

export async function loadStableRuntimeConfig() {
  const runtimeHome = runtimeHomeFromLauncher()
  const raw = await readFile(join(runtimeHome, 'runtime.json'), 'utf8')
  return { runtimeHome, config: validateConfig(JSON.parse(raw), runtimeHome) }
}

export async function launchRuntime(kind, argv = process.argv.slice(2)) {
  const { runtimeHome, config } = await loadStableRuntimeConfig()
  const relative = {
    server: ['src', 'server.mjs'],
    conversation: ['src', 'cli.mjs'],
    work: ['src', 'work-cli.mjs']
  }[kind]
  if (!relative) throw new Error(`Unsupported runtime launcher kind: ${kind}`)
  const entrypoint = join(config.current_release_dir, ...relative)
  const env = {
    ...process.env,
    SIDECAR_DATA_ROOT: config.data_root
  }
  if (config.state === 'ready' && config.managed_project?.url) env.SIDECAR_MANAGED_PROJECT_URL = config.managed_project.url

  const child = spawn(process.execPath, [entrypoint, ...argv], {
    stdio: 'inherit',
    env
  })
  return await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal)
        return
      }
      resolveExit(code ?? 1)
    })
  })
}
