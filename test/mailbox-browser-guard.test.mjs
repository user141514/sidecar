import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
const source = await readFile(new URL('../extension/content-script.js', import.meta.url), 'utf8')
function fixture({ normalizeWrites = false, bodyMode = null, laterTurn = false, interrupted = false, finalized = true, needsInputText = false } = {}) {
  let listener, clicks = 0, pending = false, active = false, gate = false, submitted = false
  class Editor {
    _value = ''
    get value() { return this._value }
    set value(value) { this._value = normalizeWrites ? String(value).replace(/\n/g, '\n\n') : value }
    focus() {}
    dispatchEvent() {}
    getAttribute() { return null }
  }
  const editor = new Editor()
  const turn = { getAttribute() { return 'conversation-turn-2' }, querySelector(s) { return finalized && s.includes('turn-action') ? {} : null } }
  const assistantText = needsInputText ? 'Need approval\n[SUPERVISOR_STATE: NEED_INPUT]' : bodyMode === 'incomplete' ? 'Only heading' : 'complete body'
  const assistant = { innerText: assistantText, getAttribute(n) { return n === 'data-message-id' ? 'a1' : null }, closest() { return turn }, compareDocumentPosition(n) { return pending && n === user ? 4 : 0 } }
  if (bodyMode) {
    const root = { innerText: assistant.innerText, querySelector(s) {
      if (bodyMode === 'substantive' && /p, li, pre, code/.test(s)) return {}
      if (bodyMode === 'incomplete' && /h1, h2, h3/.test(s)) return {}
      return null
    } }
    assistant.querySelector = s => /data-message-content|assistant-message-content|markdown|prose/.test(s) ? root : null
  }
  const user = { innerText: 'task', getAttribute(n) { return n === 'data-message-id' ? (pending ? 'u2' : 'u1') : null }, compareDocumentPosition() { return pending ? 0 : 4 }, querySelector() { return null } }
  const submittedUser = { innerText: 'submitted command', getAttribute(n) { return n === 'data-message-id' ? 'u-submit' : null }, querySelector() { return null } }
  const laterUser = { innerText: 'later task', getAttribute(n) { return n === 'data-message-id' ? 'u-later' : null }, compareDocumentPosition() { return 4 }, querySelector() { return null } }
  const laterAssistant = { innerText: 'later answer', getAttribute(n) { return n === 'data-message-id' ? 'a-later' : null }, closest() { return turn }, compareDocumentPosition() { return 0 } }
  const button = { disabled: false, getAttribute() { return null }, click() { clicks++; editor.value = ''; submitted = true } }
  const document = {
    querySelector(s) {
      if (s === '#prompt-textarea') return editor
      if (s === '[data-testid="send-button"]') return button
      if (s === '[data-testid="stop-button"]') return active ? {} : null
      if (s.includes('tool-approval-card')) return gate ? {} : null
      return null
    },
    querySelectorAll(s) {
      if (s === '[data-message-author-role="assistant"]') return laterTurn ? [assistant, laterAssistant] : [assistant]
      if (s === '[data-message-author-role="user"]') {
        const base = submitted ? [user, submittedUser] : [user]
        return laterTurn ? [...base, laterUser] : base
      }
      if (s === 'button') return interrupted ? [{
        textContent: '',
        getAttribute(name) { return name === 'aria-label' ? 'Continue generating' : null }
      }] : []
      return []
    }
  }
  const context = vm.createContext({ document, location: { href: 'https://chatgpt.com/c/guard' }, chrome: { runtime: { sendMessage: async () => null, onMessage: { addListener(fn) { listener = fn } } } }, HTMLTextAreaElement: Editor, HTMLInputElement: class {}, InputEvent: class {}, setTimeout, clearTimeout, console })
  vm.runInContext(source, context)
  return { editor, set pending(v) { pending = v }, set active(v) { active = v }, set gate(v) { gate = v }, get clicks() { return clicks }, call: message => new Promise(resolve => { let replied = false; const asynchronous = listener(message, {}, value => { replied = true; resolve(value) }); if (!replied && asynchronous !== true) resolve({ missing: true }) }) }
}

