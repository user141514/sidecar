import { readFile } from 'node:fs/promises'

export function parseDevToolsActivePort(raw) {
  const [portLine, websocketPath] = raw
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
  const port = Number(portLine)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('Invalid DevToolsActivePort port')
  }
  if (!websocketPath?.startsWith('/devtools/browser/')) {
    throw new Error('Invalid DevToolsActivePort websocket path')
  }
  return { port, websocketPath }
}

export async function endpointFromDevToolsActivePort(path) {
  const { port, websocketPath } = parseDevToolsActivePort(await readFile(path, 'utf8'))
  return `ws://127.0.0.1:${port}${websocketPath}`
}

export class CdpClient {
  constructor({ endpoint, socketFactory = (url) => new WebSocket(url), connectTimeoutMs = 15_000 }) {
    this.endpoint = endpoint
    this.socketFactory = socketFactory
    this.connectTimeoutMs = connectTimeoutMs
    this.socket = null
    this.nextId = 1
    this.pending = new Map()
    this.connecting = null
  }

  async connect() {
    if (this.socket?.readyState === 1) return
    if (this.connecting) return this.connecting

    this.connecting = new Promise((resolve, reject) => {
      const socket = this.socketFactory(this.endpoint)
      this.socket = socket
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out connecting to Chrome CDP at ${this.endpoint}`))
        try { socket.close() } catch {}
      }, this.connectTimeoutMs)

      socket.addEventListener('open', () => {
        clearTimeout(timeout)
        resolve()
      })
      socket.addEventListener('error', (event) => {
        clearTimeout(timeout)
        reject(event?.error ?? new Error('Chrome CDP websocket error'))
      })
      socket.addEventListener('message', (event) => this.#handleMessage(event.data))
      socket.addEventListener('close', () => {
        for (const { reject: rejectPending } of this.pending.values()) {
          rejectPending(new Error('Chrome CDP websocket closed'))
        }
        this.pending.clear()
        this.socket = null
        this.connecting = null
      })
    })

    try {
      await this.connecting
    } finally {
      if (this.socket?.readyState === 1) this.connecting = null
    }
  }

  #handleMessage(raw) {
    let message
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw))
    } catch {
      return
    }
    if (!message.id) return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.error) pending.reject(new Error(message.error.message ?? 'CDP command failed'))
    else pending.resolve(message.result ?? {})
  }

  async command(method, params = {}, sessionId) {
    await this.connect()
    const id = this.nextId++
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
    this.socket.send(JSON.stringify(payload))
    return result
  }

  async createTarget(url, options = {}) {
    const result = await this.command('Target.createTarget', { url, ...options })
    if (!result.targetId) throw new Error('Chrome did not return targetId')
    return result.targetId
  }

  async attach(targetId) {
    const result = await this.command('Target.attachToTarget', { targetId, flatten: true })
    if (!result.sessionId) throw new Error('Chrome did not return sessionId')
    return result.sessionId
  }

  async evaluate(sessionId, expression) {
    const result = await this.command(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId
    )
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? 'Runtime.evaluate failed')
    }
    return result.result?.value
  }

  close() {
    this.socket?.close()
  }
}
