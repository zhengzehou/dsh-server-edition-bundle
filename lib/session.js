import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export function parseCookies(header = '') {
  const result = {}
  for (const item of String(header).split(';')) {
    const index = item.indexOf('=')
    if (index < 1) continue
    result[item.slice(0, index).trim()] = decodeURIComponent(item.slice(index + 1).trim())
  }
  return result
}

function sign(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

export class SignedSessionCodec {
  constructor({ secret, ttlSeconds = 8 * 60 * 60, cookieName = 'dsh_session' } = {}) {
    this.secret = secret || randomBytes(32).toString('base64url')
    this.ephemeral = !secret
    this.ttlSeconds = ttlSeconds
    this.cookieName = cookieName
  }

  issue(claims = {}) {
    const now = Math.floor(Date.now() / 1000)
    const value = {
      userId: String(claims.userId || ''),
      displayName: claims.displayName ? String(claims.displayName) : undefined,
      roles: Array.isArray(claims.roles) ? claims.roles.map(String) : [],
      csrfToken: randomBytes(24).toString('base64url'),
      iat: now,
      exp: now + this.ttlSeconds,
    }
    const payload = Buffer.from(JSON.stringify(value)).toString('base64url')
    return `${payload}.${sign(this.secret, payload)}`
  }

  verify(token) {
    if (!token || typeof token !== 'string') return null
    const [payload, signature, extra] = token.split('.')
    if (!payload || !signature || extra) return null
    const expected = Buffer.from(sign(this.secret, payload))
    const actual = Buffer.from(signature)
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
    try {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
      if (!claims.userId || !claims.exp || claims.exp <= Math.floor(Date.now() / 1000)) return null
      return claims
    } catch {
      return null
    }
  }

  fromRequest(request) {
    return this.verify(parseCookies(request.headers.get('cookie'))[this.cookieName])
  }

  cookie(token, requestUrl, { clear = false } = {}) {
    const secure = new URL(requestUrl).protocol === 'https:' ? '; Secure' : ''
    const maxAge = clear ? 0 : this.ttlSeconds
    return `${this.cookieName}=${clear ? '' : encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
  }
}

export function safeReturnTo(value, fallback = '/') {
  const text = typeof value === 'string' ? value : ''
  return text.startsWith('/') && !text.startsWith('//') && !text.includes('\\') ? text : fallback
}
