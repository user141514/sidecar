import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../extension/content-script.js', import.meta.url), 'utf8')

async function runSubmitFixture({ clickTakesEffect, requestSubmitTakesEffect = false, hasForm = true, draftOnly = false, generationOnly = false }) {
  let runtimeListener = null
  let userSubmitted = false
  let generationVisible = false
  const editor = {
    textContent: 'fixture prompt',
    get innerText() { return this.textContent },
    focus() {},
    dispatchEvent() {},
    getAttribute() { return null }
  }
  const form = {
    requestSubmit() {
      if (requestSubmitTakesEffect) {
        editor.textContent = ''
        if (generationOnly) generationVisible = true
        else if (!draftOnly) userSubmitted = true
      }
    }
  }
  const sendButton = {
    disabled: false,
    getAttribute(name) {
      if (name === 'data-testid') return 'send-button'
      if (name === 'aria-disabled') return 'false'
      return null
    },
    closest(selector) {
      return selector === 'form' && hasForm ? form : null
    },
    click() {
      if (clickTakesEffect) {
        editor.textContent = ''
        if (generationOnly) generationVisible = true
        else if (!draftOnly) userSubmitted = true
      }
    }
  }
  const document = {
    querySelector(selector) {
      if (selector === '#prompt-textarea') return editor
      if (selector === '[data-testid="send-button"]') return sendButton
      if (selector === '[data-testid="stop-button"]') return generationVisible ? {} : null
      return null
    },
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') return []
      if (selector === '[data-message-author-role="user"]') return userSubmitted ? [{ getAttribute(name) { return name === 'data-message-id' ? 'user-submitted-1' : null } }] : []
      if (selector === 'button') return [sendButton]
      if (selector === '[contenteditable="true"]') return []
      return []
    },
    execCommand() { return true }
  }
  const context = {
    document,
    location: { href: 'https://chatgpt.com/g/g-p-test-subagents/project' },
    chrome: {
      runtime: {
        async sendMessage() { return null },
        onMessage: {
          addListener(listener) { runtimeListener = listener },
          removeListener() {}
        }
      }
    },
    HTMLTextAreaElement: class {},
    HTMLInputElement: class {},
    InputEvent: class {},
    Date,
    Promise,
    Object,
    URL,
    console,
    setTimeout(callback) { queueMicrotask(callback); return 1 },
    clearTimeout() {}
  }
  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'extension/content-script.js' })
  return await new Promise((resolve) => {
    const keepOpen = runtimeListener({ type: 'conversation_submit' }, {}, resolve)
    assert.equal(keepOpen, true)
  })
}

test('conversation_submit rejects a click that leaves the prompt draft untouched', async () => {
  const response = await runSubmitFixture({ clickTakesEffect: false })
  assert.equal(response.accepted, false)
  assert.match(response.error, /submit|submission|prompt/i)
})

test('conversation_submit rejects draft clearing without a new user turn or generation evidence', async () => {
  const response = await runSubmitFixture({ clickTakesEffect: true, hasForm: false, draftOnly: true })
  assert.equal(response.accepted, false)
  assert.match(response.error, /submit|submission|prompt/i)
})

test('conversation_submit rejects generation UI without a new user turn', async () => {
  const response = await runSubmitFixture({ clickTakesEffect: true, hasForm: false, generationOnly: true })
  assert.equal(response.accepted, false)
  assert.match(response.error, /submit|submission|prompt/i)
})

test('conversation_submit falls back to button click when no form is available', async () => {
  const response = await runSubmitFixture({ clickTakesEffect: true, hasForm: false })
  assert.equal(response.accepted, true)
  assert.equal(response.userMessageId, 'user-submitted-1')
})

test('conversation_submit prefers native form submission when button click is ignored', async () => {
  const response = await runSubmitFixture({ clickTakesEffect: false, requestSubmitTakesEffect: true })
  assert.equal(response.accepted, true)
  assert.equal(response.userMessageId, 'user-submitted-1')
})

test('conversation_prepare selects a requested ChatGPT app before writing prompt text', async () => {
  let runtimeListener = null
  let menuOpen = false
  const order = []

  const editor = {
    textContent: '',
    focus() { order.push('focus-editor') },
    dispatchEvent() {},
    getAttribute() { return null }
  }
  const plusButton = {
    disabled: false,
    textContent: '',
    getAttribute(name) {
      if (name === 'aria-label') return 'Add files and more'
      if (name === 'data-testid') return 'composer-plus-btn'
      return null
    },
    click() {
      menuOpen = true
      order.push('open-tools')
    }
  }
  const appItem = {
    disabled: false,
    textContent: 'DevSpace',
    getAttribute(name) {
      return name === 'aria-label' ? 'DevSpace' : null
    },
    click() {
      order.push('select-app')
      menuOpen = false
    }
  }

  const document = {
    querySelector(selector) {
      if (selector === '#prompt-textarea') return editor
      if (selector === '[data-testid="composer-plus-btn"]') return plusButton
      if (selector === '[data-testid="stop-button"]') return null
      return null
    },
    querySelectorAll(selector) {
      if (selector === '[contenteditable="true"]') return []
      if (selector === '[data-message-author-role="assistant"]') return []
      if (selector === '[data-message-author-role="user"]') return []
      if (selector === 'button') return menuOpen ? [plusButton, appItem] : [plusButton]
      if (selector.includes('[role="menuitem"]') || selector.includes('[role="option"]')) {
        return menuOpen ? [appItem] : []
      }
      return []
    },
    execCommand(command, _showUi, value) {
      if (command === 'insertText') order.push(`write:${value}`)
      return true
    }
  }
  const context = {
    document,
    location: { href: 'https://chatgpt.com/c/app-test' },
    chrome: {
      runtime: {
        async sendMessage() { return null },
        onMessage: {
          addListener(listener) { runtimeListener = listener },
          removeListener() {}
        }
      }
    },
    HTMLTextAreaElement: class {},
    HTMLInputElement: class {},
    InputEvent: class {},
    Date,
    Promise,
    Object,
    URL,
    console,
    setTimeout(callback) { queueMicrotask(callback); return 1 },
    clearTimeout() {}
  }

  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'extension/content-script.js' })

  const response = await new Promise((resolve) => {
    const keepOpen = runtimeListener(
      { type: 'conversation_prepare', text: 'hello', app: 'DevSpace' },
      {},
      resolve
    )
    assert.equal(keepOpen, true)
  })

  assert.equal(response.prepared, true)
  assert.ok(order.includes('select-app'), `app was not selected: ${order.join(',')}`)
  assert.ok(
    order.indexOf('select-app') < order.findIndex((entry) => entry.startsWith('write:')),
    `prompt text was written before app selection: ${order.join(',')}`
  )
})

test('webgpt shift probe switches High to Extra High on the current page and reads it back', async () => {
  let pickerOpen = false
  let selected = 'High'
  const pickerButton = {
    disabled: false,
    get textContent() { return selected },
    getAttribute(name) { return name === 'aria-label' ? `Thinking ${selected}` : null },
    click() { pickerOpen = true }
  }
  const extraHigh = {
    disabled: false,
    textContent: 'Extra High',
    getAttribute(name) { return name === 'aria-label' ? 'Extra High' : null },
    click() { selected = 'Extra High'; pickerOpen = false }
  }
  const document = {
    title: 'ChatGPT',
    querySelector() { return null },
    querySelectorAll(selector) {
      if (selector === 'button') return pickerOpen ? [pickerButton, extraHigh] : [pickerButton]
      if (selector.includes('[role="menuitem"]') || selector.includes('[role="option"]')) return pickerOpen ? [extraHigh] : []
      if (selector === '[contenteditable="true"]') return []
      if (selector === '[data-message-author-role="assistant"]') return []
      if (selector === '[data-message-author-role="user"]') return []
      return []
    },
    execCommand() { return true }
  }
  const context = {
    document,
    location: { href: 'https://chatgpt.com/c/profile-test#webgpt-shift-test=Extra%20High', hash: '#webgpt-shift-test=Extra%20High' },
    chrome: { runtime: { sendMessage: async () => null, onMessage: { addListener() {}, removeListener() {} } } },
    HTMLTextAreaElement: class {},
    HTMLInputElement: class {},
    InputEvent: class {},
    Date,
    Promise,
    Object,
    URL,
    console,
    setTimeout(callback) { queueMicrotask(callback); return 1 },
    clearTimeout() {}
  }

  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'extension/content-script.js' })
  for (let attempt = 0; attempt < 8 && !document.title.startsWith('WEBGPT_SHIFT_'); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }

  assert.equal(document.title, 'WEBGPT_SHIFT_OK|High|Extra High')
})

