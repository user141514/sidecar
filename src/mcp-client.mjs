const DEFAULT_ENDPOINT = 'http://127.0.0.1:7337/mcp'

function decodeToolResult(result) {
  const text = result?.content?.find(({ type }) => type === 'text')?.text
  if (typeof text !== 'string') throw new Error('Local MCP returned an invalid tool result')
  return JSON.parse(text)
}

export class McpHttpClient {
  #id = 0

  constructor({ endpoint = process.env.CONVERSATION_SIDECAR_MCP_URL ?? DEFAULT_ENDPOINT, fetchImpl = fetch } = {}) {
    this.endpoint = endpoint
    this.fetch = fetchImpl
  }

  async request(method, params = {}) {
    const response = await this.fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.#id, method, params })
    })
    const raw = await response.text()
    if (!response.ok) throw new Error(`Local MCP returned HTTP ${response.status}${raw ? `: ${raw}` : ''}`)
    if (!raw) throw new Error('Local MCP returned an empty response')
    const body = JSON.parse(raw)
    if (body.error) throw new Error(body.error.message)
    return body.result
  }

  async toolsList() {
    return (await this.request('tools/list')).tools
  }

  async call(name, args = {}) {
    return decodeToolResult(await this.request('tools/call', { name, arguments: args }))
  }

  projectPin(projectUrl) {
    return this.call('project_pin', { project_url: projectUrl })
  }

  conversationCreate(projectUrl) {
    return this.call('conversation_create', projectUrl === undefined ? {} : { project_url: projectUrl })
  }

  conversationSend(conversationId, text) {
    return this.call('conversation_send', { conversation_id: conversationId, text })
  }

  conversationRead(conversationId) {
    return this.call('conversation_read', { conversation_id: conversationId })
  }
}
