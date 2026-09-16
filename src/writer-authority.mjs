import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

function defaultProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

function busy() {
  const error = new Error('writer authority is owned by another live process')
  error.code = 'WRITER_AUTHORITY_BUSY'
  return error
}

async function acquire(lock, { pid, ownerId, processAlive }) {
  try {
    await mkdir(lock)
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    let owner
    try {
      owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'))
    } catch {
      throw busy()
    }
    if (!Number.isInteger(owner?.pid) || owner.pid <= 0 || typeof owner?.ownerId !== 'string' || !owner.ownerId) {
      throw busy()
    }
    let alive
    try { alive = processAlive(owner.pid) } catch { throw busy() }
    if (alive !== false) throw busy()
    try {
      await rm(lock, { recursive: true })
      await mkdir(lock)
    } catch (replacementError) {
      if (replacementError?.code === 'EEXIST') throw busy()
      throw replacementError
    }
  }

  try {
    const handle = await open(join(lock, 'owner.json'), 'wx')
    try {
      await handle.writeFile(`${JSON.stringify({ pid, ownerId })}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    await rm(lock, { recursive: true }).catch(() => {})
    throw error
  }
}

async function release(lock, ownerId) {
  try {
    const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'))
    if (owner?.ownerId !== ownerId) return
    await rm(lock, { recursive: true })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function readState(statePath) {
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    if (!state || state.version !== 1 || !Number.isSafeInteger(state.epoch) || state.epoch < 0) {
      throw new Error('invalid writer authority state')
    }
    return state
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, epoch: 0 }
    if (/invalid writer authority state/i.test(error?.message ?? '')) throw error
    throw new Error(`invalid writer authority state: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function persist(statePath, state) {
  const temporary = `${statePath}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx')
  try {
    await handle.writeFile(`${JSON.stringify(state)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, statePath)
}

export async function claimWriterEpoch(statePath, {
  pid = process.pid,
  ownerId = randomUUID(),
  processAlive = defaultProcessAlive
} = {}) {
  if (typeof statePath !== 'string' || !statePath) throw new TypeError('writer authority state path is required')
  if (!Number.isInteger(pid) || pid <= 0) throw new TypeError('writer authority pid must be a positive integer')
  if (typeof ownerId !== 'string' || !ownerId) throw new TypeError('writer authority ownerId is required')
  if (typeof processAlive !== 'function') throw new TypeError('writer authority processAlive must be a function')

  await mkdir(dirname(statePath), { recursive: true })
  const lock = `${statePath}.lock`
  await acquire(lock, { pid, ownerId, processAlive })
  try {
    const state = await readState(statePath)
    if (state.epoch >= Number.MAX_SAFE_INTEGER) throw new Error('writer authority epoch exhausted')
    const epoch = state.epoch + 1
    await persist(statePath, { version: 1, epoch })
    return epoch
  } finally {
    await release(lock, ownerId)
  }
}