test('webgpt shift probe canonicalizes Chinese strength labels and switches Extra High to Medium', async () => {
  let pickerOpen = false
  let selected = '极高'
  const pickerButton = {
    disabled: false,
    get textContent() { return selected },
    getAttribute(name) { return name === 'aria-label' ? selected : null },
    click() { pickerOpen = true }
  }
  const medium = {
    disabled: false,
    textContent: '中等',
    getAttribute(name) { return name === 'aria-label' ? '中等' : null },
    click() { selected = '中等'; pickerOpen = false }
  }
  const document = {
    title: 'ChatGPT',
    querySelector() { return null },
    querySelectorAll(selector) {
      if (selector === 'button') return pickerOpen ? [pickerButton, medium] : [pickerButton]
      if (selector.includes('[role="menuitem"]') || selector.includes('[role="option"]')) return pickerOpen ? [medium] : []
      if (selector === '[contenteditable="true"]') return []
      if (selector === '[data-message-author-role="assistant"]') return []
      if (selector === '[data-message-author-role="user"]') return []
      return []
    },
    execCommand() { return true }
  }
  const context = {
    document,
    location: { href: 'https://chatgpt.com/c/profile-test#webgpt-shift-test=Medium', hash: '#webgpt-shift-test=Medium' },
    chrome: { runtime: { sendMessage: async () => null, onMessage: { addListener() {}, removeListener() {} } } },
    HTMLTextAreaElement: class {},
    HTMLInputElement: class {},
    InputEvent: class {},
    Date,
    Promise,
    Object,
    URL,
    console,
    setTimeout(callback) { queueMicrotask(callback); return 1 },
    clearTimeout() {}
  }

  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'extension/content-script.js' })
  for (let attempt = 0; attempt < 8 && !document.title.startsWith('WEBGPT_SHIFT_'); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }

  assert.equal(document.title, 'WEBGPT_SHIFT_OK|Extra High|Medium')
})

test('webgpt shift probe recognizes compact Chinese Medium label used by current ChatGPT UI', async () => {
  let pickerOpen = false
  let selected = '中'
  const pickerButton = {
    disabled: false,
    get textContent() { return selected },
    getAttribute(name) { return name === 'aria-label' ? selected : null },
    click() { pickerOpen = true }
  }
  const instant = {
    disabled: false,
    textContent: '即时',
    getAttribute(name) { return name === 'aria-label' ? '即时' : null },
    click() { selected = '即时'; pickerOpen = false }
  }
  const document = {
    title: 'ChatGPT',
    querySelector() { return null },
    querySelectorAll(selector) {
      if (selector === 'button') return pickerOpen ? [pickerButton, instant] : [pickerButton]
      if (selector.includes('[role="menuitem"]') || selector.includes('[role="option"]')) return pickerOpen ? [instant] : []
      if (selector === '[contenteditable="true"]') return []
      if (selector === '[data-message-author-role="assistant"]') return []
      if (selector === '[data-message-author-role="user"]') return []
      return []
    },
    execCommand() { return true }
  }
  const context = {
    document,
    location: { href: 'https://chatgpt.com/c/profile-test#webgpt-shift-test=Instant', hash: '#webgpt-shift-test=Instant' },
    chrome: { runtime: { sendMessage: async () => null, onMessage: { addListener() {}, removeListener() {} } } },
    HTMLTextAreaElement: class {},
    HTMLInputElement: class {},
    InputEvent: class {},
    Date,
    Promise,
    Object,
    URL,
    console,
    setTimeout(callback) { queueMicrotask(callback); return 1 },
    clearTimeout() {}
  }

  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'extension/content-script.js' })
  for (let attempt = 0; attempt < 8 && !document.title.startsWith('WEBGPT_SHIFT_'); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }

  assert.equal(document.title, 'WEBGPT_SHIFT_OK|Medium|Instant')
})

test('webgpt shift probe reports bounded menu labels when the requested strength option is absent', async () => {
  let pickerOpen = false
  const pickerButton = {
    disabled: false,
    textContent: '极高',
    getAttribute(name) { return name === 'aria-label' ? '极高' : null },
    click() { pickerOpen = true }
  }
  const unknownOption = {
    disabled: false,
    textContent: '标准',
    getAttribute(name) {
      if (name === 'aria-label') return '标准'
      if (name === 'role') return 'menuitemradio'
      return null
    }
  }
  const document = {
    title: 'ChatGPT',
    querySelector() { return null },
    querySelectorAll(selector) {
      if (selector === 'button') return [pickerButton]
      if (selector.includes('[role="menuitem"]') || selector.includes('[role="option"]')) return pickerOpen ? [unknownOption] : []
      if (selector === '[contenteditable="true"]') return []
      if (selector === '[data-message-author-role="assistant"]') return []
      if (selector === '[data-message-author-role="user"]') return []
      return []
    },
    execCommand() { return true }
  }
  const context = {
    document,
    location: { href: 'https://chatgpt.com/c/profile-test#webgpt-shift-test=High', hash: '#webgpt-shift-test=High' },
    chrome: { runtime: { sendMessage: async () => null, onMessage: { addListener() {}, removeListener() {} } } },
    HTMLTextAreaElement: class {},
    HTMLInputElement: class {},
    InputEvent: class {},
    Date,
    Promise,
    Object,
    URL,
    console,
    setTimeout(callback) { queueMicrotask(callback); return 1 },
    clearTimeout() {}
  }

  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'extension/content-script.js' })
  for (let attempt = 0; attempt < 8 && !document.title.startsWith('WEBGPT_SHIFT_'); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }

  assert.equal(
    document.title,
    'WEBGPT_SHIFT_ERROR|WebGPT thinking option was not found: High; candidates=["标准"]'
  )
})

test('webgpt shift probe resolves options from the trigger aria-controls popup', async () => {
  let pickerOpen = false
  let selected = '极高'
  const medium = {
    disabled: false,
    textContent: '中等',
    getAttribute(name) { return name === 'aria-label' ? '中等' : null },
    click() { selected = '中等'; pickerOpen = false }
  }
  const popup = {
    querySelectorAll() { return pickerOpen ? [medium] : [] }
  }
  const pickerButton = {
    disabled: false,
    get textContent() { return selected },
    getAttribute(name) {
      if (name === 'aria-label') return selected
      if (name === 'aria-controls') return 'strength-popup'
      return null
    },
    click() { pickerOpen = true }
  }
  const document = {
    title: 'ChatGPT',
    getElementById(id) { return id === 'strength-popup' ? popup : null },
    querySelector() { return null },
    querySelectorAll(selector) {
      if (selector === 'button') return [pickerButton]
      if (selector.includes('[role="menuitem"]') || selector.includes('[role="option"]')) return []
      if (selector === '[contenteditable="true"]') return []
      if (selector === '[data-message-author-role="assistant"]') return []
      if (selector === '[data-message-author-role="user"]') return []
      return []
    },
    execCommand() { return true }
  }
  const context = {
    document,
    location: { href: 'https://chatgpt.com/c/profile-test#webgpt-shift-test=Medium', hash: '#webgpt-shift-test=Medium' },
    chrome: { runtime: { sendMessage: async () => null, onMessage: { addListener() {}, removeListener() {} } } },
    HTMLTextAreaElement: class {},
    HTMLInputElement: class {},
    InputEvent: class {},
    Date,
    Promise,
    Object,
    URL,
    console,
    setTimeout(callback) { queueMicrotask(callback); return 1 },
    clearTimeout() {}
  }

  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'extension/content-script.js' })
  for (let attempt = 0; attempt < 8 && !document.title.startsWith('WEBGPT_SHIFT_'); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }

  assert.equal(document.title, 'WEBGPT_SHIFT_OK|Extra High|Medium')
})