test('state observation anchors exact user identity and reuses body/terminal evidence', async () => {
  const complete = fixture({ bodyMode: 'substantive' })
  const state = await complete.call({ type: 'conversation_state_observe', expectedUserMessageId: 'u1' })
  assert.equal(state.readable, true)
  assert.equal(state.userMessageId, 'u1')
  assert.equal(state.assistantMessageId, 'a1')
  assert.equal(state.assistantText, 'complete body')
  assert.equal(state.generating, false)
  assert.equal(state.terminal, true)
  assert.equal(state.body, 'substantive')
  assert.equal(state.humanGate, false)

  const shellOnly = fixture({ bodyMode: 'incomplete' })
  assert.equal((await shellOnly.call({ type: 'conversation_state_observe', expectedUserMessageId: 'u1' })).body, 'incomplete')
})

test('state observation fails closed when exact user identity is absent', async () => {
  const f = fixture({ bodyMode: 'substantive' })
  const state = await f.call({ type: 'conversation_state_observe', expectedUserMessageId: 'missing-user' })
  assert.equal(state.readable, false)
  assert.equal(state.userMessageId, null)
  assert.equal(state.assistantMessageId, null)
  assert.equal(state.terminal, null)
})

test('state observation fails closed when a newer user turn supersedes the expected turn', async () => {
  const f = fixture({ bodyMode: 'substantive', laterTurn: true })
  const state = await f.call({ type: 'conversation_state_observe', expectedUserMessageId: 'u1' })
  assert.equal(state.readable, false)
  assert.equal(state.userMessageId, 'u1')
  assert.equal(state.assistantMessageId, null)
  assert.equal(state.terminal, null)
})

test('interrupted substantive response is not terminal state evidence', async () => {
  const f = fixture({ bodyMode: 'substantive', interrupted: true })
  const state = await f.call({ type: 'conversation_state_observe', expectedUserMessageId: 'u1' })
  assert.equal(state.readable, true)
  assert.equal(state.generating, false)
  assert.equal(state.body, 'substantive')
  assert.equal(state.terminal, false)
})

test('legacy writer guard still requires local terminal evidence', async () => {
  const f = fixture({ finalized: false })
  const observed = await f.call({ type: 'conversation_observe' })
  assert.equal(observed.allowed, false)
  assert.equal(observed.reason, 'terminal_evidence_missing')
  const prepared = await f.call({
    type: 'conversation_prepare', guarded: true, turnId: 't-legacy', text: 'continue',
    expected: { userMessageId: 'u1', assistantMessageId: 'a1' }
  })
  assert.equal(prepared.prepared, false)
  assert.equal(f.clicks, 0)
})

test('authoritative writer observation delegates lifecycle finality but preserves live effect safety', async () => {
  const f = fixture({ finalized: false })
  const observed = await f.call({ type: 'conversation_observe', authoritativeState: true })
  assert.equal(observed.allowed, true)

  for (const field of ['active', 'gate', 'pending']) {
    const g = fixture({ finalized: false }); g[field] = true
    const denied = await g.call({ type: 'conversation_observe', authoritativeState: true })
    assert.equal(denied.allowed, false)
  }
})

test('acknowledged textual human gate follows Sidecar authority while live browser approval gate still blocks', async () => {
  const legacy = fixture({ needsInputText: true })
  const legacyPrepared = await legacy.call({
    type: 'conversation_prepare', guarded: true,
    turnId: 't-human-legacy', text: 'continue', expected: { userMessageId: 'u1', assistantMessageId: 'a1' }
  })
  assert.equal(legacyPrepared.prepared, false)

  const authoritative = fixture({ needsInputText: true })
  const acknowledged = await authoritative.call({
    type: 'conversation_prepare', guarded: true, authoritativeState: true,
    turnId: 't-human-ack', text: 'continue', expected: { userMessageId: 'u1', assistantMessageId: 'a1' }
  })
  assert.equal(acknowledged.prepared, true)

  const liveApproval = fixture({ needsInputText: true })
  liveApproval.gate = true
  const denied = await liveApproval.call({
    type: 'conversation_prepare', guarded: true, authoritativeState: true,
    turnId: 't-live-approval', text: 'continue', expected: { userMessageId: 'u1', assistantMessageId: 'a1' }
  })
  assert.equal(denied.prepared, false)
})

