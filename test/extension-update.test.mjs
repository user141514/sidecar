import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

async function harness(storage = {}) {
  const source = await readFile(new URL('../extension/lifecycle.js', import.meta.url), 'utf8').catch(() => '')
  const context = { console, setTimeout, clearTimeout }
  vm.runInNewContext(source, context)
  assert.equal(typeof context.createSidecarLifecycle, 'function', 'extension lifecycle control must exist')
  const trace = []
  const timers = []
  const chrome = {
    runtime: { id: 'fixed-id', getManifest: () => ({ version: '0.0.3' }), reload: () => trace.push('reload') },
    storage: { local: {
      get: async () => ({ ...storage }),
      set: async (values) => { Object.assign(storage, values); trace.push('durable') }
    } },
    tabs: { get: async () => { throw new Error('closed tab') } },
    scripting: { executeScript: async () => { throw new Error('must not inject unrelated tabs') } }
  }
  const lifecycle = context.createSidecarLifecycle({ chrome, buildId: 'a'.repeat(64), instanceId: 'epoch-old', schedule: (fn) => timers.push(fn), matchesTab: () => false })
  await lifecycle.restoreAfterReload()
  return { lifecycle, storage, trace, timers, chrome, context }
}
const request = { requestId: 'reload-123', expectedInstanceId: 'epoch-old', expectedBuildId: 'b'.repeat(64) }

test('idle reload persists receipt before ack and schedules only after response', async () => {
  const h = await harness()
  const accepted = await h.lifecycle.requestReload(request)
  assert.equal(accepted.accepted, true)
  assert.deepEqual(h.trace, ['durable'])
  assert.equal(h.storage['reload:receipt'].requestId, request.requestId)
  h.trace.push('ack')
  h.lifecycle.afterResponse('extension_reload', accepted)
  h.timers[0]()
  assert.deepEqual(h.trace, ['durable', 'ack', 'reload'])
})

test('pending work and undelivered terminal events each block reload without changing state', async () => {
  for (const key of ['pending:conv-1', 'outbox:terminal-1']) {
    const h = await harness({ [key]: { turnId: 'busy' } })
    await assert.rejects(h.lifecycle.requestReload(request), /busy/i)
    assert.equal(h.timers.length, 0)
    assert.equal(h.storage['reload:receipt'], undefined)
    assert.deepEqual(h.trace, [])
  }
})

test('reload admission excludes mutations in both directions', async () => {
  const h = await harness()
  let release
  const active = h.lifecycle.runMutation(() => new Promise((resolve) => { release = resolve }))
  await assert.rejects(h.lifecycle.requestReload(request), /busy/i)
  release('done')
  await active
  await h.lifecycle.requestReload(request)
  await assert.rejects(h.lifecycle.runMutation(async () => 'forbidden'), /reload/i)
})

test('storage failure rolls admission back and never triggers a reload', async () => {
  const h = await harness()
  h.chrome.storage.local.set = async () => { throw new Error('disk unavailable') }
  await assert.rejects(h.lifecycle.requestReload(request), /disk unavailable/)
  assert.equal(h.timers.length, 0)
  assert.equal(await h.lifecycle.runMutation(async () => 'usable'), 'usable')
})

test('a duplicate request waits for the original durable receipt write', async () => {
  const h = await harness()
  let release
  let duplicateAccepted = false
  h.chrome.storage.local.set = (values) => new Promise((resolve) => {
    release = () => { Object.assign(h.storage, values); resolve() }
  })
  const first = h.lifecycle.requestReload(request)
  await new Promise((resolve) => setImmediate(resolve))
  const duplicate = h.lifecycle.requestReload(request).then((value) => { duplicateAccepted = true; return value })
  await new Promise((resolve) => setImmediate(resolve))
  const acceptedBeforePersistence = duplicateAccepted
  release()
  await Promise.all([first, duplicate])
  assert.equal(acceptedBeforePersistence, false, 'duplicate acknowledged before durable receipt')
})

test('stale instance and invalid target hashes fail before persistence', async () => {
  const h = await harness()
  await assert.rejects(h.lifecycle.requestReload({ ...request, expectedInstanceId: 'other' }), /instance/i)
  await assert.rejects(h.lifecycle.requestReload({ ...request, expectedBuildId: 'unknown' }), /build/i)
  assert.deepEqual(h.trace, [])
})

test('reload receipt retries are idempotent but cannot schedule a second reload', async () => {
  const h = await harness()
  const first = await h.lifecycle.requestReload(request)
  const again = await h.lifecycle.requestReload(request)
  h.lifecycle.afterResponse('extension_reload', first)
  h.lifecycle.afterResponse('extension_reload', again)
  assert.equal(h.timers.length, 1)
  assert.deepEqual(h.trace, ['durable'])
})

