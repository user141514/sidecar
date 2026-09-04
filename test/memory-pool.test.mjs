import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkLedger } from '../src/work-ledger.mjs'

async function loadModule() {
  try {
    return await import('../src/memory-pool.mjs')
  } catch {
    return {}
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'conversation-sidecar-memory-'))
  const workLedger = new WorkLedger(join(root, 'works'))
  const { MemoryPool } = await loadModule()
  return {
    root,
    workLedger,
    MemoryPool,
    memoryRoot: join(root, 'memory'),
    async cleanup() { await rm(root, { recursive: true, force: true }) }
  }
}

async function completedWork(workLedger, goal = 'historical task', outcome = 'completed') {
  const work = await workLedger.create(goal)
  await workLedger.append(work.id, 'observation', { fact: 'material evidence' })
  await workLedger.append(work.id, 'decision', { action: 'STOP', reason: 'done' })
  await workLedger.append(work.id, 'completed', { outcome })
  return work
}

test('MemoryPool publishes only terminal work as an immutable copied snapshot and is idempotent', async () => {
  const f = await fixture()
  try {
    assert.equal(typeof f.MemoryPool, 'function')
    if (typeof f.MemoryPool !== 'function') return

    let id = 0
    const pool = new f.MemoryPool({
      rootDir: f.memoryRoot,
      workLedger: f.workLedger,
      now: () => '2026-09-04T02:00:00.000Z',
      randomId: () => `fixed-${++id}`
    })
    const source = await completedWork(f.workLedger, 'repair completion', 'fixed')

    const first = await pool.publish(source.id)
    assert.match(first.memory_id, /^mem_/)
    assert.equal(first.pool_revision, 1)
    assert.equal(first.source_work_id, source.id)
    assert.equal(first.source_completed_event_index, 3)
    assert.match(first.source_events_sha256, /^[a-f0-9]{64}$/)
    assert.match(first.record_sha256, /^[a-f0-9]{64}$/)

    const meta = JSON.parse(await readFile(join(f.memoryRoot, 'records', first.memory_id, 'meta.json'), 'utf8'))
    assert.equal(meta.schema_version, 1)
    assert.equal(meta.record_sha256, first.record_sha256)

    const snapshotBefore = await readFile(join(f.memoryRoot, 'records', first.memory_id, 'events.jsonl'), 'utf8')
    assert.equal(snapshotBefore.trim().split('\n').length, 4)

    const second = await pool.publish(source.id)
    assert.equal(second.memory_id, first.memory_id)
    assert.equal(second.pool_revision, 1)
    assert.equal(second.existing, true)

    await f.workLedger.append(source.id, 'observation', { fact: 'post-publication source mutation' })
    const snapshotAfter = await readFile(join(f.memoryRoot, 'records', first.memory_id, 'events.jsonl'), 'utf8')
    assert.equal(snapshotAfter, snapshotBefore)

    const manifest = (await readFile(join(f.memoryRoot, 'manifest.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(manifest.length, 1)
  } finally {
    await f.cleanup()
  }
})

test('MemoryPool rejects publication before STOP plus terminal completed', async () => {
  const f = await fixture()
  try {
    assert.equal(typeof f.MemoryPool, 'function')
    if (typeof f.MemoryPool !== 'function') return
    const pool = new f.MemoryPool({ rootDir: f.memoryRoot, workLedger: f.workLedger })

    const active = await f.workLedger.create('still active')
    await assert.rejects(pool.publish(active.id), /terminal STOP \+ completed/)

    const trailing = await completedWork(f.workLedger, 'completed then changed')
    await f.workLedger.append(trailing.id, 'observation', { fact: 'late event' })
    await assert.rejects(pool.publish(trailing.id), /completed must be the final event/)
  } finally {
    await f.cleanup()
  }
})

test('MemoryPool query freezes available and matched provenance and logs zero-match queries', async () => {
  const f = await fixture()
  try {
    assert.equal(typeof f.MemoryPool, 'function')
    if (typeof f.MemoryPool !== 'function') return
    let id = 0
    const pool = new f.MemoryPool({
      rootDir: f.memoryRoot,
      workLedger: f.workLedger,
      now: () => '2026-09-04T02:00:00.000Z',
      randomId: () => `fixed-${++id}`
    })

    const a = await completedWork(f.workLedger, 'completion recovery', 'fixed')
    const b = await completedWork(f.workLedger, 'latency audit', 'passed')
    const ma = await pool.publish(a.id)
    await pool.publish(b.id)
    const current = await f.workLedger.create('new task')

    const result = await pool.query(current.id, { contains: 'completion' })
    assert.equal(result.poolRevision, 2)
    assert.match(result.manifestSha256, /^[a-f0-9]{64}$/)
    assert.equal(result.available.length, 2)
    assert.deepEqual(result.matched.map((item) => item.memory_id), [ma.memory_id])
    assert.equal(result.matches[0].goal, 'completion recovery')
    assert.equal(result.matches[0].outcome, 'fixed')

    const currentState = await f.workLedger.read(current.id)
    const queryEvent = currentState.events.at(-1)
    assert.equal(queryEvent.type, 'memory_query')
    assert.equal(queryEvent.payload.retrieval_id, result.retrievalId)
    assert.equal(queryEvent.payload.available.length, 2)
    assert.equal(queryEvent.payload.matched.length, 1)

    const none = await pool.query(current.id, { contains: 'COMPLETION' })
    assert.equal(none.matched.length, 0)
    const spaced = await pool.query(current.id, { contains: ' completion ' })
    assert.equal(spaced.matched.length, 0)
    assert.deepEqual(spaced.query, { contains: ' completion ' })
    const empty = await pool.query(current.id, { contains: '' })
    assert.equal(empty.matched.length, 2)
    assert.deepEqual(empty.query, { contains: '' })
    const afterNone = await f.workLedger.read(current.id)
    assert.equal(afterNone.events.at(-1).type, 'memory_query')
    assert.equal(afterNone.events.at(-1).payload.matched.length, 2)
  } finally {
    await f.cleanup()
  }
})

test('MemoryPool rejects unsupported query fields instead of silently changing the experiment', async () => {
  const f = await fixture()
  try {
    assert.equal(typeof f.MemoryPool, 'function')
    if (typeof f.MemoryPool !== 'function') return
    const pool = new f.MemoryPool({ rootDir: f.memoryRoot, workLedger: f.workLedger })
    const current = await f.workLedger.create('current task')

    await assert.rejects(
      pool.query(current.id, { similarity: 0.8 }),
      /unsupported memory query field/
    )
    const state = await f.workLedger.read(current.id)
    assert.equal(state.events.length, 1)
  } finally {
    await f.cleanup()
  }
})

test('MemoryPool read consumes only a matched record from the named retrieval', async () => {
  const f = await fixture()
  try {
    assert.equal(typeof f.MemoryPool, 'function')
    if (typeof f.MemoryPool !== 'function') return
    let id = 0
    const pool = new f.MemoryPool({
      rootDir: f.memoryRoot,
      workLedger: f.workLedger,
      randomId: () => `fixed-${++id}`
    })

    const source = await completedWork(f.workLedger, 'recover stale binding', 'fixed')
    const published = await pool.publish(source.id)
    const current = await f.workLedger.create('new recovery issue')
    const retrieval = await pool.query(current.id, { contains: 'stale binding' })

    const consumed = await pool.read(current.id, retrieval.retrievalId, published.memory_id)
    assert.equal(consumed.meta.memory_id, published.memory_id)
    assert.equal(consumed.events.length, 4)

    const state = await f.workLedger.read(current.id)
    const event = state.events.at(-1)
    assert.equal(event.type, 'memory_consumed')
    assert.equal(event.payload.retrieval_id, retrieval.retrievalId)
    assert.equal(event.payload.memory_id, published.memory_id)
    assert.equal(event.payload.record_sha256, published.record_sha256)

    const otherCurrent = await f.workLedger.create('other current')
    await assert.rejects(
      pool.read(otherCurrent.id, retrieval.retrievalId, published.memory_id),
      /retrieval not found/
    )
  } finally {
    await f.cleanup()
  }
})
