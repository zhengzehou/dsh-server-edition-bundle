import { ConflictError, DshPluginError } from '../lib/errors.js'
import { registerService } from '../lib/register.js'

export const id = 'dsh-runtime-manager'

export class InMemoryLeaseStore {
  #leases = new Map()

  async acquire(key, owner, ttlMs) {
    const now = Date.now()
    const current = this.#leases.get(key)
    if (current && current.expiresAt > now && current.owner !== owner) return null
    if (current && current.expiresAt > now && current.owner === owner) {
      current.expiresAt = now + ttlMs
      return { ...current }
    }
    const fencingToken = (current?.fencingToken || 0) + 1
    this.#leases.set(key, { owner, fencingToken, expiresAt: now + ttlMs })
    return { owner, fencingToken, expiresAt: now + ttlMs }
  }

  async renew(key, owner, fencingToken, ttlMs) {
    const current = this.#leases.get(key)
    if (!current || current.owner !== owner || current.fencingToken !== fencingToken) return false
    current.expiresAt = Date.now() + ttlMs
    return true
  }

  async get(key) {
    const current = this.#leases.get(key)
    if (!current || current.expiresAt <= Date.now()) { this.#leases.delete(key); return null }
    return { ...current }
  }

  async release(key, owner, fencingToken) {
    const current = this.#leases.get(key)
    if (current && current.owner === owner && current.fencingToken === fencingToken) this.#leases.delete(key)
  }
}

export class RedisLeaseStore {
  constructor(redis, { keyPrefix = 'dsh:runtime:', ttlMs = 15000 } = {}) {
    this.redis = redis
    this.keyPrefix = keyPrefix
    this.ttlMs = ttlMs
  }

  key(userId) { return `${this.keyPrefix}${userId}` }

  async acquire(userId, owner) {
    if (!this.redis || typeof this.redis.set !== 'function') throw new DshPluginError('REDIS_UNAVAILABLE', 'Redis client with set() is required')
    const key = this.key(userId)
    const token = `${owner}:${Date.now()}:${Math.random().toString(36).slice(2)}`
    const result = await this.redis.set(key, JSON.stringify({ owner, token }), { NX: true, PX: this.ttlMs })
    if (result !== 'OK' && result !== true) return null
    return { owner, fencingToken: token, expiresAt: Date.now() + this.ttlMs }
  }

  async renew(userId, owner, fencingToken) {
    if (!this.redis || typeof this.redis.eval !== 'function') return false
    const script = 'local v=redis.call("GET",KEYS[1]); if not v then return 0 end; local x=cjson.decode(v); if x.owner~=ARGV[1] or x.token~=ARGV[2] then return 0 end; redis.call("PEXPIRE",KEYS[1],ARGV[3]); return 1'
    return Number(await this.redis.eval(script, { keys: [this.key(userId)], arguments: [owner, fencingToken, String(this.ttlMs)] })) === 1
  }

  async get(userId) {
    if (!this.redis || typeof this.redis.get !== 'function') return null
    const raw = await this.redis.get(this.key(userId))
    if (!raw) return null
    const value = JSON.parse(raw)
    return { owner: value.owner, fencingToken: value.token }
  }

  async release(userId, owner, fencingToken) {
    if (!this.redis || typeof this.redis.eval !== 'function') return
    const script = 'local v=redis.call("GET",KEYS[1]); if not v then return 0 end; local x=cjson.decode(v); if x.owner~=ARGV[1] or x.token~=ARGV[2] then return 0 end; return redis.call("DEL",KEYS[1])'
    await this.redis.eval(script, { keys: [this.key(userId)], arguments: [owner, fencingToken] })
  }
}

export class RuntimeManager {
  constructor({ leaseStore = new InMemoryLeaseStore(), runtimeFactory = async ({ userId }) => ({ runtimeId: `runtime_${userId}`, nodeId: 'local' }), leaseTtlMs = 15000 } = {}) {
    this.leaseStore = leaseStore
    this.runtimeFactory = runtimeFactory
    this.leaseTtlMs = leaseTtlMs
    this.runtimes = new Map()
  }

  async ensureRuntime(context) {
    const owner = context.runtimeId || `node_${process.pid}`
    const cached = this.runtimes.get(context.userId)
    if (cached && cached.owner === owner) {
      const current = await this.leaseStore.get(context.userId)
      if (current && current.fencingToken === cached.fencingToken) return { ...cached, reused: true }
      this.runtimes.delete(context.userId)
    }
    const lease = await this.leaseStore.acquire(context.userId, owner, this.leaseTtlMs)
    if (!lease) {
      const existing = await this.leaseStore.get(context.userId)
      if (!existing) throw new DshPluginError('RUNTIME_UNAVAILABLE', 'No runtime lease is available')
      return { ...this.runtimes.get(context.userId), owner: existing.owner, fencingToken: existing.fencingToken, reused: true }
    }
    const runtime = await this.runtimeFactory({ userId: context.userId, fencingToken: lease.fencingToken })
    const value = { ...runtime, userId: context.userId, owner, fencingToken: lease.fencingToken, state: 'RUNNING' }
    this.runtimes.set(context.userId, value)
    return value
  }

  async assertFence(userId, fencingToken) {
    const current = await this.leaseStore.get(userId)
    if (!current || current.fencingToken !== fencingToken) throw new ConflictError('Stale runtime fencing token')
    return true
  }

  async release(context) {
    const current = this.runtimes.get(context.userId)
    if (!current) return
    await this.leaseStore.release(context.userId, current.owner, current.fencingToken)
    current.state = 'STOPPED'
    this.runtimes.delete(context.userId)
  }
}

export function apply(ctx, config = {}) {
  return registerService(ctx, id, new RuntimeManager(config))
}


