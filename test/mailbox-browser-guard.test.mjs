import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
const source = await readFile(new URL('../extension/content-script.js', import.meta.url), 'utf8')
function fixture() {
  let listener, clicks = 0, pending = false, active = false, gate = false
  class Editor {
    value = ''
    focus() {}
    dispatchEvent() {}
    getAttribute() { return null }
  }
  const editor = new Editor()
  const turn = { getAttribute() { return 'conversation-turn-2' }, querySelector(s) { return s.includes('turn-action') ? {} : null } }
  const assistant = { innerText: 'complete body', getAttribute(n) { return n === 'data-message-id' ? 'a1' : null }, closest() { return turn }, compareDocumentPosition(n) { return pending && n === user ? 4 : 0 } }
  const user = { innerText: 'task', getAttribute(n) { return n === 'data-message-id' ? (pending ? 'u2' : 'u1') : null }, compareDocumentPosition() { return pending ? 0 : 4 }, querySelector() { return null } }
  const button = { disabled: false, getAttribute() { return null }, click() { clicks++; editor.value = '' } }
  const document = {
    querySelector(s) {
      if (s === '#prompt-textarea') return editor
      if (s === '[data-testid="send-button"]') return button
      if (s === '[data-testid="stop-button"]') return active ? {} : null
      if (s.includes('tool-approval-card')) return gate ? {} : null
      return null
    },
    querySelectorAll(s) {
      if (s === '[data-message-author-role="assistant"]') return [assistant]
      if (s === '[data-message-author-role="user"]') return [user]
      return []
    }
  }
  const context = vm.createContext({ document, location: { href: 'https://chatgpt.com/c/guard' }, chrome: { runtime: { sendMessage: async () => null, onMessage: { addListener(fn) { listener = fn } } } }, HTMLTextAreaElement: Editor, HTMLInputElement: class {}, InputEvent: class {}, setTimeout, clearTimeout, console })
  vm.runInContext(source, context)
  return { editor, set pending(v) { pending = v }, set active(v) { active = v }, set gate(v) { gate = v }, get clicks() { return clicks }, call: message => new Promise(resolve => { let replied = false; const asynchronous = listener(message, {}, value => { replied = true; resolve(value) }); if (!replied && asynchronous !== true) resolve({ missing: true }) }) }
}

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
