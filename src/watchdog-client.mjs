const DEFAULT_WATCHDOG_URL = 'http://127.0.0.1:9235'

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_WATCHDOG_URL).replace(/\/$/, '')
}

export class WatchdogClient {
  constructor({ baseUrl = process.env.CHAT_WATCHDOG_URL ?? DEFAULT_WATCHDOG_URL, fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl)
    this.fetchImpl = fetchImpl
  }

  async #post(path, url) {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(500)
      })
      return response.ok
    } catch {
      return false
    }
  }

  async register(url) {
    return this.#post('/register', url)
  }

  async unregister(url) {
    return this.#post('/unregister', url)
  }

  async completion(url) {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/completion`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(500)
      })
      if (!response.ok) return null
      const payload = await response.json()
      if (!payload || typeof payload !== 'object') return null
      return {
        active: payload.active === true,
        completed: payload.completed === true,
        result: typeof payload.result === 'string' ? payload.result : null
      }
    } catch {
      return null
    }
  }

  async ackCompletion(url) {
    return this.#post('/completion/ack', url)
  }
}
