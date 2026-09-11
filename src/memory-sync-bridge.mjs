import { spawn } from 'node:child_process'
import { access, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, win32 } from 'node:path'

const EXPECTED_REMOTE = 'github.com/user141514/mymem'
const SKIP_DIR_NAMES = new Set([
  '.git',
  '.cache',
  'node_modules',
  '__pycache__',
  '$Recycle.Bin',
  'System Volume Information',
  'Windows',
  'Program Files',
  'Program Files (x86)',
  'ProgramData',
  'AppData'
])

function canonicalRemoteIdentity(raw) {
  const value = String(raw ?? '').trim().replace(/\.git$/i, '')
  if (value.startsWith('git@github.com:')) {
    return `github.com/${value.slice('git@github.com:'.length)}`
  }
  try {
    const url = new URL(value)
    if (url.hostname !== 'github.com') return null
    return `github.com/${url.pathname.replace(/^\/+|\/+$/g, '')}`
  } catch {
    return null
  }
}

function runText(command, args, { cwd = undefined } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.once('error', rejectPromise)
    child.once('close', (code) => {
      if (code === 0) {
        resolvePromise(stdout.trim())
        return
      }
      rejectPromise(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`))
    })
  })
}

async function gitText(repoRoot, args) {
  try {
    return await runText('git', ['-C', repoRoot, ...args])
  } catch {
    return null
  }
}

async function inspectMymemRepo(repoRoot) {
  if (typeof repoRoot !== 'string' || !repoRoot.trim()) return null
  const resolved = resolve(repoRoot)
  try {
    await access(join(resolved, 'scripts', 'upload-local-memory.mjs'))
  } catch {
    return null
  }
  if (await gitText(resolved, ['rev-parse', '--is-inside-work-tree']) !== 'true') return null
  if (canonicalRemoteIdentity(await gitText(resolved, ['remote', 'get-url', 'origin'])) !== EXPECTED_REMOTE) return null
  return {
    repoRoot: resolved,
    branch: await gitText(resolved, ['branch', '--show-current'])
  }
}

function uniquePaths(paths, { caseInsensitive = false } = {}) {
  const seen = new Set()
  const out = []
  for (const value of paths) {
    if (typeof value !== 'string' || !value.trim()) continue
    const key = caseInsensitive ? value.toLowerCase() : value
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

export function defaultSearchRoots({
  platform = process.platform,
  homeDir = homedir(),
  driveLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
} = {}) {
  if (platform === 'win32') {
    const roots = [win32.normalize(homeDir), ...driveLetters.map((letter) => `${String(letter).toUpperCase()}:\\`)]
    return uniquePaths(roots, { caseInsensitive: true })
  }
  if (platform === 'darwin') {
    return uniquePaths([homeDir, '/Users', '/Volumes'])
  }
  return uniquePaths([homeDir, '/home', '/mnt', '/media', '/workspace', '/workspaces', '/data', '/srv', '/opt'])
}

export async function discoverGitRepos(searchRoots, { maxDepth = 10, maxRepos = 256 } = {}) {
  const found = []
  const visited = new Set()

  async function walk(dir, depth) {
    if (depth > maxDepth || found.length >= maxRepos) return
    const resolved = resolve(dir)
    if (visited.has(resolved)) return
    visited.add(resolved)

    let entries
    try {
      entries = await readdir(resolved, { withFileTypes: true })
    } catch {
      return
    }

    if (entries.some((entry) => entry.name === '.git' && (entry.isDirectory() || entry.isFile()))) {
      found.push(resolved)
      if (found.length >= maxRepos) return
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIR_NAMES.has(entry.name)) continue
      await walk(join(resolved, entry.name), depth + 1)
      if (found.length >= maxRepos) return
    }
  }

  for (const root of uniquePaths(searchRoots)) {
    await walk(root, 0)
    if (found.length >= maxRepos) break
  }
  return found
}

function chooseRepo(candidates) {
  return [...candidates].sort((a, b) => {
    const mainRank = Number(b.branch === 'main') - Number(a.branch === 'main')
    if (mainRank !== 0) return mainRank
    if (a.repoRoot.length !== b.repoRoot.length) return a.repoRoot.length - b.repoRoot.length
    return a.repoRoot.localeCompare(b.repoRoot)
  })[0] ?? null
}

function defaultRunUploader({ repoRoot, memoryRoot }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const script = join(repoRoot, 'scripts', 'upload-local-memory.mjs')
    const child = spawn(process.execPath, [script, '--source', memoryRoot], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.once('error', rejectPromise)
    child.once('close', (code) => {
      if (code === 0) {
        resolvePromise(stdout.trim())
        return
      }
      rejectPromise(new Error(stderr.trim() || stdout.trim() || `memory uploader exited with code ${code}`))
    })
  })
}

export class MemorySyncBridge {
  constructor({
    memoryRoot,
    mymemRepo,
    searchRoots = defaultSearchRoots(),
    discoverRepos = discoverGitRepos,
    retryDelayMs = 30_000,
    runUploader = defaultRunUploader,
    scheduleRetry = (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs)
      timer.unref?.()
      return timer
    },
    logger = console
  }) {
    if (typeof memoryRoot !== 'string' || !memoryRoot.trim()) throw new TypeError('memoryRoot is required')
    if (typeof mymemRepo !== 'string' || !mymemRepo.trim()) throw new TypeError('mymemRepo is required')
    this.memoryRoot = resolve(memoryRoot)
    this.preferredMymemRepo = resolve(mymemRepo)
    this.searchRoots = searchRoots
    this.discoverRepos = discoverRepos
    this.cachedMymemRepo = null
    this.discoveryAttempted = false
    this.retryDelayMs = retryDelayMs
    this.runUploader = runUploader
    this.scheduleRetry = scheduleRetry
    this.logger = logger
    this.running = false
    this.startScheduled = false
    this.retryScheduled = false
    this.queued = false
    this.idleWaiters = []
  }

  kick() {
    this.queued = true
    if (this.running || this.startScheduled) return
    this.startScheduled = true
    setImmediate(() => {
      this.startScheduled = false
      void this.#drain()
    })
  }

  whenIdle() {
    if (!this.running && !this.startScheduled) return Promise.resolve()
    return new Promise((resolvePromise) => this.idleWaiters.push(resolvePromise))
  }

  #resolveIdle() {
    if (this.running || this.startScheduled) return
    const waiters = this.idleWaiters.splice(0)
    for (const resolvePromise of waiters) resolvePromise()
  }

  #scheduleRetry() {
    if (this.retryScheduled) return
    this.retryScheduled = true
    this.scheduleRetry(() => {
      this.retryScheduled = false
      this.kick()
    }, this.retryDelayMs)
  }

  async #resolveMymemRepo() {
    const preferred = await inspectMymemRepo(this.preferredMymemRepo)
    if (preferred) {
      this.cachedMymemRepo = preferred.repoRoot
      return preferred.repoRoot
    }

    if (this.cachedMymemRepo) {
      const cached = await inspectMymemRepo(this.cachedMymemRepo)
      if (cached) return cached.repoRoot
      this.cachedMymemRepo = null
      this.discoveryAttempted = false
    }

    if (this.discoveryAttempted) return null
    this.discoveryAttempted = true
    const discovered = await this.discoverRepos(this.searchRoots)
    const valid = []
    for (const candidate of uniquePaths(discovered)) {
      const inspected = await inspectMymemRepo(candidate)
      if (inspected) valid.push(inspected)
    }
    const selected = chooseRepo(valid)
    this.cachedMymemRepo = selected?.repoRoot ?? null
    return this.cachedMymemRepo
  }

  async #drain() {
    if (this.running) return
    this.running = true
    try {
      while (this.queued) {
        this.queued = false
        const repoRoot = await this.#resolveMymemRepo()
        if (!repoRoot) break
        try {
          await this.runUploader({ repoRoot, memoryRoot: this.memoryRoot })
        } catch (error) {
          this.queued = false
          this.logger?.warn?.(`memory sync failed: ${error instanceof Error ? error.message : String(error)}`)
          this.#scheduleRetry()
          break
        }
      }
    } finally {
      this.running = false
      this.#resolveIdle()
      if (this.queued && !this.startScheduled) this.kick()
    }
  }
}
