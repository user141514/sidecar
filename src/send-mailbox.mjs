import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

const hash = value => createHash('sha256').update(value).digest('hex')
const uncertain = (pending = {}) => ({ accepted: false, reason: 'delivery_uncertain', deliveryUncertain: true, ...(pending.effect || {}) })

function defaultProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

export function canonicalTarget(target, fallbackId = '') {
  try {
    const url = new URL(target)
    const match = url.pathname.match(/\/c\/([a-z0-9-]+)\/?$/i)
    if (url.origin === 'https://chatgpt.com' && match) return `chatgpt:${match[1].toLowerCase()}`
  } catch {}
  if (fallbackId) return `local:${fallbackId}`
  throw new TypeError('exact ChatGPT conversation target is required')
}

// The disk lock has no timeout or automatic stealing. An abandoned lock or
// pending effect requires reconciliation, never an optimistic second writer.
export class SendMailbox {
  constructor({ rootDir = null, processAlive = defaultProcessAlive, pid = process.pid, ownerId = randomUUID() } = {}) {
    this.rootDir = rootDir
    this.queues = new Map()
    this.memory = new Map() // Used only by hosts with in-memory test stores.
    this.processAlive = processAlive
    this.pid = pid
    this.ownerId = ownerId
  }

  async acquireLock(lock, { allowDeadOwner = false } = {}) {
    if (!lock) return true
    await mkdir(this.rootDir, { recursive: true })
    try {
      await mkdir(lock)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (!allowDeadOwner) return false
      let owner
      try {
        owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'))
      } catch {
        return false
      }
      if (!Number.isInteger(owner?.pid) || typeof owner?.ownerId !== 'string' || !owner.ownerId) return false
      let alive = true
      try { alive = this.processAlive(owner.pid) } catch { return false }
      if (alive !== false) return false
      try {
        await rm(lock, { recursive: true })
        await mkdir(lock)
      } catch (error) {
        if (error.code === 'EEXIST') return false
        throw error
      }
    }

    try {
      const handle = await open(join(lock, 'owner.json'), 'wx')
      try {
        await handle.writeFile(`${JSON.stringify({ pid: this.pid, ownerId: this.ownerId })}\n`)
        await handle.sync()
      } finally {
        await handle.close()
      }
      return true
    } catch (error) {
      await rm(lock, { recursive: true }).catch(() => {})
      throw error
    }
  }

  async releaseLock(lock) {
    if (!lock) return
    try {
      const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'))
      if (owner?.ownerId !== this.ownerId) return
      await rm(lock, { recursive: true })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  run(target, requestId, payload, operation, fallbackId = '') {
    if (typeof requestId !== 'string' || !requestId || requestId.length > 256) throw new TypeError('invalid request id')
    const key = canonicalTarget(target, fallbackId)
    const digest = hash(JSON.stringify(payload))
    const previous = this.queues.get(key) ?? Promise.resolve()
    const run = previous.then(() => this.execute(key, requestId, digest, operation))
    const tail = run.catch(() => {})
    this.queues.set(key, tail)
    void tail.then(() => { if (this.queues.get(key) === tail) this.queues.delete(key) })
    return run
  }

  reconcile(target, requestId, result, fallbackId = '') {
    if (typeof requestId !== 'string' || !requestId || requestId.length > 256) throw new TypeError('invalid request id')
    if (result?.accepted !== true) throw new TypeError('authoritative receipt must prove accepted effect')
    const key = canonicalTarget(target, fallbackId)
    const previous = this.queues.get(key) ?? Promise.resolve()
    const run = previous.then(() => this.settlePending(key, requestId, result))
    const tail = run.catch(() => {})
    this.queues.set(key, tail)
    void tail.then(() => { if (this.queues.get(key) === tail) this.queues.delete(key) })
    return run
  }

  async settlePending(key, requestId, result) {
    const file = this.rootDir ? join(this.rootDir, `${hash(key)}.json`) : null
    const lock = file ? `${file}.lock` : null
    if (!await this.acquireLock(lock, { allowDeadOwner: true })) return uncertain()
    try {
      let state
      if (file) {
        try { state = JSON.parse(await readFile(file, 'utf8')) } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
      } else state = this.memory.get(key)
      if (!state || state.version !== 1 || state.key !== key || !state.receipts) throw new Error('mailbox request is not pending')
      if (state.receipts[requestId]?.result) return state.receipts[requestId].result
      if (!state.pending || state.pending.requestId !== requestId) return state.pending ? uncertain(state.pending) : uncertain()

      const persist = async () => {
        if (!file) { this.memory.set(key, structuredClone(state)); return }
        const temporary = `${file}.${randomUUID()}.tmp`
        const handle = await open(temporary, 'wx')
        try { await handle.writeFile(`${JSON.stringify(state)}\n`); await handle.sync() } finally { await handle.close() }
        await rename(temporary, file)
      }
      state.receipts[requestId] = { digest: state.pending.digest, result }
      state.pending = null
      await persist()
      return result
    } finally {
      await this.releaseLock(lock)
    }
  }

  async execute(key, requestId, digest, operation) {
    const file = this.rootDir ? join(this.rootDir, `${hash(key)}.json`) : null
    const lock = file ? `${file}.lock` : null
    if (!await this.acquireLock(lock)) return uncertain()
    let state
    try {
      if (file) {
        try { state = JSON.parse(await readFile(file, 'utf8')) } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
      } else state = this.memory.get(key)
      state ??= { version: 1, key, revision: 0, pending: null, receipts: {} }
      if (state.version !== 1 || state.key !== key || !Number.isInteger(state.revision) || !state.receipts) throw new Error('invalid mailbox journal')
      const receipt = state.receipts[requestId]
      if (receipt && receipt.digest !== digest) throw new Error('request identity conflict')
      if (receipt?.result) return receipt.result
      if (state.pending) return state.pending.outcome || uncertain(state.pending)

      const persist = async () => {
        if (!file) { this.memory.set(key, structuredClone(state)); return }
        const temporary = `${file}.${randomUUID()}.tmp`
        const handle = await open(temporary, 'wx')
        try { await handle.writeFile(`${JSON.stringify(state)}\n`); await handle.sync() } finally { await handle.close() }
        await rename(temporary, file)
      }
      // Receipt keys are hashes, supplied by Host. Still reject dangerous JS keys.
      if (['__proto__', 'constructor', 'prototype'].includes(requestId)) throw new TypeError('invalid request id')
      let dispatched = false
      const dispatch = async (effect = {}) => {
        if (dispatched) throw new Error('effect already reserved')
        state.revision++
        state.pending = { requestId, digest, revision: state.revision, effect, at: new Date().toISOString() }
        await persist()
        dispatched = true
      }
      let result
      try {
        result = await operation(dispatch)
      } catch (error) {
        if (!dispatched) throw error
        if (error.definiteRejection === true) {
          state.pending = null
          await persist()
          throw error
        }
        result = { ...uncertain(state.pending), message: error.message || 'delivery uncertain' }
      }
      if (result?.deliveryUncertain === true || result?.reason === 'delivery_uncertain') {
        // Keep the reservation even if the transport error arrived as a result.
        if (!state.pending) await dispatch()
        state.pending.outcome = result
        await persist()
        return result
      }
      state.pending = null
      state.receipts[requestId] = { digest, ...((result?.accepted === true || result?.reason === 'stale_intent') ? { result } : {}) }
      await persist()
      return result
    } finally {
      await this.releaseLock(lock)
    }
  }
}
