import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

async function read(path) {
  try {
    return await readFile(new URL(path, import.meta.url), 'utf8')
  } catch {
    return ''
  }
}

test('extension manifest declares the unattended bridge capabilities with a deterministic id key', async () => {
  const raw = await read('../extension/manifest.json')
  assert.notEqual(raw, '')
  if (!raw) return
  const manifest = JSON.parse(raw)

  assert.equal(manifest.manifest_version, 3)
  assert.equal(typeof manifest.key, 'string')
  assert.ok(manifest.key.length > 100)
  assert.deepEqual(
    [...manifest.permissions].sort(),
    ['nativeMessaging', 'storage', 'tabs', 'windows'].sort()
  )
  assert.deepEqual(manifest.host_permissions, ['https://chatgpt.com/*'])
  assert.equal(manifest.background.service_worker, 'service-worker.js')
  assert.equal(manifest.content_scripts[0].matches[0], 'https://chatgpt.com/*')
  assert.equal(manifest.content_scripts[0].js[0], 'content-script.js')
})

test('extension service worker owns one managed window0 and creates later conversations as tabs inside it', async () => {
  const source = await read('../extension/service-worker.js')
  assert.match(source, /com\.conversation_sidecar\.host/)
  assert.match(source, /connectNative\(NATIVE_HOST\)/)
  assert.match(source, /WINDOW0_KEY/)
  assert.match(source, /ensureWindow0/)
  assert.match(source, /chrome\.windows\.create/)
  assert.equal((source.match(/chrome\.windows\.create/g) ?? []).length, 1)
  assert.match(source, /chrome\.tabs\.create/)
  assert.match(source, /windowId:\s*window0\.windowId/)
  assert.match(source, /chrome\.tabs\.sendMessage/)
  assert.match(source, /onDisconnect/)
})

test('ChatGPT content script submits prompts and emits raw asynchronous completion events', async () => {
  const source = await read('../extension/content-script.js')
  assert.match(source, /#prompt-textarea/)
  assert.match(source, /send-button/)
  assert.match(source, /data-message-author-role/)
  assert.match(source, /response_completed/)
  assert.match(source, /chrome\.runtime\.sendMessage/)
})

test('monitor state survives ChatGPT navigation by persisting and resuming pending turns', async () => {
  const worker = await read('../extension/service-worker.js')
  const content = await read('../extension/content-script.js')

  assert.match(worker, /pending:/)
  assert.match(worker, /pending_turn_lookup/)
  assert.match(worker, /baselineAssistantCount/)
  assert.match(worker, /chrome\.storage\.local/)
  assert.match(content, /resumePendingTurn/)
  assert.match(content, /pending_turn_lookup/)
  assert.match(content, /baselineAssistantCount/)
  assert.match(content, /void resumePendingTurn\(\)/)
})

test('formal server runtime does not import CDP or DevToolsActivePort', async () => {
  const source = await read('../src/server.mjs')
  assert.doesNotMatch(source, /\.\/cdp\.mjs/)
  assert.doesNotMatch(source, /DevToolsActivePort/)
})
