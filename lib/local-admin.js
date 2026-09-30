import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { DshPluginError } from './errors.js'

const scryptAsync = promisify(scrypt)
const KEY_LENGTH = 32
const SCRYPT_OPTIONS = Object.freeze({ N: 16384, r: 8, p: 1 })

export function normalizeAdminUsername(value = 'admin') {
  const username = String(value || '').trim()
  if (!/^[A-Za-z0-9_.@-]{3,64}$/.test(username)) {
    throw new DshPluginError('INVALID_ADMIN_USERNAME', '管理员用户名须为 3-64 位字母、数字或 _.@-')
  }
  return username
}

export function validateAdminPassword(value) {
  const password = String(value || '')
  if (password.length < 12 || password.length > 256) {
    throw new DshPluginError('INVALID_ADMIN_PASSWORD', '管理员密码须为 12-256 个字符')
  }
  return password
}

export function generateAdminPassword() {
  return `Dsh-${randomBytes(18).toString('base64url')}`
}

export async function hashAdminPassword(value) {
  const password = validateAdminPassword(value)
  const salt = randomBytes(16)
  const derived = await scryptAsync(password, salt, KEY_LENGTH, SCRYPT_OPTIONS)
  return `scrypt$${SCRYPT_OPTIONS.N}$${SCRYPT_OPTIONS.r}$${SCRYPT_OPTIONS.p}$${salt.toString('base64url')}$${Buffer.from(derived).toString('base64url')}`
}

export async function verifyAdminPassword(value, encoded) {
  const parts = String(encoded || '').split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, saltText, expectedText] = parts
  const options = { N: Number(n), r: Number(r), p: Number(p) }
  if (options.N !== SCRYPT_OPTIONS.N || options.r !== SCRYPT_OPTIONS.r || options.p !== SCRYPT_OPTIONS.p) return false
  let salt
  let expected
  try {
    salt = Buffer.from(saltText, 'base64url')
    expected = Buffer.from(expectedText, 'base64url')
  } catch {
    return false
  }
  if (salt.length !== 16 || expected.length !== KEY_LENGTH) return false
  const derived = Buffer.from(await scryptAsync(String(value || ''), salt, KEY_LENGTH, options))
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}
