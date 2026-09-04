import { execFile } from 'node:child_process'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { homedir, platform as currentPlatform } from 'node:os'
import { dirname, posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const hostName = 'com.conversation_sidecar.host'
const extensionOrigin = 'chrome-extension://cfifihieaffhniimpimnfmignbbdaalb/'
const installDirectory = dirname(fileURLToPath(import.meta.url))

export function resolveWindowsLocalAppData({ userProfileDirectory = process.env.USERPROFILE ?? homedir() } = {}) {
  return win32.join(userProfileDirectory, 'AppData', 'Local')
}

export function resolveNativeHostManifestPath({
  platform = currentPlatform(),
  runtimeConfigDirectory,
  homeDirectory = homedir(),
  userProfileDirectory = process.env.USERPROFILE ?? homedir()
} = {}) {
  if (platform === 'linux') {
    return posix.join(homeDirectory, '.config', 'google-chrome', 'NativeMessagingHosts', `${hostName}.json`)
  }
  if (platform === 'win32') {
    return win32.join(
      runtimeConfigDirectory ?? resolveWindowsLocalAppData({ userProfileDirectory }),
      'Conversation Sidecar',
      'NativeMessagingHosts',
      `${hostName}.json`
    )
  }
  throw new Error(`Unsupported platform: ${platform}`)
}

function defaultHostPath(platform) {
  if (platform === 'linux') return posix.join(installDirectory, 'conversation-sidecar-host')
  if (platform === 'win32') return win32.join(installDirectory, 'conversation-sidecar-host.bat')
  throw new Error(`Unsupported platform: ${platform}`)
}

async function registerWindowsHost(key, manifestPath) {
  await execFileAsync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'])
}

export async function installNativeHost({
  platform = currentPlatform(),
  runtimeConfigDirectory,
  manifestPath = resolveNativeHostManifestPath({ platform, runtimeConfigDirectory }),
  hostPath = defaultHostPath(platform),
  registerWindows = registerWindowsHost,
  chmodHost = chmod
} = {}) {
  if (!['linux', 'win32'].includes(platform)) throw new Error(`Unsupported platform: ${platform}`)

  await mkdir(dirname(manifestPath), { recursive: true })
  if (platform === 'linux') await chmodHost(hostPath, 0o755)
  await writeFile(manifestPath, `${JSON.stringify({
    name: hostName,
    description: 'Sidecar native host',
    path: hostPath,
    type: 'stdio',
    allowed_origins: [extensionOrigin]
  }, null, 2)}\n`, 'utf8')

  if (platform === 'win32') {
    await registerWindows(
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`,
      manifestPath
    )
  }

  return manifestPath
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const manifestPath = await installNativeHost()
  console.log(`Installed Chrome native messaging host: ${manifestPath}`)
}
