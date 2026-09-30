import { ConflictError, TenantContextError } from '../lib/errors.js'
import { createTenantContext, requireSameTenant } from '../lib/tenant.js'
import { registerService } from '../lib/register.js'

export const id = 'dsh-persistence-spi'

export function assertTenantRecord(context, record) {
  if (!context?.userId) throw new TenantContextError()
  if (!record || record.userId !== context.userId) throw new TenantContextError('Record is not owned by the trusted tenant context')
  return record
}

export class PersistenceProvider {
  constructor({ sessionStore, settingsStore, userModelStore, pluginConfigStore, health = async () => ({ ok: true }) } = {}) {
    this.sessionStore = sessionStore
    this.settingsStore = settingsStore
    this.userModelStore = userModelStore
    this.pluginConfigStore = pluginConfigStore
    this.health = health
  }

  tenant(input) { return createTenantContext(input) }

  assertOwner(context, record) {
    requireSameTenant(context, record.userId)
    return record
  }

  assertVersion(expected, actual) {
    if (expected !== actual) throw new ConflictError(`Expected version ${expected}, got ${actual}`)
  }
}

export function apply(ctx, config = {}) {
  return registerService(ctx, id, new PersistenceProvider(config))
}
