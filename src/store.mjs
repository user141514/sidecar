import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
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
    if (event.externalUrl) externalUrl = event.externalUrl

    if (event.type === 'prompt_sent') {
      latestTurnId = event.turnId ?? latestTurnId
      status = 'submitted'
      latestResponse = null
      error = null
      continue
    }

    if (event.type === 'generation_started') {
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

    if (event.type === 'error') {
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

  async append(id, event) {
    const record = { at: now(), ...event }
    const previous = this.appendQueues.get(id) ?? Promise.resolve()
    const write = previous.then(async () => {
      await appendFile(join(this.conversationDir(id), 'events.jsonl'), `${JSON.stringify(record)}\n`, 'utf8')
      return record
    })
    this.appendQueues.set(id, write.catch(() => {}))
    return write
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
