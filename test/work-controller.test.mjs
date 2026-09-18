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

  async appendIfEventCount(_id, expectedCount, type, payload) {
    if (this.events.length !== expectedCount) {
      const error = new Error(`stale work state: expected ${expectedCount}, current ${this.events.length}`)
      error.code = 'WORK_STALE'
      throw error
    }
    return this.append(_id, type, payload)
  }

  async read(id) {
    return { id, createdAt: '2026-09-03T00:00:00.000Z', events: [...this.events] }
  }
}

FakeLedger.now = Date.parse('2026-09-03T09:00:00.000Z')
const managedProjectUrl = 'https://chatgpt.com/g/g-p-subagents-test/project'

class FakeHost {
  constructor() {
    this.created = []
    this.sent = []
    this.shifts = []
    this.shiftResult = null
    this.states = new Map()
    this.authoritativeStates = new Map()
    this.terminalListeners = new Map()
    this.admissions = []
    this.admitResult = { admitted: true, admittedAt: FakeLedger.now }
  }

  async admitSend(request) {
    this.admissions.push(request)
    return this.admitResult
  }

  async create(options = {}) {
    this.created.push(options)
    const index = this.created.length
    return {
      id: `conv_${index}`,
      status: 'idle',
      tabId: 100 + index,
      externalUrl: `${managedProjectUrl}/c/conv_${index}`
    }
  }

  async shiftTest(target, targetUrl = null, targetTabId = null) {
    this.shifts.push({ target, targetUrl, targetTabId })
    if (this.shiftResult instanceof Error) throw this.shiftResult
    return this.shiftResult ?? { switched: true, before: 'Pro', after: target, tabId: targetTabId }
  }

  async send(id, text, options = {}) {
    this.sent.push({ id, text, options })
    return { conversationId: id, turnId: `turn_${this.sent.length}`, accepted: true }
  }

  async read(id) {
    return this.states.get(id) ?? { id, status: 'generating', latestResponse: null }
  }

  async state(id) {
    if (this.authoritativeStates.has(id)) return this.authoritativeStates.get(id)
    const legacy = await this.read(id)
    const completed = legacy.status === 'completed'
    return {
      contractVersion: 1,
      conversationId: id,
      target: legacy.externalUrl ?? `https://chatgpt.com/c/${id}`,
      stateVersion: 1,
      turn: { turnId: legacy.latestTurnId ?? null, userMessageId: completed ? 'user-1' : null, assistantMessageId: completed ? 'assistant-1' : null },
      progress: completed ? 'terminal' : legacy.status === 'error' ? 'blocked' : 'active',
      body: completed ? 'substantive' : 'incomplete',
      delivery: completed ? 'delivered' : 'pending',
      gate: 'none',
      writer: { mode: 'managed', epoch: 1 }
    }
  }

  onTerminal(id, listener) {
    this.terminalListeners.set(id, listener)
    return () => this.terminalListeners.delete(id)
  }

  async emitTerminal(id, event) {
    const listener = this.terminalListeners.get(id)
    if (!listener) return
    this.terminalListeners.delete(id)
    await listener(event)
  }
}

class FakeWatchdog {
  constructor() {
    this.registered = []
    this.completions = new Map()
    this.acked = []
    this.registerResult = true
  }

  async register(url) {
    this.registered.push(url)
    return this.registerResult
  }

  async completion(url) {
    return this.completions.get(url) ?? { active: false, completed: false, result: null }
  }

  async ackCompletion(url) {
    this.acked.push(url)
    return true
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

test('WorkController dispatch creates managed workers inside the configured subagents Project', async () => {
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
        reason: 'one managed frontier',
        frontiers: [{ id: 'f1', task: 'inspect recovery', depends_on: [] }]
      }
    }
  ])
  const host = new FakeHost()
  const controller = new WorkController({
    ledger,
    conversationHost: host,
    managedProjectUrl,
    now: () => FakeLedger.now
  })

  const dispatched = await controller.dispatch('work_test', 'f1')
  assert.equal(dispatched.dispatched, true)
  assert.equal(dispatched.worker_kind, 'conversation_worker')
  assert.equal(dispatched.backend, 'sidecar')
  assert.deepEqual(host.created, [{ projectUrl: managedProjectUrl }])
  assert.deepEqual(host.shifts, [{ target: 'High', targetUrl: null, targetTabId: 101 }])
  const dispatchEvents = ledger.events.filter((event) => event.type === 'worker_dispatched')
  assert.equal(dispatchEvents.length, 2)
  assert.ok(dispatchEvents.every((event) => event.payload.worker_kind === 'conversation_worker'))
  assert.ok(dispatchEvents.every((event) => event.payload.backend === 'sidecar'))
  const state = await controller.state('work_test')
  assert.equal(state.frontiers[0].worker_kind, 'conversation_worker')
  assert.equal(state.frontiers[0].backend, 'sidecar')
})

test('WorkController allows an explicit managed worker strength override', async () => {
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
        reason: 'one managed frontier',
        frontiers: [{ id: 'f1', task: 'inspect recovery', depends_on: [] }]
      }
    }
  ])
  const host = new FakeHost()
  const controller = new WorkController({
    ledger,
    conversationHost: host,
    managedProjectUrl,
    workerStrength: 'Medium',
    now: () => FakeLedger.now
  })

  const dispatched = await controller.dispatch('work_test', 'f1')
  assert.equal(dispatched.dispatched, true)
  assert.deepEqual(host.shifts, [{ target: 'Medium', targetUrl: null, targetTabId: 101 }])
})

