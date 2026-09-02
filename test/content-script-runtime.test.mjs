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

  const assistantNode = {
    get innerText() {
      return stream[Math.min(poll, stream.length - 1)]
    },
    get textContent() {
      return this.innerText
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
  assert.ok(now >= 5000, `completion happened too early at ${now}ms`)
})