test('authoritative writer guard delegates lifecycle finality to Sidecar but preserves effect safety checks', async () => {
  const f = fixture({ finalized: false })
  const prepared = await f.call({
    type: 'conversation_prepare', guarded: true, authoritativeState: true,
    turnId: 't-v1', text: 'continue', expected: { userMessageId: 'u1', assistantMessageId: 'a1' }
  })
  assert.equal(prepared.prepared, true)
  assert.equal((await f.call({ type: 'conversation_submit', guarded: true, authoritativeState: true, turnId: 't-v1' })).accepted, true)
  assert.equal(f.clicks, 1)

  for (const field of ['active', 'gate', 'pending']) {
    const g = fixture({ finalized: false }); g[field] = true
    const denied = await g.call({
      type: 'conversation_prepare', guarded: true, authoritativeState: true,
      turnId: `t-${field}`, text: 'continue', expected: { userMessageId: 'u1', assistantMessageId: 'a1' }
    })
    assert.equal(denied.prepared, false)
    assert.equal(g.clicks, 0)
  }
})

test('writer observation detects a newer user before new assistant or Stop exists', async () => {
  const f = fixture(); f.pending = true
  const state = await f.call({ type: 'conversation_observe' })
  assert.equal(state.allowed, false)
  assert.equal(state.reason, 'user_turn_pending')
})

test('newer coordinator user between prepare and submit denies the actual click', async () => {
  const f = fixture()
  const prepared = await f.call({ type: 'conversation_prepare', guarded: true, turnId: 't1', text: 'continue', expected: { userMessageId: 'u1', assistantMessageId: 'a1' } })
  assert.equal(prepared.prepared, true)
  f.pending = true
  const submitted = await f.call({ type: 'conversation_submit', guarded: true, turnId: 't1' })
  assert.equal(submitted.accepted, false)
  assert.equal(f.clicks, 0)
})

test('guarded prepare never overwrites an existing human draft', async () => {
  const f = fixture(); f.editor.value = 'human draft'
  const prepared = await f.call({ type: 'conversation_prepare', guarded: true, turnId: 't1', text: 'continue' })
  assert.equal(prepared.prepared, false)
  assert.equal(f.editor.value, 'human draft')
})

test('guarded send owns the composer representation produced synchronously by the editor', async () => {
  const f = fixture({ normalizeWrites: true })
  const prepared = await f.call({ type: 'conversation_prepare', guarded: true, turnId: 't1', text: 'line one\nline two', expected: { userMessageId: 'u1', assistantMessageId: 'a1' } })
  assert.equal(prepared.prepared, true)
  const submitted = await f.call({ type: 'conversation_submit', guarded: true, turnId: 't1' })
  assert.equal(submitted.accepted, true)
  assert.equal(f.clicks, 1)
})

test('matching prepared command clicks once and active generation or human gate never clicks', async () => {
  const f = fixture()
  await f.call({ type: 'conversation_prepare', guarded: true, turnId: 't1', text: 'continue' })
  assert.equal((await f.call({ type: 'conversation_submit', guarded: true, turnId: 't1' })).accepted, true)
  assert.equal(f.clicks, 1)
  for (const field of ['active', 'gate']) {
    const g = fixture(); g[field] = true
    assert.equal((await g.call({ type: 'conversation_prepare', guarded: true, turnId: 't2', text: 'continue' })).prepared, false)
    assert.equal(g.clicks, 0)
  }
})
