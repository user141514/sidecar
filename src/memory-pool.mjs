import { appendFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key])
    return out
  }
  return value
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalEvents(events) {
  return `${events.map((event) => canonicalJson(event)).join('\n')}\n`
}

function parseJsonl(raw) {
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

function requireString(value, message) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(message)
  return value.trim()
}

function preview(events, manifestEntry) {
  const goal = events.find((event) => event.type === 'goal')?.payload?.goal ?? null
  const outcome = [...events].reverse().find((event) => event.type === 'completed')?.payload?.outcome ?? null
  return {
    memory_id: manifestEntry.memory_id,
    source_work_id: manifestEntry.source_work_id,
    published_at: manifestEntry.published_at,
    record_sha256: manifestEntry.record_sha256,
    goal,
    outcome
  }
}

export class MemoryPool {
  constructor({ rootDir, workLedger, now = () => new Date().toISOString(), randomId = randomUUID }) {
    this.rootDir = rootDir
    this.workLedger = workLedger
    this.now = now
    this.randomId = randomId
    this.publishQueue = Promise.resolve()
  }

  async ensureRoot() {
    await mkdir(this.rootDir, { recursive: true })
    await mkdir(join(this.rootDir, 'records'), { recursive: true })
  }

  manifestPath() {
    return join(this.rootDir, 'manifest.jsonl')
  }

  memoryDir(memoryId) {
    if (typeof memoryId !== 'string' || !/^mem_[a-z0-9-]+$/i.test(memoryId)) throw new TypeError('invalid memory id')
    return join(this.rootDir, 'records', memoryId)
  }

