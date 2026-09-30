import { IdempotencyConflictError } from './errors.js'

export class IdempotencyLedger {
  #entries = new Map()

  async run({ userId, operation, key, requestHash, action }) {
    if (!userId || !operation || !key || !requestHash) {
      throw new Error('userId, operation, key and requestHash are required')
    }
    const id = `${userId}:${operation}:${key}`
    const current = this.#entries.get(id)
    if (current && current.requestHash !== requestHash) throw new IdempotencyConflictError()
    if (current) return current.result
    const result = await action()
    this.#entries.set(id, { requestHash, result, createdAt: Date.now() })
    return result
  }

  clearExpired(maxAgeMs) {
    const cutoff = Date.now() - maxAgeMs
    for (const [key, value] of this.#entries) if (value.createdAt < cutoff) this.#entries.delete(key)
  }
}