test('webgpt shift probe opens Radix strength menu on pointerdown when click is inert', async () => {
  let pickerOpen = false
  let selected = '极高'
  class FakePointerEvent {
    constructor(type, init = {}) {
      this.type = type
      Object.assign(this, init)
    }
  }
  const high = {
    disabled: false,
    textContent: '高',
    getAttribute(name) { return name === 'aria-label' ? '高' : null },
    click() { selected = '高'; pickerOpen = false }
  }
  const popup = {
    querySelectorAll() { return pickerOpen ? [high] : [] }
  }
  const pickerButton = {
    disabled: false,
    get textContent() { return selected },
    getAttribute(name) {
      if (name === 'aria-label') return selected
      if (name === 'aria-controls') return 'strength-popup'
      return null
    },
    dispatchEvent(event) {
      if (event.type === 'pointerdown') pickerOpen = true
      return true
    },
    click() {}
  }
  const document = {
    title: 'ChatGPT',
    getElementById(id) { return id === 'strength-popup' ? popup : null },
    querySelector() { return null },
    querySelectorAll(selector) {
      if (selector === 'button') return [pickerButton]
      if (selector.includes('[role="menuitem"]') || selector.includes('[role="option"]')) return []
      if (selector === '[contenteditable="true"]') return []
      if (selector === '[data-message-author-role="assistant"]') return []
      if (selector === '[data-message-author-role="user"]') return []
      return []
    },
    execCommand() { return true }
  }
  const context = {
    document,
    location: { href: 'https://chatgpt.com/c/profile-test#webgpt-shift-test=High', hash: '#webgpt-shift-test=High' },
    chrome: { runtime: { sendMessage: async () => null, onMessage: { addListener() {}, removeListener() {} } } },
    HTMLTextAreaElement: class {},
    HTMLInputElement: class {},
    InputEvent: class {},
    PointerEvent: FakePointerEvent,
    Date,
    Promise,
    Object,
    URL,
    console,
    setTimeout(callback) { queueMicrotask(callback); return 1 },
    clearTimeout() {}
  }

  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'extension/content-script.js' })
  for (let attempt = 0; attempt < 8 && !document.title.startsWith('WEBGPT_SHIFT_'); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }

  assert.equal(document.title, 'WEBGPT_SHIFT_OK|Extra High|High')
})

test('webgpt shift probe drives the capability slider by index and leaves the fifth position untouched', async () => {
  let pickerOpen = false
  let index = 3
  const labels = { 0: '即时', 1: '中等', 2: '高', 3: '极高', 4: 'Pro' }
  class FakePointerEvent {
    constructor(type, init = {}) { this.type = type; Object.assign(this, init) }
  }
  class FakeKeyboardEvent {
    constructor(type, init = {}) { this.type = type; Object.assign(this, init) }
  }
  const slider = {
    disabled: false,
    get textContent() { return `${labels[index]}，第 ${index} 项，共 5 项。使用左右箭头键调整能力。` },
    getAttribute(name) {
      if (name === 'role') return 'slider'
      if (name === 'aria-valuenow') return String(index)
      if (name === 'aria-valuemin') return '0'
      if (name === 'aria-valuemax') return '4'
      if (name === 'aria-valuetext') return labels[index]
      return null
    },
    dispatchEvent(event) {
      if (event.type === 'keydown' && event.key === 'ArrowLeft' && index > 0) index -= 1
      if (event.type === 'keydown' && event.key === 'ArrowRight' && index < 4) index += 1
      return true
    },
    focus() {}
  }
  const popup = { querySelectorAll() { return pickerOpen ? [slider] : [] } }
  const pickerButton = {
    disabled: false,
    get textContent() { return '思考强度' },
    getAttribute(name) {
      if (name === 'aria-controls') return 'strength-popup'
      if (name === 'aria-haspopup') return 'menu'
      return null
    },
    dispatchEvent(event) { if (event.type === 'pointerdown') pickerOpen = true; return true },
    click() {}
  }
  const document = {
    title: 'ChatGPT',
    getElementById(id) { return id === 'strength-popup' ? popup : null },
    querySelector() { return null },
    querySelectorAll(selector) {
      if (selector === 'button') return [pickerButton]
      if (selector.includes('[role="menuitem"]') || selector.includes('[role="option"]')) return []
      if (selector === '[contenteditable="true"]') return []
      if (selector === '[data-message-author-role="assistant"]') return []
      if (selector === '[data-message-author-role="user"]') return []
      return []
    },
    execCommand() { return true }
  }
  const context = {
    document,
    location: { href: 'https://chatgpt.com/c/profile-test#webgpt-shift-test=High', hash: '#webgpt-shift-test=High' },
    chrome: { runtime: { sendMessage: async () => null, onMessage: { addListener() {}, removeListener() {} } } },
    HTMLTextAreaElement: class {},
    HTMLInputElement: class {},
    InputEvent: class {},
    PointerEvent: FakePointerEvent,
    KeyboardEvent: FakeKeyboardEvent,
    Date,
    Promise,
    Object,
    URL,
    console,
    setTimeout(callback) { queueMicrotask(callback); return 1 },
    clearTimeout() {}
  }

  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'extension/content-script.js' })
  for (let attempt = 0; attempt < 8 && !document.title.startsWith('WEBGPT_SHIFT_'); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }

  assert.equal(index, 2)
  assert.equal(document.title, 'WEBGPT_SHIFT_OK|思考强度|High')
})

test('webgpt shift probe waits for a semantic strength control rendered as role button', async () => {
  let pickerOpen = false
  let selected = '极高'
  let controlQueries = 0
  const pickerButton = {
    disabled: false,
    get textContent() { return selected },
    getAttribute(name) {
      if (name === 'aria-label') return selected
      if (name === 'role') return 'button'
      return null
    },
    click() { pickerOpen = true }
  }
  const high = {
    disabled: false,
    textContent: '高',
    getAttribute(name) {
      if (name === 'aria-label') return '高'
      if (name === 'role') return 'menuitemradio'
      return null
    },
    click() { selected = '高'; pickerOpen = false }
  }
  const document = {
    title: 'ChatGPT',
    querySelector() { return null },
    querySelectorAll(selector) {
      if (selector === 'button') return []
      if (selector.includes('[role="button"]')) {
        controlQueries += 1
        return controlQueries >= 3 ? [pickerButton] : []
      }
      if (selector.includes('[role="menuitem"]') || selector.includes('[role="option"]')) return pickerOpen ? [high] : []
      if (selector === '[contenteditable="true"]') return []
      if (selector === '[data-message-author-role="assistant"]') return []
      if (selector === '[data-message-author-role="user"]') return []
      return []
    },
    execCommand() { return true }
  }
  const context = {
    document,
    location: { href: 'https://chatgpt.com/c/profile-test#webgpt-shift-test=High', hash: '#webgpt-shift-test=High' },
    chrome: { runtime: { sendMessage: async () => null, onMessage: { addListener() {}, removeListener() {} } } },
    HTMLTextAreaElement: class {},
    HTMLInputElement: class {},
    InputEvent: class {},
    MessageChannel: class {
      constructor() {
        this.port1 = { onmessage: null, close() {} }
        this.port2 = {
          postMessage: () => queueMicrotask(() => this.port1.onmessage?.()),
          close() {}
        }
      }
    },
    Date,
    Promise,
    Object,
    URL,
    console,
    setTimeout() { throw new Error('WebGPT strength probing must not depend on timers') },
    clearTimeout() {}
  }

  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'extension/content-script.js' })
  for (let attempt = 0; attempt < 12 && !document.title.startsWith('WEBGPT_SHIFT_'); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }

  assert.equal(document.title, 'WEBGPT_SHIFT_OK|Extra High|High')
  assert.ok(controlQueries >= 3)
})

test('webgpt shift probe accepts a localized class-only composer pill as the strength control', async () => {
  let pickerOpen = false
  let selected = '极高'
  let pointerDowns = 0
  const pickerButton = {
    disabled: false,
    className: '__composer-pill __composer-pill--neutral group/pill',
    get textContent() { return selected },
    getAttribute(name) {
      if (name === 'aria-label') return selected
      if (name === 'class') return this.className
      return null
    },
    dispatchEvent() { pointerDowns += 1; return true },
    click() { pickerOpen = true }
  }
  const high = {
    disabled: false,
    textContent: '高',
    getAttribute(name) {
      if (name === 'aria-label') return '高'
      if (name === 'role') return 'menuitemradio'
      return null
    },
    click() { selected = '高'; pickerOpen = false }
  }
  const document = {
    title: 'ChatGPT',
    querySelector() { return null },
    querySelectorAll(selector) {
      if (selector === '.__composer-pill') return [pickerButton]
      if (selector === 'button') return []
      if (selector.includes('[role="button"]') || selector.includes('[aria-haspopup]') || selector.includes('[aria-controls]')) return []
      if (selector.includes('[role="menuitem"]') || selector.includes('[role="option"]')) return pickerOpen ? [high] : []
      if (selector === '[contenteditable="true"]') return []
      if (selector === '[data-message-author-role="assistant"]') return []
      if (selector === '[data-message-author-role="user"]') return []
      return []
    },
    execCommand() { return true }
  }
  const context = {
    document,
    location: { href: 'https://chatgpt.com/c/profile-test#webgpt-shift-test=High', hash: '#webgpt-shift-test=High' },
    chrome: { runtime: { sendMessage: async () => null, onMessage: { addListener() {}, removeListener() {} } } },
    HTMLTextAreaElement: class {},
    HTMLInputElement: class {},
    InputEvent: class {},
    PointerEvent: class {},
    Date,
    Promise,
    Object,
    URL,
    console,
    setTimeout(callback) { queueMicrotask(callback); return 1 },
    clearTimeout() {}
  }

  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'extension/content-script.js' })
  for (let attempt = 0; attempt < 12 && !document.title.startsWith('WEBGPT_SHIFT_'); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }

  assert.equal(document.title, 'WEBGPT_SHIFT_OK|Extra High|High')
  assert.equal(pointerDowns, 0)
})