  async readManifestRaw() {
    await this.ensureRoot()
    try {
      return await readFile(this.manifestPath(), 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return ''
      throw error
    }
  }

  async readManifest() {
    return parseJsonl(await this.readManifestRaw())
  }

  async checkedMemoryDir(memoryId) {
    const dir = this.memoryDir(memoryId)
    const recordsRoot = join(this.rootDir, 'records')
    const [root, resolved] = await Promise.all([realpath(recordsRoot), realpath(dir)])
    if (resolved !== join(root, memoryId)) throw new TypeError('invalid memory directory')
    return dir
  }

  async loadRecord(memoryId, expectedHash = null) {
    const dir = await this.checkedMemoryDir(memoryId)
    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'))
    const eventsRaw = await readFile(join(dir, 'events.jsonl'), 'utf8')
    const { record_sha256: storedHash, ...baseMeta } = meta
    const actualHash = sha256(`${canonicalJson(baseMeta)}\n${eventsRaw}`)
    if (storedHash !== actualHash || (expectedHash && expectedHash !== actualHash)) {
      throw new Error(`memory record hash mismatch: ${memoryId}`)
    }
    return { meta, eventsRaw, events: parseJsonl(eventsRaw) }
  }

  async publish(sourceWorkId) {
    const run = this.publishQueue.then(() => this.#publish(sourceWorkId))
    this.publishQueue = run.catch(() => {})
    return run
  }

  async #publish(sourceWorkId) {
    await this.ensureRoot()
    const work = await this.workLedger.read(requireString(sourceWorkId, 'source_work_id is required'))
    const completedIndex = work.events.findIndex((event) => event.type === 'completed')
    const hasStop = work.events.some((event, index) => index < completedIndex && event.type === 'decision' && event.payload?.action === 'STOP')
    if (completedIndex < 0 || !hasStop) throw new Error('source work requires terminal STOP + completed')
    if (completedIndex !== work.events.length - 1) throw new Error('completed must be the final event')

    const eventsRaw = canonicalEvents(work.events)
    const sourceEventsSha256 = sha256(eventsRaw)
    const manifestRaw = await this.readManifestRaw()
    const manifest = parseJsonl(manifestRaw)
    const existing = manifest.find((entry) =>
      entry.source_work_id === work.id &&
      entry.source_completed_event_index === completedIndex &&
      entry.source_events_sha256 === sourceEventsSha256
    )
    if (existing) return { ...existing, existing: true }

    const memoryId = `mem_${this.randomId()}`
    const publishedAt = this.now()
    const poolRevision = manifest.length + 1
    const baseMeta = {
      schema_version: 1,
      memory_id: memoryId,
      pool_revision: poolRevision,
      published_at: publishedAt,
      source_completed_event_index: completedIndex,
      source_events_sha256: sourceEventsSha256,
      source_work_id: work.id
    }
    const recordSha256 = sha256(`${canonicalJson(baseMeta)}\n${eventsRaw}`)
    const meta = { ...baseMeta, record_sha256: recordSha256 }
    const dir = this.memoryDir(memoryId)
    await mkdir(dir)
    await writeFile(join(dir, 'events.jsonl'), eventsRaw, 'utf8')
    await writeFile(join(dir, 'meta.json'), `${canonicalJson(meta)}\n`, 'utf8')

    const manifestEntry = {
      pool_revision: poolRevision,
      memory_id: memoryId,
      source_work_id: work.id,
      published_at: publishedAt,
      source_completed_event_index: completedIndex,
      source_events_sha256: sourceEventsSha256,
      record_sha256: recordSha256
    }
    await appendFile(this.manifestPath(), `${canonicalJson(manifestEntry)}\n`, 'utf8')
    return meta
  }

  async query(workId, query = {}) {
    await this.publishQueue
    const currentWorkId = requireString(workId, 'work_id is required')
    if (!query || typeof query !== 'object' || Array.isArray(query)) throw new TypeError('memory query must be an object')
    const unsupported = Object.keys(query).find((key) => key !== 'contains')
    if (unsupported) throw new TypeError(`unsupported memory query field: ${unsupported}`)
    if (query.contains !== undefined && typeof query.contains !== 'string') throw new TypeError('contains must be a string')
    const contains = query.contains
    const current = await this.workLedger.read(currentWorkId)
    if (current.events.some((event) => event.type === 'completed' || (event.type === 'decision' && event.payload?.action === 'STOP'))) {
      throw new Error('current work is stopped')
    }

    const manifestRaw = await this.readManifestRaw()
    const manifest = parseJsonl(manifestRaw)
    const manifestSha256 = sha256(manifestRaw)
    const available = manifest.map((entry) => ({
      memory_id: entry.memory_id,
      source_work_id: entry.source_work_id,
      published_at: entry.published_at,
      record_sha256: entry.record_sha256
    }))

    const matched = []
    const matches = []
    for (const entry of manifest) {
      const record = await this.loadRecord(entry.memory_id, entry.record_sha256)
      if (contains !== undefined && !record.eventsRaw.includes(contains)) continue
      const provenance = {
        memory_id: entry.memory_id,
        source_work_id: entry.source_work_id,
        published_at: entry.published_at,
        record_sha256: entry.record_sha256
      }
      matched.push(provenance)
      matches.push(preview(record.events, entry))
    }

    const retrievalId = `retrieval_${this.randomId()}`
    const retrievedAt = this.now()
    const normalizedQuery = contains === undefined ? {} : { contains }
    await this.workLedger.append(currentWorkId, 'memory_query', {
      retrieval_id: retrievalId,
      retrieved_at: retrievedAt,
      pool_revision: manifest.length,
      manifest_sha256: manifestSha256,
      query: normalizedQuery,
      available,
      matched
    })

    return {
      retrievalId,
      retrievedAt,
      poolRevision: manifest.length,
      manifestSha256,
      query: normalizedQuery,
      available,
      matched,
      matches
    }
  }

  async read(workId, retrievalId, memoryId) {
    await this.publishQueue
    const currentWorkId = requireString(workId, 'work_id is required')
    const retrieval = requireString(retrievalId, 'retrieval_id is required')
    const memory = requireString(memoryId, 'memory_id is required')
    const current = await this.workLedger.read(currentWorkId)
    if (current.events.some((event) => event.type === 'completed' || (event.type === 'decision' && event.payload?.action === 'STOP'))) {
      throw new Error('current work is stopped')
    }
    const queryEvent = [...current.events].reverse().find((event) =>
      event.type === 'memory_query' && event.payload?.retrieval_id === retrieval
    )
    if (!queryEvent) throw new Error(`retrieval not found: ${retrieval}`)
    const matched = queryEvent.payload.matched?.find((entry) => entry.memory_id === memory)
    if (!matched) throw new Error(`memory was not matched by retrieval: ${memory}`)

    const record = await this.loadRecord(memory, matched.record_sha256)
    await this.workLedger.append(currentWorkId, 'memory_consumed', {
      retrieval_id: retrieval,
      memory_id: memory,
      source_work_id: matched.source_work_id,
      record_sha256: matched.record_sha256
    })
    return { meta: record.meta, events: record.events }
  }
}
