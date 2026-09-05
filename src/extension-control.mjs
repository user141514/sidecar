import { randomUUID } from 'node:crypto'
import { setTimeout as sleepDefault } from 'node:timers/promises'

export const EXTENSION_TOOLS = [
  {
    name: 'extension_status',
    description: 'Read the running extension instance, build, pending work and reload receipt. Does not change browser state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'extension_reload',
    description: 'Request an idle-only reload of the installed unpacked extension. Acceptance is NOT verification; use the independent CLI extension-update to verify reconnect, build and receipt.',
    inputSchema: {
      type: 'object',
      properties: { request_id: { type: 'string' }, expected_instance_id: { type: 'string' }, expected_build_id: { type: 'string' } },
      required: ['request_id', 'expected_instance_id', 'expected_build_id'],
      additionalProperties: false
    }
  }
]

export async function dispatchExtensionTool(bridge, name, args = {}) {
  if (!bridge) throw new Error('Extension bridge unavailable')
  const allowed = name === 'extension_status' ? [] : ['request_id', 'expected_instance_id', 'expected_build_id']
  if (Object.keys(args).some((key) => !allowed.includes(key))) throw new TypeError('Unexpected extension tool argument')
  if (name === 'extension_status') return bridge.request('extension_status')
  if (name !== 'extension_reload') throw new TypeError('Unknown extension tool')
  if (allowed.some((key) => typeof args[key] !== 'string' || !args[key])) throw new TypeError('Reload requires request, instance and build IDs')
  return bridge.request('extension_reload', { requestId: args.request_id, expectedInstanceId: args.expected_instance_id, expectedBuildId: args.expected_build_id })
}

export async function updateExtension(callTool, {
  expectedBuildId,
  expectedExtensionId,
  timeoutMs = 30_000,
  now = () => performance.now(),
  sleep = sleepDefault
} = {}) {
  if (!/^[a-f0-9]{64}$/.test(expectedBuildId ?? '')) throw new TypeError('Expected build ID must be a SHA-256 fingerprint')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) throw new TypeError('timeoutMs must be between 100 and 300000')
  const deadline = now() + timeoutMs
  const requestId = randomUUID()
  const call = (name, args) => callTool(name, args, Math.max(1, Math.min(3000, deadline - now())))
  let before
  try { before = await call('extension_status', {}) } catch (error) {
    if (error?.code === 'TOOL_ERROR' && /unknown|not found|unsupported/i.test(error.message)) {
      throw new Error('Installed host/extension lacks self-update support; install this release and perform one manual bootstrap reload')
    }
    throw error
  }
  if (now() >= deadline) throw new Error('Update preflight deadline elapsed; reload was not requested')
  if (!before?.instanceId || !before?.buildId) throw new Error('Installed extension lacks self-update support; manual bootstrap required')
  if (expectedExtensionId && before.extensionId !== expectedExtensionId) throw new Error('Installed extension ID mismatch')
  if (before.pendingCount || before.outboxCount || before.activeOperations || before.reloading) throw new Error('Extension busy; wait for pending work and outbox delivery')
  let requestError = null
  try {
    const accepted = await call('extension_reload', { request_id: requestId, expected_instance_id: before.instanceId, expected_build_id: expectedBuildId })
    if (accepted?.accepted !== true) throw new Error('Extension did not accept reload')
  } catch (error) {
    // Reload may close the native host before the CLI receives its HTTP reply.
    // A typed server rejection is authoritative; only transport loss is ambiguous.
    if (error?.code === 'TOOL_ERROR') throw error
    requestError = error instanceof Error ? error.message : String(error)
  }
  let lastStatus = null
  while (now() < deadline) {
    try { lastStatus = await call('extension_status', {}) } catch { lastStatus = null }
    const receipt = lastStatus?.lastReload
    if (lastStatus?.instanceId !== before.instanceId && receipt?.requestId === requestId && receipt.previousInstanceId === before.instanceId) {
      if (lastStatus.extensionId !== before.extensionId) throw new Error('Extension ID changed during reload')
      if (lastStatus.buildId !== expectedBuildId) throw new Error('Extension build mismatch after reload')
      if (lastStatus.restoration?.state === 'failed') throw new Error(`Content reattachment failed: ${lastStatus.restoration.error}`)
      if (lastStatus.restoration?.state === 'ready') return { verified: true, requestId, previousInstanceId: before.instanceId, status: lastStatus }
    }
    await sleep(Math.min(250, Math.max(0, deadline - now())))
  }
  const error = new Error(`Extension update not verified within ${timeoutMs}ms${requestError ? `; request: ${requestError}` : ''}`)
  error.details = { requestId, previousInstanceId: before.instanceId, lastStatus }
  throw error
}
