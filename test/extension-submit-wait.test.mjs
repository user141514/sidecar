import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const worker = (await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
const start = worker.indexOf('async function waitForSubmittedConversationTab(')
const end = worker.indexOf('\nasync function findProject(', start)
assert.ok(start >= 0 && end > start)
const source = worker.slice(start, end)
const project = 'https://chatgpt.com/g/g-p-test-subagents/project'
const thread = 'https://chatgpt.com/g/g-p-test-subagents/c/00000000-0000-4000-8000-000000000007'
function harness(committedAt, initial = project) {
  let clock = 0, reads = 0
  const uuid = value => String(value ?? '').match(/\/c\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i)?.[1] ?? null
  const context = vm.createContext({
    Date: { now: () => clock }, Promise,
    setTimeout(callback, ms) { clock += ms; queueMicrotask(callback) },
    stableConversationUrl: value => uuid(value) ? value : null,
    exactAdoptionUuid: uuid, projectHomeUrl: value => value === project ? project : null,
    deliveryUncertain: message => Object.assign(new Error(message), { code: 'DELIVERY_UNCERTAIN' }),
    chrome: { tabs: {
      async get() { reads++; return { id: 20, windowId: 10, url: clock >= committedAt ? thread : initial } },
      async query() { return [] }
    } }
  })
  vm.runInContext(source, context)
  return { run: () => context.waitForSubmittedConversationTab({ tabId: 20 }, initial, new Set([20]), 'owned'),
    elapsed: () => clock, reads: () => reads }
}

test('first submit waits for the original tab to replace a temporary URL after six seconds', async () => {
  const h = harness(6250, 'https://chatgpt.com/c/local-chatgpt%3Atemporary')
  const result = await h.run()
  assert.equal(result.tabId, 20)
  assert.equal(result.url, thread)
  assert.ok(h.elapsed() >= 6250)
  assert.ok(h.elapsed() <= 30000)
})

test('a permanent temporary URL still stops within thirty seconds with unknown delivery', async () => {
  const h = harness(Infinity, 'https://chatgpt.com/c/local-chatgpt%3Atemporary')
  await assert.rejects(h.run(), error => error.code === 'DELIVERY_UNCERTAIN')
  assert.ok(h.elapsed() <= 30000)
  assert.ok(h.reads() > 0)
})

test('waiting longer cannot replace the identity of an existing persistent thread', async () => {
  const h = harness(0, 'https://chatgpt.com/c/00000000-0000-4000-8000-000000000099')
  await assert.rejects(h.run(), error => error.code === 'DELIVERY_UNCERTAIN' && /changed persistent/.test(error.message))
  assert.equal(h.reads(), 1)
})
