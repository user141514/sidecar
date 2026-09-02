import { execFile } from 'node:child_process'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { installNativeHost, resolveWindowsLocalAppData } from '../install/install-host.mjs'

const extensionOrigin = 'chrome-extension://cfifihieaffhniimpimnfmignbbdaalb/'

const execFileAsync = promisify(execFile)
const hostName = 'com.conversation_sidecar.host'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'conversation-sidecar-host-'))
  return {
    root,
    manifestPath: join(root, 'native-host', 'com.conversation_sidecar.host.json'),
    hostPath: resolve('install/conversation-sidecar-host'),
    register: async () => {}
  }
}

test('installs a Linux Chrome manifest with an absolute native-host launcher path', async () => {
  const options = await fixture()

  await installNativeHost({ ...options, platform: 'linux' })

  const manifest = JSON.parse(await readFile(options.manifestPath, 'utf8'))
  assert.equal(manifest.name, 'com.conversation_sidecar.host')
  assert.equal(manifest.path, options.hostPath)
  assert.equal(manifest.type, 'stdio')
  assert.deepEqual(manifest.allowed_origins, [extensionOrigin])
})

test('installs a macOS Chrome manifest in Application Support', async () => {
  const options = await fixture()

  await installNativeHost({ ...options, platform: 'darwin' })

  const manifest = JSON.parse(await readFile(options.manifestPath, 'utf8'))
  assert.equal(manifest.path, options.hostPath)
})

test('registers the Windows manifest for the current Chrome user', async () => {
  const options = await fixture()
  const calls = []

  await installNativeHost({
    ...options,
    platform: 'win32',
    hostPath: resolve('install/conversation-sidecar-host.bat'),
    register: async (...args) => calls.push(args)
  })

  assert.deepEqual(calls, [[
    'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.conversation_sidecar.host',
    options.manifestPath
  ]])
  assert.equal(JSON.parse(await readFile(options.manifestPath, 'utf8')).path, resolve('install/conversation-sidecar-host.bat'))
})

test('uses the Windows user runtime configuration directory instead of the checkout for generated manifests', async () => {
  const runtimeConfigDirectory = await mkdtemp(join(tmpdir(), 'conversation-sidecar-runtime-'))
  const manifestPath = await installNativeHost({
    platform: 'win32',
    runtimeConfigDirectory,
    register: async () => {}
  })

  assert.equal(manifestPath, join(runtimeConfigDirectory, 'Conversation Sidecar', 'NativeMessagingHosts', `${hostName}.json`))
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).path, resolve('install/conversation-sidecar-host.bat'))
})

test('resolves Windows local app data from the user profile, not LOCALAPPDATA', () => {
  assert.equal(
    resolveWindowsLocalAppData({
      userProfileDirectory: 'C:\\Users\\14579',
      environment: { LOCALAPPDATA: 'E:\\orca-poison' }
    }),
    'C:\\Users\\14579\\AppData\\Local'
  )
})

test('Windows CLI installation ignores poisoned LOCALAPPDATA and registers the real user profile manifest', {
  skip: process.platform !== 'win32' || process.env.RUN_WINDOWS_NATIVE_HOST_INSTALL_TEST !== '1'
}, async () => {
  const poisonedLocalAppData = await mkdtemp(join(tmpdir(), 'orca-poison-'))
  const localAppData = join(process.env.USERPROFILE, 'AppData', 'Local')
  const key = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`
  const manifestPath = join(localAppData, 'Conversation Sidecar', 'NativeMessagingHosts', `${hostName}.json`)
  let existingManifest
  let existingManifestContent

  try {
    try {
      ({ stdout: existingManifest } = await execFileAsync('reg', ['query', key, '/ve']))
    } catch {}
    try {
      existingManifestContent = await readFile(manifestPath, 'utf8')
    } catch {}

    await execFileAsync(process.execPath, [resolve('install/install-host.mjs')], {
      env: { ...process.env, LOCALAPPDATA: poisonedLocalAppData }
    })

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const { stdout } = await execFileAsync('reg', ['query', key, '/ve'])
    assert.equal(manifest.path, resolve('install/conversation-sidecar-host.bat'))
    assert.match(stdout, new RegExp(manifestPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
  } finally {
    await rm(poisonedLocalAppData, { recursive: true, force: true })
    if (existingManifestContent) {
      await writeFile(manifestPath, existingManifestContent)
    } else {
      await rm(manifestPath, { force: true })
    }
    if (existingManifest) {
      const previousPath = existingManifest.match(/REG_SZ\s+(.+)\s*$/m)?.[1]
      if (previousPath) await execFileAsync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', previousPath, '/f'])
    } else {
      await execFileAsync('reg', ['delete', key, '/f']).catch(() => {})
    }
  }
})

test('rejects unsupported operating systems before creating a manifest', async () => {
  const options = await fixture()

  await assert.rejects(() => installNativeHost({ ...options, platform: 'freebsd' }), /Unsupported platform: freebsd/)
})
