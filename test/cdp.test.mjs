import test from 'node:test'
import assert from 'node:assert/strict'

async function loadCdpModule() {
  try {
    return await import('../src/cdp.mjs')
  } catch {
    return {}
  }
}

class FakeSocket {
  constructor() {
    this.readyState = 0
    this.sent = []
    this.listeners = new Map()
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  send(value) {
    this.sent.push(value)
  }

  close() {
    this.readyState = 3
    this.emit('close', {})
  }

  open() {
    this.readyState = 1
    this.emit('open', {})
  }

  message(payload) {
    this.emit('message', { data: JSON.stringify(payload) })
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

test('parseDevToolsActivePort returns the exact browser websocket endpoint parts', async () => {
  const { parseDevToolsActivePort } = await loadCdpModule()
  assert.equal(typeof parseDevToolsActivePort, 'function')
  if (typeof parseDevToolsActivePort !== 'function') return

  assert.deepEqual(parseDevToolsActivePort('9222\n/devtools/browser/abc-123\n'), {
    port: 9222,
    websocketPath: '/devtools/browser/abc-123'
  })
  assert.throws(() => parseDevToolsActivePort('bad\n/devtools/browser/x\n'))
})

test('CdpClient correlates command responses and preserves target session ids', async () => {
  const { CdpClient } = await loadCdpModule()
  assert.equal(typeof CdpClient, 'function')
  if (typeof CdpClient !== 'function') return

  const socket = new FakeSocket()
  const client = new CdpClient({
    endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
    socketFactory: () => socket
  })

  const connecting = client.connect()
  socket.open()
  await connecting

  const pending = client.command('Runtime.evaluate', { expression: '1+1' }, 'session-7')
  await Promise.resolve()
  assert.equal(socket.sent.length, 1)
  const request = JSON.parse(socket.sent[0])
  assert.equal(request.method, 'Runtime.evaluate')
  assert.equal(request.sessionId, 'session-7')
  assert.deepEqual(request.params, { expression: '1+1' })

  socket.message({ id: request.id, result: { result: { value: 2 } } })
  assert.deepEqual(await pending, { result: { value: 2 } })
})

test('createTarget can request a dedicated Chrome window', async () => {
  const { CdpClient } = await loadCdpModule()
  assert.equal(typeof CdpClient, 'function')
  if (typeof CdpClient !== 'function') return

  const socket = new FakeSocket()
  const client = new CdpClient({ endpoint: 'ws://127.0.0.1:9222/devtools/browser/test', socketFactory: () => socket })
  const connecting = client.connect()
  socket.open()
  await connecting

  const pending = client.createTarget('https://chatgpt.com/', { newWindow: true })
  await Promise.resolve()
  const request = JSON.parse(socket.sent[0])
  assert.deepEqual(request.params, { url: 'https://chatgpt.com/', newWindow: true })
  socket.message({ id: request.id, result: { targetId: 'target-window-1' } })
  assert.equal(await pending, 'target-window-1')
})
