import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { runCli } from '../src/cli.mjs'

// Preserve the original standalone provider's CLI contracts when updating it.
function fakeFetch(calls) {
  return async (_url, options) => {
    const body = JSON.parse(options.body)
    calls.push(body)
    return { async json() {
      return { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: body.params.name, args: body.params.arguments }) }] } }
    } }
  }
}

test('CLI maps stock DevSpace-friendly commands to shared provider MCP tools', async () => {
  const calls = []
  const fetchImpl = fakeFetch(calls)
  await runCli(['project-create', 'subagents'], { fetchImpl })
  await runCli(['project-find', 'subagents'], { fetchImpl })
  await runCli(['project-pin', 'https://chatgpt.com/g/g-p-test/project'], { fetchImpl })
  await runCli(['create'], { fetchImpl })
  await runCli(['create', '--project', 'https://chatgpt.com/g/g-p-test/project'], { fetchImpl })
  await runCli(['send', 'conv_1', 'inspect', 'the', 'repo'], { fetchImpl })
  await runCli(['read', 'conv_1'], { fetchImpl })
  assert.deepEqual(calls.map((call) => [call.params.name, call.params.arguments]), [
    ['project_create', { name: 'subagents' }],
    ['project_find', { name: 'subagents' }],
    ['project_pin', { project_url: 'https://chatgpt.com/g/g-p-test/project' }],
    ['conversation_create', {}],
    ['conversation_create', { project_url: 'https://chatgpt.com/g/g-p-test/project' }],
    ['conversation_send', { conversation_id: 'conv_1', text: 'inspect the repo' }],
    ['conversation_read', { conversation_id: 'conv_1' }]
  ])
})

test('CLI prints help when invoked directly with Node on either OS', () => {
  const target = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [target, '--help'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /chatgpt-conversation create/)
  assert.match(result.stdout, /extension-update/)
})

test('CLI runs through a POSIX installed bin symlink without changing command semantics', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-conversation-bin-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const target = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))
  const link = join(dir, 'chatgpt-conversation')
  await symlink(target, link)
  const result = spawnSync(process.execPath, [link, '--help'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /chatgpt-conversation create/)
})

test('CLI rejects malformed commands before contacting the provider', async () => {
  const calls = []
  const fetchImpl = fakeFetch(calls)
  await assert.rejects(runCli(['send', '', 'hello'], { fetchImpl }), /send requires conversation_id and text/)
  await assert.rejects(runCli(['read', '   '], { fetchImpl }), /read requires conversation_id/)
  await assert.rejects(runCli(['create', '--project'], { fetchImpl }), /create --project requires project_url/)
  await assert.rejects(runCli(['unknown'], { fetchImpl }), /unknown command/)
  assert.equal(calls.length, 0)
})
