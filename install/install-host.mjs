import { execFile } from 'node:child_process'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { homedir, platform as currentPlatform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const hostName = 'com.conversation_sidecar.host'
const extensionOrigin = 'chrome-extension://cfifihieaffhniimpimnfmignbbdaalb/'
const installDirectory = dirname(fileURLToPath(import.meta.url))

export function resolveWindowsLocalAppData({ userProfileDirectory = process.env.USERPROFILE ?? homedir() } = {}) {
  return join(userProfileDirectory, 'AppData', 'Local')
}

function defaultManifestPath(platform, runtimeConfigDirectory) {
  if (platform === 'linux') return join(homedir(), '.config', 'google-chrome', 'NativeMessagingHosts', `${hostName}.json`)
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', `${hostName}.json`)
  if (platform === 'win32') return join(
    runtimeConfigDirectory ?? resolveWindowsLocalAppData(),
    'Conversation Sidecar',
    'NativeMessagingHosts',
    `${hostName}.json`
  )
  throw new Error(`Unsupported platform: ${platform}`)
}

function defaultHostPath(platform) {
  if (platform === 'win32') return join(installDirectory, 'conversation-sidecar-host.bat')
  if (platform === 'linux' || platform === 'darwin') return join(installDirectory, 'conversation-sidecar-host')
  throw new Error(`Unsupported platform: ${platform}`)
}

async function registerWindowsHost(key, manifestPath) {
  await execFileAsync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'])
}

export async function installNativeHost({
  platform = currentPlatform(),
  runtimeConfigDirectory,
  manifestPath = defaultManifestPath(platform, runtimeConfigDirectory),
  hostPath = defaultHostPath(platform),
  register = registerWindowsHost
} = {}) {
  if (!['linux', 'darwin', 'win32'].includes(platform)) throw new Error(`Unsupported platform: ${platform}`)

  await mkdir(dirname(manifestPath), { recursive: true })
  if (platform !== 'win32') await chmod(hostPath, 0o755)
  await writeFile(manifestPath, `${JSON.stringify({
    name: hostName,
    description: 'Conversation Sidecar native host',
    path: hostPath,
    type: 'stdio',
    allowed_origins: [extensionOrigin]
  }, null, 2)}\n`)

  if (platform === 'win32') {
    await register(`HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`, manifestPath)
  }

  return manifestPath
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifestPath = await installNativeHost()
  console.log(`Installed Chrome native messaging host: ${manifestPath}`)
}
