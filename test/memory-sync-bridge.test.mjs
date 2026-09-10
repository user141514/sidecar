import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { MemorySyncBridge } from '../src/memory-sync-bridge.mjs'

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

async function makeMymemRepo(remote = 'git@github.com:user141514/mymem.git') {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-mymem-'))
  git(root, ['init', '-q'])
  git(root, ['remote', 'add', 'origin', remote])
  await mkdir(join(root, 'scripts'), { recursive: true })
  await writeFile(join(root, 'scripts', 'upload-local-memory.mjs'), '// test uploader\n')
  return root
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition not reached')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('valid local mymem checkout kicks the uploader without blocking the caller', async (t) => {
  const repo = await makeMymemRepo()
  t.after(() => rm(repo, { recursive: true, force: true }))
  const gate = deferred()
  const calls = []
  const bridge = new MemorySyncBridge({
    memoryRoot: '/sidecar/data/memory',
    mymemRepo: repo,
    runUploader: async (input) => {
      calls.push(input)
      await gate.promise
    }
  })

  assert.equal(bridge.kick(), undefined)
  await waitFor(() => calls.length === 1)
  assert.deepEqual(calls[0], { repoRoot: repo, memoryRoot: '/sidecar/data/memory' })

  gate.resolve()
  await bridge.whenIdle()
})

test('missing or wrong local mymem checkout disables that pass without running uploader', async (t) => {
  const wrongRepo = await makeMymemRepo('git@github.com:user141514/not-mymem.git')
  t.after(() => rm(wrongRepo, { recursive: true, force: true }))
  const calls = []

  for (const mymemRepo of ['/definitely/missing/mymem', wrongRepo]) {
    const bridge = new MemorySyncBridge({
      memoryRoot: '/sidecar/data/memory',
      mymemRepo,
      runUploader: async () => calls.push(mymemRepo)
    })
    bridge.kick()
    await bridge.whenIdle()
  }

  assert.deepEqual(calls, [])
})

test('kicks during an active upload are single-flight and coalesce to one follow-up pass', async (t) => {
  const repo = await makeMymemRepo('https://github.com/user141514/mymem.git')
  t.after(() => rm(repo, { recursive: true, force: true }))
  const first = deferred()
  let active = 0
  let maxActive = 0
  let runs = 0
  const bridge = new MemorySyncBridge({
    memoryRoot: '/sidecar/data/memory',
    mymemRepo: repo,
    runUploader: async () => {
      runs += 1
      active += 1
      maxActive = Math.max(maxActive, active)
      if (runs === 1) await first.promise
      active -= 1
    }
  })

  bridge.kick()
  await waitFor(() => runs === 1)
  bridge.kick()
  bridge.kick()
  first.resolve()
  await bridge.whenIdle()

  assert.equal(runs, 2)
  assert.equal(maxActive, 1)
})

test('uploader failure schedules one delayed retry and preserves fire-and-forget semantics', async (t) => {
  const repo = await makeMymemRepo()
  t.after(() => rm(repo, { recursive: true, force: true }))
  const retryCallbacks = []
  const errors = []
  let runs = 0
  const bridge = new MemorySyncBridge({
    memoryRoot: '/sidecar/data/memory',
    mymemRepo: repo,
    retryDelayMs: 1234,
    scheduleRetry: (callback, delayMs) => retryCallbacks.push({ callback, delayMs }),
    logger: { warn: (message) => errors.push(message) },
    runUploader: async () => {
      runs += 1
      if (runs === 1) throw new Error('network unavailable')
    }
  })

  assert.equal(bridge.kick(), undefined)
  await bridge.whenIdle()
  assert.equal(runs, 1)
  assert.equal(retryCallbacks.length, 1)
  assert.equal(retryCallbacks[0].delayMs, 1234)
  assert.match(errors[0], /network unavailable/)

  retryCallbacks[0].callback()
  await bridge.whenIdle()
  assert.equal(runs, 2)
})
