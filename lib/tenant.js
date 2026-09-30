import { TenantContextError, AccessDeniedError } from './errors.js'

export function createTenantContext(input = {}) {
  const userId = typeof input.userId === 'string' ? input.userId.trim() : ''
  if (!userId) throw new TenantContextError()
  return Object.freeze({
    userId,
    roles: Array.isArray(input.roles) ? [...new Set(input.roles.map(String))] : [],
    deviceId: input.deviceId ? String(input.deviceId) : undefined,
    sessionId: input.sessionId ? String(input.sessionId) : undefined,
    runtimeId: input.runtimeId ? String(input.runtimeId) : undefined,
    requestId: input.requestId ? String(input.requestId) : undefined
  })
}

export function requireRole(context, role) {
  if (!context || !Array.isArray(context.roles) || !context.roles.includes(role)) {
    throw new AccessDeniedError(`Role ${role} is required`)
  }
  return context
}

export function requireSameTenant(context, userId) {
  if (!context || context.userId !== userId) throw new AccessDeniedError('Cross-tenant access denied')
}

export function tenantKey(context, domain, recordId) {
  requireSameTenant(context, context.userId)
  return `${context.userId}:${domain}:${recordId}`
}