test('WorkController refuses to send a worker prompt when strength normalization fails', async () => {
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
        reason: 'one managed frontier',
        frontiers: [{ id: 'f1', task: 'inspect recovery', depends_on: [] }]
      }
    }
  ])
  const host = new FakeHost()
  host.shiftResult = { switched: true, before: 'Pro', after: 'Extra High', tabId: 101 }
  const controller = new WorkController({
    ledger,
    conversationHost: host,
    managedProjectUrl,
    now: () => FakeLedger.now
  })

  await assert.rejects(
    controller.dispatch('work_test', 'f1'),
    /worker strength normalization failed/i
  )
  assert.equal(host.sent.length, 0)
  assert.deepEqual(host.shifts, [{ target: 'High', targetUrl: null, targetTabId: 101 }])
})

test('WorkController refuses managed dispatch before Project identity is resolved', async () => {
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
        reason: 'one managed frontier',
        frontiers: [{ id: 'f1', task: 'inspect recovery', depends_on: [] }]
      }
    }
  ])
  const host = new FakeHost()
  const controller = new WorkController({ ledger, conversationHost: host, now: () => FakeLedger.now })

  await assert.rejects(
    controller.dispatch('work_test', 'f1'),
    (error) => error?.code === 'MANAGED_PROJECT_UNRESOLVED'
  )
  assert.equal(host.created.length, 0)
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
  const controller = new WorkController({ ledger, conversationHost: host, managedProjectUrl, now: () => FakeLedger.now })

  await assert.rejects(controller.dispatch('work_test', 'f2'), /dependencies are not complete/)

  const first = await controller.dispatch('work_test', 'f1')
  assert.equal(first.dispatched, true)
  assert.equal(host.created.length, 1)
  assert.match(host.sent[0].text, /depth-1 worker/i)
  assert.match(host.sent[0].text, /first task/)
  assert.match(host.sent[0].text, /human action, authorization, login, UI interaction, or missing input/i)
  assert.match(host.sent[0].text, /\[SUPERVISOR_STATE: NEED_INPUT\]/)

  FakeLedger.now += 60_000
  const paced = await controller.dispatch('work_test', 'f3')
  assert.equal(paced.dispatched, false)
  assert.equal(paced.worker_kind, 'conversation_worker')
  assert.equal(paced.backend, 'sidecar')
  assert.equal(paced.reason, 'pacing')
  assert.equal(paced.retryAfterMs, 60_000)

  FakeLedger.now += 60_000
  const second = await controller.dispatch('work_test', 'f3')
  assert.equal(second.dispatched, true)
  assert.equal(host.created.length, 2)
})

test('WorkController asks the shared admission owner before allocating a worker', async () => {
  const { WorkController } = await loadModule()
  const ledger = new FakeLedger()
  const host = new FakeHost()
  host.admitResult = { admitted: false, retryAfterMs: 45_000, lastAdmittedAt: 1 }
  const controller = new WorkController({ ledger, conversationHost: host, managedProjectUrl, now: () => FakeLedger.now })
  await controller.decide('work_test', {
    action: 'SPLIT', reason: 'bounded test', frontiers: [{ id: 'f1', task: 'one task', depends_on: [] }]
  })

  const result = await controller.dispatch('work_test', 'f1')

  assert.equal(result.dispatched, false)
  assert.equal(result.reason, 'pacing')
  assert.equal(result.retryAfterMs, 45_000)
  assert.deepEqual(host.created, [])
  assert.deepEqual(host.sent, [])
  assert.equal(host.admissions.length, 1)
  assert.equal(host.admissions[0].source, 'work_dispatch')
  assert.equal(host.admissions[0].target, managedProjectUrl)
})

test('WorkController passes a successful shared admission into the managed send', async () => {
  const { WorkController } = await loadModule()
  const ledger = new FakeLedger()
  const host = new FakeHost()
  const controller = new WorkController({ ledger, conversationHost: host, managedProjectUrl, now: () => FakeLedger.now })
  await controller.decide('work_test', {
    action: 'SPLIT', reason: 'bounded test', frontiers: [{ id: 'f1', task: 'one task', depends_on: [] }]
  })

  const result = await controller.dispatch('work_test', 'f1')

  assert.equal(result.dispatched, true)
  assert.equal(host.admissions.length, 1)
  assert.equal(host.sent[0].options.preAdmitted, true)
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
  const controller = new WorkController({ ledger, conversationHost: host, managedProjectUrl, now: () => FakeLedger.now })

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
  host.states.set('conv_1', { id: 'conv_1', status: 'completed', latestTurnId: 'turn_1', latestResponse: 'recovery result' })
  const controller = new WorkController({ ledger, conversationHost: host, managedProjectUrl, now: () => FakeLedger.now })

  const collected = await controller.collect('work_test')
  assert.equal(collected.collected, 1)
  assert.equal(collected.state.frontiers.find((f) => f.id === 'f1').status, 'completed')
  assert.equal(collected.state.frontiers.find((f) => f.id === 'f1').worker_kind, 'conversation_worker')
  assert.equal(collected.state.frontiers.find((f) => f.id === 'f1').backend, 'sidecar')
  assert.equal(collected.state.frontiers.find((f) => f.id === 'f2').status, 'pending')
  const resultEvent = ledger.events.findLast((event) => event.type === 'worker_result')
  assert.equal(resultEvent.payload.worker_kind, 'conversation_worker')
  assert.equal(resultEvent.payload.backend, 'sidecar')

  const dispatched = await controller.dispatch('work_test', 'f2')
  assert.equal(dispatched.dispatched, true)
})

