import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatGptConversationHost } from '../src/chatgpt.mjs'
import { ConversationStore } from '../src/store.mjs'
import { createSidecarServer } from '../src/server.mjs'
import { runCli } from '../src/cli.mjs'

const reg = '30000000-0000-4000-8000-000000000081'
const instance = '40000000-0000-4000-8000-000000000081'
const operation = '50000000-0000-4000-8000-000000000081'
const target = 'https://chatgpt.com/c/00000000-0000-4000-8000-000000000081'
const sha = 'a'.repeat(64)

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pending-retirement-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ConversationStore(root)
  const record = await store.create({ backend: 'test', externalUrl: target })
  await store.append(record.id, { type: 'send_intent', turnId: 'turn-unknown', requestId: 'unknown-request', source: 'watchdog', registrationId: reg, text: 'private prompt' })
  await store.append(record.id, { type: 'delivery_uncertain', turnId: 'turn-unknown', message: 'unknown' })
  const bridge = new EventEmitter(); bridge.calls = []; bridge.receipt = null; bridge.mutate = x => x
  bridge.request = async (method, params) => {
    bridge.calls.push({ method, params })
    if (method === 'writer_quiesce') return { quiescent: true, registrationId: params.registrationId, currentWriterEpoch: params.writerEpoch, target: params.target }
    if (method === 'pending_retirement_inspect') return { ...params, found: true, retirable: true, pendingDigest: sha, instanceId: instance, buildId: sha, tabId: 81 }
    if (method === 'pending_retire') {
      bridge.receipt ??= { version: 1, state: 'retired', delivery: 'unknown', reason: params.reason,
        conversationId: params.conversationId, turnId: params.turnId, requestId: params.requestId, registrationId: params.registrationId,
        target: params.target, writerEpoch: params.writerEpoch, operationId: params.operationId, pendingDigest: params.expectedPendingDigest,
        instanceId: params.expectedInstanceId, buildId: params.expectedBuildId, tabId: 81, retiredAt: Date.now(),
        proof: { originalTabAbsent: true, targetAbsent: true, writerDrained: true, contentDrained: true, contentEffectCount: 0, outboxCount: 0, revokedRegistration: true, generationSource: 'host_ledger' } }
      return bridge.mutate({ accepted: true, retired: true, delivery: 'unknown', receipt: structuredClone(bridge.receipt) })
    }
    assert.fail('unexpected bridge method ' + method)
  }
  const host = new ChatGptConversationHost({ bridge, store, writerEpoch: 7 })
  await host.watchdogAuthority.bind({ registrationId: reg, target })
  await host.watchdogAuthority.withdraw({ registrationId: reg, target }, async () => ({ quiescent: true }))
  const inspect = { conversationId: record.id, requestId: 'unknown-request' }
  const retire = { ...inspect, operationId: operation, expectedPendingDigest: sha, expectedInstanceId: instance, expectedBuildId: sha, reason: 'closed_target_after_quiesce' }
  return { root, store, host, bridge, record, inspect, retire }
}

test('host retirement preserves unknown outcome and real uncertain mailbox; concurrent retry audits once', async t => {
  const f = await fixture(t)
  await f.host.mailbox.run(target, f.inspect.requestId, { text: 'private prompt' }, async mark => {
    await mark({ action: 'send', conversationId: f.record.id, turnId: 'turn-unknown' })
    throw Object.assign(new Error('channel lost'), { code: 'DELIVERY_UNCERTAIN' })
  }).catch(() => {})
  const before = await f.host.mailbox.pendingEffect(target)
  assert.ok(before)
  assert.equal((await f.host.inspectPendingRetirement(f.inspect)).retirable, true)
  const results = await Promise.all([f.host.retirePendingAttempt(f.retire), f.host.retirePendingAttempt(f.retire)])
  assert.ok(results.every(x => x.retired && x.delivery === 'unknown'))
  const after = await f.store.read(f.record.id)
  assert.equal(after.status, 'delivery_uncertain'); assert.equal(after.latestTurnId, 'turn-unknown')
  assert.equal(after.events.filter(x => x.type === 'pending_retired').length, 1)
  assert.deepEqual(await f.host.mailbox.pendingEffect(target), before)
  assert.ok(f.bridge.calls.every(x => ['pending_retirement_inspect', 'writer_quiesce', 'pending_retire'].includes(x.method)))
})

test('audit persistence failure reconciles same native receipt after writer restart without completing turn', async t => {
  const f = await fixture(t); const append = f.store.recordPendingRetirement.bind(f.store)
  f.store.recordPendingRetirement = async () => { throw new Error('disk full') }
  await assert.rejects(f.host.retirePendingAttempt(f.retire), /disk full/)
  assert.equal((await f.store.read(f.record.id)).status, 'delivery_uncertain')
  f.store.recordPendingRetirement = append; f.host.writer.epoch = 8
  assert.equal((await f.host.retirePendingAttempt(f.retire)).retired, true)
  assert.equal((await f.store.read(f.record.id)).events.filter(x => x.type === 'pending_retired').length, 1)
})

