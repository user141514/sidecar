import test from 'node:test'
import assert from 'node:assert/strict'

async function loadModule() {
  try {
    return await import('../src/work-cli.mjs')
  } catch {
    return {}
  }
}

function fakeFetch(calls) {
  return async (_url, options) => {
    const body = JSON.parse(options.body)
    calls.push(body)
    return {
      async json() {
        return {
          jsonrpc: '2.0',
          id: body.id,
          result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: body.params.name, args: body.params.arguments }) }] }
        }
      }
    }
  }
}

test('work CLI maps create, append, decide, dispatch, collect and state to MCP tools', async () => {
  const { runCli } = await loadModule()
  assert.equal(typeof runCli, 'function')
  if (typeof runCli !== 'function') return

  const calls = []
  const fetchImpl = fakeFetch(calls)

  await runCli(['create', 'inspect', 'sidecar'], { fetchImpl })
  await runCli(['append', 'work_1', 'observation', '{"fact":"done"}'], { fetchImpl })
  await runCli(['state', 'work_1'], { fetchImpl })
  await runCli(['decide', 'work_1', '{"action":"CONTINUE","reason":"keep going"}'], { fetchImpl })
  await runCli(['dispatch', 'work_1', 'f1'], { fetchImpl })
  await runCli(['collect', 'work_1'], { fetchImpl })
  await runCli(['read', 'work_1'], { fetchImpl })
  await runCli(['memory-publish', 'work_done'], { fetchImpl })
  await runCli(['memory-query', 'work_1', '{"contains":"completion"}'], { fetchImpl })
  await runCli(['memory-read', 'work_1', 'retrieval_1', 'mem_1'], { fetchImpl })

  assert.deepEqual(calls.map((call) => [call.params.name, call.params.arguments]), [
    ['work_create', { goal: 'inspect sidecar' }],
    ['work_append', { work_id: 'work_1', type: 'observation', payload: { fact: 'done' } }],
    ['work_state', { work_id: 'work_1' }],
    ['work_decide', { work_id: 'work_1', decision: { action: 'CONTINUE', reason: 'keep going' } }],
    ['work_dispatch', { work_id: 'work_1', frontier_id: 'f1' }],
    ['work_collect', { work_id: 'work_1' }],
    ['work_read', { work_id: 'work_1' }],
    ['work_memory_publish', { source_work_id: 'work_done' }],
    ['work_memory_query', { work_id: 'work_1', contains: 'completion' }],
    ['work_memory_read', { work_id: 'work_1', retrieval_id: 'retrieval_1', memory_id: 'mem_1' }]
  ])
})

test('work CLI rejects surplus positional arguments before contacting the sidecar', async () => {
  const { runCli } = await loadModule()
  assert.equal(typeof runCli, 'function')
  if (typeof runCli !== 'function') return

  const calls = []
  const fetchImpl = fakeFetch(calls)
  await assert.rejects(
    runCli(['append', 'work_1', 'observation', '{"fact":"done"}', 'extra'], { fetchImpl }),
    /append requires work_id, type and payload_json/
  )
  await assert.rejects(
    runCli(['decide', 'work_1', '{"action":"CONTINUE","reason":"keep going"}', 'extra'], { fetchImpl }),
    /decide requires work_id and decision_json/
  )
  assert.equal(calls.length, 0)
})

test('work CLI rejects empty identifiers before contacting the sidecar', async () => {
  const { runCli } = await loadModule()
  assert.equal(typeof runCli, 'function')
  if (typeof runCli !== 'function') return

  const calls = []
  const fetchImpl = fakeFetch(calls)
  await assert.rejects(runCli(['state', ''], { fetchImpl }), /state requires work_id/)
  await assert.rejects(runCli(['dispatch', 'work_1', '   '], { fetchImpl }), /dispatch requires work_id and frontier_id/)
  await assert.rejects(runCli(['collect', ' '], { fetchImpl }), /collect requires work_id/)
  await assert.rejects(runCli(['read', ''], { fetchImpl }), /read requires work_id/)
  assert.equal(calls.length, 0)
})

test('work CLI rejects malformed memory command arguments before contacting the sidecar', async () => {
  const { runCli } = await loadModule()
  assert.equal(typeof runCli, 'function')
  if (typeof runCli !== 'function') return

  const calls = []
  const fetchImpl = fakeFetch(calls)
  await assert.rejects(runCli(['memory-publish', '   '], { fetchImpl }), /memory-publish requires source_work_id/)
  await assert.rejects(runCli(['memory-query', 'work_1', '{bad'], { fetchImpl }), /invalid JSON/)
  await assert.rejects(runCli(['memory-query', 'work_1', '{"similarity":0.8}'], { fetchImpl }), /unsupported memory query field/)
  await assert.rejects(runCli(['memory-read', 'work_1', '', 'mem_1'], { fetchImpl }), /memory-read requires work_id, retrieval_id, and memory_id/)
  assert.equal(calls.length, 0)
})

test('work CLI rejects malformed JSON before contacting the sidecar', async () => {
  const { runCli } = await loadModule()
  assert.equal(typeof runCli, 'function')
  if (typeof runCli !== 'function') return

  const calls = []
  await assert.rejects(
    runCli(['decide', 'work_1', '{bad'], { fetchImpl: fakeFetch(calls) }),
    /invalid JSON/
  )
  assert.equal(calls.length, 0)
})
