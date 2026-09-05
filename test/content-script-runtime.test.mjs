import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../extension/content-script.js', import.meta.url), 'utf8')

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

  await context.monitorTurn({
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

  await context.monitorTurn({
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

  await context.monitorTurn({
    conversationId: 'conv_project',
    turnId: 'turn_project',
    baselineAssistantCount: 0
  })

  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].type, 'error')
  assert.match(emitted[0].message, /Timed out/)
})

test('recovery may complete without seeing generation when terminal UI evidence converges for 10 seconds', async () => {
  const emitted = []
  let now = 0
  let poll = 0

  const turnRoot = {
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

  const document = {
    querySelector() {
      return null
    },
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') return [assistantNode]
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

  await context.monitorTurn({
    conversationId: 'conv_project',
    turnId: 'turn_recovery',
    baselineAssistantCount: 0,
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

  const assistantNode = {
    innerText: '完整回答',
    textContent: '完整回答'
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

  await context.monitorTurn({
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

  const assistantNode = {
    innerText: '完整回答',
    textContent: '完整回答'
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

  await context.monitorTurn({
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

  const assistantNode = {
    innerText: '完整回答',
    textContent: '完整回答'
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

  await context.monitorTurn({
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

  const assistantNode = {
    innerText: '长任务最终回答',
    textContent: '长任务最终回答'
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

  await context.monitorTurn({
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