test('project_find returns the canonical Project URL from the current sidebar without clicking', async () => {
  let runtimeListener = null
  const links = [
    {
      textContent: 'agent',
      getAttribute(name) {
        return name === 'href' ? '/g/g-p-agent-test-agent/project' : null
      }
    },
    {
      textContent: 'subagents',
      getAttribute(name) {
        return name === 'href' ? '/g/g-p-subagents-test/project' : null
      }
    }
  ]
  const document = {
    querySelector() {
      return null
    },
    querySelectorAll(selector) {
      if (selector === 'a[href]') return links
      if (selector === 'button') return []
      if (selector === '[contenteditable="true"]') return []
      if (selector === '[data-message-author-role="assistant"]') return []
      return []
    },
    execCommand() {
      return true
    }
  }
  const context = {
    document,
    location: { href: 'https://chatgpt.com/c/current' },
    chrome: {
      runtime: {
        async sendMessage() {
          return null
        },
        onMessage: {
          addListener(listener) {
            runtimeListener = listener
          }
        }
      }
    },
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    InputEvent: class {},
    Date,
    Promise,
    Object,
    URL,
    console,
    setTimeout(callback) {
      queueMicrotask(callback)
      return 1
    },
    clearTimeout() {}
  }

  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'extension/content-script.js' })

  const response = await new Promise((resolve) => {
    const keepOpen = runtimeListener({ type: 'project_find', name: 'subagents' }, {}, resolve)
    assert.equal(keepOpen, true)
  })

  assert.equal(response.found, true)
  assert.equal(response.name, 'subagents')
  assert.equal(response.projectUrl, 'https://chatgpt.com/g/g-p-subagents-test/project')
})

test('project_open maps an existing Project conversation to the authoritative Project home link', async () => {
  let runtimeListener = null
  let clicked = false
  const requestedProjectUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946/project'
  const navigationProjectUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946-subagents/project'
  const links = [{
    textContent: '',
    getAttribute(name) {
      return name === 'href' ? navigationProjectUrl : null
    },
    click() { clicked = true }
  }]
  const document = {
    querySelector() { return null },
    querySelectorAll(selector) {
      if (selector === 'a[href]') return links
      if (selector === 'button') return []
      if (selector === 'button,[role="button"]') return []
      if (selector === '[contenteditable="true"]') return []
      if (selector === '[data-message-author-role="assistant"]') return []
      return []
    },
    execCommand() { return true }
  }
  const context = {
    document,
    location: { href: 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946/c/thread-existing' },
    chrome: {
      runtime: {
        async sendMessage() { return null },
        onMessage: { addListener(listener) { runtimeListener = listener } }
      }
    },
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    InputEvent: class {},
    Date, Promise, Object, URL, console,
    setTimeout(callback) { queueMicrotask(callback); return 1 },
    clearTimeout() {}
  }

  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'extension/content-script.js' })

  const response = await new Promise((resolve) => {
    const keepOpen = runtimeListener({ type: 'project_open', projectUrl: requestedProjectUrl }, {}, resolve)
    assert.equal(keepOpen, true)
  })

  assert.equal(response.accepted, true)
  assert.equal(response.projectUrl, navigationProjectUrl)
  assert.equal(response.control?.kind, 'project-link')
  assert.equal(clicked, true)
})

test('project_open waits for the authoritative Project anchor on an existing Project conversation before using sidebar controls', async () => {
  let runtimeListener = null
  let rowClicked = false
  let anchorClicked = false
  let anchorVisible = false
  let linkQueries = 0
  const projectUrl = 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946-subagents/project'
  const projectAnchor = {
    textContent: '打开“subagents”项目',
    tagName: 'A',
    getAttribute(name) {
      if (name === 'href') return '/g/g-p-6a983ccfa9148191b42da3db5412f946-subagents/project'
      if (name === 'class') return 'project-anchor'
      return null
    },
    click() { anchorClicked = true }
  }
  const projectRow = {
    disabled: false,
    textContent: 'subagents',
    tagName: 'DIV',
    getAttribute(name) {
      if (name === 'role') return 'button'
      if (name === 'class') return 'project-unfurl-row'
      return null
    },
    getClientRects() { return [{ width: 100, height: 20 }] },
    click() { rowClicked = true }
  }
  const document = {
    querySelector() { return null },
    querySelectorAll(selector) {
      if (selector === 'a[href]') {
        linkQueries += 1
        if (linkQueries >= 3) anchorVisible = true
        return anchorVisible ? [projectAnchor] : []
      }
      if (selector === 'button') return []
      if (selector === 'button,[role="button"]') return [projectRow]
      if (selector === '[contenteditable="true"]') return []
      if (selector === '[data-message-author-role="assistant"]') return []
      return []
    },
    execCommand() { return true }
  }
  const context = {
    document,
    location: { href: 'https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946-subagents/c/thread-existing' },
    chrome: {
      runtime: {
        async sendMessage() { return null },
        onMessage: { addListener(listener) { runtimeListener = listener } }
      }
    },
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    InputEvent: class {},
    Date, Promise, Object, URL, console,
    setTimeout(callback) { queueMicrotask(callback); return 1 },
    clearTimeout() {}
  }

  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'extension/content-script.js' })

  linkQueries = 0
  anchorVisible = false
  const response = await new Promise((resolve) => {
    const keepOpen = runtimeListener({ type: 'project_open', projectUrl }, {}, resolve)
    assert.equal(keepOpen, true)
  })

  assert.equal(response.accepted, true)
  assert.equal(response.control?.kind, 'project-link')
  assert.equal(anchorClicked, true)
  assert.equal(rowClicked, false)
})

test('project_create opens the New project dialog, submits a name, and acknowledges the UI action', async () => {
  let runtimeListener = null
  let dialogOpen = false
  let created = false
  let unrelatedCreated = false

  class FakeInput {
    constructor(label = '') {
      this.value = ''
      this.label = label
    }
    focus() {}
    dispatchEvent() {}
    getAttribute(name) {
      if (name === 'aria-label') return this.label || null
      return null
    }
  }

  const projectNameInput = new FakeInput('Project name')
  const unrelatedInput = new FakeInput('Folder name')
  const newProjectButton = {
    disabled: false,
    textContent: 'New project',
    getAttribute(name) {
      return name === 'aria-label' ? 'New project' : null
    },
    click() {
      dialogOpen = true
    }
  }
  const createButton = {
    disabled: false,
    textContent: 'Create',
    getAttribute(name) {
      return name === 'aria-label' ? 'Create' : null
    },
    click() {
      created = true
    }
  }
  const unrelatedCreateButton = {
    disabled: false,
    textContent: 'Create',
    getAttribute(name) {
      return name === 'aria-label' ? 'Create' : null
    },
    click() {
      unrelatedCreated = true
    }
  }
  const unrelatedDialog = {
    textContent: 'Create folder',
    getAttribute() {
      return null
    },
    querySelectorAll(selector) {
      if (selector === 'input') return [unrelatedInput]
      if (selector === 'button') return [unrelatedCreateButton]
      return []
    }
  }
  const dialog = {
    textContent: 'New project',
    getAttribute(name) {
      return name === 'aria-label' ? 'New project' : null
    },
    querySelectorAll(selector) {
      if (selector === 'input') return [projectNameInput]
      if (selector === 'button') return [createButton]
      return []
    }
  }

  const document = {
    querySelector(selector) {
      if (selector === '[role="dialog"]') return dialogOpen ? unrelatedDialog : null
      if (selector === '[data-testid="stop-button"]') return null
      return null
    },
    querySelectorAll(selector) {
      if (selector === '[role="dialog"]') return dialogOpen ? [unrelatedDialog, dialog] : []
      if (selector === 'button') return [newProjectButton]
      if (selector === '[contenteditable="true"]') return []
      if (selector === '[data-message-author-role="assistant"]') return []
      return []
    },
    execCommand() {
      return true
    }
  }

  const context = {
    document,
    location: { href: 'https://chatgpt.com/' },
    chrome: {
      runtime: {
        async sendMessage() {
          return null
        },
        onMessage: {
          addListener(listener) {
            runtimeListener = listener
          }
        }
      }
    },
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: class {},
    InputEvent: class {},
    Date,
    Promise,
    Object,
    console,
    setTimeout(callback) {
      queueMicrotask(callback)
      return 1
    },
    clearTimeout() {}
  }

  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'extension/content-script.js' })
  assert.equal(typeof runtimeListener, 'function')

  const response = await new Promise((resolve) => {
    const keepOpen = runtimeListener(
      { type: 'project_create', name: 'subagents' },
      {},
      resolve
    )
    assert.equal(keepOpen, true)
  })

  assert.equal(response.accepted, true)
  assert.equal(projectNameInput.value, 'subagents')
  assert.equal(unrelatedInput.value, '')
  assert.equal(unrelatedCreated, false)
  assert.equal(created, true)
})

