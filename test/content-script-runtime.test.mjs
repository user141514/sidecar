import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../extension/content-script.js', import.meta.url), 'utf8')

test('completion waits for assistant text to settle when generation controls are absent', async () => {
  const emitted = []
  let now = 0
  let poll = 0
  const stream = [
    '',
    '当前',
    '当前这个',
    '当前这个 Project',
    '当前这个 Project 的主题',
    '当前这个 Project 的主题是 agent',
    '当前这个 Project 的主题是 agent',
    '当前这个 Project 的主题是 agent',
    '当前这个 Project 的主题是 agent',
    '当前这个 Project 的主题是 agent',
    '当前这个 Project 的主题是 agent',
    '当前这个 Project 的主题是 agent',
    '当前这个 Project 的主题是 agent',
    '当前这个 Project 的主题是 agent',
    '当前这个 Project 的主题是 agent',
    '当前这个 Project 的主题是 agent'
  ]

  const turnRoot = {
    querySelector(selector) {
      if (selector.includes('copy-turn-action-button')) {
        return poll >= 20 ? { disabled: false } : null
      }
      return null
    }
  }

  const assistantNode = {
    get innerText() {
      return stream[Math.min(poll, stream.length - 1)]
    },
    get textContent() {
      return this.innerText
    },
    closest(selector) {
      return selector === '[data-testid^="conversation-turn-"]' ? turnRoot : null
    }
  }

  const document = {
    querySelector(selector) {
      if (selector === '[data-testid="stop-button"]') return null
      return null
    },
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') {
        return poll === 0 ? [] : [assistantNode]
      }
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
          if (message?.kind === 'conversation_event') emitted.push(message.event)
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
  assert.equal(emitted[0].type, 'response_completed')
  assert.equal(emitted[0].text, '当前这个 Project 的主题是 agent')
  assert.ok(now >= 10000, `completion happened before the assistant turn exposed completion actions at ${now}ms`)
})

test('completion does not fire while ChatGPT exposes a Stop responding control', async () => {
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
      if (selector === '[data-message-author-role="assistant"]') return [assistantNode]
      if (selector === 'button') return poll < 20 ? [stopButton] : []
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
          if (message?.kind === 'conversation_event') emitted.push(message.event)
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
  assert.ok(now >= 10000, `completion fired while Stop responding was still present at ${now}ms`)
})
