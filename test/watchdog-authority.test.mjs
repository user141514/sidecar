import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WatchdogAuthority } from '../src/watchdog-authority.mjs'

const target = 'https://chatgpt.com/c/00000000-0000-0000-0000-000000000031'
const registrationId = '00000000-0000-0000-0000-000000000001'
async function fixture(t) {
  const rootDir = await mkdtemp(join(tmpdir(), 'watchdog-authority-'))
  t.after(() => rm(rootDir, { recursive: true, force: true }))
  return { rootDir, owner: new WatchdogAuthority({ rootDir }) }
}

test('withdraw persists revocation before waiting for actual accepted operations and owner quiescence', async t => {
  const { owner, rootDir } = await fixture(t)
  assert.equal((await owner.bind({ registrationId, target })).accepted, true)
  let release
  const effect = new Promise(resolve => { release = resolve })
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const accepted = owner.run({ registrationId, target }, async () => { entered(); await effect; return { accepted: true } })
  await started
  let acknowledged = false
  let quiesceCalls = 0
  const withdrawal = owner.withdraw({ registrationId, target }, async () => { quiesceCalls++; return { quiescent: true } })
    .then(result => { acknowledged = true; return result })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(acknowledged, false)
  assert.equal(quiesceCalls, 0)
  assert.equal((await owner.run({ registrationId, target }, () => { throw new Error('late effect') })).accepted, false)
  assert.equal((await new WatchdogAuthority({ rootDir }).bind({ registrationId, target })).accepted, false)
  release()
  await accepted
  assert.deepEqual(await withdrawal, { accepted: true, quiescent: true, registrationId })
  assert.equal(quiesceCalls, 1)
})

test('unknown actual extension outcome cannot acknowledge quiescent withdrawal and revoked admission survives restart', async t => {
  const { owner, rootDir } = await fixture(t)
  await owner.bind({ registrationId, target })
  const result = await owner.withdraw({ registrationId, target }, async () => { throw new Error('bridge timed out') })
  assert.equal(result.accepted, false)
  assert.equal(result.quiescent, false)
  const restarted = new WatchdogAuthority({ rootDir })
  assert.equal((await restarted.run({ registrationId, target }, async () => ({ accepted: true }))).accepted, false)
  assert.equal((await restarted.withdraw({ registrationId, target }, async () => ({ quiescent: true }))).quiescent, true)
})

test('failed revocation persistence closes admission immediately and retry must durably repair before ACK', async t => {
  const { owner, rootDir } = await fixture(t)
  await owner.bind({ registrationId, target })
  const blocked = join(rootDir, 'blocked')
  await writeFile(blocked, 'regular file')
  owner.rootDir = blocked
  const failed = await owner.withdraw({ registrationId, target }, async () => ({ quiescent: true }))
  assert.equal(failed.accepted, false)
  assert.equal(failed.quiescent, false)
  assert.equal((await owner.run({ registrationId, target }, async () => ({ accepted: true }))).accepted, false)
  owner.rootDir = rootDir
  assert.equal((await owner.withdraw({ registrationId, target }, async () => ({ quiescent: true }))).quiescent, true)
  assert.equal((await new WatchdogAuthority({ rootDir }).bind({ registrationId, target })).accepted, false)
})

test('a new owner epoch requires explicit Registry restore before an old active grant admits effects', async t => {
  const { rootDir } = await fixture(t)
  const old = new WatchdogAuthority({ rootDir, writerEpoch: 7 })
  await old.bind({ registrationId, target })
  const restarted = new WatchdogAuthority({ rootDir, writerEpoch: 8 })
  assert.equal((await restarted.run({ registrationId, target }, async () => ({ accepted: true }))).accepted, false)
  assert.equal((await restarted.bind({ registrationId, target })).accepted, true)
  assert.equal((await restarted.run({ registrationId, target }, async () => ({ accepted: true }))).accepted, true)
  await restarted.withdraw({ registrationId, target }, async () => ({ quiescent: true }))
  assert.equal((await new WatchdogAuthority({ rootDir, writerEpoch: 9 }).bind({ registrationId, target })).accepted, false)
})

test('a delayed bind cannot overwrite withdrawal or admit an action after revoke was requested', async t => {
  const { owner, rootDir } = await fixture(t)
  const binding = owner.bind({ registrationId, target })
  const withdrawal = owner.withdraw({ registrationId, target }, async () => ({ quiescent: true }))
  const [bound, withdrawn] = await Promise.all([binding, withdrawal])
  assert.equal(bound.accepted, false)
  assert.equal(withdrawn.quiescent, true)
  assert.equal((await new WatchdogAuthority({ rootDir }).bind({ registrationId, target })).accepted, false)
})

test('generation identity is exact and an explicitly new binding cannot restore a withdrawn generation', async t => {
  const { owner } = await fixture(t)
  await owner.bind({ registrationId, target })
  const wrong = 'https://chatgpt.com/c/00000000-0000-0000-0000-000000000032'
  assert.equal((await owner.bind({ registrationId, target: wrong })).accepted, false)
  assert.equal((await owner.run({ registrationId, target: wrong }, async () => ({ accepted: true }))).accepted, false)
  await owner.withdraw({ registrationId, target }, async () => ({ quiescent: true }))
  const next = '00000000-0000-0000-0000-000000000002'
  assert.equal((await owner.bind({ registrationId: next, target })).accepted, true)
  assert.equal((await owner.run({ registrationId, target }, async () => ({ accepted: true }))).accepted, false)
  assert.equal((await owner.run({ registrationId: next, target }, async () => ({ accepted: true }))).accepted, true)
})
