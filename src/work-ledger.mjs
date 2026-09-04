import { appendFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

const EVENT_TYPES = new Set([
  'goal',
  'action',
  'observation',
  'decision',
  'worker_dispatched',
  'worker_result',
  'memory_query',
  'memory_consumed',
  'completed'
])

function now() {
  return new Date().toISOString()
}

export class WorkLedger {
  constructor(rootDir) {
    this.rootDir = rootDir
  }

  workDir(id) {
    if (typeof id !== 'string' || !/^work_[a-z0-9-]+$/.test(id)) throw new TypeError('invalid work id')
    return join(this.rootDir, id)
  }

  async checkedWorkDir(id) {
    const dir = this.workDir(id)
    const [root, resolved] = await Promise.all([realpath(this.rootDir), realpath(dir)])
    if (resolved !== join(root, id)) throw new TypeError('invalid work directory')
    return dir
  }

  async create(goal) {
    if (typeof goal !== 'string' || !goal.trim()) throw new TypeError('goal is required')
    const id = `work_${randomUUID()}`
    const dir = this.workDir(id)
    const meta = { id, createdAt: now() }
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
    await this.append(id, 'goal', { goal: goal.trim() })
    return meta
  }

  async append(id, type, payload = {}) {
    if (!EVENT_TYPES.has(type)) throw new TypeError(`unsupported work event type: ${type}`)
    if (JSON.stringify(payload) === undefined) throw new TypeError('payload must be JSON-serializable')
    const dir = await this.checkedWorkDir(id)
    const event = { at: now(), type, payload }
    await appendFile(join(dir, 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8')
    return event
  }

  async read(id) {
    const dir = await this.checkedWorkDir(id)
    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'))
    const raw = await readFile(join(dir, 'events.jsonl'), 'utf8')
    return {
      ...meta,
      events: raw.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    }
  }
}