test('fresh durable revocation and exact watchdog ledger are required before native access', async t => {
  for (const change of ['missing', 'active', 'target', 'duplicate', 'turn', 'source']) await t.test(change, async t => {
    const f = await fixture(t); const file = join(f.root, '.watchdog-authority', reg + '.json')
    if (change === 'missing') await rm(file)
    if (change === 'active' || change === 'target') {
      const x = JSON.parse(await readFile(file, 'utf8'))
      if (change === 'active') x.status = 'active'; else x.target = target.replace(/081$/, '082')
      await writeFile(file, JSON.stringify(x))
    }
    if (change === 'duplicate') await f.store.append(f.record.id, { type: 'send_intent', turnId: 'turn-unknown', requestId: f.inspect.requestId, source: 'watchdog', registrationId: reg })
    if (change === 'turn') await f.store.append(f.record.id, { type: 'send_intent', turnId: 'other', requestId: 'other' })
    if (change === 'source') {
      const p = join(f.root, f.record.id, 'events.jsonl'); await writeFile(p, (await readFile(p, 'utf8')).replace('"source":"watchdog"', '"source":"human"'))
    }
    await assert.rejects(f.host.inspectPendingRetirement(f.inspect))
    assert.equal(f.bridge.calls.length, 0)
  })
})

test('partial, forged and wrong identity native receipts cannot append audit', async t => {
  for (const field of ['requestId', 'writerEpoch', 'operationId', 'pendingDigest', 'buildId', 'delivery', 'proof']) await t.test(field, async t => {
    const f = await fixture(t)
    f.bridge.mutate = x => { if (field === 'proof') delete x.receipt.proof; else x.receipt[field] = field === 'writerEpoch' ? 99 : 'wrong'; return x }
    await assert.rejects(f.host.retirePendingAttempt(f.retire), /receipt_mismatch/)
    assert.equal((await f.store.read(f.record.id)).events.filter(x => x.type === 'pending_retired').length, 0)
  })
})

test('real CLI and integrated API enforce local nonbrowser exact JSON maintenance boundary', async t => {
  const f = await fixture(t); const app = createSidecarServer({ conversationHost: f.host })
  const address = await app.listen({ port: 0 }); t.after(() => app.close())
  const url = `http://127.0.0.1:${address.port}/mcp`
  const seen = []
  const fetchImpl = (url, options) => { seen.push({ url, options }); return fetch(url, options) }
  assert.equal((await runCli(['extension-pending-inspect', f.record.id, f.inspect.requestId], { url, fetchImpl })).retirable, true)
  assert.equal((await runCli(['extension-pending-retire', f.record.id, f.inspect.requestId, '--operation-id', operation,
    '--expected-instance-id', instance, '--expected-build-id', sha, '--pending-digest', sha], { url, fetchImpl })).retired, true)
  assert.ok(seen.every(x => x.options.redirect === 'error' && !JSON.parse(x.options.body).jsonrpc))
  for (const headers of [{ origin: 'null' }, { 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-dest': 'empty' }]) {
    const r = await fetch(url.replace('/mcp', '/internal/pending-retirement-inspect'), { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-mode': 'none', ...headers }, body: JSON.stringify(f.inspect) })
    assert.equal(r.status, 403)
  }
  const extra = await fetch(url.replace('/mcp', '/internal/pending-retirement-inspect'), { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-mode': 'none' }, body: JSON.stringify({ ...f.inspect, target }) })
  assert.equal(extra.status, 400)
  await assert.rejects(runCli(['extension-pending-inspect', f.record.id, f.inspect.requestId], { url: 'https://remote.example/mcp', fetchImpl }), /local HTTP/)
  const tools = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }).then(x => x.json())
  assert.ok(tools.result.tools.every(x => !/pending.*retir/i.test(x.name)))
})

test('host revalidates unknown lineage and durable revocation after native acknowledgement', async t => {
  for (const change of ['turn', 'authority']) await t.test(change, async t => {
    const f = await fixture(t); const request = f.bridge.request
    f.bridge.request = async (method, params) => {
      const result = await request(method, params)
      if (method === 'pending_retire') {
        if (change === 'turn') await f.store.append(f.record.id, { type: 'send_intent', turnId: 'changed', requestId: 'other' })
        else {
          const file = join(f.root, '.watchdog-authority', reg + '.json')
          const record = JSON.parse(await readFile(file, 'utf8')); record.status = 'active'; await writeFile(file, JSON.stringify(record))
        }
      }
      return result
    }
    await assert.rejects(f.host.retirePendingAttempt(f.retire))
    assert.ok(f.bridge.receipt)
    assert.equal((await f.store.read(f.record.id)).events.filter(x => x.type === 'pending_retired').length, 0)
  })
})
