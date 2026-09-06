import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostName, extensionOrigin, resolvePlatformLink } from './platform-link.mjs'

export { resolveNativeHostManifestPath, resolveWindowsLocalAppData } from './platform-link.mjs'
const installDirectory = dirname(fileURLToPath(import.meta.url))

export async function installNativeHost({ platform, runtimeConfigDirectory, manifestPath, hostPath, registerWindows, chmodHost } = {}) {
  const link = resolvePlatformLink({ platform, runtimeConfigDirectory, installDirectory })
  manifestPath ??= link.manifestPath
  hostPath ??= link.hostPath
  await mkdir(dirname(manifestPath), { recursive: true })
  await link.prepare(hostPath, { chmodHost })
  await writeFile(manifestPath, `${JSON.stringify({
    name: hostName,
    description: 'Sidecar native host',
    path: hostPath,
    type: 'stdio',
    allowed_origins: [extensionOrigin]
  }, null, 2)}\n`, 'utf8')
  await link.register(manifestPath, { registerWindows })
  return manifestPath
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const manifestPath = await installNativeHost()
  console.log(`Installed Chrome native messaging host: ${manifestPath}`)
}
