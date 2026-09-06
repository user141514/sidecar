import test from 'node:test'
import assert from 'node:assert/strict'
import { createProviderServer } from '../src/provider-server.mjs'
import { runCli } from '../src/cli.mjs'
import { checkedExtensionBuild } from '../scripts/extension-build.mjs'

async function rpc(url, method, params = {}) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  return response.json()
}

test('standalone exposes shared conversation and update tools without controller or memory tools', async (t) => {
  const app = createProviderServer({ conversationHost: { read: async (id) => ({ id, status: 'completed', latestResponse: 'result' }) } })
  t.after(() => app.close())
  const { port } = await app.listen({ port: 0 })
  const url = `http://127.0.0.1:${port}/mcp`
  const listed = await rpc(url, 'tools/list')
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['extension_status', 'extension_reload', 'project_create', 'project_find', 'project_pin', 'conversation_create', 'conversation_send', 'conversation_read'])
  const read = await runCli(['read', 'conv_test'], { url })
  assert.equal(read.latestResponse, 'result')
  const missing = await rpc(url, 'tools/call', { name: 'work_create', arguments: { goal: 'not available' } })
  assert.equal(missing.error.code, -32602)
})

test('CLI verifies a replacement HTTP native host rather than accepting the reload response', async (t) => {
  const build = await checkedExtensionBuild()
  let state = { instanceId: 'old', extensionId: build.extensionId, buildId: build.buildId, pendingCount: 0, outboxCount: 0, activeOperations: 0, restoration: { state: 'ready' } }
  let reloads = 0
  let timer
  let restart
  const bridge = { async request(method, params) {
    if (method === 'extension_status') return state
    assert.equal(method, 'extension_reload')
    reloads++
    timer = setTimeout(() => {
      restart = (async () => {
        await app.close()
        state = { ...state, instanceId: 'new', lastReload: { requestId: params.requestId, previousInstanceId: 'old' } }
        app = createProviderServer({ conversationHost: { bridge } })
        await app.listen({ port })
      })()
    }, 30)
    return { accepted: true, requestId: params.requestId }
  } }
  let app = createProviderServer({ conversationHost: { bridge } })
  const { port } = await app.listen({ port: 0 })
  t.after(async () => { clearTimeout(timer); await restart; await app.close() })
  const result = await runCli(['extension-update', '--timeout-ms', '3000'], { url: `http://127.0.0.1:${port}/mcp` })
  assert.equal(result.verified, true)
  assert.equal(result.status.instanceId, 'new')
  assert.equal(reloads, 1)
})

test('CLI rejects malformed update flags and nonlocal control endpoints before I/O', async () => {
  const neverFetch = async () => { throw new Error('unexpected request') }
  await assert.rejects(runCli(['extension-update', '--force'], { fetchImpl: neverFetch }), /accepts only/)
  await assert.rejects(runCli(['extension-update', '--timeout-ms', '0'], { fetchImpl: neverFetch }), /between/)
  await assert.rejects(runCli(['extension-update'], { fetchImpl: neverFetch, url: 'https://example.com/mcp' }), /local HTTP/)
})
