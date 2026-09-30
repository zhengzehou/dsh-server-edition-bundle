import { AccessDeniedError, SecurityDeniedError } from '../lib/errors.js'
import { registerService } from '../lib/register.js'

export const id = 'dsh-device-workspace'

function opaqueId(prefix, counter) {
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`
}

export class DeviceWorkspaceRegistry {
  #devices = new Map()
  #workspaces = new Map()
  #grants = new Map()
  #counter = 0

  enroll(context, { name = 'Local Agent', platform = 'unknown', agentVersion = 'unknown' } = {}) {
    const deviceId = opaqueId('dev', ++this.#counter)
    this.#devices.set(deviceId, { deviceId, userId: context.userId, name, platform, agentVersion, status: 'active', lastSeen: Date.now() })
    return { deviceId }
  }

  revoke(context, deviceId) {
    const device = this.#devices.get(deviceId)
    if (!device || device.userId !== context.userId) throw new AccessDeniedError('Device does not belong to user')
    device.status = 'revoked'
    return { deviceId, status: device.status }
  }

  createWorkspace(context, { displayName = 'Workspace', permissions = ['read'] } = {}) {
    const workspaceId = opaqueId('ws', ++this.#counter)
    this.#workspaces.set(workspaceId, { workspaceId, userId: context.userId, displayName, status: 'active' })
    const grantId = opaqueId('grant', ++this.#counter)
    this.#grants.set(grantId, { grantId, workspaceId, userId: context.userId, permissions: [...new Set(permissions)], status: 'active' })
    return { workspaceId, grantId }
  }

  assertGrant(context, workspaceId, grantId, permission = 'read') {
    const grant = this.#grants.get(grantId)
    if (!grant || grant.userId !== context.userId || grant.workspaceId !== workspaceId || grant.status !== 'active') {
      throw new SecurityDeniedError('Workspace grant is invalid or revoked')
    }
    if (!grant.permissions.includes(permission)) throw new SecurityDeniedError(`Permission ${permission} is not granted`)
    return grant
  }

  revokeGrant(context, grantId) {
    const grant = this.#grants.get(grantId)
    if (!grant || grant.userId !== context.userId) throw new AccessDeniedError('Grant does not belong to user')
    grant.status = 'revoked'
    return { grantId, status: grant.status }
  }
}

export function apply(ctx) {
  return registerService(ctx, id, new DeviceWorkspaceRegistry())
}
