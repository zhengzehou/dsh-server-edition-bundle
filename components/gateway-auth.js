import { createTenantContext, requireRole } from '../lib/tenant.js'
import { TenantContextError } from '../lib/errors.js'
import { registerService } from '../lib/register.js'

export const id = 'dsh-gateway-auth'

export class GatewayAuthService {
  constructor({ issuer = undefined, audience = undefined } = {}) {
    this.issuer = issuer
    this.audience = audience
  }

  fromVerifiedClaims(claims, request = {}) {
    if (!claims || claims.verified !== true) throw new TenantContextError('Authentication claims must be verified by the Gateway')
    if (this.issuer && claims.iss !== this.issuer) throw new TenantContextError('Unexpected token issuer')
    if (this.audience && claims.aud !== this.audience) throw new TenantContextError('Unexpected token audience')
    return createTenantContext({
      userId: claims.sub || claims.userId,
      roles: claims.roles,
      deviceId: request.deviceId,
      sessionId: request.sessionId,
      requestId: request.requestId
    })
  }

  requireAdmin(context) {
    return requireRole(context, 'admin')
  }
}

export function apply(ctx, config = {}) {
  return registerService(ctx, id, new GatewayAuthService(config))
}
