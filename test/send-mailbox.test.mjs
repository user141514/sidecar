import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mod = await import('../src/send-mailbox.mjs').catch(() => ({}))
const url = 'https://chatgpt.com/c/00000000-0000-0000-0000-000000000001'
async function fixture(t) {
  assert.equal(typeof mod.SendMailbox, 'function', 'durable send mailbox must exist')
  const rootDir = await mkdtemp(join(tmpdir(), 'send-mailbox-'))
  t.after(() => rm(rootDir, { recursive: true, force: true }))
  return { rootDir, box: new mod.SendMailbox({ rootDir }) }
}

test('mailbox serializes all writers to a canonical conversation including Project aliases', async t => {
  const { box } = await fixture(t)
  let writers = 0, peak = 0, calls = 0
  const effect = async dispatch => {
    await dispatch()
    peak = Math.max(peak, ++writers)
    await new Promise(resolve => setTimeout(resolve, 10))
    writers--; calls++
    return { accepted: true }
  }
  await Promise.all([
    box.run(url, 'coordinator', { text: 'one' }, effect),
    box.run(url.replace('/c/', '/g/g-p-test/c/'), 'watchdog', { text: 'two' }, effect)
  ])
  assert.equal(peak, 1)
  assert.equal(calls, 2)
})

test('same request returns one durable receipt after response loss and process restart', async t => {
  const { box, rootDir } = await fixture(t)
  let calls = 0
  const effect = async dispatch => { await dispatch(); calls++; return { accepted: true, turnId: 't1' } }
  const first = await box.run(url, 'same', { text: 'one' }, effect)
  const afterRestart = await new mod.SendMailbox({ rootDir }).run(url, 'same', { text: 'one' }, effect)
  assert.deepEqual(afterRestart, first)
  assert.equal(calls, 1)
})

test('same request identity cannot change the command content', async t => {
  const { box } = await fixture(t)
  await box.run(url, 'same', { text: 'one' }, async () => ({ accepted: true }))
  await assert.rejects(box.run(url, 'same', { text: 'different' }, async () => assert.fail('must not send')), /request.*conflict/i)
})

test('uncertain effect blocks both replay and a fresh request after restart', async t => {
  const { box, rootDir } = await fixture(t)
  const result = await box.run(url, 'lost', {}, async dispatch => { await dispatch(); throw new Error('connection lost after click') })
  assert.equal(result.reason, 'delivery_uncertain')
  const restarted = new mod.SendMailbox({ rootDir })
  for (const requestId of ['lost', 'different']) {
    const next = await restarted.run(url, requestId, {}, async () => assert.fail('must not replay'))
    assert.equal(next.reason, 'delivery_uncertain')
  }
})

test('authoritative effect receipt settles an uncertain pending request without replay', async t => {
  const { box, rootDir } = await fixture(t)
  let sends = 0
  const first = await box.run(url, 'lost', { text: 'once' }, async dispatch => {
    await dispatch({ conversationId: 'conv-1', turnId: 'turn-1' })
    sends++
    throw new Error('response lost after browser effect')
  })
  assert.equal(first.reason, 'delivery_uncertain')

  const restarted = new mod.SendMailbox({ rootDir })
  const reconciled = await restarted.reconcile(url, 'lost', {
    accepted: true,
    conversationId: 'conv-1',
    turnId: 'turn-1',
    reconciled: true
  })
  assert.equal(reconciled.accepted, true)

  const replay = await restarted.run(url, 'lost', { text: 'once' }, async () => assert.fail('must not replay reconciled effect'))
  assert.deepEqual(replay, reconciled)
  assert.equal(sends, 1)
})

test('reconciliation fences an orphaned mailbox lock only after proving its owner dead', async t => {
  const { box, rootDir } = await fixture(t)
  await box.run(url, 'lost-crash', { text: 'once' }, async dispatch => {
    await dispatch({ conversationId: 'conv-1', turnId: 'turn-1' })
    throw new Error('effect happened before process crash')
  })

  const key = 'chatgpt:00000000-0000-0000-0000-000000000001'
  const stateFile = join(rootDir, `${createHash('sha256').update(key).digest('hex')}.json`)
  const lockDir = `${stateFile}.lock`
  await mkdir(lockDir)
  await writeFile(join(lockDir, 'owner.json'), `${JSON.stringify({ pid: 424242, ownerId: 'dead-owner' })}\n`)

  const restarted = new mod.SendMailbox({ rootDir, processAlive: () => false, pid: 515151, ownerId: 'new-owner' })
  const reconciled = await restarted.reconcile(url, 'lost-crash', {
    accepted: true,
    conversationId: 'conv-1',
    turnId: 'turn-1',
    reconciled: true
  })
  assert.equal(reconciled.accepted, true)
})

