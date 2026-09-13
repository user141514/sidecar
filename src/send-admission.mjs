import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

const VERSION = 1

async function readState(statePath) {
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8'))
    if (parsed?.version !== VERSION || !Number.isFinite(parsed.lastAdmittedAt)) {
      throw new Error('invalid send admission state')
    }
    return parsed
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function writeState(statePath, state) {
  await mkdir(dirname(statePath), { recursive: true })
  const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(state)}\n`, 'utf8')
  await rename(temporary, statePath)
}

export class SendAdmission {
  constructor({ statePath, intervalMs = 120_000, now = () => Date.now() }) {
    if (typeof statePath !== 'string' || !statePath) throw new TypeError('statePath is required')
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new TypeError('intervalMs must be > 0')
    this.statePath = statePath
    this.intervalMs = intervalMs
    this.now = now
    this.queue = Promise.resolve()
  }

  admit({ source, target }) {
    if (typeof source !== 'string' || !source.trim()) throw new TypeError('source is required')
    if (typeof target !== 'string' || !target.trim()) throw new TypeError('target is required')
    const run = this.queue.then(() => this.#admit(source.trim(), target.trim()))
    this.queue = run.catch(() => {})
    return run
  }

  async #admit(source, target) {
    const current = Number(this.now())
    if (!Number.isFinite(current)) throw new Error('send admission clock returned an invalid time')
    const previous = await readState(this.statePath)
    if (previous) {
      const elapsed = current - previous.lastAdmittedAt
      if (elapsed < this.intervalMs) {
        return {
          admitted: false,
          retryAfterMs: this.intervalMs - elapsed,
          lastAdmittedAt: previous.lastAdmittedAt
        }
      }
    }

    const state = {
      version: VERSION,
      lastAdmittedAt: current,
      source,
      target
    }
    await writeState(this.statePath, state)
    return { admitted: true, admittedAt: current }
  }
}
