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
