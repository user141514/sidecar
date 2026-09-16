import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function loadStoreModule() {
  try {
    return await import('../src/store.mjs')
  } catch {
    return {}
  }
}

test('ConversationStore persists append-only events and reconstructs latest state', async () => {
  const { ConversationStore } = await loadStoreModule()
  assert.equal(typeof ConversationStore, 'function')
  if (typeof ConversationStore !== 'function') return

  const root = await mkdtemp(join(tmpdir(), 'conversation-sidecar-store-'))
  try {
    const store = new ConversationStore(root)
    const created = await store.create({ backend: 'chatgpt-web', externalUrl: 'https://chatgpt.com/' })

    assert.match(created.id, /^conv_[a-z0-9-]+$/)
    assert.equal(created.status, 'idle')

    await store.append(created.id, {
      type: 'prompt_sent',
      turnId: 'turn_1',
      text: 'probe'
    })
    await store.append(created.id, {
      type: 'generation_started',
      turnId: 'turn_1'
    })
    await store.append(created.id, {
      type: 'response_completed',
      turnId: 'turn_1',
      text: 'PROJECT_A_SUBAGENT_TEST_001'
    })

    const state = await store.read(created.id)
    assert.equal(state.status, 'completed')
    assert.equal(state.latestResponse, 'PROJECT_A_SUBAGENT_TEST_001')
    assert.equal(state.latestTurnId, 'turn_1')
    assert.equal(state.events.length, 4)

    const raw = await readFile(join(root, created.id, 'events.jsonl'), 'utf8')
    const lines = raw.trim().split('\n')
    assert.equal(lines.length, 4)
    assert.equal(JSON.parse(lines[0]).type, 'conversation_created')
    assert.equal(JSON.parse(lines[3]).type, 'response_completed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ConversationStore keeps current turn status and response causally aligned despite late old terminal events', async () => {
  const { ConversationStore } = await loadStoreModule()
  assert.equal(typeof ConversationStore, 'function')
  if (typeof ConversationStore !== 'function') return

  const root = await mkdtemp(join(tmpdir(), 'conversation-sidecar-store-'))
  try {
    const store = new ConversationStore(root)
    const created = await store.create({ backend: 'chatgpt-web', externalUrl: 'https://chatgpt.com/' })

    await store.append(created.id, { type: 'prompt_sent', turnId: 'turn_1', text: 'first' })
    await store.append(created.id, { type: 'generation_started', turnId: 'turn_1' })
    await store.append(created.id, { type: 'response_completed', turnId: 'turn_1', text: 'OLD' })
    await store.append(created.id, { type: 'prompt_sent', turnId: 'turn_2', text: 'second' })
    await store.append(created.id, { type: 'generation_started', turnId: 'turn_2' })

    let state = await store.read(created.id)
    assert.equal(state.status, 'generating')
    assert.equal(state.latestTurnId, 'turn_2')
    assert.equal(state.latestResponse, null)
    assert.equal(state.error, null)

    await store.append(created.id, { type: 'error', turnId: 'turn_2', message: 'failed' })
    state = await store.read(created.id)
    assert.equal(state.status, 'error')
    assert.equal(state.latestTurnId, 'turn_2')
    assert.equal(state.latestResponse, null)
    assert.equal(state.error, 'failed')

    await store.append(created.id, { type: 'response_completed', turnId: 'turn_1', text: 'LATE_OLD' })
    state = await store.read(created.id)
    assert.equal(state.status, 'error')
    assert.equal(state.latestTurnId, 'turn_2')
    assert.equal(state.latestResponse, null)
    assert.equal(state.error, 'failed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ConversationStore persists a default ChatGPT Project URL across sidecar restarts', async () => {
  const { ConversationStore } = await loadStoreModule()
  assert.equal(typeof ConversationStore, 'function')
  if (typeof ConversationStore !== 'function') return

  const root = await mkdtemp(join(tmpdir(), 'conversation-sidecar-store-'))
  try {
    const projectUrl = 'https://chatgpt.com/g/g-p-project123-agent/project'
    const first = new ConversationStore(root)
    await first.setDefaultProjectUrl(projectUrl)

    const restarted = new ConversationStore(root)
    assert.equal(await restarted.getDefaultProjectUrl(), projectUrl)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ConversationStore reconstructs need_continue as a recoverable terminal turn state', async () => {
  const { ConversationStore } = await loadStoreModule()
  assert.equal(typeof ConversationStore, 'function')
  if (typeof ConversationStore !== 'function') return

  const root = await mkdtemp(join(tmpdir(), 'conversation-sidecar-store-'))
  try {
    const store = new ConversationStore(root)
    const created = await store.create({ backend: 'chatgpt-web', externalUrl: 'https://chatgpt.com/' })
    await store.append(created.id, { type: 'prompt_sent', turnId: 'turn_need', text: 'finish it' })
    await store.append(created.id, { type: 'generation_started', turnId: 'turn_need' })
    await store.append(created.id, {
      type: 'need_continue',
      turnId: 'turn_need',
      text: 'partial shell',
      reason: 'assistant_body_incomplete',
      externalUrl: 'https://chatgpt.com/c/need'
    })

    const state = await store.read(created.id)
    assert.equal(state.status, 'need_continue')
    assert.equal(state.latestTurnId, 'turn_need')
    assert.equal(state.latestResponse, 'partial shell')
    assert.equal(state.error, null)
    assert.equal(state.externalUrl, 'https://chatgpt.com/c/need')

    await store.append(created.id, {
      type: 'response_completed',
      turnId: 'turn_need',
      text: 'eventual complete answer',
      externalUrl: 'https://chatgpt.com/c/need'
    })
    await store.append(created.id, {
      type: 'need_continue',
      turnId: 'turn_need',
      text: 'late incomplete observation',
      reason: 'assistant_body_incomplete',
      externalUrl: 'https://chatgpt.com/c/need'
    })
    const finalState = await store.read(created.id)
    assert.equal(finalState.status, 'completed')
    assert.equal(finalState.latestResponse, 'eventual complete answer')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ConversationStore allocates one deterministic logical child per NEW intent across restart', async () => {
  const { ConversationStore } = await loadStoreModule()
  assert.equal(typeof ConversationStore, 'function')
  if (typeof ConversationStore !== 'function') return

  const root = await mkdtemp(join(tmpdir(), 'conversation-sidecar-allocation-'))
  try {
    const request = {
      backend: 'chatgpt-web-extension',
      externalUrl: 'https://chatgpt.com/g/g-p-project123-agent/project',
      intentId: 'intent-new-stable-1',
      intentDigest: 'a'.repeat(64)
    }
    const firstStore = new ConversationStore(root)
    assert.equal(typeof firstStore.allocate, 'function')
    const first = await firstStore.allocate(request)
    const duplicate = await firstStore.allocate(request)
    const restarted = await new ConversationStore(root).allocate(request)

    assert.equal(first.id, duplicate.id)
    assert.equal(first.id, restarted.id)
    assert.equal(first.allocationIntentId, request.intentId)
    assert.equal(first.allocationIntentDigest, request.intentDigest)
    assert.match(first.id, /^conv_[a-f0-9]{64}$/)

    const raw = await readFile(join(root, first.id, 'events.jsonl'), 'utf8')
    const events = raw.trim().split('\n').map(line => JSON.parse(line))
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'conversation_created')
    assert.equal(events[0].allocationIntentId, request.intentId)
    assert.equal(events[0].allocationIntentDigest, request.intentDigest)

    await assert.rejects(
      firstStore.allocate({ ...request, intentDigest: 'b'.repeat(64) }),
      /allocation identity conflict/i
    )

    const other = await firstStore.allocate({ ...request, intentId: 'intent-new-stable-2' })
    assert.notEqual(other.id, first.id)

    const concurrentRequest = { ...request, intentId: 'intent-new-concurrent' }
    const [left, right] = await Promise.all([
      new ConversationStore(root).allocate(concurrentRequest),
      new ConversationStore(root).allocate(concurrentRequest)
    ])
    assert.equal(left.id, right.id)
    const concurrentRaw = await readFile(join(root, left.id, 'events.jsonl'), 'utf8')
    assert.equal(concurrentRaw.trim().split('\n').length, 1)

    await assert.rejects(
      firstStore.allocate({ ...request, externalUrl: 'https://chatgpt.com/g/g-p-other/project' }),
      /allocation identity conflict/i
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('legacy NEW allocation without payload digest fails closed before its first send', async () => {
  const { ConversationStore } = await loadStoreModule()
  const root = await mkdtemp(join(tmpdir(), 'conversation-sidecar-legacy-unbound-'))
  try {
    const store = new ConversationStore(root)
    const legacy = await store.allocate({
      backend: 'chatgpt-web-extension',
      externalUrl: 'https://chatgpt.com/g/g-p-project123-agent/project',
      intentId: 'legacy-unbound-intent'
    })
    assert.equal(legacy.allocationIntentDigest, undefined)
    await assert.rejects(
      store.allocate({
        backend: 'chatgpt-web-extension',
        externalUrl: 'https://chatgpt.com/g/g-p-project123-agent/project',
        intentId: 'legacy-unbound-intent',
        intentDigest: 'c'.repeat(64)
      }),
      /allocation identity conflict/i
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('legacy NEW allocation already bound by send intent remains replayable during digest upgrade', async () => {
  const { ConversationStore } = await loadStoreModule()
  const root = await mkdtemp(join(tmpdir(), 'conversation-sidecar-legacy-bound-'))
  try {
    const store = new ConversationStore(root)
    const legacy = await store.allocate({
      backend: 'chatgpt-web-extension',
      externalUrl: 'https://chatgpt.com/g/g-p-project123-agent/project',
      intentId: 'legacy-bound-intent'
    })
    await store.append(legacy.id, {
      type: 'send_intent', turnId: 'turn-legacy', requestId: 'legacy-bound-intent', text: 'original task', source: 'human'
    })
    const replay = await new ConversationStore(root).allocate({
      backend: 'chatgpt-web-extension',
      externalUrl: 'https://chatgpt.com/g/g-p-project123-agent/project',
      intentId: 'legacy-bound-intent',
      intentDigest: 'd'.repeat(64)
    })
    assert.equal(replay.id, legacy.id)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ConversationStore records errors as durable terminal state', async () => {
  const { ConversationStore } = await loadStoreModule()
  assert.equal(typeof ConversationStore, 'function')
  if (typeof ConversationStore !== 'function') return

  const root = await mkdtemp(join(tmpdir(), 'conversation-sidecar-store-'))
  try {
    const store = new ConversationStore(root)
    const created = await store.create({ backend: 'chatgpt-web', externalUrl: 'https://chatgpt.com/' })
    await store.append(created.id, { type: 'error', turnId: 'turn_2', message: 'boom' })

    const state = await store.read(created.id)
    assert.equal(state.status, 'error')
    assert.equal(state.error, 'boom')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
