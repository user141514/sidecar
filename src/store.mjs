import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { canonicalTarget } from './send-mailbox.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'

function now() {
  return new Date().toISOString()
}

function statusFromEvents(events) {
  let status = 'idle'
  let latestResponse = null
  let latestTurnId = null
  let error = null
  let externalUrl = null

  for (const event of events) {
    // Delayed events from an older turn must not replace current browser facts.
    if (event.turnId && latestTurnId && event.turnId !== latestTurnId &&
        !['send_intent', 'prompt_sent'].includes(event.type)) continue
    if (event.externalUrl && !(status === 'completed' &&
        ['generation_started', 'delivery_uncertain', 'error'].includes(event.type))) externalUrl = event.externalUrl

    if (event.type === 'send_intent' || event.type === 'prompt_sent') {
      latestTurnId = event.turnId ?? latestTurnId
      status = event.type === 'send_intent' ? 'sending' : 'submitted'
      latestResponse = null
      error = null
      continue
    }

    if (event.type === 'delivery_uncertain') {
      if (status !== 'completed' && status !== 'need_continue' && status !== 'error') {
        status = 'delivery_uncertain'
        error = event.message ?? 'delivery outcome is unknown'
      }
      continue
    }

    if (event.type === 'generation_started') {
      if (status === 'completed' || status === 'need_continue' || status === 'error') continue
      if (latestTurnId === null) latestTurnId = event.turnId ?? null
      if (event.turnId === latestTurnId) {
        status = 'generating'
        latestResponse = null
        error = null
      }
      continue
    }

    if (event.type === 'response_completed') {
      if (latestTurnId === null) latestTurnId = event.turnId ?? null
      if (event.turnId === latestTurnId) {
        status = 'completed'
        latestResponse = event.text ?? ''
        error = null
      }
      continue
    }

    if (event.type === 'need_continue') {
      if (status === 'completed') continue
      if (latestTurnId === null) latestTurnId = event.turnId ?? null
      if (event.turnId === latestTurnId) {
        status = 'need_continue'
        latestResponse = event.text ?? ''
        error = null
      }
      continue
    }

    if (event.type === 'error') {
      if (status === 'completed' || status === 'need_continue') continue
      if (!event.turnId) {
        status = 'error'
        latestResponse = null
        error = event.message ?? 'unknown error'
        continue
      }
      if (latestTurnId === null) latestTurnId = event.turnId
      if (event.turnId === latestTurnId) {
        status = 'error'
        latestResponse = null
        error = event.message ?? 'unknown error'
      }
    }
  }

  return { status, latestResponse, latestTurnId, error, externalUrl }
}

export class ConversationStore {
  constructor(rootDir) {
    this.rootDir = rootDir
    this.appendQueues = new Map()
  }

  conversationDir(id) {
    return join(this.rootDir, id)
  }