test('WorkController does not collect a legacy completed projection when authoritative state is nonterminal', async () => {
  const { WorkController } = await loadModule()
  const ledger = new FakeLedger([
    { at: '2026-09-03T08:00:00.000Z', type: 'goal', payload: { goal: 'inspect system' } },
    {
      at: '2026-09-03T08:01:00.000Z',
      type: 'decision',
      payload: { action: 'SPLIT', reason: 'work found', frontiers: [{ id: 'f1', task: 'first task', depends_on: [] }] }
    },
    {
      at: '2026-09-03T08:02:00.000Z',
      type: 'worker_dispatched',
      payload: { frontierId: 'f1', conversationId: 'conv_1', turnId: 'turn_1' }
    }
  ])
  const host = new FakeHost()
  const target = 'https://chatgpt.com/c/00000000-0000-0000-0000-000000000099'
  host.states.set('conv_1', {
    id: 'conv_1', status: 'completed', latestTurnId: 'turn_1', latestResponse: 'legacy false positive', externalUrl: target
  })
  host.authoritativeStates.set('conv_1', {
    contractVersion: 1,
    conversationId: 'conv_1',
    target,
    stateVersion: 7,
    turn: { turnId: 'turn_1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' },
    progress: 'blocked', body: 'incomplete', delivery: 'delivered', gate: 'none',
    writer: { mode: 'managed', epoch: 4 }
  })
  const controller = new WorkController({ ledger, conversationHost: host, managedProjectUrl, now: () => FakeLedger.now })

  const collected = await controller.collect('work_test')

  assert.equal(collected.collected, 0)
  assert.equal(collected.state.frontiers.find((f) => f.id === 'f1').status, 'dispatched')
  assert.equal(ledger.events.some((event) => event.type === 'worker_result'), false)
})

test('WorkController refuses legacy completed collection while authoritative human gate is active', async () => {
  const { WorkController } = await loadModule()
  const ledger = new FakeLedger([
    { at: '2026-09-03T08:00:00.000Z', type: 'goal', payload: { goal: 'inspect system' } },
    { at: '2026-09-03T08:01:00.000Z', type: 'decision', payload: { action: 'SPLIT', reason: 'work found', frontiers: [{ id: 'f1', task: 'first task', depends_on: [] }] } },
    { at: '2026-09-03T08:02:00.000Z', type: 'worker_dispatched', payload: { frontierId: 'f1', conversationId: 'conv_1', turnId: 'turn_1' } }
  ])
  const host = new FakeHost()
  const target = 'https://chatgpt.com/c/00000000-0000-0000-0000-000000000100'
  host.states.set('conv_1', { id: 'conv_1', status: 'completed', latestTurnId: 'turn_1', latestResponse: 'legacy done', externalUrl: target })
  host.authoritativeStates.set('conv_1', {
    contractVersion: 1, conversationId: 'conv_1', target, stateVersion: 3,
    turn: { turnId: 'turn_1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' },
    progress: 'terminal', body: 'substantive', delivery: 'delivered', gate: 'human_required',
    writer: { mode: 'managed', epoch: 4 }
  })
  const controller = new WorkController({ ledger, conversationHost: host, managedProjectUrl, now: () => FakeLedger.now })
  assert.equal((await controller.collect('work_test')).collected, 0)
  assert.equal(ledger.events.some((event) => event.type === 'worker_result'), false)
})

test('WorkController refuses legacy completed collection when authoritative turn identity differs', async () => {
  const { WorkController } = await loadModule()
  const ledger = new FakeLedger([
    { at: '2026-09-03T08:00:00.000Z', type: 'goal', payload: { goal: 'inspect system' } },
    { at: '2026-09-03T08:01:00.000Z', type: 'decision', payload: { action: 'SPLIT', reason: 'work found', frontiers: [{ id: 'f1', task: 'first task', depends_on: [] }] } },
    { at: '2026-09-03T08:02:00.000Z', type: 'worker_dispatched', payload: { frontierId: 'f1', conversationId: 'conv_1', turnId: 'turn_1' } }
  ])
  const host = new FakeHost()
  const target = 'https://chatgpt.com/c/00000000-0000-0000-0000-000000000101'
  host.states.set('conv_1', { id: 'conv_1', status: 'completed', latestTurnId: 'turn_1', latestResponse: 'legacy done', externalUrl: target })
  host.authoritativeStates.set('conv_1', {
    contractVersion: 1, conversationId: 'conv_1', target, stateVersion: 3,
    turn: { turnId: 'turn_other', userMessageId: 'user-2', assistantMessageId: 'assistant-2' },
    progress: 'terminal', body: 'substantive', delivery: 'delivered', gate: 'none',
    writer: { mode: 'managed', epoch: 4 }
  })
  const controller = new WorkController({ ledger, conversationHost: host, managedProjectUrl, now: () => FakeLedger.now })
  assert.equal((await controller.collect('work_test')).collected, 0)
  assert.equal(ledger.events.some((event) => event.type === 'worker_result'), false)
})

test('WorkController fails closed when authoritative state owner is unavailable for a legacy completed projection', async () => {
  const { WorkController } = await loadModule()
  const ledger = new FakeLedger([
    { at: '2026-09-03T08:00:00.000Z', type: 'goal', payload: { goal: 'inspect system' } },
    { at: '2026-09-03T08:01:00.000Z', type: 'decision', payload: { action: 'SPLIT', reason: 'work found', frontiers: [{ id: 'f1', task: 'first task', depends_on: [] }] } },
    { at: '2026-09-03T08:02:00.000Z', type: 'worker_dispatched', payload: { frontierId: 'f1', conversationId: 'conv_1', turnId: 'turn_1' } }
  ])
  const host = new FakeHost()
  host.states.set('conv_1', {
    id: 'conv_1', status: 'completed', latestTurnId: 'turn_1', latestResponse: 'legacy done',
    externalUrl: 'https://chatgpt.com/c/00000000-0000-0000-0000-000000000102'
  })
  host.state = async () => { throw new Error('authoritative state unavailable') }
  const controller = new WorkController({ ledger, conversationHost: host, managedProjectUrl, now: () => FakeLedger.now })
  assert.equal((await controller.collect('work_test')).collected, 0)
  assert.equal(ledger.events.some((event) => event.type === 'worker_result'), false)
})

