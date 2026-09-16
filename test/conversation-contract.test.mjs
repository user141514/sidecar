import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  CONVERSATION_CONTRACT_VERSION,
  parseObservation,
  parseConversationState,
  parseIntentEnvelope
} from '../src/conversation-contract.mjs'

const fixture = JSON.parse(await readFile(new URL('./fixtures/conversation-runtime-v1.json', import.meta.url), 'utf8'))
const copy = value => structuredClone(value)

function assertDeepFrozen(value) {
  if (!value || typeof value !== 'object') return
  assert.equal(Object.isFrozen(value), true)
  for (const nested of Object.values(value)) assertDeepFrozen(nested)
}

test('v1 fixtures parse strictly and return immutable normalized values', () => {
  assert.equal(CONVERSATION_CONTRACT_VERSION, 1)
  const observation = parseObservation(fixture.observation)
  const state = parseConversationState(fixture.state)
  const existingIntent = parseIntentEnvelope(fixture.existingIntent)
  const newIntent = parseIntentEnvelope(fixture.newIntent)
  assert.deepEqual(observation, fixture.observation)
  assert.deepEqual(state, fixture.state)
  assert.deepEqual(existingIntent, fixture.existingIntent)
  assert.deepEqual(newIntent, fixture.newIntent)
  for (const value of [observation, state, existingIntent, newIntent]) assertDeepFrozen(value)
})

test('unknown contract versions and extra top-level fields fail closed', () => {
  for (const [parser, source] of [
    [parseObservation, fixture.observation],
    [parseConversationState, fixture.state],
    [parseIntentEnvelope, fixture.existingIntent]
  ]) {
    assert.throws(() => parser({ ...copy(source), contractVersion: 2 }), /contractVersion|version/i)
    assert.throws(() => parser({ ...copy(source), unexpected: true }), /field|unexpected|keys/i)
  }
})

test('existing conversation mutation requires state version, writer epoch and exact identity', () => {
  for (const key of ['expectedStateVersion', 'expectedWriterEpoch']) {
    const candidate = copy(fixture.existingIntent)
    candidate[key] = null
    assert.throws(() => parseIntentEnvelope(candidate), /state|epoch|existing/i)
  }
  const missingTarget = copy(fixture.existingIntent)
  missingTarget.target = null
  assert.throws(() => parseIntentEnvelope(missingTarget), /target|existing/i)
  const missingExpected = copy(fixture.existingIntent)
  missingExpected.expected.userMessageId = null
  assert.throws(() => parseIntentEnvelope(missingExpected), /message|identity|expected/i)
})

test('open_child NEW and REUSE have unambiguous allocation semantics', () => {
  const newWithTarget = copy(fixture.newIntent)
  newWithTarget.target = fixture.existingIntent.target
  assert.throws(() => parseIntentEnvelope(newWithTarget), /NEW|target|conversation/i)

  const reuse = copy(fixture.existingIntent)
  reuse.intentId = 'intent-reuse'
  reuse.action = 'open_child'
  reuse.allocation = 'REUSE'
  assert.equal(parseIntentEnvelope(reuse).allocation, 'REUSE')

  const reuseMissingTarget = copy(reuse)
  reuseMissingTarget.target = null
  assert.throws(() => parseIntentEnvelope(reuseMissingTarget), /REUSE|target|conversation/i)

  const continueWithAllocation = copy(fixture.existingIntent)
  continueWithAllocation.allocation = 'REUSE'
  assert.throws(() => parseIntentEnvelope(continueWithAllocation), /allocation|continue/i)
})

test('unknown conversation state remains explicitly unknown', () => {
  const unknown = copy(fixture.state)
  unknown.stateVersion++
  unknown.progress = 'unknown'
  unknown.body = 'unknown'
  unknown.delivery = 'uncertain'
  const parsed = parseConversationState(unknown)
  assert.equal(parsed.progress, 'unknown')
  assert.equal(parsed.body, 'unknown')
  assert.equal(parsed.delivery, 'uncertain')
})