test('project_create fails closed when only an unrelated generic dialog is present', async () => {
  let runtimeListener = null
  let dialogOpen = false
  let unrelatedCreated = false

  class FakeInput {
    constructor() {
      this.value = ''
    }
    focus() {}
    dispatchEvent() {}
    getAttribute(name) {
      return name === 'aria-label' ? 'Folder name' : null
    }
  }

  const unrelatedInput = new FakeInput()
  const newProjectButton = {
    disabled: false,
    textContent: 'New project',
    getAttribute(name) {
      return name === 'aria-label' ? 'New project' : null
    },
    click() {
      dialogOpen = true
    }
  }
  const unrelatedCreateButton = {
    disabled: false,
    textContent: 'Create',
    getAttribute(name) {
      return name === 'aria-label' ? 'Create' : null
    },
    click() {
      unrelatedCreated = true
    }
  }
  const unrelatedDialog = {
    textContent: 'Create folder',
    getAttribute() {
      return null
    },
    querySelectorAll(selector) {
      if (selector === 'input') return [unrelatedInput]
      if (selector === 'button') return [unrelatedCreateButton]
      return []
    }
  }

  const document = {
    querySelector(selector) {
      if (selector === '[data-testid="stop-button"]') return null
      return null
    },
    querySelectorAll(selector) {
      if (selector === '[role="dialog"]') return dialogOpen ? [unrelatedDialog] : []
      if (selector === 'button') return [newProjectButton]
      if (selector === '[contenteditable="true"]') return []
      if (selector === '[data-message-author-role="assistant"]') return []
      return []
    },
    execCommand() {
      return true
    }
  }

  const context = {
    document,
    location: { href: 'https://chatgpt.com/' },
    chrome: {
      runtime: {
        async sendMessage() {
          return null
        },
        onMessage: {
          addListener(listener) {
            runtimeListener = listener
          }
        }
      }
    },
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: class {},
    InputEvent: class {},
    Date,
    Promise,
    Object,
    console,
    setTimeout(callback) {
      queueMicrotask(callback)
      return 1
    },
    clearTimeout() {}
  }

  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'extension/content-script.js' })

  const response = await new Promise((resolve) => {
    const keepOpen = runtimeListener(
      { type: 'project_create', name: 'subagents' },
      {},
      resolve
    )
    assert.equal(keepOpen, true)
  })

  assert.equal(response.accepted, false)
  assert.match(response.error, /Project dialog was not found/)
  assert.equal(unrelatedInput.value, '')
  assert.equal(unrelatedCreated, false)
})

test('resume retries pending lookup when a new document loads before pending persistence', async () => {
  let pendingLookups = 0
  let now = 0
  const emitted = []
  const document = {
    querySelector() {
      return null
    },
    querySelectorAll(selector) {
      if (selector === 'button') return []
      if (selector === '[data-message-author-role="assistant"]') return []
      if (selector === '[contenteditable="true"]') return []
      return []
    }
  }
  const context = {
    document,
    location: { href: 'https://chatgpt.com/g/g-p-test-agent/c/thread-resume-race' },
    chrome: {
      runtime: {
        async sendMessage(message) {
          if (message?.kind === 'pending_turn_lookup') {
            pendingLookups += 1
            if (pendingLookups < 3) throw new Error('service worker not ready')
            return {
              conversationId: 'conv_resume',
              turnId: 'turn_resume',
              baselineAssistantCount: 0,
              startedAt: -1_200_000
            }
          }
          if (message?.kind === 'conversation_event') {
            emitted.push(message.event)
            return { durable: true, eventId: 'terminal:test-resume-expired' }
          }
          return null
        },
        onMessage: { addListener() {} }
      }
    },
    Date: class extends Date {
      static now() {
        return now
      }
    },
    Promise,
    Object,
    console,
    setTimeout(callback, ms) {
      now += ms
      queueMicrotask(callback)
      return 1
    },
    clearTimeout() {}
  }

  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'extension/content-script.js' })
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve))

  assert.equal(pendingLookups, 3)
})

test('recovery anchors the current assistant to the last matching user prompt instead of baseline assistant count', async () => {
  const emitted = []
  let now = 0
  let poll = 0

  const turnRoot = {
    querySelector(selector) {
      return selector.includes('copy-turn-action-button') ? { disabled: false } : null
    }
  }
  const assistantNode = {
    innerText: '恢复后的最终回答',
    textContent: '恢复后的最终回答',
    closest() {
      return turnRoot
    }
  }
  const userNode = {
    innerText: '重复使用当前 prompt',
    textContent: '重复使用当前 prompt',
    getAttribute(name) {
      return name === 'data-message-id' ? 'user-reloaded' : null
    },
    compareDocumentPosition(other) {
      return other === assistantNode ? 4 : 0
    }
  }
  const document = {
    querySelector() {
      return null
    },
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') return [assistantNode]
      if (selector === '[data-message-author-role="user"]') return [userNode]
      if (selector === 'button') return []
      if (selector === '[contenteditable="true"]') return []
      return []
    }
  }
  const context = {
    document,
    location: { href: 'https://chatgpt.com/g/g-p-test-agent/c/thread-baseline-reload' },
    chrome: {
      runtime: {
        async sendMessage(message) {
          if (message?.kind === 'pending_turn_lookup') return null
          if (message?.kind === 'conversation_event') {
            emitted.push(message.event)
            return { durable: true, eventId: 'terminal:test' }
          }
          return null
        },
        onMessage: { addListener() {} }
      }
    },
    Date: class extends Date {
      static now() {
        return now
      }
    },
    Promise,
    Object,
    console,
    setTimeout(callback, ms) {
      now += ms
      poll += 1
      queueMicrotask(callback)
      return 1
    },
    clearTimeout() {}
  }

  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'extension/content-script.js' })

  await context.__sidecarContentRuntime.monitorTurn({
    conversationId: 'conv_project',
    turnId: 'turn_reloaded',
    baselineAssistantCount: 3,
    promptText: '重复使用当前 prompt',
    recovery: true
  })

  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].type, 'response_completed')
  assert.equal(emitted[0].text, '恢复后的最终回答')
})

test('recovery anchors a collapsed long user prompt by message content instead of shell controls', async () => {
  const emitted = []
  let now = 0
  const promptText = 'A long bounded prompt whose exact content must identify this turn.'

  const turnRoot = {
    querySelector(selector) {
      return selector.includes('copy-turn-action-button') ? { disabled: false } : null
    }
  }
  const assistantNode = {
    innerText: '完整恢复回答',
    textContent: '完整恢复回答',
    closest() {
      return turnRoot
    }
  }
  const contentNode = {
    innerText: promptText,
    textContent: promptText
  }
  const userNode = {
    innerText: `${promptText}\n展开`,
    textContent: `${promptText}\n展开`,
    querySelector(selector) {
      return selector === '[data-testid="collapsible-user-message-content"]' ? contentNode : null
    },
    getAttribute(name) {
      return name === 'data-message-id' ? 'user-collapsed' : null
    },
    compareDocumentPosition(other) {
      return other === assistantNode ? 4 : 0
    }
  }
  const document = {
    querySelector() {
      return null
    },
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') return [assistantNode]
      if (selector === '[data-message-author-role="user"]') return [userNode]
      if (selector === 'button') return []
      if (selector === '[contenteditable="true"]') return []
      if (selector === '[role="alert"]') return []
      return []
    }
  }
  const context = {
    document,
    location: { href: 'https://chatgpt.com/g/g-p-test-agent/c/thread-collapsed-user' },
    chrome: {
      runtime: {
        async sendMessage(message) {
          if (message?.kind === 'conversation_event') {
            emitted.push(message.event)
            return { durable: true, eventId: 'terminal:test-collapsed-user' }
          }
          return null
        },
        onMessage: { addListener() {} }
      }
    },
    Date: class extends Date {
      static now() {
        return now
      }
    },
    Promise,
    Object,
    console,
    setTimeout(callback, ms) {
      now += ms
      queueMicrotask(callback)
      return 1
    },
    clearTimeout() {}
  }

  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'extension/content-script.js' })

  await context.__sidecarContentRuntime.monitorTurn({
    conversationId: 'conv_project',
    turnId: 'turn_collapsed_user',
    baselineAssistantCount: 99,
    promptText,
    recovery: true
  })

  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].type, 'response_completed')
  assert.equal(emitted[0].text, '完整恢复回答')
})