test('concurrent WorkController collect calls append at most one worker_result for the same terminal frontier', async () => {
  const { WorkController } = await loadModule()
  const ledger = new FakeLedger([
    { at: '2026-09-03T08:00:00.000Z', type: 'goal', payload: { goal: 'inspect system' } },
    { at: '2026-09-03T08:01:00.000Z', type: 'decision', payload: { action: 'SPLIT', reason: 'work found', frontiers: [{ id: 'f1', task: 'first task', depends_on: [] }] } },
    { at: '2026-09-03T08:02:00.000Z', type: 'worker_dispatched', payload: { frontierId: 'f1', conversationId: 'conv_1', turnId: 'turn_1' } }
  ])
  const host = new FakeHost()
  const target = 'https://chatgpt.com/c/00000000-0000-0000-0000-000000000106'
  host.states.set('conv_1', { id: 'conv_1', status: 'completed', latestTurnId: 'turn_1', latestResponse: 'done once', externalUrl: target })
  host.authoritativeStates.set('conv_1', {
    contractVersion: 1, conversationId: 'conv_1', target, stateVersion: 3,
    turn: { turnId: 'turn_1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' },
    progress: 'terminal', body: 'substantive', delivery: 'delivered', gate: 'none',
    writer: { mode: 'managed', epoch: 4 }
  })
  const controller = new WorkController({ ledger, conversationHost: host, managedProjectUrl, now: () => FakeLedger.now })

  const [left, right] = await Promise.all([controller.collect('work_test'), controller.collect('work_test')])

  assert.equal(left.collected + right.collected, 1)
  assert.equal(ledger.events.filter(event => event.type === 'worker_result' && event.payload.frontierId === 'f1').length, 1)
})

test('collect does not append a second worker_result when another work path wins during reconciliation', async () => {
  const { WorkController } = await loadModule()
  const ledger = new FakeLedger([
    { at: '2026-09-03T08:00:00.000Z', type: 'goal', payload: { goal: 'inspect system' } },
    { at: '2026-09-03T08:01:00.000Z', type: 'decision', payload: { action: 'SPLIT', reason: 'work found', frontiers: [{ id: 'f1', task: 'first task', depends_on: [] }] } },
    { at: '2026-09-03T08:02:00.000Z', type: 'worker_dispatched', payload: { frontierId: 'f1', conversationId: 'conv_1', turnId: 'turn_1' } }
  ])
  const host = new FakeHost()
  const target = 'https://chatgpt.com/c/00000000-0000-0000-0000-000000000109'
  host.states.set('conv_1', { id: 'conv_1', status: 'completed', latestTurnId: 'turn_1', latestResponse: 'collector result', externalUrl: target })
  host.authoritativeStates.set('conv_1', {
    contractVersion: 1, conversationId: 'conv_1', target, stateVersion: 3,
    turn: { turnId: 'turn_1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' },
    progress: 'terminal', body: 'substantive', delivery: 'delivered', gate: 'none',
    writer: { mode: 'managed', epoch: 4 }
  })
  let releaseState
  const stateGate = new Promise(resolve => { releaseState = resolve })
  const baseState = host.state.bind(host)
  host.state = async id => {
    await stateGate
    return baseState(id)
  }
  const controller = new WorkController({ ledger, conversationHost: host, managedProjectUrl, now: () => FakeLedger.now })

  const pendingCollect = controller.collect('work_test')
  await new Promise(resolve => setImmediate(resolve))
  await ledger.append('work_test', 'worker_result', {
    frontierId: 'f1', conversationId: 'conv_1', outcome: 'error', error: 'external winner'
  })
  releaseState()
  const collected = await pendingCollect

  assert.equal(collected.collected, 0)
  assert.equal(ledger.events.filter(event => event.type === 'worker_result' && event.payload.frontierId === 'f1').length, 1)
  assert.equal(collected.state.frontiers[0].status, 'error')
  assert.equal(collected.state.frontiers[0].error, 'external winner')
})

test('a blocked collect for one work does not freeze collection of an unrelated work', async () => {
  const { WorkController } = await loadModule()
  const workEvents = new Map()
  const baseEvents = conversationId => [
    { at: '2026-09-03T08:00:00.000Z', type: 'goal', payload: { goal: `inspect ${conversationId}` } },
    { at: '2026-09-03T08:01:00.000Z', type: 'decision', payload: { action: 'SPLIT', reason: 'work found', frontiers: [{ id: 'f1', task: 'task', depends_on: [] }] } },
    { at: '2026-09-03T08:02:00.000Z', type: 'worker_dispatched', payload: { frontierId: 'f1', conversationId, turnId: `turn_${conversationId}` } }
  ]
  workEvents.set('work_a', baseEvents('conv_a'))
  workEvents.set('work_b', baseEvents('conv_b'))
  const ledger = {
    async read(id) { return { id, createdAt: '2026-09-03T00:00:00.000Z', events: [...workEvents.get(id)] } },
    async append(id, type, payload) {
      const event = { at: new Date(FakeLedger.now).toISOString(), type, payload }
      workEvents.get(id).push(event)
      return event
    },
    async appendIfEventCount(id, expectedCount, type, payload) {
      if (workEvents.get(id).length !== expectedCount) {
        const error = new Error(`stale work state: expected ${expectedCount}, current ${workEvents.get(id).length}`)
        error.code = 'WORK_STALE'
        throw error
      }
      return this.append(id, type, payload)
    }
  }
  const host = new FakeHost()
  for (const id of ['a', 'b']) {
    const conversationId = `conv_${id}`
    const turnId = `turn_${conversationId}`
    const target = `https://chatgpt.com/c/00000000-0000-0000-0000-00000000010${id === 'a' ? '7' : '8'}`
    host.states.set(conversationId, { id: conversationId, status: 'completed', latestTurnId: turnId, latestResponse: `done ${id}`, externalUrl: target })
    host.authoritativeStates.set(conversationId, {
      contractVersion: 1, conversationId, target, stateVersion: 1,
      turn: { turnId, userMessageId: `user-${id}`, assistantMessageId: `assistant-${id}` },
      progress: 'terminal', body: 'substantive', delivery: 'delivered', gate: 'none',
      writer: { mode: 'managed', epoch: 4 }
    })
  }
  let releaseA
  const gateA = new Promise(resolve => { releaseA = resolve })
  const baseState = host.state.bind(host)
  host.state = async id => {
    if (id === 'conv_a') await gateA
    return baseState(id)
  }
  const controller = new WorkController({ ledger, conversationHost: host, managedProjectUrl, now: () => FakeLedger.now })

  const pendingA = controller.collect('work_a')
  await new Promise(resolve => setImmediate(resolve))
  let bResolved = false
  const pendingB = controller.collect('work_b').then(result => { bResolved = true; return result })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(bResolved, true)
  assert.equal((await pendingB).collected, 1)
  releaseA()
  assert.equal((await pendingA).collected, 1)
})