test('reinjection replaces listeners and reports the executed build without refreshing the page', async () => {
  const source = await readFile(new URL('../extension/content-script.js', import.meta.url), 'utf8')
  const listeners = new Set()
  const context = vm.createContext({
    __sidecarBuildId: 'old-build',
    document: { querySelector: () => null, querySelectorAll: () => [] },
    location: { href: 'https://chatgpt.com/c/test' },
    chrome: { runtime: { sendMessage: async () => null, onMessage: { addListener: (f) => listeners.add(f), removeListener: (f) => listeners.delete(f) } } },
    console, setTimeout, clearTimeout
  })
  vm.runInContext(source, context)
  const firstRuntime = context.__sidecarContentRuntime
  context.__sidecarBuildId = 'new-build'
  vm.runInContext(source, context)
  assert.notEqual(context.__sidecarContentRuntime, firstRuntime)
  assert.equal(listeners.size, 1)
  let ping
  for (const listener of listeners) listener({ type: 'sidecar_ping' }, {}, (result) => { ping = result })
  assert.equal(ping.buildId, 'new-build')
  assert.equal(ping.url, 'https://chatgpt.com/c/test')
})

test('fresh content script tolerates disposal from an invalidated extension context', async () => {
  const source = await readFile(new URL('../extension/content-script.js', import.meta.url), 'utf8')
  const listeners = []
  const context = vm.createContext({
    __sidecarBuildId: 'fresh-build',
    __sidecarContentRuntime: { dispose() { throw new Error('Extension context invalidated') } },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    location: { href: 'https://chatgpt.com/c/test' },
    chrome: { runtime: { sendMessage: async () => null, onMessage: { addListener: (f) => listeners.push(f) } } },
    console, setTimeout, clearTimeout
  })
  assert.doesNotThrow(() => vm.runInContext(source, context))
  let ping
  listeners[0]({ type: 'sidecar_ping' }, {}, (result) => { ping = result })
  assert.equal(ping.buildId, 'fresh-build')
})

test('restarted extension refreshes only exact managed tabs and verifies their build', async () => {
  const h = await harness()
  h.storage['reload:receipt'] = { ...request, previousInstanceId: 'epoch-old' }
  h.storage['conversation:live'] = { tabId: 10, url: 'https://chatgpt.com/c/live' }
  h.storage['conversation:retired'] = { tabId: 11, url: 'https://chatgpt.com/c/retired' }
  let injected = false
  h.chrome.tabs.get = async (id) => ({ id, url: id === 10 ? 'https://chatgpt.com/c/live' : 'https://chatgpt.com/c/unrelated' })
  h.chrome.tabs.sendMessage = async () => ({ ready: true, buildId: injected ? 'b'.repeat(64) : 'old-build' })
  h.chrome.scripting.executeScript = async (args) => {
    assert.equal(args.target.tabId, 10)
    assert.deepEqual(Array.from(args.files), ['build-info.js', 'content-script.js'])
    injected = true
  }
  const restarted = h.context.createSidecarLifecycle({ chrome: h.chrome, buildId: 'b'.repeat(64), instanceId: 'epoch-new', matchesTab: (tab, url) => tab.url === url })
  await restarted.restoreAfterReload()
  const status = await restarted.status()
  assert.equal(status.restoration.state, 'ready')
  assert.deepEqual(Array.from(status.restoration.refreshedTabs), [10])
  assert.equal(status.restoration.skippedTabs[0].tabId, 11)
})

async function updater() {
  const mod = await import('../src/extension-control.mjs').catch(() => ({}))
  assert.equal(typeof mod.updateExtension, 'function', 'reconnect verifier must exist')
  return mod.updateExtension
}
const oldStatus = { instanceId: 'epoch-old', extensionId: 'fixed-id', buildId: 'a'.repeat(64), pendingCount: 0, outboxCount: 0, activeOperations: 0, restoration: { state: 'ready' } }

test('independent updater tolerates lost reload ACK and verifies the correlated new runtime', async () => {
  const update = await updater()
  let phase = 0
  let token
  let reloads = 0
  const callTool = async (name, args) => {
    if (name === 'extension_reload') { token = args.request_id; reloads++; phase = 1; throw new Error('ECONNRESET') }
    if (!phase) return oldStatus
    if (phase++ === 1) throw new Error('ECONNREFUSED')
    return { ...oldStatus, instanceId: 'epoch-new', buildId: 'b'.repeat(64), lastReload: { requestId: token, previousInstanceId: 'epoch-old' } }
  }
  const result = await update(callTool, { expectedBuildId: 'b'.repeat(64), sleep: async () => {}, timeoutMs: 1000 })
  assert.equal(result.verified, true)
  assert.equal(reloads, 1)
  assert.equal(result.status.instanceId, 'epoch-new')
})

test('old epoch or uncorrelated restart can never be reported as updated', async () => {
  const update = await updater()
  let time = 0
  const callTool = async (name) => name === 'extension_reload' ? { accepted: true } : oldStatus
  await assert.rejects(update(callTool, { expectedBuildId: 'b'.repeat(64), now: () => time, sleep: async () => { time += 250 }, timeoutMs: 500 }), /not verified/i)
})

test('new instance with the wrong build fails rather than returning successful reload', async () => {
  const update = await updater()
  let token
  const callTool = async (name, args) => {
    if (name === 'extension_reload') { token = args.request_id; return { accepted: true } }
    return token ? { ...oldStatus, instanceId: 'epoch-new', lastReload: { requestId: token, previousInstanceId: 'epoch-old' } } : oldStatus
  }
  await assert.rejects(update(callTool, { expectedBuildId: 'b'.repeat(64), sleep: async () => {}, timeoutMs: 500 }), /build mismatch/i)
})
