import test from 'node:test'
import assert from 'node:assert/strict'

async function loadModule() {
  try {
    return await import('../src/work-controller.mjs')
  } catch {
    return {}
  }
}

class FakeLedger {
  constructor(events = []) {
    this.events = [...events]
  }

  async append(_id, type, payload) {
    const event = { at: new Date(FakeLedger.now).toISOString(), type, payload }
    this.events.push(event)
    return event
  }

  async read(id) {
    return { id, createdAt: '2026-09-03T00:00:00.000Z', events: [...this.events] }
  }
}

FakeLedger.now = Date.parse('2026-09-03T09:00:00.000Z')

class FakeHost {
  constructor() {
    this.created = []
    this.sent = []
    this.states = new Map()
  }

  async create(options = {}) {
    this.created.push(options)
    return { id: `conv_${this.created.length}`, status: 'idle' }
  }

  async send(id, text) {
    this.sent.push({ id, text })
    return { conversationId: id, turnId: `turn_${this.sent.length}`, accepted: true }
  }

  async read(id) {
    return this.states.get(id) ?? { id, status: 'generating', latestResponse: null }
  }
}

test('WorkController records structured split decisions and derives frontier state', async () => {
  const { WorkController } = await loadModule()
  assert.equal(typeof WorkController, 'function')
  if (typeof WorkController !== 'function') return

  const ledger = new FakeLedger([
    { at: '2026-09-03T08:00:00.000Z', type: 'goal', payload: { goal: 'inspect system' } }
  ])
  const controller = new WorkController({ ledger, conversationHost: new FakeHost(), now: () => FakeLedger.now })

  await controller.decide('work_test', {
    action: 'SPLIT',
    reason: 'two independent frontiers emerged',
    frontiers: [
      { id: 'f1', task: 'inspect recovery', depends_on: [] },
      { id: 'f2', task: 'inspect completion', depends_on: [] }
    ]
  })

  const state = await controller.state('work_test')
  assert.equal(state.goal, 'inspect system')
  assert.equal(state.latestDecision.action, 'SPLIT')
  assert.deepEqual(state.frontiers.map(({ id, status }) => ({ id, status })), [
    { id: 'f1', status: 'pending' },
    { id: 'f2', status: 'pending' }
  ])
})

test('WorkController records evidence-linked plan revisions and derives current plan state', async () => {
  const { WorkController } = await loadModule()
  assert.equal(typeof WorkController, 'function')
  if (typeof WorkController !== 'function') return

  const ledger = new FakeLedger([
    { at: '2026-09-03T08:00:00.000Z', type: 'goal', payload: { goal: 'inspect system' } },
    { at: '2026-09-03T08:01:00.000Z', type: 'observation', payload: { fact: 'hypothesis A failed' } }
  ])
  const controller = new WorkController({ ledger, conversationHost: new FakeHost(), now: () => FakeLedger.now })

  await controller.decide('work_test', {
    action: 'REVISE',
    reason: 'new evidence changed the best route',
    evidence_event_indexes: [1],
    plan: {
      objective: 'resolve the failure',
      approach: 'compare the two surviving hypotheses',
      current_focus: 'falsify hypothesis B',
      assumptions: ['identity is stable'],
      open_questions: ['which lifecycle transition invalidates the binding?']
    },
    orchestration: { mode: 'ADVERSARIAL' }
  })

  const state = await controller.state('work_test')
  assert.equal(state.currentPlan.version, 1)
  assert.equal(state.currentPlan.objective, 'resolve the failure')
  assert.equal(state.currentOrchestration.mode, 'ADVERSARIAL')
  assert.equal(state.planHistory.length, 1)
  assert.deepEqual(state.planHistory[0].evidence_event_indexes, [1])
})

test('WorkController rejects invalid plan revision evidence and orchestration mode', async () => {
  const { WorkController } = await loadModule()
  assert.equal(typeof WorkController, 'function')
  if (typeof WorkController !== 'function') return

  const ledger = new FakeLedger([
    { at: '2026-09-03T08:00:00.000Z', type: 'goal', payload: { goal: 'inspect system' } },
    { at: '2026-09-03T08:01:00.000Z', type: 'observation', payload: { fact: 'new evidence' } }
  ])
  const controller = new WorkController({ ledger, conversationHost: new FakeHost(), now: () => FakeLedger.now })
  const plan = {
    objective: 'resolve the failure',
    approach: 'compare hypotheses',
    current_focus: 'test hypothesis B',
    assumptions: [],
    open_questions: []
  }

  await assert.rejects(
    controller.decide('work_test', {
      action: 'REVISE', reason: 'missing evidence', evidence_event_indexes: [], plan,
      orchestration: { mode: 'EXPLORE' }
    }),
    /REVISE requires evidence_event_indexes/
  )
  await assert.rejects(
    controller.decide('work_test', {
      action: 'REVISE', reason: 'bad evidence', evidence_event_indexes: [99], plan,
      orchestration: { mode: 'EXPLORE' }
    }),
    /invalid evidence event index/
  )
  await assert.rejects(
    controller.decide('work_test', {
      action: 'REVISE', reason: 'bad mode', evidence_event_indexes: [1], plan,
      orchestration: { mode: 'MONITOR' }
    }),
    /unsupported orchestration mode/
  )
})

