const DECISION_ACTIONS = new Set(['CONTINUE', 'SPLIT', 'PRUNE', 'REVISE', 'STOP'])
const ORCHESTRATION_MODES = new Set(['EXPLORE', 'EXECUTE', 'ADVERSARIAL', 'SYNTHESIZE'])
const MIN_DISPATCH_INTERVAL_MS = 120_000

function requireString(value, message) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(message)
  return value.trim()
}

function normalizeStringArray(value, message) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new TypeError(message)
  return value.map((item) => item.trim()).filter(Boolean)
}

function normalizePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new TypeError('REVISE requires plan')
  return {
    objective: requireString(plan.objective, 'plan objective is required'),
    approach: requireString(plan.approach, 'plan approach is required'),
    current_focus: requireString(plan.current_focus, 'plan current_focus is required'),
    assumptions: normalizeStringArray(plan.assumptions, 'plan assumptions must be an array of strings'),
    open_questions: normalizeStringArray(plan.open_questions, 'plan open_questions must be an array of strings')
  }
}

function normalizeOrchestration(orchestration) {
  if (!orchestration || typeof orchestration !== 'object' || Array.isArray(orchestration)) {
    throw new TypeError('REVISE requires orchestration')
  }
  const mode = requireString(orchestration.mode, 'orchestration mode is required').toUpperCase()
  if (!ORCHESTRATION_MODES.has(mode)) throw new TypeError(`unsupported orchestration mode: ${mode}`)
  return { mode }
}

function normalizeEvidenceIndexes(indexes, eventCount) {
  if (!Array.isArray(indexes) || indexes.length === 0) throw new TypeError('REVISE requires evidence_event_indexes')
  if (indexes.some((index) => !Number.isInteger(index) || index < 0 || index >= eventCount)) {
    throw new TypeError('invalid evidence event index')
  }
  if (new Set(indexes).size !== indexes.length) throw new TypeError('duplicate evidence event index')
  return [...indexes]
}

function normalizeFrontier(frontier) {
  if (!frontier || typeof frontier !== 'object' || Array.isArray(frontier)) {
    throw new TypeError('frontier must be an object')
  }
  const id = requireString(frontier.id, 'frontier id is required')
  const task = requireString(frontier.task, 'frontier task is required')
  const prompt = frontier.prompt === undefined ? undefined : requireString(frontier.prompt, 'frontier prompt must be a string')
  const dependsOn = frontier.depends_on ?? []
  if (!Array.isArray(dependsOn) || dependsOn.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new TypeError('frontier depends_on must be an array of ids')
  }
  return {
    id,
    task,
    ...(prompt ? { prompt } : {}),
    depends_on: [...new Set(dependsOn.map((value) => value.trim()))]
  }
}

function deriveState(work) {
  let goal = null
  let latestDecision = null
  let completed = false
  let stopped = false
  let currentPlan = null
  let currentOrchestration = null
  let planVersion = 0
  const planHistory = []
  const frontiers = new Map()

  for (const event of work.events) {
    if (event.type === 'goal' && typeof event.payload?.goal === 'string') goal ??= event.payload.goal

    if (event.type === 'decision') {
      if (stopped || completed) continue
      latestDecision = event.payload
      if (event.payload?.action === 'STOP') stopped = true
      if (event.payload?.action === 'REVISE') {
        planVersion += 1
        currentPlan = {
          version: planVersion,
          ...event.payload.plan,
          assumptions: [...(event.payload.plan?.assumptions ?? [])],
          open_questions: [...(event.payload.plan?.open_questions ?? [])]
        }
        currentOrchestration = { ...event.payload.orchestration }
        planHistory.push({
          version: planVersion,
          at: event.at,
          reason: event.payload.reason,
          evidence_event_indexes: [...(event.payload.evidence_event_indexes ?? [])],
          plan: {
            ...currentPlan,
            assumptions: [...currentPlan.assumptions],
            open_questions: [...currentPlan.open_questions]
          },
          orchestration: { ...currentOrchestration }
        })
      }
      if (event.payload?.action === 'SPLIT') {
        for (const frontier of event.payload.frontiers ?? []) {
          if (!frontiers.has(frontier.id)) {
            frontiers.set(frontier.id, { ...frontier, status: 'pending' })
          }
        }
      }
      if (event.payload?.action === 'PRUNE') {
        for (const id of event.payload.frontier_ids ?? []) {
          const frontier = frontiers.get(id)
          if (frontier && frontier.status !== 'completed') frontier.status = 'pruned'
        }
      }
    }

    if (event.type === 'worker_dispatched') {
      const frontier = frontiers.get(event.payload?.frontierId)
      if (frontier) {
        frontier.status = event.payload?.phase === 'allocated' ? 'dispatching' : 'dispatched'
        frontier.conversationId = event.payload.conversationId
        frontier.turnId = event.payload.turnId ?? frontier.turnId ?? null
      }
    }

    if (event.type === 'worker_result') {
      const frontier = frontiers.get(event.payload?.frontierId)
      if (frontier) {
        frontier.status = event.payload.outcome === 'completed' ? 'completed' : 'error'
        frontier.result = event.payload.result ?? null
        frontier.error = event.payload.error ?? null
      }
    }

    if (event.type === 'completed') completed = true
  }

  return {
    id: work.id,
    createdAt: work.createdAt,
    goal,
    latestDecision,
    completed,
    stopped,
    currentPlan,
    currentOrchestration,
    planHistory,
    frontiers: [...frontiers.values()],
    events: work.events
  }
}

