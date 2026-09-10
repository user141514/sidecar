import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExtensionBridge } from '../src/native-messaging.mjs'
import { ChatGptConversationHost } from '../src/chatgpt.mjs'
import { ConversationStore } from '../src/store.mjs'

class Channel extends EventEmitter {
  sent = []
  send(message) { this.sent.push(message) }
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'delivery-regression-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new ConversationStore(dir)
  const conversation = await store.create({ backend: 'test', externalUrl: 'https://chatgpt.com/c/thread' })
  const channel = new Channel()
  const bridge = new ExtensionBridge({ channel, requestTimeoutMs: 10 })
  const host = new ChatGptConversationHost({ bridge, store })
  return { dir, store, conversation, channel, bridge, host }
}
async function settle(host, id, status) {
  for (let i = 0; i < 100; i += 1) {
    const state = await host.read(id)
    if (state.status === status) return state
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.fail('expected ' + status)
}

test('timed out send remains uncertain across host restart and rejects overlapping retry', async t => {
  const { dir, conversation, channel, bridge, host } = await fixture(t)
  await assert.rejects(host.send(conversation.id, 'once'), { code: 'DELIVERY_UNCERTAIN' })
  const uncertain = await host.read(conversation.id)
  assert.equal(uncertain.status, 'delivery_uncertain')
  assert.equal(uncertain.events.some(e => e.type === 'prompt_sent'), false)
  assert.equal(uncertain.events.some(e => e.type === 'send_intent'), true)
  const restarted = new ChatGptConversationHost({ bridge, store: new ConversationStore(dir) })
  await assert.rejects(restarted.send(conversation.id, 'retry'), /in flight|uncertain/)
  assert.equal(channel.sent.filter(m => m.method === 'conversation_send').length, 1)
  channel.emit('message', { kind: 'event', eventId: 'terminal-once', event: {
    conversationId: conversation.id, turnId: uncertain.latestTurnId,
    type: 'response_completed', text: 'late success', externalUrl: 'https://chatgpt.com/c/thread'
  } })
  const done = await settle(host, conversation.id, 'completed')
  assert.equal(done.latestResponse, 'late success')
})

test('completion before send acknowledgement cannot be downgraded by late acknowledgement', async t => {
  const { conversation, channel, host, bridge } = await fixture(t)
  bridge.requestTimeoutMs = 1000
  const sent = host.send(conversation.id, 'fast')
  while (!channel.sent.length) await new Promise(resolve => setImmediate(resolve))
  const req = channel.sent[0]
  channel.emit('message', { kind: 'event', event: {
    conversationId: conversation.id, turnId: req.params.turnId,
    type: 'response_completed', text: 'already done', externalUrl: 'https://chatgpt.com/c/thread'
  } })
  await settle(host, conversation.id, 'completed')
  channel.emit('message', { kind: 'response', requestId: req.requestId, ok: true, result: { accepted: true } })
  await sent
  const done = await host.read(conversation.id)
  assert.equal(done.status, 'completed')
  assert.equal(done.latestResponse, 'already done')
})

test('bridge disconnect and explicit uncertain error preserve delivery classification', async () => {
  const channel = new Channel()
  const bridge = new ExtensionBridge({ channel, requestTimeoutMs: 1000 })
  const disconnected = bridge.request('conversation_send', { conversationId: 'conv', turnId: 'turn' })
  channel.emit('close')
  await assert.rejects(disconnected, { code: 'DELIVERY_UNCERTAIN' })
  const explicit = bridge.request('conversation_send')
  channel.emit('message', { kind: 'response', requestId: channel.sent.at(-1).requestId,
    ok: false, error: 'prepare response lost', errorCode: 'DELIVERY_UNCERTAIN' })
  await assert.rejects(explicit, { code: 'DELIVERY_UNCERTAIN' })
})

test('definite failure before submit remains retryable', async t => {
  const { conversation, channel, host, bridge } = await fixture(t)
  bridge.requestTimeoutMs = 1000
  const sent = host.send(conversation.id, 'bad editor')
  while (!channel.sent.length) await new Promise(resolve => setImmediate(resolve))
  channel.emit('message', { kind: 'response', requestId: channel.sent[0].requestId,
    ok: false, error: 'editor unavailable' })
  await assert.rejects(sent, /editor unavailable/)
  assert.equal((await host.read(conversation.id)).status, 'error')
})

test('old-turn events and late failure cannot replace completed response or current URL', async t => {
  const { conversation, store, host } = await fixture(t)
  await store.append(conversation.id, { type: 'send_intent', turnId: 'new', text: 'new' })
  await store.append(conversation.id, { type: 'response_completed', turnId: 'new', text: 'done', externalUrl: 'https://chatgpt.com/c/new' })
  await store.append(conversation.id, { type: 'generation_started', turnId: 'new' })
  await store.append(conversation.id, { type: 'error', turnId: 'new', message: 'late transport error' })
  await store.append(conversation.id, { type: 'response_completed', turnId: 'old', text: 'stale', externalUrl: 'https://chatgpt.com/c/old' })
  const state = await host.read(conversation.id)
  assert.equal(state.status, 'completed')
  assert.equal(state.latestResponse, 'done')
  assert.equal(state.externalUrl, 'https://chatgpt.com/c/new')
})
