import { execFile } from 'node:child_process'
import { chmod } from 'node:fs/promises'
import { homedir, platform as currentPlatform } from 'node:os'
import { posix, win32 } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
export const hostName = 'com.conversation_sidecar.host'
export const extensionOrigin = 'chrome-extension://cfifihieaffhniimpimnfmignbbdaalb/'

export function resolveWindowsLocalAppData({ userProfileDirectory = process.env.USERPROFILE ?? homedir() } = {}) {
  return win32.join(userProfileDirectory, 'AppData', 'Local')
}

export function resolveNativeHostManifestPath({ platform = currentPlatform(), runtimeConfigDirectory, homeDirectory = homedir(), userProfileDirectory = process.env.USERPROFILE ?? homedir() } = {}) {
  if (platform === 'linux') return posix.join(homeDirectory, '.config', 'google-chrome', 'NativeMessagingHosts', `${hostName}.json`)
  if (platform === 'win32') return win32.join(runtimeConfigDirectory ?? resolveWindowsLocalAppData({ userProfileDirectory }), 'Conversation Sidecar', 'NativeMessagingHosts', `${hostName}.json`)
  throw new Error(`Unsupported platform: ${platform}`)
}

export function resolvePlatformLink({ platform = currentPlatform(), installDirectory, ...options }) {
  const manifestPath = resolveNativeHostManifestPath({ ...options, platform })
  return {
    manifestPath,
    hostPath: platform === 'win32' ? win32.join(installDirectory, 'conversation-sidecar-host.bat') : posix.join(installDirectory, 'conversation-sidecar-host'),
    async prepare(hostPath, { chmodHost = chmod } = {}) {
      if (platform === 'linux') await chmodHost(hostPath, 0o755)
    },
    async register(manifestPath, { registerWindows = (key, path) => execFileAsync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', path, '/f']) } = {}) {
      if (platform === 'win32') await registerWindows(`HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`, manifestPath)
    }
  }
}