test('WorkController leaves need_continue workers dispatched for an explicit continuation decision', async () => {
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
        frontiers: [{ id: 'f1', task: 'first task', depends_on: [] }]
      }
    },
    {
      at: '2026-09-03T08:02:00.000Z',
      type: 'worker_dispatched',
      payload: { frontierId: 'f1', conversationId: 'conv_1', turnId: 'turn_need' }
    }
  ])
  const host = new FakeHost()
  host.states.set('conv_1', {
    id: 'conv_1',
    status: 'need_continue',
    latestTurnId: 'turn_need',
    latestResponse: 'partial shell',
    error: null
  })
  const controller = new WorkController({ ledger, conversationHost: host, managedProjectUrl, now: () => FakeLedger.now })

  const collected = await controller.collect('work_test')
  assert.equal(collected.collected, 0)
  assert.equal(collected.state.frontiers.find((f) => f.id === 'f1').status, 'dispatched')
  assert.equal(ledger.events.some((event) => event.type === 'worker_result'), false)
})

test('WorkController does not collect a terminal result from the wrong dispatched turn', async () => {
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
        frontiers: [{ id: 'f1', task: 'first task', depends_on: [] }]
      }
    },
    {
      at: '2026-09-03T08:02:00.000Z',
      type: 'worker_dispatched',
      payload: { frontierId: 'f1', conversationId: 'conv_1', turnId: 'turn_expected' }
    }
  ])
  const host = new FakeHost()
  host.states.set('conv_1', {
    id: 'conv_1',
    status: 'completed',
    latestTurnId: 'turn_old',
    latestResponse: 'stale result'
  })
  const controller = new WorkController({ ledger, conversationHost: host, now: () => FakeLedger.now })

  const collected = await controller.collect('work_test')
  assert.equal(collected.collected, 0)
  assert.equal(collected.state.frontiers.find((f) => f.id === 'f1').status, 'dispatched')
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
  const controller = new WorkController({ ledger, conversationHost: host, managedProjectUrl, now: () => FakeLedger.now })

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

test('WorkController checkpoint commits one decision against an exact state revision and evidence set', async () => {
  const { WorkController } = await loadModule()
  assert.equal(typeof WorkController, 'function')
  if (typeof WorkController !== 'function') return

  const ledger = new FakeLedger([
    { at: '2026-09-03T08:00:00.000Z', type: 'goal', payload: { goal: 'inspect system' } },
    { at: '2026-09-03T08:01:00.000Z', type: 'observation', payload: { fact: 'two independent frontiers emerged' } }
  ])
  const controller = new WorkController({ ledger, conversationHost: new FakeHost(), now: () => FakeLedger.now })
  const before = await controller.state('work_test')
  assert.equal(before.eventCount, 2)

  const state = await controller.checkpoint('work_test', {
    based_on_event_count: 2,
    evidence_event_indexes: [1],
    decision: {
      action: 'SPLIT',
      reason: 'commit the split against the observed state',
      frontiers: [{ id: 'f1', task: 'inspect recovery', depends_on: [] }]
    }
  })

  assert.equal(state.eventCount, 3)
  assert.equal(state.latestDecision.action, 'SPLIT')
  assert.deepEqual(state.latestDecision.checkpoint, {
    based_on_event_count: 2,
    evidence_event_indexes: [1]
  })
  assert.equal(state.frontiers[0].id, 'f1')
})

test('WorkController checkpoint rejects stale state without appending a decision', async () => {
  const { WorkController } = await loadModule()
  assert.equal(typeof WorkController, 'function')
  if (typeof WorkController !== 'function') return

  const ledger = new FakeLedger([
    { at: '2026-09-03T08:00:00.000Z', type: 'goal', payload: { goal: 'inspect system' } },
    { at: '2026-09-03T08:01:00.000Z', type: 'observation', payload: { fact: 'old evidence' } }
  ])
  const controller = new WorkController({ ledger, conversationHost: new FakeHost(), now: () => FakeLedger.now })
  await ledger.append('work_test', 'observation', { fact: 'new evidence arrived' })

  await assert.rejects(
    controller.checkpoint('work_test', {
      based_on_event_count: 2,
      evidence_event_indexes: [1],
      decision: { action: 'CONTINUE', reason: 'stale continuation' }
    }),
    /stale work state: expected 2, current 3/
  )
  assert.equal(ledger.events.length, 3)
})

