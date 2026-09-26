import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { MessageChannel } from 'node:worker_threads'

const source = await fs.readFile(new URL('../extension/content-script.js', import.meta.url), 'utf8')

// Matches PC2's observed 2026-09-26 composer: the accessible label names
// a model picker, the visible label is Pro, and the measurement label is hidden.
// data-selected-reasoning-effort can be medium even while Pro is selected.
async function runNewUiProbe({ initial = 4, withSlider = true } = {}) {
  let open = false
  let index = initial
  const keys = []
  const labels = ['即时', '中', '高', '极高', 'Pro']
  class FakeEvent {
    constructor(type, init = {}) { this.type = type; Object.assign(this, init) }
  }
  const trigger = {
    disabled: false,
    get innerText() { return labels[index] },
    get textContent() { return '思考强度' + labels[index] },
    getAttribute(name) {
      if (name === 'aria-label') return '选择 ChatGPT 模型'
      if (name === 'aria-haspopup') return 'menu'
      if (name === 'aria-expanded') return String(open)
      if (name === 'data-composer-navigation-target') return 'reasoning'
      if (name === 'data-selected-reasoning-effort') return 'medium'
      return null
    },
    dispatchEvent(event) { if (event.type === 'pointerdown') open = true; return true },
    click() { open = true }
  }
  const slider = {
    disabled: false,
    get textContent() { return labels[index] },
    getAttribute(name) {
      if (name === 'role') return 'slider'
      if (name === 'aria-valuenow') return String(index)
      if (name === 'aria-valuemin') return '0'
      if (name === 'aria-valuemax') return '4'
      if (name === 'aria-valuetext') return labels[index]
      return null
    },
    focus() {},
    dispatchEvent(event) {
      if (event.type === 'keydown') {
        keys.push(event.key)
        // React commits after the input handler, not necessarily in the same microtask.
        setImmediate(() => {
          if (event.key === 'ArrowLeft') index = Math.max(0, index - 1)
          if (event.key === 'ArrowRight') index = Math.min(4, index + 1)
        })
      }
      return true
    }
  }
  const document = {
    title: 'ChatGPT - subagents',
    querySelector() { return null },
    getElementById() { return null },
    querySelectorAll(selector) {
      if (selector === 'button') return [trigger]
      if (selector.includes('role="slider"') || selector.includes('type="range"')) {
        return open && withSlider ? [slider] : []
      }
      if (selector.includes('[role="menuitem"]')) return [trigger]
      return []
    }
  }
  const context = {
    document,
    location: { href: 'https://chatgpt.com/c/strength-only-test', hash: '#webgpt-shift-test=Medium' },
    chrome: { runtime: { sendMessage: async () => null, onMessage: { addListener() {}, removeListener() {} } } },
    HTMLTextAreaElement: class {}, HTMLInputElement: class {}, InputEvent: FakeEvent,
    PointerEvent: FakeEvent, KeyboardEvent: FakeEvent, MessageChannel,
    Date, Promise, Object, URL, console,
    setTimeout, clearTimeout
  }
  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'extension/content-script.js' })
  for (let attempt = 0; attempt < 200 && !document.title.startsWith('WEBGPT_SHIFT_'); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  return { title: document.title, index, keys, open }
}

test('new UI: switch visible Pro to Medium despite model-picker aria-label and stale effort attribute', async () => {
  const result = await runNewUiProbe()
  assert.equal(result.title, 'WEBGPT_SHIFT_OK|Pro|Medium')
  assert.equal(result.index, 1)
  assert.deepEqual(result.keys, ['ArrowLeft', 'ArrowLeft', 'ArrowLeft'])
})

test('new UI: read visible Medium without spuriously stepping to High', async () => {
  const result = await runNewUiProbe({ initial: 1 })
  assert.equal(result.title, 'WEBGPT_SHIFT_OK|Medium|Medium')
  assert.equal(result.index, 1)
  assert.deepEqual(result.keys, [])
})

test('new UI: a stale medium effort attribute must not pass the gate when no slider or option exists', async () => {
  const result = await runNewUiProbe({ withSlider: false })
  assert.match(result.title, /^WEBGPT_SHIFT_ERROR\|/)
  assert.equal(result.index, 4)
  assert.deepEqual(result.keys, [])
})
