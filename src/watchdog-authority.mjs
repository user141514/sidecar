import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { exactConversationUuid } from './conversation-adoption.mjs'

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const denied = reason => ({ accepted: false, reason })

// Admission and revocation belong to the writer. Registry membership remains
// outside this journal; a tombstone prevents delayed HTTP requests or a restart
// from restoring permission for an old registration generation.
export class WatchdogAuthority {
  constructor({ rootDir = null, writerEpoch = 0 } = {}) {
    if (!Number.isSafeInteger(writerEpoch) || writerEpoch < 0) throw new TypeError('writerEpoch required')
    this.writerEpoch = writerEpoch
    this.revoked = new Set()
    this.rootDir = rootDir
    this.records = new Map()
    this.queues = new Map()
    this.operations = new Map()
  }

  #identity({ registrationId, target }) {
    if (typeof registrationId !== 'string' || !UUID.test(registrationId)) throw new TypeError('registrationId UUID required')
    const uuid = exactConversationUuid(target)
    return { registrationId: registrationId.toLowerCase(), target: 'https://chatgpt.com/c/' + uuid }
  }

  #serial(id, action) {
    const previous = this.queues.get(id) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(action)
    const tail = run.catch(() => {})
    this.queues.set(id, tail)
    void tail.then(() => { if (this.queues.get(id) === tail) this.queues.delete(id) })
    return run
  }

  async #load(id) {
    if (this.records.has(id)) return this.records.get(id)
    let record = null
    if (this.rootDir) {
      try { record = JSON.parse(await readFile(join(this.rootDir, id + '.json'), 'utf8')) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    if (record && (record.version !== 1 || record.registrationId !== id ||
        !['active', 'revoked'].includes(record.status) ||
        (record.writerEpoch !== undefined && (!Number.isSafeInteger(record.writerEpoch) || record.writerEpoch < 0)) ||
        this.#identity(record).target !== record.target)) {
      throw new Error('invalid watchdog authority journal')
    }
    this.records.set(id, record)
    if (record?.status === 'revoked') this.revoked.add(id)
    return record
  }

  async #save(record) {
    if (this.rootDir) {
      await mkdir(this.rootDir, { recursive: true })
      const file = join(this.rootDir, record.registrationId + '.json')
      const temporary = file + '.' + randomUUID() + '.tmp'
      let handle
      try {
        handle = await open(temporary, 'wx')
        await handle.writeFile(JSON.stringify(record) + '\n', 'utf8')
        await handle.sync()
        await handle.close()
        handle = null
        await rename(temporary, file)
      } catch (error) {
        await handle?.close().catch(() => {})
        await rm(temporary, { force: true }).catch(() => {})
        throw error
      }
    }
    this.records.set(record.registrationId, record)
  }

  async #permission(identity) {
    if (this.revoked.has(identity.registrationId)) return denied('registration_revoked')
    const prior = await this.#load(identity.registrationId)
    if (this.revoked.has(identity.registrationId) || !prior || prior.status !== 'active') return denied('registration_revoked')
    if (prior.target !== identity.target) return denied('registration_target_mismatch')
    if (prior.writerEpoch !== this.writerEpoch) return denied('watchdog_binding_required')
    return { accepted: true }
  }

  assertActive(payload) {
    const identity = this.#identity(payload)
    return this.#serial(identity.registrationId, () => this.#permission(identity))
  }

  async assertRevoked(payload) {
    const identity = this.#identity(payload)
    // Admission requires an existing durable fact, never a memory-only fence.
    if (!this.rootDir) return denied('durable_revocation_required')
    let record
    try { record = JSON.parse(await readFile(join(this.rootDir, identity.registrationId + '.json'), 'utf8')) }
    catch { return denied('durable_revocation_required') }
    if (record?.version !== 1 || record.registrationId !== identity.registrationId || record.status !== 'revoked' ||
        !Number.isSafeInteger(record.writerEpoch) || record.writerEpoch < 0) return denied('durable_revocation_required')
    if (record.target !== identity.target) return denied('registration_target_mismatch')
    return { accepted: true, ...identity }
  }

  bind(payload) {
    const identity = this.#identity(payload)
    return this.#serial(identity.registrationId, async () => {
      const prior = await this.#load(identity.registrationId)
      if (prior?.target !== undefined && prior.target !== identity.target) return denied('registration_target_mismatch')
      if (this.revoked.has(identity.registrationId) || prior?.status === 'revoked') return denied('registration_revoked')
      if (!prior || prior.writerEpoch !== this.writerEpoch) {
        await this.#save({ version: 1, ...identity, status: 'active', writerEpoch: this.writerEpoch })
      }
      if (this.revoked.has(identity.registrationId)) return denied('registration_revoked')
      return { accepted: true, ...identity }
    })
  }

  async run(payload, action) {
    const identity = this.#identity(payload)
    let finish
    const done = new Promise(resolve => { finish = resolve })
    const admission = await this.#serial(identity.registrationId, async () => {
      const permission = await this.#permission(identity)
      if (!permission.accepted) return permission
      let active = this.operations.get(identity.registrationId)
      if (!active) this.operations.set(identity.registrationId, active = new Set())
      active.add(done)
      return { accepted: true }
    })
    if (!admission.accepted) return admission
    try {
      if (this.revoked.has(identity.registrationId)) return denied('registration_revoked')
      return await action()
    }
    finally {
      this.operations.get(identity.registrationId)?.delete(done)
      finish()
    }
  }

  async withdraw(payload, quiesce) {
    const identity = this.#identity(payload)
    const cached = this.records.get(identity.registrationId)
    if (cached && cached.target !== identity.target) {
      return { ...denied('registration_target_mismatch'), quiescent: false, registrationId: identity.registrationId }
    }
    const alreadyRevoked = this.revoked.has(identity.registrationId)
    this.revoked.add(identity.registrationId)
    let pending
    try {
      pending = await this.#serial(identity.registrationId, async () => {
        const prior = await this.#load(identity.registrationId)
        if (prior && prior.target !== identity.target) {
          if (!alreadyRevoked && prior.status !== 'revoked') this.revoked.delete(identity.registrationId)
          return null
        }
        const revoked = { version: 1, ...identity, status: 'revoked', writerEpoch: this.writerEpoch }
        this.records.set(identity.registrationId, revoked)
        // Retry persistence even when memory was already revoked by a failed
        // write. No withdrawal ACK may rely on that memory-only tombstone.
        await this.#save(revoked)
        return [...(this.operations.get(identity.registrationId) ?? [])]
      })
    } catch {
      return { accepted: false, quiescent: false, reason: 'revocation_persistence_failed', registrationId: identity.registrationId }
    }
    if (pending === null) return { ...denied('registration_target_mismatch'), quiescent: false, registrationId: identity.registrationId }
    await Promise.all(pending)
    try {
      const result = await quiesce()
      if (result?.quiescent === true) return { accepted: true, quiescent: true, registrationId: identity.registrationId }
    } catch {}
    return { accepted: false, quiescent: false, reason: 'effect_outcome_unknown', registrationId: identity.registrationId }
  }
}