test('recovery waits for an assistant node before comparing DOM position', async () => {
  const emitted = []
  let now = 0
  let poll = 0

  const turnRoot = {
    querySelector(selector) {
      return selector.includes('copy-turn-action-button') ? { disabled: false } : null
    }
  }
  const assistantNode = {
    innerText: '稍后出现的回答',
    textContent: '稍后出现的回答',
    closest() {
      return turnRoot
    }
  }
  const userNode = {
    innerText: '等待 assistant',
    textContent: '等待 assistant',
    getAttribute(name) {
      return name === 'data-message-id' ? 'user-delayed' : null
    },
    compareDocumentPosition(other) {
      if (other !== assistantNode) {
        throw new TypeError("Failed to execute 'compareDocumentPosition' on 'Node': parameter 1 is not of type 'Node'.")
      }
      return 4
    }
  }
  const document = {
    querySelector() {
      return null
    },
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') return poll < 2 ? [] : [assistantNode]
      if (selector === '[data-message-author-role="user"]') return [userNode]
      if (selector === 'button') return []
      if (selector === '[contenteditable="true"]') return []
      return []
    }
  }
  const context = {
    document,
    location: { href: 'https://chatgpt.com/g/g-p-test-agent/c/thread-delayed-assistant' },
    chrome: {
      runtime: {
        async sendMessage(message) {
          if (message?.kind === 'pending_turn_lookup') return null
          if (message?.kind === 'conversation_event') {
            emitted.push(message.event)
            return { durable: true, eventId: 'terminal:test-delayed-assistant' }
          }
          return null
        },
        onMessage: { addListener() {} }
      }
    },
    Date: class extends Date {
      static now() {
        return now
      }
    },
    Promise,
    Object,
    console,
    setTimeout(callback, ms) {
      now += ms
      poll += 1
      queueMicrotask(callback)
      return 1
    },
    clearTimeout() {}
  }

  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'extension/content-script.js' })

  await context.__sidecarContentRuntime.monitorTurn({
    conversationId: 'conv_project',
    turnId: 'turn_delayed_assistant',
    baselineAssistantCount: 0,
    promptText: '等待 assistant',
    recovery: true
  })

  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].type, 'response_completed')
  assert.equal(emitted[0].text, '稍后出现的回答')
})

test('recovered monitor uses the original startedAt deadline instead of granting a fresh 20 minutes without liveness', async () => {
  const emitted = []
  let now = 600_000
  const document = {
    querySelector() {
      return null
    },
    querySelectorAll(selector) {
      if (selector === 'button') return []
      if (selector === '[data-message-author-role="assistant"]') return []
      if (selector === '[data-message-author-role="user"]') return []
      if (selector === '[contenteditable="true"]') return []
      return []
    }
  }
  const context = {
    document,
    location: { href: 'https://chatgpt.com/g/g-p-test-agent/c/thread-deadline' },
    chrome: {
      runtime: {
        async sendMessage(message) {
          if (message?.kind === 'pending_turn_lookup') return null
          if (message?.kind === 'conversation_event') {
            emitted.push(message.event)
            return { durable: true, eventId: 'terminal:test' }
          }
          return null
        },
        onMessage: { addListener() {} }
      }
    },
    Date: class extends Date {
      static now() {
        return now
      }
    },
    Promise,
    Object,
    console,
    setTimeout(callback, ms) {
      now += ms
      queueMicrotask(callback)
      return 1
    },
    clearTimeout() {}
  }

  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'extension/content-script.js' })

  await context.__sidecarContentRuntime.monitorTurn({
    conversationId: 'conv_project',
    turnId: 'turn_deadline',
    baselineAssistantCount: 0,
    startedAt: 100_000,
    recovery: true
  })

  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].type, 'error')
  assert.ok(now <= 1_300_500, `recovery extended the original monitor deadline to ${now}ms`)
})

test('normal completion requires observing generation before idle convergence', async () => {
  const emitted = []
  let now = 0
  let poll = 0

  const assistantNode = {
    innerText: '完整回答',
    textContent: '完整回答'
  }

  const document = {
    querySelector() {
      return null
    },
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') return poll === 0 ? [] : [assistantNode]
      if (selector === 'button') return []
      if (selector === '[contenteditable="true"]') return []
      return []
    }
  }

  const context = {
    document,
    location: { href: 'https://chatgpt.com/g/g-p-test-agent/c/thread-1' },
    chrome: {
      runtime: {
        async sendMessage(message) {
          if (message?.kind === 'conversation_event') {
            emitted.push(message.event)
            return { durable: true, eventId: 'terminal:test' }
          }
          return null
        },
        onMessage: { addListener() {} }
      }
    },
    Date: class extends Date {
      static now() {
        return now
      }
    },
    Promise,
    Object,
    console,
    setTimeout(callback, ms) {
      now += ms
      poll += 1
      queueMicrotask(callback)
      return 1
    },
    clearTimeout() {}
  }

  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'extension/content-script.js' })

  await context.__sidecarContentRuntime.monitorTurn({
    conversationId: 'conv_project',
    turnId: 'turn_project',
    baselineAssistantCount: 0
  })

  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].type, 'error')
  assert.match(emitted[0].message, /Timed out/)
})

test('normal completion waits for explicit final-turn evidence instead of a stable streamed prefix', async () => {
  const emitted = []
  let now = 0
  let poll = 0

  const stopButton = {
    getAttribute(name) {
      return name === 'aria-label' ? 'Stop responding' : null
    },
    textContent: ''
  }
  const turnRoot = {
    querySelector(selector) {
      return poll >= 30 && selector.includes('copy-turn-action-button') ? { disabled: false } : null
    }
  }
  const assistantNode = {
    get innerText() {
      return poll >= 30 ? 'FULL RESPONSE' : 'PARTIAL'
    },
    get textContent() {
      return this.innerText
    },
    closest() {
      return turnRoot
    }
  }
  const document = {
    querySelector() {
      return null
    },
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') return [assistantNode]
      if (selector === 'button') return poll <= 2 ? [stopButton] : []
      if (selector === '[contenteditable="true"]') return []
      return []
    }
  }
  const context = {
    document,
    location: { href: 'https://chatgpt.com/g/g-p-test-agent/c/thread-late-finality' },
    chrome: {
      runtime: {
        async sendMessage(message) {
          if (message?.kind === 'conversation_event') {
            emitted.push(message.event)
            return { durable: true, eventId: 'terminal:late-finality' }
          }
          return null
        },
        onMessage: { addListener() {} }
      }
    },
    Date: class extends Date {
      static now() {
        return now
      }
    },
    Promise,
    Object,
    console,
    setTimeout(callback, ms) {
      now += ms
      poll += 1
      queueMicrotask(callback)
      return 1
    },
    clearTimeout() {}
  }

  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'extension/content-script.js' })

  await context.__sidecarContentRuntime.monitorTurn({
    conversationId: 'conv_project',
    turnId: 'turn_late_finality',
    baselineAssistantCount: 0
  })

  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].type, 'response_completed')
  assert.equal(emitted[0].text, 'FULL RESPONSE')
})

