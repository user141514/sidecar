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
    if (event.turnId) latestTurnId = event.turnId
    if (event.type === 'prompt_sent') status = 'submitted'
    if (event.type === 'generation_started') status = 'generating'
    if (event.type === 'response_completed') {
      status = 'completed'
      latestResponse = event.text ?? ''
      error = null
    }
    if (event.type === 'error') {
      status = 'error'
      error = event.message ?? 'unknown error'
    }
  }

  return { status, latestResponse, latestTurnId, error, externalUrl }
}

export class ConversationStore {
  constructor(rootDir) {
    this.rootDir = rootDir
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
    await appendFile(join(this.conversationDir(id), 'events.jsonl'), `${JSON.stringify(record)}\n`, 'utf8')
    return record
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
