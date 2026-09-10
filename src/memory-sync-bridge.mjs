import { spawn, spawnSync } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const EXPECTED_REMOTE = 'github.com/user141514/mymem'

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

function gitText(repoRoot, args) {
  const result = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' })
  if (result.status !== 0) return null
  return result.stdout.trim()
}

async function isEligibleMymemRepo(repoRoot) {
  if (gitText(repoRoot, ['rev-parse', '--is-inside-work-tree']) !== 'true') return false
  if (canonicalRemoteIdentity(gitText(repoRoot, ['remote', 'get-url', 'origin'])) !== EXPECTED_REMOTE) return false
  try {
    await access(join(repoRoot, 'scripts', 'upload-local-memory.mjs'))
    return true
  } catch {
    return false
  }
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
    this.mymemRepo = resolve(mymemRepo)
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

  async #drain() {
    if (this.running) return
    this.running = true
    try {
      while (this.queued) {
        this.queued = false
        if (!(await isEligibleMymemRepo(this.mymemRepo))) break
        try {
          await this.runUploader({ repoRoot: this.mymemRepo, memoryRoot: this.memoryRoot })
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