test('recovery may complete without seeing generation when the exact prompt turn has final-turn evidence and converges for 10 seconds', async () => {
  const emitted = []
  let now = 0
  let poll = 0
  const promptText = '恢复当前任务'

  const turnRoot = {
    getAttribute(name) {
      return name === 'data-testid' ? 'conversation-turn-recovery' : null
    },
    querySelector(selector) {
      return selector.includes('copy-turn-action-button') ? { disabled: false } : null
    }
  }
  const assistantNode = {
    innerText: '恢复后的完整回答',
    textContent: '恢复后的完整回答',
    closest() {
      return turnRoot
    }
  }
  const userNode = {
    innerText: promptText,
    textContent: promptText,
    getAttribute(name) {
      return name === 'data-message-id' ? 'user-recovery' : null
    },
    compareDocumentPosition(other) {
      return other === assistantNode ? 4 : 0
    }
  }

  const document = {
    querySelector() {
      return null
    },
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') return [assistantNode]
      if (selector === '[data-message-author-role="user"]') return [userNode]
      if (selector === 'button') return []
      if (selector === '[contenteditable="true"]') return []
      return []
    }
  }

  const context = {
    document,
    location: { href: 'https://chatgpt.com/g/g-p-test-agent/c/thread-recovery' },
    chrome: {
      runtime: {
        async sendMessage(message) {
          if (message?.kind === 'conversation_event') {
            emitted.push(message.event)
            return { durable: true, eventId: 'terminal:test' }
          }
          return null
        },
        onMessage: { addListener() {} }
      }
    },
    Date: class extends Date {
      static now() {
        return now
      }
    },
    Promise,
    Object,
    console,
    setTimeout(callback, ms) {
      now += ms
      poll += 1
      queueMicrotask(callback)
      return 1
    },
    clearTimeout() {}
  }

  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'extension/content-script.js' })

  await context.__sidecarContentRuntime.monitorTurn({
    conversationId: 'conv_project',
    turnId: 'turn_recovery',
    baselineAssistantCount: 0,
    promptText,
    recovery: true
  })

  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].type, 'response_completed')
  assert.equal(emitted[0].text, '恢复后的完整回答')
  assert.ok(now >= 10500, `recovery completed before the 10-second convergence window at ${now}ms`)
})

test('completion retries until the service worker acknowledges durable terminal storage', async () => {
  let now = 0
  let poll = 0
  let terminalAttempts = 0

  const turnRoot = {
    querySelector(selector) {
      return selector.includes('copy-turn-action-button') ? { disabled: false } : null
    }
  }
  const assistantNode = {
    innerText: '完整回答',
    textContent: '完整回答',
    closest() {
      return turnRoot
    }
  }
  const stopButton = {
    getAttribute(name) {
      return name === 'aria-label' ? 'Stop responding' : null
    },
    textContent: ''
  }
  const document = {
    querySelector() {
      return null
    },
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') return [assistantNode]
      if (selector === 'button') return poll <= 2 ? [stopButton] : []
      if (selector === '[contenteditable="true"]') return []
      return []
    }
  }
  const context = {
    document,
    location: { href: 'https://chatgpt.com/g/g-p-test-agent/c/thread-durable-ack' },
    chrome: {
      runtime: {
        async sendMessage(message) {
          if (message?.kind === 'pending_turn_lookup') return null
          if (message?.kind === 'conversation_event' && message.event?.type === 'response_completed') {
            terminalAttempts += 1
            if (terminalAttempts === 1) return null
            return { durable: true, eventId: 'terminal:conv_project:turn_ack:response_completed' }
          }
          return null
        },
        onMessage: { addListener() {} }
      }
    },
    Date: class extends Date {
      static now() {
        return now
      }
    },
    Promise,
    Object,
    console,
    setTimeout(callback, ms) {
      now += ms
      poll += 1
      queueMicrotask(callback)
      return 1
    },
    clearTimeout() {}
  }

  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'extension/content-script.js' })

  await context.__sidecarContentRuntime.monitorTurn({
    conversationId: 'conv_project',
    turnId: 'turn_ack',
    baselineAssistantCount: 0
  })

  assert.equal(terminalAttempts, 2)
})

test('completion starts a fresh 10-second snapshot window after Chinese Stop answering disappears', async () => {
  const emitted = []
  let now = 0
  let poll = 0

  const turnRoot = {
    querySelector(selector) {
      return selector.includes('copy-turn-action-button') ? { disabled: false } : null
    }
  }
  const assistantNode = {
    innerText: '完整回答',
    textContent: '完整回答',
    closest() {
      return turnRoot
    }
  }
  const stopButton = {
    getAttribute(name) {
      return name === 'aria-label' ? '停止回答' : null
    },
    textContent: ''
  }

  const document = {
    querySelector(selector) {
      if (selector === '[data-testid="stop-button"]') return null
      return null
    },
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') return [assistantNode]
      if (selector === 'button') return poll < 30 ? [stopButton] : []
      if (selector === '[contenteditable="true"]') return []
      return []
    }
  }

  const context = {
    document,
    location: { href: 'https://chatgpt.com/g/g-p-test-agent/c/thread-2' },
    chrome: {
      runtime: {
        async sendMessage(message) {
          if (message?.kind === 'conversation_event') {
            emitted.push(message.event)
            return { durable: true, eventId: 'terminal:test' }
          }
          return null
        },
        onMessage: { addListener() {} }
      }
    },
    Date: class extends Date {
      static now() {
        return now
      }
    },
    Promise,
    Object,
    console,
    setTimeout(callback, ms) {
      now += ms
      poll += 1
      queueMicrotask(callback)
      return 1
    },
    clearTimeout() {}
  }

  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'extension/content-script.js' })

  await context.__sidecarContentRuntime.monitorTurn({
    conversationId: 'conv_project',
    turnId: 'turn_stop',
    baselineAssistantCount: 0
  })

  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].type, 'response_completed')
  assert.equal(emitted[0].text, '完整回答')
  assert.ok(now >= 25000, `completion ignored the live Chinese generation control at ${now}ms`)
})

test('completion resets convergence when an expected assistant snapshot is temporarily missing', async () => {
  const emitted = []
  let now = 0
  let poll = 0

  const turnRoot = {
    querySelector(selector) {
      return selector.includes('copy-turn-action-button') ? { disabled: false } : null
    }
  }
  const assistantNode = {
    innerText: '完整回答',
    textContent: '完整回答',
    closest() {
      return turnRoot
    }
  }
  const stopButton = {
    getAttribute(name) {
      return name === 'aria-label' ? 'Stop responding' : null
    },
    textContent: ''
  }

  const document = {
    querySelector(selector) {
      if (selector === '[data-testid="stop-button"]') return null
      return null
    },
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') {
        if (poll === 23) return []
        return [assistantNode]
      }
      if (selector === 'button') return poll <= 2 ? [stopButton] : []
      if (selector === '[contenteditable="true"]') return []
      return []
    }
  }

  const context = {
    document,
    location: { href: 'https://chatgpt.com/g/g-p-test-agent/c/thread-missing' },
    chrome: {
      runtime: {
        async sendMessage(message) {
          if (message?.kind === 'conversation_event') {
            emitted.push(message.event)
            return { durable: true, eventId: 'terminal:test' }
          }
          return null
        },
        onMessage: { addListener() {} }
      }
    },
    Date: class extends Date {
      static now() {
        return now
      }
    },
    Promise,
    Object,
    console,
    setTimeout(callback, ms) {
      now += ms
      poll += 1
      queueMicrotask(callback)
      return 1
    },
    clearTimeout() {}
  }

  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'extension/content-script.js' })

  await context.__sidecarContentRuntime.monitorTurn({
    conversationId: 'conv_project',
    turnId: 'turn_missing',
    baselineAssistantCount: 0
  })

  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].type, 'response_completed')
  assert.equal(emitted[0].text, '完整回答')
  assert.ok(now >= 26000, `missing assistant observation was incorrectly counted as stable time at ${now}ms`)
})

test('active generation refreshes the inactivity watchdog beyond the nominal 20-minute runtime', async () => {
  const emitted = []
  let now = 0
  const stopUntil = 1_210_000

  const turnRoot = {
    querySelector(selector) {
      return selector.includes('copy-turn-action-button') ? { disabled: false } : null
    }
  }
  const assistantNode = {
    innerText: '长任务最终回答',
    textContent: '长任务最终回答',
    closest() {
      return turnRoot
    }
  }
  const stopButton = {
    getAttribute(name) {
      return name === 'aria-label' ? 'Stop responding' : null
    },
    textContent: ''
  }
  const document = {
    querySelector(selector) {
      if (selector === '[data-testid="stop-button"]') return now < stopUntil ? stopButton : null
      return null
    },
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') return [assistantNode]
      if (selector === 'button') return []
      if (selector === '[data-message-author-role="user"]') return []
      if (selector === '[contenteditable="true"]') return []
      return []
    }
  }
  const context = {
    document,
    location: { href: 'https://chatgpt.com/g/g-p-test-agent/c/thread-long-running' },
    chrome: {
      runtime: {
        async sendMessage(message) {
          if (message?.kind === 'pending_turn_lookup') return null
          if (message?.kind === 'conversation_event') {
            emitted.push(message.event)
            return { durable: true, eventId: 'terminal:test-long-running' }
          }
          return null
        },
        onMessage: { addListener() {} }
      }
    },
    Date: class extends Date {
      static now() {
        return now
      }
    },
    Promise,
    Object,
    console,
    setTimeout(callback, ms) {
      now += ms
      queueMicrotask(callback)
      return 1
    },
    clearTimeout() {}
  }

  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'extension/content-script.js' })

  await context.__sidecarContentRuntime.monitorTurn({
    conversationId: 'conv_long',
    turnId: 'turn_long',
    baselineAssistantCount: 0,
    startedAt: 0
  })

  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].type, 'response_completed')
  assert.equal(emitted[0].text, '长任务最终回答')
  assert.ok(now >= 1_220_000, `active generation was terminated by total runtime at ${now}ms`)
})

