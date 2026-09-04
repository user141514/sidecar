import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { encodeNativeMessage } from '../src/native-messaging.mjs'

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

test('POSIX native host launcher delegates Chrome stdio directly to the shared Node server', async () => {
  const source = await read('../install/conversation-sidecar-host')
  assert.notEqual(source, '')
  assert.match(source, /^#!\/usr\/bin\/env sh/m)
  assert.match(source, /exec node .*src\/server\.mjs/)
})

test('Windows native host launcher delegates Chrome stdio directly to the shared Node server', async () => {
  const source = await read('../install/conversation-sidecar-host.bat')
  assert.notEqual(source, '')
  assert.match(source, /^@echo off/im)
  assert.match(source, /where node\.exe/i)
  assert.match(source, /node\.exe\s+"%~dp0\.\.\\src\\server\.mjs"\s+%\*/i)
  assert.doesNotMatch(source, /\bstart\s+/i)
})

test('Windows install wrapper delegates registration to the shared Node installer', async () => {
  const source = await read('../install/install-host-win.bat')
  assert.notEqual(source, '')
  assert.match(source, /where node\.exe/i)
  assert.match(source, /node\.exe\s+"%~dp0install-host\.mjs"/i)
})

test('server direct-entry detection uses filesystem paths rather than URL pathnames', async () => {
  const source = await read('../src/server.mjs')
  assert.match(source, /fileURLToPath\(import\.meta\.url\)\s*===\s*process\.argv\[1\]/)
  assert.doesNotMatch(source, /new URL\(import\.meta\.url\)\.pathname\s*===\s*process\.argv\[1\]/)
})

test('Windows batch launcher starts the shared server and preserves Native Messaging stdin', { skip: process.platform !== 'win32' }, async () => {
  const launcherPath = fileURLToPath(new URL('../install/conversation-sidecar-host.bat', import.meta.url))
  const child = spawn(launcherPath, [], {
    env: { ...process.env, SIDECAR_PORT: '0' },
    stdio: ['pipe', 'ignore', 'pipe'],
    shell: true
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
          reject(new Error(`launcher exited before startup: code=${code} signal=${signal} stderr=${stderr}`))
        })
        child.once('error', reject)
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for launcher startup: ${stderr}`)), 2_000))
    ])

    child.stdin.write(encodeNativeMessage({ kind: 'bridge_ready', extensionVersion: 'test' }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(child.exitCode, null)
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