test('WorkController keeps planHistory snapshots independent from currentPlan mutations', async () => {
  const { WorkController } = await loadModule()
  assert.equal(typeof WorkController, 'function')
  if (typeof WorkController !== 'function') return

  const ledger = new FakeLedger([
    { at: '2026-09-03T08:00:00.000Z', type: 'goal', payload: { goal: 'inspect system' } },
    { at: '2026-09-03T08:01:00.000Z', type: 'observation', payload: { fact: 'new evidence' } },
    {
      at: '2026-09-03T08:02:00.000Z',
      type: 'decision',
      payload: {
        action: 'REVISE', reason: 'change route', evidence_event_indexes: [1],
        plan: {
          objective: 'resolve the failure', approach: 'compare hypotheses', current_focus: 'test B',
          assumptions: ['identity is stable'], open_questions: ['which transition fails?']
        },
        orchestration: { mode: 'ADVERSARIAL' }
      }
    }
  ])
  const controller = new WorkController({ ledger, conversationHost: new FakeHost(), now: () => FakeLedger.now })
  const state = await controller.state('work_test')

  state.currentPlan.assumptions.push('mutated outside')
  assert.deepEqual(state.planHistory[0].plan.assumptions, ['identity is stable'])
})

test('WorkController serializes decisions so STOP is terminal for concurrent later revisions', async () => {
  const { WorkController } = await loadModule()
  assert.equal(typeof WorkController, 'function')
  if (typeof WorkController !== 'function') return

  const ledger = new FakeLedger([
    { at: '2026-09-03T08:00:00.000Z', type: 'goal', payload: { goal: 'inspect system' } },
    { at: '2026-09-03T08:01:00.000Z', type: 'observation', payload: { fact: 'enough evidence' } }
  ])
  const controller = new WorkController({ ledger, conversationHost: new FakeHost(), now: () => FakeLedger.now })

  const results = await Promise.allSettled([
    controller.decide('work_test', { action: 'STOP', reason: 'done' }),
    controller.decide('work_test', {
      action: 'REVISE', reason: 'late revision', evidence_event_indexes: [1],
      plan: {
        objective: 'should not apply', approach: 'late', current_focus: 'late',
        assumptions: [], open_questions: []
      },
      orchestration: { mode: 'EXECUTE' }
    })
  ])

  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'rejected')
  const state = await controller.state('work_test')
  assert.equal(state.stopped, true)
  assert.equal(state.currentPlan, null)
  assert.equal(state.latestDecision.action, 'STOP')
})

test('WorkController replay ignores decisions recorded after STOP', async () => {
  const { WorkController } = await loadModule()
  assert.equal(typeof WorkController, 'function')
  if (typeof WorkController !== 'function') return

  const ledger = new FakeLedger([
    { at: '2026-09-03T08:00:00.000Z', type: 'goal', payload: { goal: 'inspect system' } },
    { at: '2026-09-03T08:01:00.000Z', type: 'observation', payload: { fact: 'done' } },
    { at: '2026-09-03T08:02:00.000Z', type: 'decision', payload: { action: 'STOP', reason: 'done' } },
    {
      at: '2026-09-03T08:03:00.000Z', type: 'decision',
      payload: {
        action: 'REVISE', reason: 'invalid late revision', evidence_event_indexes: [1],
        plan: { objective: 'late', approach: 'late', current_focus: 'late', assumptions: [], open_questions: [] },
        orchestration: { mode: 'EXECUTE' }
      }
    }
  ])
  const controller = new WorkController({ ledger, conversationHost: new FakeHost(), now: () => FakeLedger.now })
  const state = await controller.state('work_test')

  assert.equal(state.latestDecision.action, 'STOP')
  assert.equal(state.currentPlan, null)
  assert.equal(state.planHistory.length, 0)
})

