import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'

const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024 * 1024

export function encodeNativeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8')
  const frame = Buffer.allocUnsafe(payload.length + 4)
  frame.writeUInt32LE(payload.length, 0)
  payload.copy(frame, 4)
  return frame
}

export class NativeMessageChannel extends EventEmitter {
  constructor({ input, output, maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES }) {
    super()
    this.input = input
    this.output = output
    this.maxMessageBytes = maxMessageBytes
    this.buffer = Buffer.alloc(0)
    this.closed = false
    this.onData = (chunk) => this.#consume(chunk)
    this.onEnd = () => this.#finish()
    this.onInputError = (error) => this.emit('error', error)
    input.on('data', this.onData)
    input.on('end', this.onEnd)
    input.on('error', this.onInputError)
  }

  send(message) {
    if (this.closed) throw new Error('Native messaging channel is closed')
    this.output.write(encodeNativeMessage(message))
  }

  #consume(chunk) {
    if (this.closed) return
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.buffer = this.buffer.length === 0 ? next : Buffer.concat([this.buffer, next])

    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0)
      if (length > this.maxMessageBytes) {
        const error = new Error(`Native message exceeds ${this.maxMessageBytes} bytes`)
        this.emit('error', error)
        this.close()
        return
      }
      if (this.buffer.length < length + 4) return

      const payload = this.buffer.subarray(4, length + 4)
      this.buffer = this.buffer.subarray(length + 4)
      try {
        this.emit('message', JSON.parse(payload.toString('utf8')))
      } catch (error) {
        this.emit('error', error)
      }
    }
  }

  #finish() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.input.off('data', this.onData)
    this.input.off('end', this.onEnd)
    this.input.off('error', this.onInputError)
    this.emit('close')
  }
}

export class ExtensionBridge extends EventEmitter {
  constructor({ channel, requestTimeoutMs = 30_000 }) {
    super()
    this.channel = channel
    this.requestTimeoutMs = requestTimeoutMs
    this.pending = new Map()
    channel.on('message', (message) => this.#handle(message))
    channel.on('close', () => this.#rejectAll(new Error('Chrome extension bridge disconnected')))
    channel.on('error', (error) => this.emit('error', error))
  }

  ackEvent(eventId) {
    if (typeof eventId !== 'string' || !eventId) return
    this.channel.send({ kind: 'event_ack', eventId })
  }

  request(method, params = {}) {
    const requestId = `req_${randomUUID()}`
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`Timed out waiting for extension response to ${method}`))
      }, this.requestTimeoutMs)
      this.pending.set(requestId, { resolve, reject, timeout })
    })
    this.channel.send({ kind: 'request', requestId, method, params })
    return promise
  }

  #handle(message) {
    if (message?.kind === 'response' && typeof message.requestId === 'string') {
      const pending = this.pending.get(message.requestId)
      if (!pending) return
      clearTimeout(pending.timeout)
      this.pending.delete(message.requestId)
      if (message.ok === false) pending.reject(new Error(message.error || 'Extension request failed'))
      else pending.resolve(message.result ?? {})
      return
    }

    if (message?.kind === 'event' && message.event && typeof message.event === 'object') {
      this.emit('event', {
        ...message.event,
        eventId: typeof message.eventId === 'string' ? message.eventId : message.event.eventId
      })
      return
    }

    if (message?.kind === 'bridge_ready') {
      this.emit('ready', message)
    }
  }

  #rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