test('composer observation distinguishes generating, draft-ready, idle, interrupted, and error states', () => {
  let state = 'idle'
  const editor = {
    get value() { return state === 'draft' ? 'unsent draft' : '' },
    getAttribute() { return null }
  }
  const buttonForState = () => {
    const labels = {
      generating: 'Stop responding',
      interrupted: 'Continue generating',
      error: 'Try again'
    }
    const label = labels[state]
    return label ? [{ getAttribute: (name) => name === 'aria-label' ? label : null, textContent: '' }] : []
  }
  const document = {
    querySelector(selector) {
      if (selector === '#prompt-textarea') return editor
      if (selector === '[data-testid="stop-button"]') return null
      if (selector === '[role="alert"]') return null
      return null
    },
    querySelectorAll(selector) {
      if (selector === 'button') return buttonForState()
      if (selector === '[contenteditable="true"]') return []
      if (selector === '[role="alert"]') return []
      return []
    }
  }
  const context = {
    document,
    location: { href: 'https://chatgpt.com/c/composer-state' },
    chrome: { runtime: { onMessage: { addListener() {} } } },
    Promise,
    Object,
    console,
    setTimeout,
    clearTimeout
  }

  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'extension/content-script.js' })

  assert.equal(context.__sidecarContentRuntime.getComposerMode(), 'IDLE_EMPTY')
  state = 'draft'
  assert.equal(context.__sidecarContentRuntime.getComposerMode(), 'DRAFT_READY')
  state = 'generating'
  assert.equal(context.__sidecarContentRuntime.getComposerMode(), 'GENERATING')
  state = 'interrupted'
  assert.equal(context.__sidecarContentRuntime.getComposerMode(), 'INTERRUPTED')
  state = 'error'
  assert.equal(context.__sidecarContentRuntime.getComposerMode(), 'ERROR')
})

test('monitor recovers a missed generating phase from the anchored current assistant body plus final-turn evidence', async () => {
  const emitted = []
  let now = 0
  const promptText = 'continue exact task'
  const editor = { value: '', getAttribute() { return null } }
  const bodyRoot = {
    innerText: '完整正文',
    textContent: '完整正文',
    querySelector(selector) {
      return selector.includes('p') ? { textContent: '完整正文' } : null
    },
    matches() { return false }
  }
  const turnRoot = {
    getAttribute(name) { return name === 'data-testid' ? 'conversation-turn-8' : null },
    querySelector(selector) {
      return selector.includes('copy-turn-action-button') ? { disabled: false } : null
    }
  }
  const assistantNode = {
    innerText: 'Assistant heading\n完整正文',
    textContent: 'Assistant heading\n完整正文',
    querySelector(selector) {
      return /markdown|prose|message-content/.test(selector) ? bodyRoot : null
    },
    closest() { return turnRoot },
    getAttribute(name) { return name === 'data-message-id' ? 'assistant-8' : null }
  }
  const userTurnRoot = {
    getAttribute(name) { return name === 'data-testid' ? 'conversation-turn-7' : null }
  }
  const userNode = {
    innerText: promptText,
    textContent: promptText,
    closest() { return userTurnRoot },
    getAttribute(name) { return name === 'data-message-id' ? 'user-7' : null },
    compareDocumentPosition(other) { return other === assistantNode ? 4 : 0 }
  }
  const document = {
    querySelector(selector) {
      if (selector === '#prompt-textarea') return editor
      if (selector === '[data-testid="stop-button"]') return null
      if (selector === '[role="alert"]') return null
      return null
    },
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') return [assistantNode]
      if (selector === '[data-message-author-role="user"]') return [userNode]
      if (selector === 'button' || selector === '[contenteditable="true"]' || selector === '[role="alert"]') return []
      return []
    }
  }
  const context = {
    document,
    location: { href: 'https://chatgpt.com/g/g-p-test-agent/c/thread-missed-generation' },
    chrome: {
      runtime: {
        async sendMessage(message) {
          if (message?.kind === 'conversation_event') {
            emitted.push(message.event)
            return { durable: true, eventId: 'terminal:test-missed-generation' }
          }
          return null
        },
        onMessage: { addListener() {} }
      }
    },
    Date: class extends Date { static now() { return now } },
    Promise,
    Object,
    console,
    setTimeout(callback, ms) {
      now += ms
      queueMicrotask(callback)
      return 1
    },
    clearTimeout() {}
  }

  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'extension/content-script.js' })

  await context.__sidecarContentRuntime.monitorTurn({
    conversationId: 'conv_project',
    turnId: 'turn_missed_generation',
    baselineAssistantCount: 99,
    promptText
  })

  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].type, 'response_completed')
  assert.equal(emitted[0].text, '完整正文')
  assert.ok(now >= 10_000, `completion skipped the convergence window at ${now}ms`)
})

test('generation exit with only assistant shell title emits need_continue instead of response_completed', async () => {
  const emitted = []
  let now = 0
  let poll = 0
  const promptText = 'finish the task'
  const editor = { value: '', getAttribute() { return null } }
  const stopButton = {
    getAttribute(name) { return name === 'aria-label' ? 'Stop responding' : null },
    textContent: ''
  }
  const turnRoot = {
    getAttribute(name) { return name === 'data-testid' ? 'conversation-turn-10' : null },
    querySelector(selector) {
      return selector.includes('copy-turn-action-button') ? { disabled: false } : null
    }
  }
  const headingNode = { innerText: 'Only a title', textContent: 'Only a title' }
  const bodyRoot = {
    innerText: 'Only a title',
    textContent: 'Only a title',
    querySelector(selector) {
      if (selector.startsWith('h1,')) return headingNode
      return null
    }
  }
  const assistantNode = {
    innerText: 'Only a title',
    textContent: 'Only a title',
    querySelector(selector) {
      return /markdown|prose|message-content/.test(selector) ? bodyRoot : null
    },
    closest() { return turnRoot },
    getAttribute(name) { return name === 'data-message-id' ? 'assistant-10' : null }
  }
  const userNode = {
    innerText: promptText,
    textContent: promptText,
    closest() { return { getAttribute: (name) => name === 'data-testid' ? 'conversation-turn-9' : null } },
    getAttribute(name) { return name === 'data-message-id' ? 'user-9' : null },
    compareDocumentPosition(other) { return other === assistantNode ? 4 : 0 }
  }
  const document = {
    querySelector(selector) {
      if (selector === '#prompt-textarea') return editor
      if (selector === '[data-testid="stop-button"]') return poll <= 2 ? stopButton : null
      if (selector === '[role="alert"]') return null
      return null
    },
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') return [assistantNode]
      if (selector === '[data-message-author-role="user"]') return [userNode]
      if (selector === 'button') return []
      if (selector === '[contenteditable="true"]' || selector === '[role="alert"]') return []
      return []
    }
  }
  const context = {
    document,
    location: { href: 'https://chatgpt.com/g/g-p-test-agent/c/thread-title-only' },
    chrome: {
      runtime: {
        async sendMessage(message) {
          if (message?.kind === 'conversation_event') {
            emitted.push(message.event)
            return { durable: true, eventId: 'terminal:test-title-only' }
          }
          return null
        },
        onMessage: { addListener() {} }
      }
    },
    Date: class extends Date { static now() { return now } },
    Promise,
    Object,
    console,
    setTimeout(callback, ms) {
      now += ms
      poll += 1
      queueMicrotask(callback)
      return 1
    },
    clearTimeout() {}
  }

  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'extension/content-script.js' })

  await context.__sidecarContentRuntime.monitorTurn({
    conversationId: 'conv_project',
    turnId: 'turn_title_only',
    baselineAssistantCount: 0,
    promptText
  })

  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].type, 'need_continue')
  assert.equal(emitted[0].reason, 'assistant_body_incomplete')
})
