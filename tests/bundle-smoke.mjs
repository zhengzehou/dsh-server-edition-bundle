import assert from 'node:assert/strict'
import { apply, createTenantContext } from '../lib/index.js'

const result = apply({})
assert.equal(Object.keys(result.services).length, 10)
const tenant = createTenantContext({ userId: 'bundle-user' })
const registry = result.services['dsh-device-workspace']
const device = registry.enroll(tenant)
const workspace = registry.createWorkspace(tenant, { permissions: ['read'] })
const provider = result.services['dsh-local-tool-provider']
provider.register(device.deviceId, { send: async () => ({ ok: true }) })
await assert.rejects(() => provider.call(tenant, {
  deviceId: device.deviceId,
  workspaceId: workspace.workspaceId,
  grantId: 'revoked-or-unknown',
  requestId: 'bundle-1',
  operation: 'readFile',
  relativePath: 'README.md',
}), (error) => error.code === 'SECURITY_DENIED')
console.log('bundle registration smoke passed')