test('reconciliation never steals a lock whose owner is still alive', async t => {
  const { box, rootDir } = await fixture(t)
  await box.run(url, 'lost-live', { text: 'once' }, async dispatch => {
    await dispatch({ conversationId: 'conv-1', turnId: 'turn-1' })
    throw new Error('uncertain')
  })

  const key = 'chatgpt:00000000-0000-0000-0000-000000000001'
  const stateFile = join(rootDir, `${createHash('sha256').update(key).digest('hex')}.json`)
  const lockDir = `${stateFile}.lock`
  await mkdir(lockDir)
  await writeFile(join(lockDir, 'owner.json'), `${JSON.stringify({ pid: 616161, ownerId: 'live-owner' })}\n`)

  const restarted = new mod.SendMailbox({ rootDir, processAlive: () => true, pid: 717171, ownerId: 'new-owner' })
  const result = await restarted.reconcile(url, 'lost-live', {
    accepted: true,
    conversationId: 'conv-1',
    turnId: 'turn-1',
    reconciled: true
  })
  assert.equal(result.reason, 'delivery_uncertain')
})

test('hard-killed mailbox owner is reconciled after restart without a second effect', async t => {
  const { rootDir } = await fixture(t)
  const child = spawn(process.execPath, [
    fileURLToPath(new URL('./send-mailbox-crash-child.mjs', import.meta.url)),
    rootDir,
    url
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })

  await new Promise((resolve, reject) => {
    child.stdout.setEncoding('utf8')
    let output = ''
    child.stdout.on('data', chunk => {
      output += chunk
      if (output.includes('DISPATCHED')) resolve()
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (!output.includes('DISPATCHED')) reject(new Error(`crash child exited before dispatch: ${code}`))
    })
  })
  const deadPid = child.pid
  child.kill('SIGKILL')
  await new Promise(resolve => child.once('exit', resolve))
  assert.ok(Number.isInteger(deadPid))

  const restarted = new mod.SendMailbox({ rootDir })
  const reconciled = await restarted.reconcile(url, 'crash-child', {
    accepted: true,
    conversationId: 'conv-crash',
    turnId: 'turn-crash',
    reconciled: true
  })
  assert.equal(reconciled.accepted, true)
  const replay = await restarted.run(url, 'crash-child', { text: 'once' }, async () => assert.fail('must not repeat browser effect'))
  assert.deepEqual(replay, reconciled)
})

test('preflight denial can be retried without consuming an effect reservation', async t => {
  const { box } = await fixture(t)
  const waiting = await box.run(url, 'pace', {}, async () => ({ accepted: false, reason: 'pacing' }))
  assert.equal(waiting.reason, 'pacing')
  const accepted = await box.run(url, 'pace', {}, async dispatch => { await dispatch(); return { accepted: true } })
  assert.equal(accepted.accepted, true)
})

test('temporary missing final evidence does not permanently poison an unsent intent', async t => {
  const { box } = await fixture(t)
  await box.run(url, 'waiting', {}, async () => ({ accepted: false, reason: 'terminal_evidence_missing' }))
  let writes = 0
  const next = await box.run(url, 'waiting', {}, async dispatch => { await dispatch(); writes++; return { accepted: true } })
  assert.equal(next.accepted, true)
  assert.equal(writes, 1)
})

test('two independent mailbox objects cannot both own the same effect', async t => {
  const { box, rootDir } = await fixture(t)
  let release, entered
  const ready = new Promise(resolve => { entered = resolve })
  const hold = new Promise(resolve => { release = resolve })
  const first = box.run(url, 'one', {}, async dispatch => { await dispatch(); entered(); await hold; return { accepted: true } })
  await ready
  const second = await new mod.SendMailbox({ rootDir }).run(url, 'two', {}, async () => assert.fail('second owner'))
  assert.equal(second.accepted, false)
  release()
  await first
})
