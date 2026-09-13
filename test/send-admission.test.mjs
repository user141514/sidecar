import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function loadModule() {
  try {
    return await import('../src/send-admission.mjs')
  } catch {
    return {}
  }
}

async function fixture(t, start = 1_000_000) {
  const dir = await mkdtemp(join(tmpdir(), 'sidecar-send-admission-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  let current = start
  const { SendAdmission } = await loadModule()
  assert.equal(typeof SendAdmission, 'function')
  return {
    statePath: join(dir, 'send-admission.json'),
    now: () => current,
    setNow(value) { current = value },
    SendAdmission
  }
}

test('first admission succeeds and a second send inside 120 seconds is denied with retryAfterMs', async (t) => {
  const f = await fixture(t)
  const admission = new f.SendAdmission({ statePath: f.statePath, intervalMs: 120_000, now: f.now })

  const first = await admission.admit({ source: 'conversation_send', target: 'https://chatgpt.com/c/a' })
  assert.equal(first.admitted, true)
  assert.equal(first.admittedAt, 1_000_000)

  f.setNow(1_030_000)
  const second = await admission.admit({ source: 'watchdog', target: 'https://chatgpt.com/c/a' })
  assert.deepEqual(second, { admitted: false, retryAfterMs: 90_000, lastAdmittedAt: 1_000_000 })
})

test('admission succeeds once the durable 120-second window has elapsed', async (t) => {
  const f = await fixture(t)
  const admission = new f.SendAdmission({ statePath: f.statePath, intervalMs: 120_000, now: f.now })
  await admission.admit({ source: 'conversation_send', target: 'https://chatgpt.com/c/a' })

  f.setNow(1_120_000)
  const next = await admission.admit({ source: 'work_dispatch', target: 'https://chatgpt.com/g/project' })
  assert.equal(next.admitted, true)
  assert.equal(next.admittedAt, 1_120_000)
})

test('concurrent admissions serialize so only one caller receives the grant', async (t) => {
  const f = await fixture(t)
  const admission = new f.SendAdmission({ statePath: f.statePath, intervalMs: 120_000, now: f.now })

  const [a, b] = await Promise.all([
    admission.admit({ source: 'manual-a', target: 'https://chatgpt.com/c/a' }),
    admission.admit({ source: 'manual-b', target: 'https://chatgpt.com/c/b' })
  ])

  assert.equal([a, b].filter((result) => result.admitted).length, 1)
  assert.equal([a, b].filter((result) => !result.admitted).length, 1)
})

test('a fresh admission owner preserves the window across process-style restart', async (t) => {
  const f = await fixture(t)
  const firstOwner = new f.SendAdmission({ statePath: f.statePath, intervalMs: 120_000, now: f.now })
  await firstOwner.admit({ source: 'conversation_send', target: 'https://chatgpt.com/c/a' })

  f.setNow(1_060_000)
  const restartedOwner = new f.SendAdmission({ statePath: f.statePath, intervalMs: 120_000, now: f.now })
  const result = await restartedOwner.admit({ source: 'watchdog', target: 'https://chatgpt.com/c/a' })

  assert.deepEqual(result, { admitted: false, retryAfterMs: 60_000, lastAdmittedAt: 1_000_000 })
})
