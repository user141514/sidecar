import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

async function loadReplay() {
  try {
    return await import('../src/decision-replay.mjs')
  } catch {
    return {}
  }
}

function event(type, payload, at) {
  return { at, type, payload }
}

test('decision replay reconstructs state from only the causal prefix before each decision', async () => {
  const { buildDecisionReplay } = await loadReplay()
  assert.equal(typeof buildDecisionReplay, 'function')
  if (typeof buildDecisionReplay !== 'function') return

  const work = {
    id: 'work_replay-test',
    createdAt: '2026-09-09T00:00:00.000Z',
    events: [
      event('goal', { goal: 'diagnose a failure' }, '2026-09-09T00:00:00.000Z'),
      event('observation', { fact: 'first evidence' }, '2026-09-09T00:00:01.000Z'),
      event('decision', {
        action: 'REVISE',
        reason: 'use first evidence',
        evidence_event_indexes: [1],
        plan: {
          objective: 'diagnose a failure',
          approach: 'inspect evidence',
          current_focus: 'first branch',
          assumptions: [],
          open_questions: []
        },
        orchestration: { mode: 'EXPLORE' }
      }, '2026-09-09T00:00:02.000Z'),
      event('observation', { fact: 'future secret' }, '2026-09-09T00:00:03.000Z'),
      event('decision', { action: 'STOP', reason: 'resolved' }, '2026-09-09T00:00:04.000Z'),
      event('completed', { outcome: 'completed' }, '2026-09-09T00:00:05.000Z')
    ]
  }

  const replay = buildDecisionReplay(work)
  assert.equal(replay.schema_version, 1)
  assert.equal(replay.work_id, work.id)
  assert.equal(replay.samples.length, 2)

  const first = replay.samples[0]
  assert.equal(first.decision_index, 2)
  assert.deepEqual(first.decision, work.events[2].payload)
  assert.equal(first.state_before.eventCount, 2)
  assert.equal(first.state_before.latestDecision, null)
  assert.equal(first.state_before.events.length, 2)
  assert.equal(first.state_before.events.some((item) => item.payload?.fact === 'future secret'), false)
  assert.equal(first.state_before.events.some((item) => item.type === 'completed'), false)

  const second = replay.samples[1]
  assert.equal(second.decision_index, 4)
  assert.equal(second.state_before.eventCount, 4)
  assert.equal(second.state_before.latestDecision.action, 'REVISE')
  assert.equal(second.state_before.events.some((item) => item.payload?.fact === 'future secret'), true)
  assert.equal(second.state_before.events.some((item) => item.type === 'completed'), false)
})

test('decision replay rejects malformed decision payloads instead of silently omitting them', async () => {
  const { buildDecisionReplay } = await loadReplay()
  assert.equal(typeof buildDecisionReplay, 'function')
  if (typeof buildDecisionReplay !== 'function') return

  const work = {
    id: 'work_malformed-decision',
    createdAt: '2026-09-09T00:00:00.000Z',
    events: [
      event('goal', { goal: 'malformed' }, '2026-09-09T00:00:00.000Z'),
      { at: '2026-09-09T00:00:01.000Z', type: 'decision' }
    ]
  }

  assert.throws(() => buildDecisionReplay(work), /decision payload must be an object/i)
})

test('decision replay preserves legacy decision actions instead of normalizing them', async () => {
  const { buildDecisionReplay } = await loadReplay()
  assert.equal(typeof buildDecisionReplay, 'function')
  if (typeof buildDecisionReplay !== 'function') return

  const work = {
    id: 'work_legacy-test',
    createdAt: '2026-09-09T00:00:00.000Z',
    events: [
      event('goal', { goal: 'legacy work' }, '2026-09-09T00:00:00.000Z'),
      event('decision', { action: 'implement_dynamic_controller', reason: 'legacy action' }, '2026-09-09T00:00:01.000Z')
    ]
  }

  const replay = buildDecisionReplay(work)
  assert.equal(replay.samples.length, 1)
  assert.equal(replay.samples[0].decision.action, 'implement_dynamic_controller')
})