function workerPrompt(frontier, state) {
  const planContext = state.currentPlan
    ? [
        '',
        `Current plan v${state.currentPlan.version}`,
        `Objective: ${state.currentPlan.objective}`,
        `Approach: ${state.currentPlan.approach}`,
        `Current focus: ${state.currentPlan.current_focus}`,
        `Orchestration mode: ${state.currentOrchestration?.mode ?? 'EXECUTE'}`,
        `Assumptions: ${state.currentPlan.assumptions.join('; ') || '(none)'}`,
        `Open questions: ${state.currentPlan.open_questions.join('; ') || '(none)'}`
      ]
    : []
  return [
    'You are a depth-1 worker for a coordinator-managed task.',
    'Do not create, delegate to, or spawn any additional workers or agents.',
    'Complete only the bounded task below. Return your result, evidence, and any unresolved frontiers to the coordinator.',
    ...planContext,
    '',
    `Task: ${frontier.prompt ?? frontier.task}`
  ].join('\n')
}

export class WorkController {
  constructor({ ledger, conversationHost, now = () => Date.now(), minDispatchIntervalMs = MIN_DISPATCH_INTERVAL_MS }) {
    this.ledger = ledger
    this.conversationHost = conversationHost
    this.now = now
    this.minDispatchIntervalMs = minDispatchIntervalMs
    this.lastDispatchAt = null
    this.decisionQueue = Promise.resolve()
    this.dispatchQueue = Promise.resolve()
  }

  async state(workId) {
    return deriveState(await this.ledger.read(workId))
  }

  async decide(workId, decision) {
    const run = this.decisionQueue.then(() => this.#decide(workId, decision))
    this.decisionQueue = run.catch(() => {})
    return run
  }

  async #decide(workId, decision) {
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
      throw new TypeError('work decision must be an object')
    }
    const action = requireString(decision.action, 'work decision action is required').toUpperCase()
    if (!DECISION_ACTIONS.has(action)) throw new TypeError(`unsupported work decision action: ${action}`)
    const reason = requireString(decision.reason, 'work decision reason is required')
    const current = await this.state(workId)
    if (current.stopped || current.completed) throw new Error('work is stopped')
    const existingIds = new Set(current.frontiers.map((frontier) => frontier.id))
    let payload

