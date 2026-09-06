import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function loadInstaller() {
  try {
    return await import('../install/install-host.mjs')
  } catch {
    return {}
  }
}

const extensionOrigin = 'chrome-extension://cfifihieaffhniimpimnfmignbbdaalb/'
const hostName = 'com.conversation_sidecar.host'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-host-installer-'))
  return {
    root,
    manifestPath: join(root, 'NativeMessagingHosts', `${hostName}.json`),
    linuxHostPath: join(root, 'install', 'conversation-sidecar-host'),
    windowsHostPath: 'C:\\sidecar\\install\\conversation-sidecar-host.bat'
  }
}

test('installer writes one Linux Chrome manifest with the shared host identity', async () => {
  const { installNativeHost } = await loadInstaller()
  assert.equal(typeof installNativeHost, 'function')
  if (typeof installNativeHost !== 'function') return

  const options = await fixture()
  try {
    const installed = await installNativeHost({
      platform: 'linux',
      manifestPath: options.manifestPath,
      hostPath: options.linuxHostPath,
      chmodHost: async () => {}
    })
    assert.equal(installed, options.manifestPath)
    assert.deepEqual(JSON.parse(await readFile(options.manifestPath, 'utf8')), {
      name: hostName,
      description: 'Sidecar native host',
      path: options.linuxHostPath,
      type: 'stdio',
      allowed_origins: [extensionOrigin]
    })
  } finally {
    await rm(options.root, { recursive: true, force: true })
  }
})

test('installer writes and registers one Windows current-user manifest', async () => {
  const { installNativeHost } = await loadInstaller()
  assert.equal(typeof installNativeHost, 'function')
  if (typeof installNativeHost !== 'function') return

  const options = await fixture()
  const registrations = []
  try {
    await installNativeHost({
      platform: 'win32',
      manifestPath: options.manifestPath,
      hostPath: options.windowsHostPath,
      registerWindows: async (...args) => registrations.push(args)
    })
    const manifest = JSON.parse(await readFile(options.manifestPath, 'utf8'))
    assert.equal(manifest.path, options.windowsHostPath)
    assert.deepEqual(registrations, [[
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`,
      options.manifestPath
    ]])
  } finally {
    await rm(options.root, { recursive: true, force: true })
  }
})

test('Windows runtime paths derive from USERPROFILE with Windows path semantics on any host', async () => {
  const { resolveWindowsLocalAppData, resolveNativeHostManifestPath } = await loadInstaller()
  assert.equal(typeof resolveWindowsLocalAppData, 'function')
  assert.equal(typeof resolveNativeHostManifestPath, 'function')
  if (typeof resolveWindowsLocalAppData !== 'function' || typeof resolveNativeHostManifestPath !== 'function') return

  const userProfileDirectory = 'C:\\Users\\14579'
  assert.equal(
    resolveWindowsLocalAppData({ userProfileDirectory }),
    'C:\\Users\\14579\\AppData\\Local'
  )
  assert.equal(
    resolveNativeHostManifestPath({ platform: 'win32', userProfileDirectory }),
    'C:\\Users\\14579\\AppData\\Local\\Conversation Sidecar\\NativeMessagingHosts\\com.conversation_sidecar.host.json'
  )
})

test('installer rejects unsupported operating systems before writing a manifest', async () => {
  const { installNativeHost } = await loadInstaller()
  assert.equal(typeof installNativeHost, 'function')
  if (typeof installNativeHost !== 'function') return

  const options = await fixture()
  try {
    await assert.rejects(
      installNativeHost({ platform: 'freebsd', manifestPath: options.manifestPath, hostPath: '/tmp/host' }),
      /Unsupported platform: freebsd/
    )
  } finally {
    await rm(options.root, { recursive: true, force: true })
  }
})
