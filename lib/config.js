import { DshPluginError } from './errors.js'

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

export class MemoryConfigStore {
  #values = new Map()

  constructor(initial = {}) {
    for (const [key, value] of Object.entries(initial)) this.#values.set(key, clone(value))
  }

  async get(section) {
    return clone(this.#values.get(section))
  }

  async set(section, value) {
    this.#values.set(section, clone(value))
    return clone(value)
  }
}

export function assertConfigStore(store) {
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
    throw new DshPluginError('CONFIG_STORE_REQUIRED', 'A config store with get() and set() is required')
  }
  return store
}

export function integer(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) return fallback
  return number
}

export function boolean(value, fallback = false) {
  if (value === true || value === 'true' || value === 1 || value === '1') return true
  if (value === false || value === 'false' || value === 0 || value === '0') return false
  return fallback
}

export function requireSecretReference(value, fieldName) {
  if (!value) return ''
  const text = String(value).trim()
  if (!/^(secret|env):\/\/[A-Za-z0-9_.:/-]+$/.test(text)) {
    throw new DshPluginError('SECRET_REFERENCE_REQUIRED', `${fieldName} must use secret://NAME or env://NAME; plaintext secrets are not accepted`)
  }
  return text
}

export async function resolveSecretReference(reference, resolver) {
  if (!reference) return undefined
  if (reference.startsWith('env://')) {
    const name = reference.slice('env://'.length)
    const value = process.env[name]
    if (!value) throw new DshPluginError('SECRET_NOT_FOUND', `Environment secret ${name} is not available`)
    return value
  }
  if (typeof resolver !== 'function') throw new DshPluginError('SECRET_RESOLVER_REQUIRED', 'A secret resolver is required for secret:// references')
  const value = await resolver(reference.slice('secret://'.length))
  if (!value) throw new DshPluginError('SECRET_NOT_FOUND', 'The referenced secret is not available')
  return value
}
