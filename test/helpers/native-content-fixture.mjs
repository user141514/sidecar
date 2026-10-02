import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../../extension/content-script.js', import.meta.url), 'utf8')
export const MODERN_USER_ID = 'dc791b85-4e62-4628-8ecf-79c5a745a05a'
export const MODERN_ASSISTANT_ID = 'dc5c12a9-6092-4ddf-a7bf-6a178ffa8f99'
export const MODERN_THREAD_URL = 'https://chatgpt.com/g/g-p-test-subagents/c/6abfe3a7-9f60-83e8-880b-58a25b1901f9'

export function nativeContentFixture({ submitted = true, generating = false, ids = MODERN_ASSISTANT_ID + ' ' + MODERN_ASSISTANT_ID,
  selectionId = MODERN_ASSISTANT_ID, turnId = MODERN_USER_ID, userId = MODERN_USER_ID, terminal = true,
  ambiguousMain = false, foreignUnit = false, dialogUnit = false, conflictingRole = false, replaceBaseline = false, submissionId = MODERN_USER_ID, submissionText = null, collapsedUser = false, userContentRoots = 1, foreignUserContent = false, outsideUserBubble = false } = {}) {
  let listener, transport = async () => ({ durable: true }), submittedHook = null, clock = 0, clicks = 0, focused = null
  const all = []
  const matches = (node, selector) => selector.split(',').some(value => {
    const rule = value.trim(), tag = rule.match(/^[a-z][\w-]*/i)?.[0]
    if (tag && node.tagName.toLowerCase() !== tag.toLowerCase()) return false
    const id = rule.match(/^#([\w-]+)/)?.[1]
    if (id && node.getAttribute('id') !== id) return false
    for (const attribute of rule.matchAll(/\[([^\s~|^$*!=\]]+)\s*(?:(\^=|\*=|=)\s*"([^"]*)"\s*(i)?)?\]/g)) {
      let actual = node.getAttribute(attribute[1]), expected = attribute[3]
      if (attribute[4]) { actual = actual?.toLowerCase(); expected = expected.toLowerCase() }
      if (!attribute[2] && actual === null) return false
      if (attribute[2] === '=' && actual !== expected) return false
      if (attribute[2] === '^=' && !actual?.startsWith(expected)) return false
      if (attribute[2] === '*=' && !actual?.includes(expected)) return false
    }
    const cls = rule.match(/^\.([\w-]+)/)?.[1]
    return (!cls || (node.getAttribute('class') || '').split(/\s+/).includes(cls)) && Boolean(tag || id || cls || rule.includes('['))
  })
  const descendants = node => all.filter(candidate => candidate !== node && node.contains(candidate))
  const make = (tag, attrs = {}, parent = null, text = '') => {
    const node = { tagName: tag.toUpperCase(), parentElement: parent, attrs, ownText: text, shown: true, connected: true,
      get textContent() { return this.ownText + all.filter(child => child.parentElement === this && child.connected).map(child => child.textContent).join('') },
      set textContent(value) { this.ownText = value },
      get innerText() { return this.textContent }, get id() { return this.getAttribute('id') || '' },
      getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null },
      contains(other) { for (let p = other; p; p = p.parentElement) if (p === this) return true; return false },
      closest(selector) { for (let p = this; p; p = p.parentElement) if (matches(p, selector)) return p; return null },
      querySelectorAll(selector) { return descendants(this).filter(child => child.connected && matches(child, selector)) },
      querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null },
      getClientRects() { for (let p = this; p; p = p.parentElement) if (!p.shown || !p.connected || p.attrs.hidden !== undefined || p.attrs['aria-hidden'] === 'true') return []; return [{ width: 500, height: 24 }] },
      compareDocumentPosition(other) { if (!this.connected || !other.connected) return 1; return all.indexOf(this) < all.indexOf(other) ? 4 : this === other ? 0 : 2 },
      focus() { focused = this }, dispatchEvent() {}
    }
    all.push(node); return node
  }
  const shell = make('div'), main = make('main', { 'data-app-shell-main-surface': 'browser' }, shell)
  const sidebar = make('aside', {}, shell), hiddenHistory = make('div', { role: 'status', hidden: '' }, sidebar, '无法加载历史记录')
  make('button', { 'aria-label': '重试' }, hiddenHistory, '重试')
  const hiddenStop = make('button', { 'data-testid': 'stop-button', 'aria-label': 'Stop responding', hidden: '' }, sidebar)
  hiddenStop.click = () => { throw new Error('Foreign hidden Stop was clicked') }
  if (ambiguousMain) make('main', { 'data-app-shell-main-surface': 'browser' }, shell)
  const form = make('form', {}, main), composer = make('div', { 'data-composer-body': '' }, form)
  const input = make('div', { 'data-composer-input': '' }, composer)
  const editor = make('div', { id: '', role: 'textbox', contenteditable: 'true', 'aria-label': '在“subagents”中新建聊天' }, input)
  const send = make('button', { 'data-testid': 'send-button', 'aria-label': 'Send', 'aria-disabled': 'false' }, form)
  send.disabled = false
  const stop = make('button', { 'data-testid': 'stop-button', 'aria-label': 'Stop responding' }, form)
  stop.disabled = false; stop.connected = generating
  stop.click = () => { clicks++; generating = false; stop.connected = false }
  const turn = make('section', { 'data-turn-key': turnId }, foreignUnit ? sidebar : dialogUnit ? make('div', { role: 'dialog' }, main) : main)
  const searchTurn = make('div', { 'data-content-search-turn-key': 'fallback-turn-0' }, turn)
  const user = make('div', { 'data-chatgpt-search-unit-key': 'fallback-turn-0:0:user', 'data-chatgpt-search-message-ids': userId }, searchTurn)
  const contentUnit = make('div', { 'data-content-search-unit-key': 'fallback-turn-0:0:user' }, user)
  const bubble = make('div', { 'data-user-message-bubble': 'true' }, contentUnit, collapsedUser ? '' : 'fixture prompt')
  const userBodies = []
  if (collapsedUser) {
    const collapseShell = make('div', {}, make('div', {}, bubble))
    for (let index = 0; index < userContentRoots; index++) {
      const parent = outsideUserBubble ? contentUnit : foreignUserContent ? make('div', { role: 'dialog' }, collapseShell) : collapseShell
      const target = make('div', { 'data-search-result-target': '', class: 'overflow-hidden', style: 'max-height:494px' }, parent)
      userBodies.push(make('div', { dir: 'auto' }, make('div', {}, target), 'fixture prompt'))
    }
    make('span', { 'aria-hidden': 'true' }, collapseShell, '\n…\n')
    make('button', { 'aria-expanded': 'false', 'data-thread-find-skip': 'true' }, collapseShell, '显示更多')
  }
  make('button', { 'aria-label': '复制消息' }, user)
  const assistant = make('div', { 'data-content-search-unit-key': 'fallback-turn-0:2:assistant', 'data-chatgpt-search-unit-key': 'fallback-turn-0:2:assistant', 'data-chatgpt-search-message-ids': ids }, searchTurn)
  make('h4', { 'data-conversation-role': 'assistant', class: 'sr-only' }, assistant, 'ChatGPT 说：')
  if (conflictingRole) make('div', { 'data-user-message-bubble': 'true' }, assistant, 'decoy')
  const wrapper = make('div', { 'data-chatgpt-selection-conversation-id': 'local-chatgpt:7611e69c-88dd-4b54-99ab-56258c3c6643', 'data-chatgpt-selection-message-id': selectionId }, make('div', {}, assistant))
  const body = make('div', { 'data-markdown-text-style': 'assistant-message' }, wrapper)
  make('span', {}, make('p', {}, body), 'ACTION_OK')
  const terminalButtons = ['复制', '重新生成回复', '回复不佳'].map(label => make('button', { 'aria-label': label }, turn))
  for (const button of terminalButtons) button.connected = terminal
  make('div', { role: 'status', 'aria-live': 'polite' }, main, '回答已完成')
  const setSubmitted = value => {
    submitted = value
    for (const node of all.filter(node => turn.contains(node))) node.connected = value
    for (const button of terminalButtons) button.connected = value && terminal
    stop.connected = generating
  }
  setSubmitted(submitted)
  if (replaceBaseline && !submitted) {
    user.attrs['data-chatgpt-search-message-ids'] = '11111111-1111-4111-8111-111111111111'
    turn.attrs['data-turn-key'] = user.attrs['data-chatgpt-search-message-ids']
    user.connected = contentUnit.connected = bubble.connected = turn.connected = searchTurn.connected = true
  }
  const submit = () => {
    clicks++; const text = submissionText ?? editor.textContent.trim()
    if (collapsedUser) for (const body of userBodies) body.textContent = text
    else bubble.textContent = text
    editor.textContent = ''; user.attrs['data-chatgpt-search-message-ids'] = submissionId
    turn.attrs['data-turn-key'] = submissionId; setSubmitted(true); submittedHook?.()
  }
  send.click = submit; form.requestSubmit = submit
  const document = { title: 'subagents',
    querySelectorAll(selector) { return all.filter(node => node.connected && matches(node, selector)) },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null },
    execCommand(command, _ui, text) { if (command === 'insertText' && focused) focused.textContent = text; return true }
  }
  const location = { href: MODERN_THREAD_URL }
  const context = vm.createContext({ document, location, __sidecarBuildId: 'a'.repeat(64),
    chrome: { runtime: { sendMessage: message => transport(message), onMessage: { addListener(fn) { listener = fn }, removeListener() {} } } },
    HTMLTextAreaElement: class {}, HTMLInputElement: class {}, InputEvent: class {}, URL, console,
    getComputedStyle(node) { return { display: node.shown ? 'block' : 'none', visibility: 'visible', opacity: '1' } },
    Date: class extends Date { static now() { return clock } },
    setTimeout(callback, delay) { clock += delay; queueMicrotask(callback); return 1 }, clearTimeout() {} })
  vm.runInContext(source, context)
  return { call(message) { return new Promise(resolve => { listener(message, {}, resolve) }) },
    configureRuntimeTransport(fn) { transport = fn }, configureOnSubmit(fn) { submittedHook = fn }, get runtime() { return context.__sidecarContentRuntime },
    get clicks() { return clicks }, document, location, editor, main, turn, user, bubble, userBodies, assistant, terminalButtons, stop,
    addNode: make, setSubmitted, setGenerating(value) { generating = value; stop.connected = value }, dispose() { context.__sidecarContentRuntime.dispose() } }
}