test('WorkController blocks dependent frontiers and enforces 120 second dispatch pacing', async () => {
  const { WorkController } = await loadModule()
  assert.equal(typeof WorkController, 'function')
  if (typeof WorkController !== 'function') return

  const ledger = new FakeLedger([
    { at: '2026-09-03T08:00:00.000Z', type: 'goal', payload: { goal: 'inspect system' } },
    {
      at: '2026-09-03T08:01:00.000Z',
      type: 'decision',
      payload: {
        action: 'SPLIT',
        reason: 'work found',
        frontiers: [
          { id: 'f1', task: 'first task', depends_on: [] },
          { id: 'f2', task: 'second task', depends_on: ['f1'] },
          { id: 'f3', task: 'third task', depends_on: [] }
        ]
      }
    }
  ])
  const host = new FakeHost()
  const controller = new WorkController({ ledger, conversationHost: host, now: () => FakeLedger.now })

  await assert.rejects(controller.dispatch('work_test', 'f2'), /dependencies are not complete/)

  const first = await controller.dispatch('work_test', 'f1')
  assert.equal(first.dispatched, true)
  assert.equal(host.created.length, 1)
  assert.match(host.sent[0].text, /depth-1 worker/i)
  assert.match(host.sent[0].text, /first task/)

  FakeLedger.now += 60_000
  const paced = await controller.dispatch('work_test', 'f3')
  assert.equal(paced.dispatched, false)
  assert.equal(paced.reason, 'pacing')
  assert.equal(paced.retryAfterMs, 60_000)

  FakeLedger.now += 60_000
  const second = await controller.dispatch('work_test', 'f3')
  assert.equal(second.dispatched, true)
  assert.equal(host.created.length, 2)
})

test('WorkController includes the latest revised plan in depth-1 worker prompts', async () => {
  const { WorkController } = await loadModule()
  assert.equal(typeof WorkController, 'function')
  if (typeof WorkController !== 'function') return

  FakeLedger.now = Date.parse('2026-09-03T09:00:00.000Z')
  const ledger = new FakeLedger([
    { at: '2026-09-03T08:00:00.000Z', type: 'goal', payload: { goal: 'inspect system' } },
    { at: '2026-09-03T08:01:00.000Z', type: 'observation', payload: { fact: 'hypothesis A failed' } },
    {
      at: '2026-09-03T08:02:00.000Z',
      type: 'decision',
      payload: {
        action: 'REVISE',
        reason: 'change route',
        evidence_event_indexes: [1],
        plan: {
          objective: 'resolve the failure',
          approach: 'compare surviving hypotheses',
          current_focus: 'falsify hypothesis B',
          assumptions: ['identity is stable'],
          open_questions: ['which lifecycle transition invalidates the binding?']
        },
        orchestration: { mode: 'ADVERSARIAL' }
      }
    },
    {
      at: '2026-09-03T08:03:00.000Z',
      type: 'decision',
      payload: {
        action: 'SPLIT',
        reason: 'one bounded attack frontier',
        frontiers: [{ id: 'f1', task: 'attack hypothesis B', depends_on: [] }]
      }
    }
  ])
  const host = new FakeHost()
  const controller = new WorkController({ ledger, conversationHost: host, now: () => FakeLedger.now })

  const dispatched = await controller.dispatch('work_test', 'f1')
  assert.equal(dispatched.dispatched, true)
  assert.match(host.sent[0].text, /Current plan v1/)
  assert.match(host.sent[0].text, /Objective: resolve the failure/)
  assert.match(host.sent[0].text, /Approach: compare surviving hypotheses/)
  assert.match(host.sent[0].text, /Current focus: falsify hypothesis B/)
  assert.match(host.sent[0].text, /Orchestration mode: ADVERSARIAL/)
  assert.match(host.sent[0].text, /depth-1 worker/i)
})

