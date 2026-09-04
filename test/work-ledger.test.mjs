import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function loadModule() {
  try {
    return await import('../src/work-ledger.mjs')
  } catch {
    return {}
  }
}

test('WorkLedger persists an append-only observable work trajectory', async () => {
  const { WorkLedger } = await loadModule()
  assert.equal(typeof WorkLedger, 'function')
  if (typeof WorkLedger !== 'function') return

  const root = await mkdtemp(join(tmpdir(), 'conversation-sidecar-work-ledger-'))
  try {
    const ledger = new WorkLedger(root)
    const work = await ledger.create('inspect recovery behavior')

    assert.match(work.id, /^work_[a-z0-9-]+$/)

    await ledger.append(work.id, 'action', { name: 'read_source' })
    await ledger.append(work.id, 'observation', { fact: 'binding is stale' })
    await ledger.append(work.id, 'decision', { action: 'split' })
    await ledger.append(work.id, 'worker_dispatched', { workerId: 'conv_a' })
    await ledger.append(work.id, 'worker_result', { workerId: 'conv_a', outcome: 'completed' })
    await ledger.append(work.id, 'completed', { outcome: 'fixed' })

    const state = await ledger.read(work.id)
    assert.equal(state.id, work.id)
    assert.deepEqual(state.events.map((event) => event.type), [
      'goal',
      'action',
      'observation',
      'decision',
      'worker_dispatched',
      'worker_result',
      'completed'
    ])
    assert.deepEqual(state.events[0].payload, { goal: 'inspect recovery behavior' })
    assert.equal(typeof state.events[0].at, 'string')

    const raw = await readFile(join(root, work.id, 'events.jsonl'), 'utf8')
    assert.equal(raw.trim().split('\n').length, 7)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('WorkLedger rejects work ids that escape the ledger root', async () => {
  const { WorkLedger } = await loadModule()
  assert.equal(typeof WorkLedger, 'function')
  if (typeof WorkLedger !== 'function') return

  const root = await mkdtemp(join(tmpdir(), 'conversation-sidecar-work-ledger-'))
  try {
    const ledger = new WorkLedger(root)
    await assert.rejects(
      ledger.append('../outside', 'action', { name: 'escape' }),
      /invalid work id/
    )
    await assert.rejects(
      ledger.read('../outside'),
      /invalid work id/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('WorkLedger rejects work directories that resolve outside the ledger root', async () => {
  const { WorkLedger } = await loadModule()
  assert.equal(typeof WorkLedger, 'function')
  if (typeof WorkLedger !== 'function') return

  const root = await mkdtemp(join(tmpdir(), 'conversation-sidecar-work-ledger-'))
  const outside = await mkdtemp(join(tmpdir(), 'conversation-sidecar-work-ledger-outside-'))
  try {
    const ledger = new WorkLedger(root)
    await symlink(outside, join(root, 'work_escape'), 'dir')
    await assert.rejects(
      ledger.append('work_escape', 'action', { name: 'escape' }),
      /invalid work directory/
    )
    await assert.rejects(
      ledger.read('work_escape'),
      /invalid work directory/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('WorkLedger rejects payloads that would disappear from persisted events', async () => {
  const { WorkLedger } = await loadModule()
  assert.equal(typeof WorkLedger, 'function')
  if (typeof WorkLedger !== 'function') return

  const root = await mkdtemp(join(tmpdir(), 'conversation-sidecar-work-ledger-'))
  try {
    const ledger = new WorkLedger(root)
    const work = await ledger.create('probe')
    await assert.rejects(
      ledger.append(work.id, 'action', () => {}),
      /payload must be JSON-serializable/
    )
    const state = await ledger.read(work.id)
    assert.equal(state.events.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('WorkLedger rejects event types outside the minimal schema', async () => {
  const { WorkLedger } = await loadModule()
  assert.equal(typeof WorkLedger, 'function')
  if (typeof WorkLedger !== 'function') return

  const root = await mkdtemp(join(tmpdir(), 'conversation-sidecar-work-ledger-'))
  try {
    const ledger = new WorkLedger(root)
    const work = await ledger.create('probe')
    await assert.rejects(
      ledger.append(work.id, 'branch_utility', { score: 0.9 }),
      /unsupported work event type/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('WorkLedger compare-and-append accepts the exact current event count', async () => {
  const { WorkLedger } = await loadModule()
  assert.equal(typeof WorkLedger, 'function')
  if (typeof WorkLedger !== 'function') return

  const root = await mkdtemp(join(tmpdir(), 'conversation-sidecar-work-ledger-'))
  try {
    const ledger = new WorkLedger(root)
    const work = await ledger.create('checkpoint')
    const event = await ledger.appendIfEventCount(work.id, 1, 'decision', {
      action: 'CONTINUE',
      reason: 'state is current'
    })
    assert.equal(event.type, 'decision')
    assert.equal((await ledger.read(work.id)).events.length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('WorkLedger compare-and-append rejects stale state after another queued append', async () => {
  const { WorkLedger } = await loadModule()
  assert.equal(typeof WorkLedger, 'function')
  if (typeof WorkLedger !== 'function') return

  const root = await mkdtemp(join(tmpdir(), 'conversation-sidecar-work-ledger-'))
  try {
    const ledger = new WorkLedger(root)
    const work = await ledger.create('checkpoint')
    const first = ledger.append(work.id, 'observation', { fact: 'new evidence' })
    const stale = ledger.appendIfEventCount(work.id, 1, 'decision', {
      action: 'CONTINUE',
      reason: 'based on old state'
    })
    await first
    await assert.rejects(stale, /stale work state: expected 1, current 2/)
    assert.equal((await ledger.read(work.id)).events.length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
