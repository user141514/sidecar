import { readdir } from 'node:fs/promises'
import { WorkLedger } from './work-ledger.mjs'
import { deriveState } from './work-controller.mjs'

export function buildDecisionReplay(work) {
  if (!work || typeof work !== 'object' || !Array.isArray(work.events)) {
    throw new TypeError('work with events is required')
  }

  const samples = []
  for (let decisionIndex = 0; decisionIndex < work.events.length; decisionIndex += 1) {
    const event = work.events[decisionIndex]
    if (event?.type !== 'decision') continue
    if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
      throw new TypeError('decision payload must be an object')
    }

    const prefixWork = {
      ...work,
      events: work.events.slice(0, decisionIndex)
    }

    samples.push({
      decision_index: decisionIndex,
      decision_at: event.at ?? null,
      decision: event.payload,
      state_before: deriveState(prefixWork)
    })
  }

  return {
    schema_version: 1,
    work_id: work.id ?? null,
    source_event_count: work.events.length,
    samples
  }
}

export function buildDecisionReplayDataset(works) {
  if (!Array.isArray(works)) throw new TypeError('works array is required')

  const seen = new Set()
  const ordered = [...works]
  for (const work of ordered) {
    if (!work || typeof work.id !== 'string' || !work.id) throw new TypeError('work id is required')
    if (seen.has(work.id)) throw new TypeError(`duplicate work id: ${work.id}`)
    seen.add(work.id)
  }

  ordered.sort((left, right) => Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)))
  return ordered.map((work) => buildDecisionReplay(work))
}

export async function loadDecisionReplayDirectory(rootDir) {
  if (typeof rootDir !== 'string' || !rootDir) throw new TypeError('work ledger root is required')

  const entries = await readdir(rootDir, { withFileTypes: true })
  const ids = entries
    .filter((entry) => entry.isDirectory() && /^work_[a-z0-9-]+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))

  const ledger = new WorkLedger(rootDir)
  const works = []
  for (const id of ids) works.push(await ledger.read(id))
  return buildDecisionReplayDataset(works)
}