    if (action === 'REVISE') {
      payload = {
        action,
        reason,
        evidence_event_indexes: normalizeEvidenceIndexes(decision.evidence_event_indexes, current.events.length),
        plan: normalizePlan(decision.plan),
        orchestration: normalizeOrchestration(decision.orchestration)
      }
    } else if (action === 'SPLIT') {
      if (!Array.isArray(decision.frontiers) || decision.frontiers.length === 0) {
        throw new TypeError('SPLIT requires frontiers')
      }
      const frontiers = decision.frontiers.map(normalizeFrontier)
      const ids = new Set()
      for (const frontier of frontiers) {
        if (ids.has(frontier.id) || existingIds.has(frontier.id)) throw new TypeError(`duplicate frontier id: ${frontier.id}`)
        ids.add(frontier.id)
      }
      const knownIds = new Set([...existingIds, ...ids])
      for (const frontier of frontiers) {
        for (const dependency of frontier.depends_on) {
          if (!knownIds.has(dependency)) throw new TypeError(`unknown frontier dependency: ${dependency}`)
          if (dependency === frontier.id) throw new TypeError(`frontier cannot depend on itself: ${frontier.id}`)
        }
      }
      const newById = new Map(frontiers.map((frontier) => [frontier.id, frontier]))
      const visiting = new Set()
      const visited = new Set()
      const visit = (id) => {
        if (visited.has(id)) return
        if (visiting.has(id)) throw new TypeError(`frontier dependency cycle: ${id}`)
        visiting.add(id)
        for (const dependency of newById.get(id)?.depends_on ?? []) {
          if (newById.has(dependency)) visit(dependency)
        }
        visiting.delete(id)
        visited.add(id)
      }
      for (const id of ids) visit(id)
      payload = { action, reason, frontiers }
    } else if (action === 'PRUNE') {
      if (!Array.isArray(decision.frontier_ids) || decision.frontier_ids.length === 0) {
        throw new TypeError('PRUNE requires frontier_ids')
      }
      const frontierIds = [...new Set(decision.frontier_ids.map((id) => requireString(id, 'frontier id is required')))]
      for (const id of frontierIds) {
        if (!existingIds.has(id)) throw new TypeError(`unknown frontier id: ${id}`)
      }
      payload = { action, reason, frontier_ids: frontierIds }
    } else {
      payload = { action, reason }
    }

    await this.ledger.append(workId, 'decision', payload)
    return this.state(workId)
  }

  async dispatch(workId, frontierId) {
    const run = this.dispatchQueue.then(() => this.#dispatch(workId, frontierId))
    this.dispatchQueue = run.catch(() => {})
    return run
  }

  async #dispatch(workId, frontierId) {
    const state = await this.state(workId)
    if (state.stopped || state.completed) throw new Error('work is stopped')
    const frontier = state.frontiers.find((item) => item.id === frontierId)
    if (!frontier) throw new TypeError(`unknown frontier id: ${frontierId}`)
    if (frontier.status !== 'pending') throw new Error(`frontier is not pending: ${frontierId}`)

    const byId = new Map(state.frontiers.map((item) => [item.id, item]))
    const incomplete = frontier.depends_on.filter((id) => byId.get(id)?.status !== 'completed')
    if (incomplete.length > 0) throw new Error(`frontier dependencies are not complete: ${incomplete.join(', ')}`)

    const lastDispatch = [...state.events].reverse().find((event) => event.type === 'worker_dispatched')
    const recordedDispatchAt = lastDispatch ? Date.parse(lastDispatch.at) : null
    const lastDispatchAt = Math.max(recordedDispatchAt ?? 0, this.lastDispatchAt ?? 0)
    if (lastDispatchAt > 0) {
      const elapsed = this.now() - lastDispatchAt
      if (elapsed < this.minDispatchIntervalMs) {
        return {
          dispatched: false,
          reason: 'pacing',
          retryAfterMs: this.minDispatchIntervalMs - Math.max(0, elapsed)
        }
      }
    }

    const conversation = await this.conversationHost.create({})
    await this.ledger.append(workId, 'worker_dispatched', {
      frontierId,
      conversationId: conversation.id,
      task: frontier.task,
      phase: 'allocated'
    })

    try {
      this.lastDispatchAt = this.now()
      const sent = await this.conversationHost.send(conversation.id, workerPrompt(frontier, state))
      await this.ledger.append(workId, 'worker_dispatched', {
        frontierId,
        conversationId: conversation.id,
        task: frontier.task,
        phase: 'accepted',
        turnId: sent.turnId
      })
      return {
        dispatched: true,
        frontierId,
        conversationId: conversation.id,
        turnId: sent.turnId,
        accepted: sent.accepted === true
      }
    } catch (error) {
      await this.ledger.append(workId, 'worker_result', {
        frontierId,
        conversationId: conversation.id,
        outcome: 'error',
        result: null,
        error: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }

  async collect(workId) {
    const before = await this.state(workId)
    let collected = 0

    for (const frontier of before.frontiers) {
      if (frontier.status !== 'dispatched' || !frontier.conversationId) continue
      const conversation = await this.conversationHost.read(frontier.conversationId)
      if (conversation.status !== 'completed' && conversation.status !== 'error') continue
      await this.ledger.append(workId, 'worker_result', {
        frontierId: frontier.id,
        conversationId: frontier.conversationId,
        outcome: conversation.status,
        result: conversation.latestResponse ?? null,
        error: conversation.error ?? null
      })
      collected += 1
    }

    return { collected, state: await this.state(workId) }
  }
}