  async setDefaultProjectUrl(projectUrl) {
    await mkdir(this.rootDir, { recursive: true })
    const config = { defaultProjectUrl: projectUrl }
    await writeFile(join(this.rootDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    return config
  }

  async getDefaultProjectUrl() {
    try {
      const config = JSON.parse(await readFile(join(this.rootDir, 'config.json'), 'utf8'))
      return typeof config.defaultProjectUrl === 'string' ? config.defaultProjectUrl : null
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  async create({ backend, externalUrl }) {
    const id = `conv_${randomUUID()}`
    const dir = this.conversationDir(id)
    await mkdir(dir, { recursive: true })
    const meta = {
      id,
      backend,
      externalUrl,
      status: 'idle',
      createdAt: now()
    }
    await writeFile(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
    await this.append(id, { type: 'conversation_created', externalUrl })
    return meta
  }

  async allocate({ backend, externalUrl, intentId, intentDigest = null }) {
    if (typeof backend !== 'string' || !backend.trim()) throw new TypeError('allocation backend is required')
    if (typeof externalUrl !== 'string' || !externalUrl.trim()) throw new TypeError('allocation externalUrl is required')
    if (typeof intentId !== 'string' || !intentId.trim() || intentId.length > 256) throw new TypeError('allocation intentId is invalid')
    if (intentDigest !== null && (typeof intentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(intentDigest))) {
      throw new TypeError('allocation intentDigest is invalid')
    }
    const id = `conv_${createHash('sha256').update(`conversation-allocation:v1:${intentId}`).digest('hex')}`
    return this.enqueueWrite(id, async () => {
      const dir = this.conversationDir(id)
      await mkdir(dir, { recursive: true })
      const metaPath = join(dir, 'meta.json')
      const eventsPath = join(dir, 'events.jsonl')
      const validate = (meta) => {
        if (!meta || meta.id !== id || meta.backend !== backend || meta.externalUrl !== externalUrl || meta.allocationIntentId !== intentId) {
          throw new Error('allocation identity conflict')
        }
        return meta
      }
      const legacySendExists = async () => {
        try {
          const events = (await readFile(eventsPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
          return events.some(event => event.type === 'send_intent' && event.requestId === intentId)
        } catch (error) {
          if (error?.code === 'ENOENT') return false
          throw error
        }
      }
      const validateDigest = async (meta) => {
        if (intentDigest === null) return meta
        if (meta.allocationIntentDigest === intentDigest) return meta
        if (meta.allocationIntentDigest !== undefined) throw new Error('allocation identity conflict')
        if (await legacySendExists()) return meta
        throw new Error('allocation identity conflict')
      }
      try {
        return await validateDigest(validate(JSON.parse(await readFile(metaPath, 'utf8'))))
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }

      const createdAt = now()
      const creation = {
        at: createdAt, type: 'conversation_created', externalUrl, backend, allocationIntentId: intentId,
        ...(intentDigest ? { allocationIntentDigest: intentDigest } : {})
      }
      try {
        await writeFile(eventsPath, `${JSON.stringify(creation)}\n`, { encoding: 'utf8', flag: 'wx' })
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        const lines = (await readFile(eventsPath, 'utf8')).split('\n').filter(Boolean)
        const existing = lines[0] ? JSON.parse(lines[0]) : null
        if (!existing || existing.type !== 'conversation_created' || existing.externalUrl !== externalUrl ||
            existing.backend !== backend || existing.allocationIntentId !== intentId) throw new Error('allocation identity conflict')
        if (intentDigest !== null && existing.allocationIntentDigest !== intentDigest) {
          const boundLegacy = existing.allocationIntentDigest === undefined && lines.slice(1).map(line => JSON.parse(line))
            .some(event => event.type === 'send_intent' && event.requestId === intentId)
          if (!boundLegacy) throw new Error('allocation identity conflict')
        }
      }

      const meta = {
        id, backend, externalUrl, status: 'idle', createdAt, allocationIntentId: intentId,
        ...(intentDigest ? { allocationIntentDigest: intentDigest } : {})
      }
      try {
        await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
        return meta
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        return validate(JSON.parse(await readFile(metaPath, 'utf8')))
      }
    })
  }

  enqueueWrite(id, operation) {
    const previous = this.appendQueues.get(id) ?? Promise.resolve()
    const write = previous.then(operation)
    this.appendQueues.set(id, write.catch(() => {}))
    return write
  }

  async append(id, event) {
    const record = { at: now(), ...event }
    return this.enqueueWrite(id, async () => {
      await appendFile(join(this.conversationDir(id), 'events.jsonl'), `${JSON.stringify(record)}\n`, 'utf8')
      return record
    })
  }

  async findByExternalUrl(url) {
    const key = canonicalTarget(url)
    let entries
    try { entries = await readdir(this.rootDir, { withFileTypes: true }) } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    const matches = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^conv_[a-z0-9-]+$/.test(entry.name)) continue
      const conversation = await this.read(entry.name)
      if (canonicalTarget(conversation.externalUrl, conversation.id) === key) matches.push(conversation)
    }
    return matches
  }

  async read(id) {
    const dir = this.conversationDir(id)
    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'))
    let raw = ''
    try {
      raw = await readFile(join(dir, 'events.jsonl'), 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const events = raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    const derived = statusFromEvents(events)
    return {
      ...meta,
      externalUrl: derived.externalUrl ?? meta.externalUrl,
      status: derived.status,
      latestResponse: derived.latestResponse,
      latestTurnId: derived.latestTurnId,
      error: derived.error,
      events
    }
  }
}
