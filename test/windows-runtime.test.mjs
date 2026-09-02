import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

async function read(relativePath) {
  try {
    return await readFile(new URL(relativePath, import.meta.url), 'utf8')
  } catch {
    return ''
  }
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

test('Windows native messaging manifest keeps the fixed host and extension identity', async () => {
  const raw = await read('../install/com.conversation_sidecar.host-win.json')
  assert.notEqual(raw, '')
  if (!raw) return

  const manifest = JSON.parse(raw)
  assert.equal(manifest.name, 'com.conversation_sidecar.host')
  assert.equal(manifest.path, 'conversation-sidecar-host.bat')
  assert.equal(manifest.type, 'stdio')
  assert.deepEqual(manifest.allowed_origins, [
    'chrome-extension://cfifihieaffhniimpimnfmignbbdaalb/'
  ])
})

test('Windows native host launcher delegates Chrome stdio to the Node sidecar', async () => {
  const source = await read('../install/conversation-sidecar-host.bat')
  assert.notEqual(source, '')
  assert.match(source, /^@echo off/im)
  assert.match(source, /node\.exe\s+"%~dp0\.\.\\src\\server\.mjs"\s+%\*/i)
  assert.doesNotMatch(source, /start\s+/i)
})

test('Windows installer registers the native messaging manifest for the current user', async () => {
  const source = await read('../install/install-host-win.bat')
  assert.notEqual(source, '')
  assert.match(source, /HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com\.conversation_sidecar\.host/i)
  assert.match(source, /\/ve\s+\/t\s+REG_SZ/i)
  assert.match(source, /%~dp0com\.conversation_sidecar\.host-win\.json/i)
  assert.match(source, /\/f/i)
})

test('server starts when executed directly on Windows', { skip: process.platform !== 'win32' }, async () => {
  const serverPath = fileURLToPath(new URL('../src/server.mjs', import.meta.url))
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, SIDECAR_PORT: '0' },
    stdio: ['pipe', 'ignore', 'pipe']
  })
  let stderr = ''

  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (chunk) => {
          stderr += chunk
          if (stderr.includes('"service":"conversation-sidecar"')) resolve()
        })
        child.once('exit', (code, signal) => {
          reject(new Error(`server exited before startup: code=${code} signal=${signal} stderr=${stderr}`))
        })
        child.once('error', reject)
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for startup: ${stderr}`)), 2_000))
    ])

    assert.match(stderr, /"service":"conversation-sidecar"/)
  } finally {
    child.stdin.end()
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([
        waitForExit(child),
        new Promise((resolve) => setTimeout(() => {
          child.kill()
          resolve()
        }, 2_000))
      ])
    }
  }
})
