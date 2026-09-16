import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mod = await import('../src/writer-authority.mjs').catch(() => ({}))

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'writer-authority-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, statePath: join(root, 'writer-authority.json') }
}

test('writer epoch is durable and strictly increases across writer incarnations', async t => {
  assert.equal(typeof mod.claimWriterEpoch, 'function')
  const { statePath } = await fixture(t)
  assert.equal(await mod.claimWriterEpoch(statePath, { pid: 1001, ownerId: 'one', processAlive: () => false }), 1)
  assert.equal(await mod.claimWriterEpoch(statePath, { pid: 1002, ownerId: 'two', processAlive: () => false }), 2)
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  assert.deepEqual({ version: state.version, epoch: state.epoch }, { version: 1, epoch: 2 })
})

test('live writer authority lock is never stolen', async t => {
  const { root, statePath } = await fixture(t)
  await writeFile(statePath, `${JSON.stringify({ version: 1, epoch: 4 })}\n`)
  const lock = `${statePath}.lock`
  await mkdir(lock)
  await writeFile(join(lock, 'owner.json'), `${JSON.stringify({ pid: 2222, ownerId: 'live' })}\n`)
  await assert.rejects(
    mod.claimWriterEpoch(statePath, { pid: 3333, ownerId: 'new', processAlive: pid => pid === 2222 }),
    error => error?.code === 'WRITER_AUTHORITY_BUSY'
  )
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).epoch, 4)
})

test('dead writer authority owner can be fenced before advancing epoch', async t => {
  const { statePath } = await fixture(t)
  await writeFile(statePath, `${JSON.stringify({ version: 1, epoch: 7 })}\n`)
  const lock = `${statePath}.lock`
  await mkdir(lock)
  await writeFile(join(lock, 'owner.json'), `${JSON.stringify({ pid: 4444, ownerId: 'dead' })}\n`)
  const epoch = await mod.claimWriterEpoch(statePath, { pid: 5555, ownerId: 'replacement', processAlive: () => false })
  assert.equal(epoch, 8)
  await assert.rejects(readFile(join(lock, 'owner.json'), 'utf8'), error => error?.code === 'ENOENT')
})

test('corrupt durable writer authority state fails closed instead of resetting epoch', async t => {
  const { statePath } = await fixture(t)
  await writeFile(statePath, '{"version":1,"epoch":"broken"}\n')
  await assert.rejects(mod.claimWriterEpoch(statePath), /invalid writer authority state/i)
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(state.epoch, 'broken')
})
