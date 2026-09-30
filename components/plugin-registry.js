import { AccessDeniedError, SecurityDeniedError } from '../lib/errors.js'
import { requireRole } from '../lib/tenant.js'
import { registerService } from '../lib/register.js'

export const id = 'dsh-plugin-registry'

export class PluginRegistryPolicy {
  constructor({ allowUnsigned = false, allowedIds = [] } = {}) {
    this.allowUnsigned = allowUnsigned
    this.allowedIds = new Set(allowedIds.map(String))
  }

  validateManifest(context, manifest) {
    requireRole(context, 'admin')
    if (!manifest?.id || !manifest?.version || !manifest?.sha256) throw new SecurityDeniedError('Plugin manifest requires id, version and sha256')
    if (this.allowedIds.size && !this.allowedIds.has(manifest.id)) throw new SecurityDeniedError('Plugin is not allowlisted')
    if (!this.allowUnsigned && !manifest.signature) throw new SecurityDeniedError('Unsigned plugins are disabled')
    const denied = new Set(manifest.capabilities || [])
    for (const capability of ['server-filesystem', 'server-shell', 'child-process-unrestricted']) if (denied.has(capability)) throw new SecurityDeniedError(`Plugin capability ${capability} is denied`)
    return { id: manifest.id, version: manifest.version, sha256: manifest.sha256 }
  }

  assertUserConfig(context, pluginId) {
    if (!context?.userId || !pluginId) throw new AccessDeniedError()
    return { userId: context.userId, pluginId }
  }
}

export function apply(ctx, config = {}) {
  return registerService(ctx, id, new PluginRegistryPolicy(config))
}