test('WorkController checkpoint uses outer evidence for REVISE and rejects invalid evidence', async () => {
  const { WorkController } = await loadModule()
  assert.equal(typeof WorkController, 'function')
  if (typeof WorkController !== 'function') return

  const ledger = new FakeLedger([
    { at: '2026-09-03T08:00:00.000Z', type: 'goal', payload: { goal: 'inspect system' } },
    { at: '2026-09-03T08:01:00.000Z', type: 'observation', payload: { fact: 'plan is wrong' } }
  ])
  const controller = new WorkController({ ledger, conversationHost: new FakeHost(), now: () => FakeLedger.now })
  const plan = {
    objective: 'resolve the failure',
    approach: 'change route',
    current_focus: 'new route',
    assumptions: [],
    open_questions: []
  }

  const state = await controller.checkpoint('work_test', {
    based_on_event_count: 2,
    evidence_event_indexes: [1],
    decision: { action: 'REVISE', reason: 'evidence changed the plan', plan, orchestration: { mode: 'EXECUTE' } }
  })
  assert.deepEqual(state.latestDecision.evidence_event_indexes, [1])
  assert.equal(state.currentPlan.objective, 'resolve the failure')

  await assert.rejects(
    controller.checkpoint('work_test', {
      based_on_event_count: 3,
      evidence_event_indexes: [99],
      decision: { action: 'CONTINUE', reason: 'bad evidence' }
    }),
    /invalid evidence event index/
  )
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

test('uncertain dispatch stays collectible and late success completes the same frontier', async () => {
  const { WorkController } = await loadModule()
  const ledger = new FakeLedger()
  const host = new FakeHost()
  host.send = async id => {
    host.sent.push({ id })
    throw Object.assign(new Error('delivery unknown'), { code: 'DELIVERY_UNCERTAIN', turnId: 'turn_unknown' })
  }
  const controller = new WorkController({ ledger, conversationHost: host, managedProjectUrl, now: () => FakeLedger.now })
  await controller.decide('work_test', {
    action: 'SPLIT', reason: 'bounded test', frontiers: [{ id: 'f1', task: 'one task', depends_on: [] }]
  })
  const result = await controller.dispatch('work_test', 'f1')
  assert.equal(result.deliveryUncertain, true)
  assert.equal(result.accepted, false)
  assert.equal(result.worker_kind, 'conversation_worker')
  assert.equal(result.backend, 'sidecar')
  assert.equal((await controller.state('work_test')).frontiers[0].status, 'dispatched')
  assert.equal(ledger.events.some(event => event.type === 'worker_result'), false)
  await assert.rejects(controller.dispatch('work_test', 'f1'), /not pending/)
  host.states.set(result.conversationId, { status: 'completed', latestTurnId: 'turn_unknown', latestResponse: 'late success' })
  const collected = await controller.collect('work_test')
  assert.equal(collected.collected, 1)
  assert.equal(collected.state.frontiers[0].status, 'completed')
  assert.equal(collected.state.frontiers[0].worker_kind, 'conversation_worker')
  assert.equal(collected.state.frontiers[0].backend, 'sidecar')
  assert.equal(collected.state.frontiers[0].result, 'late success')
  assert.equal(host.created.length, 1)
})

test('collect recovers a crash after allocation using persisted send intent turn identity', async () => {
  const { WorkController } = await loadModule()
  const ledger = new FakeLedger()
  const host = new FakeHost()
  const controller = new WorkController({ ledger, conversationHost: host, managedProjectUrl })
  await controller.decide('work_test', {
    action: 'SPLIT', reason: 'bounded test', frontiers: [{ id: 'f1', task: 'one task', depends_on: [] }]
  })
  await ledger.append('work_test', 'worker_dispatched', { frontierId: 'f1', conversationId: 'conv_1', phase: 'allocated' })
  host.states.set('conv_1', { status: 'completed', latestTurnId: 'turn_recovered', latestResponse: 'recovered' })
  const collected = await controller.collect('work_test')
  assert.equal(collected.collected, 1)
  assert.equal(collected.state.frontiers[0].status, 'completed')
})

test('collect gives authoritative state one reconciliation opportunity before collecting a legacy error', async () => {
  const { WorkController } = await loadModule()
  const ledger = new FakeLedger()
  const host = new FakeHost()
  const target = 'https://chatgpt.com/c/00000000-0000-0000-0000-000000000103'
  const controller = new WorkController({ ledger, conversationHost: host, managedProjectUrl })
  await controller.decide('work_test', {
    action: 'SPLIT', reason: 'bounded test', frontiers: [{ id: 'f1', task: 'one task', depends_on: [] }]
  })
  await ledger.append('work_test', 'worker_dispatched', { frontierId: 'f1', conversationId: 'conv_1', phase: 'accepted', turnId: 'turn_1' })
  host.states.set('conv_1', { id: 'conv_1', status: 'error', latestTurnId: 'turn_1', error: 'stale timeout', externalUrl: target })
  host.state = async id => {
    host.states.set(id, { id, status: 'completed', latestTurnId: 'turn_1', latestResponse: 'fresh recovered result', externalUrl: target })
    return {
      contractVersion: 1, conversationId: id, target, stateVersion: 2,
      turn: { turnId: 'turn_1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' },
      progress: 'terminal', body: 'substantive', delivery: 'delivered', gate: 'none',
      writer: { mode: 'managed', epoch: 4 }
    }
  }

  const collected = await controller.collect('work_test')

  assert.equal(collected.collected, 1)
  assert.equal(collected.state.frontiers[0].status, 'completed')
  assert.equal(collected.state.frontiers[0].result, 'fresh recovered result')
  const results = ledger.events.filter(event => event.type === 'worker_result')
  assert.equal(results.length, 1)
  assert.equal(results[0].payload.outcome, 'completed')
})

test('collect keeps a legacy error pending when authoritative reconciliation exposes need_continue', async () => {
  const { WorkController } = await loadModule()
  const ledger = new FakeLedger()
  const host = new FakeHost()
  const target = 'https://chatgpt.com/c/00000000-0000-0000-0000-000000000104'
  const controller = new WorkController({ ledger, conversationHost: host, managedProjectUrl })
  await controller.decide('work_test', {
    action: 'SPLIT', reason: 'bounded test', frontiers: [{ id: 'f1', task: 'one task', depends_on: [] }]
  })
  await ledger.append('work_test', 'worker_dispatched', { frontierId: 'f1', conversationId: 'conv_1', phase: 'accepted', turnId: 'turn_1' })
  host.states.set('conv_1', { id: 'conv_1', status: 'error', latestTurnId: 'turn_1', error: 'stale timeout', externalUrl: target })
  host.state = async id => {
    host.states.set(id, { id, status: 'need_continue', latestTurnId: 'turn_1', latestResponse: 'partial shell', externalUrl: target })
    return {
      contractVersion: 1, conversationId: id, target, stateVersion: 2,
      turn: { turnId: 'turn_1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' },
      progress: 'blocked', body: 'incomplete', delivery: 'delivered', gate: 'none',
      writer: { mode: 'managed', epoch: 4 }
    }
  }

  const collected = await controller.collect('work_test')
  assert.equal(collected.collected, 0)
  assert.equal(collected.state.frontiers[0].status, 'dispatched')
  assert.equal(ledger.events.some(event => event.type === 'worker_result'), false)
})

test('collect keeps a legacy error pending when authoritative state says the exact turn is still active', async () => {
  const { WorkController } = await loadModule()
  const ledger = new FakeLedger()
  const host = new FakeHost()
  const target = 'https://chatgpt.com/c/00000000-0000-0000-0000-000000000106'
  const controller = new WorkController({ ledger, conversationHost: host, managedProjectUrl })
  await controller.decide('work_test', {
    action: 'SPLIT', reason: 'bounded test', frontiers: [{ id: 'f1', task: 'one task', depends_on: [] }]
  })
  await ledger.append('work_test', 'worker_dispatched', { frontierId: 'f1', conversationId: 'conv_1', phase: 'accepted', turnId: 'turn_1' })
  host.states.set('conv_1', { id: 'conv_1', status: 'error', latestTurnId: 'turn_1', error: 'stale timeout', externalUrl: target })
  host.state = async id => ({
    contractVersion: 1, conversationId: id, target, stateVersion: 2,
    turn: { turnId: 'turn_1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' },
    progress: 'active', body: 'incomplete', delivery: 'delivered', gate: 'none',
    writer: { mode: 'managed', epoch: 4 }
  })

  const collected = await controller.collect('work_test')
  assert.equal(collected.collected, 0)
  assert.equal(collected.state.frontiers[0].status, 'dispatched')
  assert.equal(ledger.events.some(event => event.type === 'worker_result'), false)
})

test('collect fails closed when authoritative reconciliation is unavailable for a legacy error', async () => {
  const { WorkController } = await loadModule()
  const ledger = new FakeLedger()
  const host = new FakeHost()
  const controller = new WorkController({ ledger, conversationHost: host, managedProjectUrl })
  await controller.decide('work_test', {
    action: 'SPLIT', reason: 'bounded test', frontiers: [{ id: 'f1', task: 'one task', depends_on: [] }]
  })
  await ledger.append('work_test', 'worker_dispatched', { frontierId: 'f1', conversationId: 'conv_1', phase: 'accepted', turnId: 'turn_1' })
  host.states.set('conv_1', {
    id: 'conv_1', status: 'error', latestTurnId: 'turn_1', error: 'legacy error',
    externalUrl: 'https://chatgpt.com/c/00000000-0000-0000-0000-000000000105'
  })
  host.state = async () => { throw new Error('authoritative owner unavailable') }

  const collected = await controller.collect('work_test')
  assert.equal(collected.collected, 0)
  assert.equal(ledger.events.some(event => event.type === 'worker_result'), false)
})

test('collect repairs a historical error only when the same worker later completes', async () => {
  const { WorkController } = await loadModule()
  const ledger = new FakeLedger()
  const host = new FakeHost()
  const controller = new WorkController({ ledger, conversationHost: host, managedProjectUrl })
  await controller.decide('work_test', {
    action: 'SPLIT', reason: 'bounded test', frontiers: [{ id: 'f1', task: 'one task', depends_on: [] }]
  })
  await ledger.append('work_test', 'worker_dispatched', { frontierId: 'f1', conversationId: 'conv_1', phase: 'accepted', turnId: 'turn_1' })
  await ledger.append('work_test', 'worker_result', { frontierId: 'f1', conversationId: 'conv_1', outcome: 'error', error: 'old transport timeout' })
  host.states.set('conv_1', { status: 'error', latestTurnId: 'turn_1' })
  assert.equal((await controller.collect('work_test')).collected, 0)
  host.states.set('conv_1', { status: 'completed', latestTurnId: 'unrelated', latestResponse: 'wrong turn' })
  assert.equal((await controller.collect('work_test')).collected, 0)
  host.states.set('conv_1', { status: 'completed', latestTurnId: 'turn_1', latestResponse: 'late reality' })
  const collected = await controller.collect('work_test')
  assert.equal(collected.collected, 1)
  assert.equal(collected.state.frontiers[0].result, 'late reality')
  assert.equal((await controller.collect('work_test')).collected, 0)
})

test('watchdog registration waits for the first terminal event carrying the exact conversation URL', async () => {
  const { WorkController } = await loadModule()
  const ledger = new FakeLedger()
  const host = new FakeHost()
  const watchdog = new FakeWatchdog()
  const controller = new WorkController({ ledger, conversationHost: host, managedProjectUrl, watchdog, now: () => FakeLedger.now })
  await controller.decide('work_test', {
    action: 'SPLIT', reason: 'bounded test', frontiers: [{ id: 'f1', task: 'one task', watchdog: true, depends_on: [] }]
  })
  host.states.set('conv_1', {
    id: 'conv_1', status: 'generating', latestTurnId: 'turn_1',
    externalUrl: 'https://chatgpt.com/g/g-p-subagents-test/project'
  })

  await controller.dispatch('work_test', 'f1')
  assert.deepEqual(watchdog.registered, [])

  await host.emitTerminal('conv_1', {
    type: 'response_completed',
    externalUrl: 'https://chatgpt.com/g/g-p-subagents-test/c/6aa-test-worker'
  })
  assert.deepEqual(watchdog.registered, ['https://chatgpt.com/g/g-p-subagents-test/c/6aa-test-worker'])
})

test('collect re-registers a watchdog-required durable need_continue after runtime listener loss', async () => {
  const { WorkController } = await loadModule()
  const url = 'https://chatgpt.com/c/6aa-need-continue-restart'
  const ledger = new FakeLedger([
    { at: '2026-09-03T08:00:00.000Z', type: 'goal', payload: { goal: 'inspect system' } },
    { at: '2026-09-03T08:01:00.000Z', type: 'decision', payload: { action: 'SPLIT', reason: 'work found', frontiers: [{ id: 'f1', task: 'first task', watchdog: true, depends_on: [] }] } },
    { at: '2026-09-03T08:02:00.000Z', type: 'worker_dispatched', payload: { frontierId: 'f1', conversationId: 'conv_1', turnId: 'turn_1', phase: 'accepted' } }
  ])
  const host = new FakeHost()
  host.states.set('conv_1', {
    id: 'conv_1', status: 'need_continue', latestTurnId: 'turn_1', latestResponse: 'partial response', externalUrl: url,
    events: [{ type: 'send_intent', turnId: 'turn_1', source: 'coordinator' }]
  })
  const watchdog = new FakeWatchdog()
  const controller = new WorkController({ ledger, conversationHost: host, managedProjectUrl, watchdog, now: () => FakeLedger.now })

  const result = await controller.collect('work_test')

  assert.equal(result.collected, 0)
  assert.equal(result.state.frontiers[0].status, 'dispatched')
  assert.deepEqual(watchdog.registered, [url])
  assert.equal(ledger.events.some(event => event.type === 'worker_result'), false)
})

test('collect re-registers a required watchdog after registry loss and does not fall back to phase-one completion', async () => {
  const { WorkController } = await loadModule()
  const ledger = new FakeLedger()
  const host = new FakeHost()
  const watchdog = new FakeWatchdog()
  const url = 'https://chatgpt.com/c/6aa-restart-worker'
  const controller = new WorkController({ ledger, conversationHost: host, managedProjectUrl, watchdog, now: () => FakeLedger.now })
  await controller.decide('work_test', {
    action: 'SPLIT', reason: 'bounded test', frontiers: [{ id: 'f1', task: 'one task', watchdog: true, depends_on: [] }]
  })
  host.states.set('conv_1', {
    id: 'conv_1', status: 'generating', latestTurnId: 'turn_1', externalUrl: url
  })
  await controller.dispatch('work_test', 'f1')
  host.states.set('conv_1', {
    id: 'conv_1', status: 'completed', latestTurnId: 'turn_1', latestResponse: 'phase one only', externalUrl: url
  })

  const afterRestart = await controller.collect('work_test')

  assert.equal(afterRestart.collected, 0)
  assert.equal(afterRestart.state.frontiers[0].status, 'dispatched')
  assert.deepEqual(watchdog.registered, [url])

  watchdog.completions.set(url, { active: false, completed: true, result: 'final after restart' })
  const collected = await controller.collect('work_test')
  assert.equal(collected.collected, 1)
  assert.equal(collected.state.frontiers[0].result, 'final after restart')
})

test('required watchdog registration failure is fail-closed during collect', async () => {
  const { WorkController } = await loadModule()
  const ledger = new FakeLedger()
  const host = new FakeHost()
  const watchdog = new FakeWatchdog()
  watchdog.registerResult = false
  const url = 'https://chatgpt.com/c/6aa-unavailable-worker'
  const controller = new WorkController({ ledger, conversationHost: host, managedProjectUrl, watchdog, now: () => FakeLedger.now })
  await controller.decide('work_test', {
    action: 'SPLIT', reason: 'bounded test', frontiers: [{ id: 'f1', task: 'one task', watchdog: true, depends_on: [] }]
  })
  host.states.set('conv_1', {
    id: 'conv_1', status: 'generating', latestTurnId: 'turn_1', externalUrl: url
  })
  await controller.dispatch('work_test', 'f1')
  host.states.set('conv_1', {
    id: 'conv_1', status: 'completed', latestTurnId: 'turn_1', latestResponse: 'must not collect', externalUrl: url
  })

  const result = await controller.collect('work_test')

  assert.equal(result.collected, 0)
  assert.equal(result.state.frontiers[0].status, 'dispatched')
  assert.deepEqual(watchdog.registered, [url])
})

test('collect waits for watchdog completion and uses the final watchdog result', async () => {
  const { WorkController } = await loadModule()
  const ledger = new FakeLedger()
  const host = new FakeHost()
  const watchdog = new FakeWatchdog()
  const url = 'https://chatgpt.com/c/6aa-test-worker'
  const controller = new WorkController({ ledger, conversationHost: host, managedProjectUrl, watchdog, now: () => FakeLedger.now })
  await controller.decide('work_test', {
    action: 'SPLIT', reason: 'bounded test', frontiers: [{ id: 'f1', task: 'one task', watchdog: true, depends_on: [] }]
  })
  host.states.set('conv_1', {
    id: 'conv_1', status: 'generating', latestTurnId: 'turn_1', externalUrl: url
  })
  await controller.dispatch('work_test', 'f1')
  host.states.set('conv_1', {
    id: 'conv_1', status: 'completed', latestTurnId: 'turn_1', latestResponse: 'phase one only', externalUrl: url
  })
  watchdog.completions.set(url, { active: true, completed: false, result: null })

  const premature = await controller.collect('work_test')
  assert.equal(premature.collected, 0)
  assert.equal(premature.state.frontiers[0].status, 'dispatched')

  watchdog.completions.set(url, { active: false, completed: true, result: 'final watchdog result' })
  const collected = await controller.collect('work_test')

  assert.equal(collected.collected, 1)
  assert.equal(collected.state.frontiers[0].status, 'completed')
  assert.equal(collected.state.frontiers[0].result, 'final watchdog result')
  assert.deepEqual(watchdog.acked, [url])
})