test('decision replay dataset preserves per-work schema, sorts by work id, and rejects duplicates', async () => {
  const { buildDecisionReplayDataset } = await loadReplay()
  assert.equal(typeof buildDecisionReplayDataset, 'function')
  if (typeof buildDecisionReplayDataset !== 'function') return

  const workB = {
    id: 'work_b',
    createdAt: '2026-09-09T00:00:00.000Z',
    events: [
      event('goal', { goal: 'b' }, '2026-09-09T00:00:00.000Z'),
      event('decision', { action: 'STOP', reason: 'b done' }, '2026-09-09T00:00:01.000Z')
    ]
  }
  const workA = {
    id: 'work_a',
    createdAt: '2026-09-09T00:00:00.000Z',
    events: [
      event('goal', { goal: 'a' }, '2026-09-09T00:00:00.000Z'),
      event('decision', { action: 'CONTINUE', reason: 'legacy stays structured' }, '2026-09-09T00:00:01.000Z')
    ]
  }

  const dataset = buildDecisionReplayDataset([workB, workA])
  assert.deepEqual(dataset.map((item) => item.work_id), ['work_a', 'work_b'])
  assert.equal(dataset[0].schema_version, 1)
  assert.equal(dataset[0].samples[0].decision.action, 'CONTINUE')
  assert.deepEqual(Object.keys(dataset[0]), ['schema_version', 'work_id', 'source_event_count', 'samples'])
  assert.throws(() => buildDecisionReplayDataset([workA, workA]), /duplicate work id/i)
})

test('decision replay directory loader reads complete work ledgers deterministically and fails closed', async (t) => {
  const { loadDecisionReplayDirectory } = await loadReplay()
  assert.equal(typeof loadDecisionReplayDirectory, 'function')
  if (typeof loadDecisionReplayDirectory !== 'function') return

  const root = await mkdtemp(join(tmpdir(), 'decision-replay-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  async function writeWork(id, action) {
    const dir = join(root, id)
    await mkdir(dir)
    await writeFile(join(dir, 'meta.json'), `${JSON.stringify({ id, createdAt: '2026-09-09T00:00:00.000Z' })}\n`, 'utf8')
    await writeFile(join(dir, 'events.jsonl'), [
      JSON.stringify(event('goal', { goal: id }, '2026-09-09T00:00:00.000Z')),
      JSON.stringify(event('decision', { action, reason: id }, '2026-09-09T00:00:01.000Z')),
      ''
    ].join('\n'), 'utf8')
  }

  await writeWork('work_z', 'STOP')
  await writeWork('work_a', 'CONTINUE')

  const dataset = await loadDecisionReplayDirectory(root)
  assert.deepEqual(dataset.map((item) => item.work_id), ['work_a', 'work_z'])
  assert.equal(dataset.reduce((sum, item) => sum + item.samples.length, 0), 2)

  const badDir = join(root, 'work_bad')
  await mkdir(badDir)
  await writeFile(join(badDir, 'meta.json'), `${JSON.stringify({ id: 'work_bad', createdAt: '2026-09-09T00:00:00.000Z' })}\n`, 'utf8')
  await writeFile(join(badDir, 'events.jsonl'), '{not-json}\n', 'utf8')
  await assert.rejects(() => loadDecisionReplayDirectory(root), /JSON|position|property|unexpected/i)
})

test('decision replay CLI emits deterministic per-work JSONL to stdout', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'decision-replay-cli-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  async function writeWork(id, action) {
    const dir = join(root, id)
    await mkdir(dir)
    await writeFile(join(dir, 'meta.json'), `${JSON.stringify({ id, createdAt: '2026-09-09T00:00:00.000Z' })}\n`, 'utf8')
    await writeFile(join(dir, 'events.jsonl'), [
      JSON.stringify(event('goal', { goal: id }, '2026-09-09T00:00:00.000Z')),
      JSON.stringify(event('decision', { action, reason: id }, '2026-09-09T00:00:01.000Z')),
      ''
    ].join('\n'), 'utf8')
  }

  await writeWork('work_z', 'STOP')
  await writeWork('work_a', 'CONTINUE')

  const script = fileURLToPath(new URL('../scripts/export-decision-replay.mjs', import.meta.url))
  const { stdout, stderr } = await execFileAsync(process.execPath, [script, root], { encoding: 'utf8' })
  assert.equal(stderr, '')
  assert.equal(stdout.endsWith('\n'), true)
  const rows = stdout.trimEnd().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(rows.map((item) => item.work_id), ['work_a', 'work_z'])
  assert.equal(rows[0].samples[0].decision.action, 'CONTINUE')
})
