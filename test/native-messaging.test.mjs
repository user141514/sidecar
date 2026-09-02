import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { PassThrough } from 'node:stream'

async function loadModule() {
  try {
    return await import('../src/native-messaging.mjs')
  } catch {
    return {}
  }
}

test('native messages use a little-endian 32-bit length prefix', async () => {
  const { encodeNativeMessage } = await loadModule()
  assert.equal(typeof encodeNativeMessage, 'function')
  if (typeof encodeNativeMessage !== 'function') return

  const encoded = encodeNativeMessage({ hello: '世界' })
  const length = encoded.readUInt32LE(0)
  assert.equal(length, encoded.length - 4)
  assert.deepEqual(JSON.parse(encoded.subarray(4).toString('utf8')), { hello: '世界' })
})

test('NativeMessageChannel reconstructs a message split across arbitrary chunks', async () => {
  const { NativeMessageChannel, encodeNativeMessage } = await loadModule()
  assert.equal(typeof NativeMessageChannel, 'function')
  assert.equal(typeof encodeNativeMessage, 'function')
  if (typeof NativeMessageChannel !== 'function' || typeof encodeNativeMessage !== 'function') return

  const input = new PassThrough()
  const output = new PassThrough()
  const channel = new NativeMessageChannel({ input, output })
  const received = once(channel, 'message')
  const encoded = encodeNativeMessage({ kind: 'event', value: 42 })
  input.write(encoded.subarray(0, 2))
  input.write(encoded.subarray(2, 7))
  input.write(encoded.subarray(7))

  const [message] = await received
  assert.deepEqual(message, { kind: 'event', value: 42 })
  channel.close()
})

class FakeChannel extends EventEmitter {
  constructor() {
    super()
    this.sent = []
  }

  send(message) {
    this.sent.push(message)
  }
}

test('ExtensionBridge correlates request responses and forwards unsolicited extension events', async () => {
  const { ExtensionBridge } = await loadModule()
  assert.equal(typeof ExtensionBridge, 'function')
  if (typeof ExtensionBridge !== 'function') return

  const channel = new FakeChannel()
  const bridge = new ExtensionBridge({ channel, requestTimeoutMs: 1000 })
  const pending = bridge.request('conversation_create', { conversationId: 'conv_1' })
  assert.equal(channel.sent.length, 1)
  const request = channel.sent[0]
  assert.equal(request.kind, 'request')
  assert.equal(request.method, 'conversation_create')
  assert.equal(request.params.conversationId, 'conv_1')

  channel.emit('message', {
    kind: 'response',
    requestId: request.requestId,
    ok: true,
    result: { windowId: 10, tabId: 20 }
  })
  assert.deepEqual(await pending, { windowId: 10, tabId: 20 })

  const eventPromise = once(bridge, 'event')
  channel.emit('message', {
    kind: 'event',
    event: { type: 'response_completed', conversationId: 'conv_1', text: 'done' }
  })
  const [event] = await eventPromise
  assert.equal(event.type, 'response_completed')
  assert.equal(event.text, 'done')
})