test('WorkController collects completed workers into the ledger and unlocks dependents', async () => {
  const { WorkController } = await loadModule()
  assert.equal(typeof WorkController, 'function')
  if (typeof WorkController !== 'function') return

  FakeLedger.now = Date.parse('2026-09-03T09:00:00.000Z')
  const ledger = new FakeLedger([
    { at: '2026-09-03T08:00:00.000Z', type: 'goal', payload: { goal: 'inspect system' } },
    {
      at: '2026-09-03T08:01:00.000Z',
      type: 'decision',
      payload: {
        action: 'SPLIT',
        reason: 'work found',
        frontiers: [
          { id: 'f1', task: 'first task', depends_on: [] },
          { id: 'f2', task: 'second task', depends_on: ['f1'] }
        ]
      }
    },
    {
      at: '2026-09-03T08:02:00.000Z',
      type: 'worker_dispatched',
      payload: { frontierId: 'f1', conversationId: 'conv_1', turnId: 'turn_1' }
    }
  ])
  const host = new FakeHost()
  host.states.set('conv_1', { id: 'conv_1', status: 'completed', latestResponse: 'recovery result' })
  const controller = new WorkController({ ledger, conversationHost: host, now: () => FakeLedger.now })

  const collected = await controller.collect('work_test')
  assert.equal(collected.collected, 1)
  assert.equal(collected.state.frontiers.find((f) => f.id === 'f1').status, 'completed')
  assert.equal(collected.state.frontiers.find((f) => f.id === 'f2').status, 'pending')

  const dispatched = await controller.dispatch('work_test', 'f2')
  assert.equal(dispatched.dispatched, true)
})

test('WorkController treats STOP as terminal for later dispatch', async () => {
  const { WorkController } = await loadModule()
  assert.equal(typeof WorkController, 'function')
  if (typeof WorkController !== 'function') return

  FakeLedger.now = Date.parse('2026-09-03T09:00:00.000Z')
  const ledger = new FakeLedger([
    { at: '2026-09-03T08:00:00.000Z', type: 'goal', payload: { goal: 'inspect system' } },
    {
      at: '2026-09-03T08:01:00.000Z',
      type: 'decision',
      payload: { action: 'SPLIT', reason: 'found work', frontiers: [{ id: 'f1', task: 'first task', depends_on: [] }] }
    },
    { at: '2026-09-03T08:02:00.000Z', type: 'decision', payload: { action: 'STOP', reason: 'goal is done' } }
  ])
  const host = new FakeHost()
  const controller = new WorkController({ ledger, conversationHost: host, now: () => FakeLedger.now })

  await assert.rejects(controller.dispatch('work_test', 'f1'), /work is stopped/)
  assert.equal(host.created.length, 0)
})

test('WorkController serializes concurrent dispatch admission and applies pacing globally in-process', async () => {
  const { WorkController } = await loadModule()
  assert.equal(typeof WorkController, 'function')
  if (typeof WorkController !== 'function') return

  FakeLedger.now = Date.parse('2026-09-03T09:00:00.000Z')
  const ledger = new FakeLedger([
    { at: '2026-09-03T08:00:00.000Z', type: 'goal', payload: { goal: 'inspect system' } },
    {
      at: '2026-09-03T08:01:00.000Z',
      type: 'decision',
      payload: {
        action: 'SPLIT',
        reason: 'parallel candidates',
        frontiers: [
          { id: 'f1', task: 'first task', depends_on: [] },
          { id: 'f2', task: 'second task', depends_on: [] }
        ]
      }
    }
  ])
  const host = new FakeHost()
  const controller = new WorkController({ ledger, conversationHost: host, now: () => FakeLedger.now })

  const [a, b] = await Promise.all([
    controller.dispatch('work_test', 'f1'),
    controller.dispatch('work_test', 'f2')
  ])
  assert.equal([a, b].filter((item) => item.dispatched).length, 1)
  const blocked = [a, b].find((item) => !item.dispatched)
  assert.equal(blocked.reason, 'pacing')
  assert.equal(blocked.retryAfterMs, 120_000)
  assert.equal(host.created.length, 1)
})

test('WorkController validates the minimal decision action schema', async () => {
  const { WorkController } = await loadModule()
  assert.equal(typeof WorkController, 'function')
  if (typeof WorkController !== 'function') return

  const ledger = new FakeLedger([
    { at: '2026-09-03T08:00:00.000Z', type: 'goal', payload: { goal: 'inspect system' } }
  ])
  const controller = new WorkController({ ledger, conversationHost: new FakeHost(), now: () => FakeLedger.now })

  await assert.rejects(
    controller.decide('work_test', { action: 'SPLIT', reason: 'missing frontiers' }),
    /SPLIT requires frontiers/
  )
  await assert.rejects(
    controller.decide('work_test', { action: 'ROUTE', reason: 'unsupported action' }),
    /unsupported work decision action/
  )
  await assert.rejects(
    controller.decide('work_test', {
      action: 'SPLIT',
      reason: 'cyclic split',
      frontiers: [
        { id: 'f1', task: 'first', depends_on: ['f2'] },
        { id: 'f2', task: 'second', depends_on: ['f1'] }
      ]
    }),
    /frontier dependency cycle/
  )
})
