import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { MemorySyncBridge, defaultSearchRoots } from '../src/memory-sync-bridge.mjs'

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

async function initMymemRepo(root, remote = 'git@github.com:user141514/mymem.git') {
  await mkdir(root, { recursive: true })
  git(root, ['init', '-q'])
  git(root, ['remote', 'add', 'origin', remote])
  await mkdir(join(root, 'scripts'), { recursive: true })
  await writeFile(join(root, 'scripts', 'upload-local-memory.mjs'), '// test uploader\n')
  return root
}

async function makeMymemRepo(remote = 'git@github.com:user141514/mymem.git') {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-mymem-'))
  return initMymemRepo(root, remote)
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
      searchRoots: [],
      discoverRepos: async () => [],
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

test('machine discovery finds a valid deep checkout when the preferred sibling is missing', async (t) => {
  const machineRoot = await mkdtemp(join(tmpdir(), 'sidecar-machine-scan-'))
  t.after(() => rm(machineRoot, { recursive: true, force: true }))
  const wrong = await initMymemRepo(join(machineRoot, 'projects', 'wrong'), 'git@github.com:user141514/not-mymem.git')
  const target = await initMymemRepo(join(machineRoot, 'very', 'deep', 'custom-folder-name'))
  const calls = []
  const bridge = new MemorySyncBridge({
    memoryRoot: '/sidecar/data/memory',
    mymemRepo: join(machineRoot, 'missing-sibling'),
    searchRoots: [machineRoot],
    runUploader: async (input) => calls.push(input)
  })

  bridge.kick()
  await bridge.whenIdle()

  assert.equal(calls.length, 1)
  assert.equal(calls[0].repoRoot, target)
  assert.notEqual(calls[0].repoRoot, wrong)
})

test('explicit valid repo has priority over machine discovery', async (t) => {
  const machineRoot = await mkdtemp(join(tmpdir(), 'sidecar-explicit-priority-'))
  t.after(() => rm(machineRoot, { recursive: true, force: true }))
  const explicit = await initMymemRepo(join(machineRoot, 'explicit'))
  await initMymemRepo(join(machineRoot, 'other'))
  const calls = []
  const bridge = new MemorySyncBridge({
    memoryRoot: '/sidecar/data/memory',
    mymemRepo: explicit,
    searchRoots: [machineRoot],
    runUploader: async (input) => calls.push(input)
  })

  bridge.kick()
  await bridge.whenIdle()

  assert.equal(calls.length, 1)
  assert.equal(calls[0].repoRoot, explicit)
})

test('discovered repo is cached and a stale cache triggers rediscovery', async (t) => {
  const machineRoot = await mkdtemp(join(tmpdir(), 'sidecar-cache-'))
  t.after(() => rm(machineRoot, { recursive: true, force: true }))
  const first = await initMymemRepo(join(machineRoot, 'a-repo'))
  const second = await initMymemRepo(join(machineRoot, 'b-repo'))
  let scans = 0
  const discoverRepos = async () => {
    scans += 1
    return [first, second]
  }
  const calls = []
  const bridge = new MemorySyncBridge({
    memoryRoot: '/sidecar/data/memory',
    mymemRepo: join(machineRoot, 'missing-preferred'),
    discoverRepos,
    runUploader: async (input) => calls.push(input)
  })

  bridge.kick()
  await bridge.whenIdle()
  bridge.kick()
  await bridge.whenIdle()
  assert.equal(scans, 1)
  assert.deepEqual(calls.map((call) => call.repoRoot), [first, first])

  git(first, ['remote', 'set-url', 'origin', 'git@github.com:user141514/not-mymem.git'])
  bridge.kick()
  await bridge.whenIdle()

  assert.equal(scans, 2)
  assert.equal(calls.at(-1).repoRoot, second)
})

test('Windows search roots include the user home and available drive roots without POSIX assumptions', () => {
  const roots = defaultSearchRoots({
    platform: 'win32',
    homeDir: 'C:\\Users\\alice',
    driveLetters: ['C', 'D']
  })
  assert.deepEqual(roots, ['C:\\Users\\alice', 'C:\\', 'D:\\'])
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
