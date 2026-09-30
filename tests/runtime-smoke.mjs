import assert from 'node:assert/strict'
import { InMemoryLeaseStore, RuntimeManager, createTenantContext } from '../lib/index.js'

let factoryCalls = 0
const manager = new RuntimeManager({
  leaseStore: new InMemoryLeaseStore(),
  runtimeFactory: async ({ userId }) => ({ runtimeId: `runtime-${userId}`, factoryCalls: ++factoryCalls }),
})
const context = { ...createTenantContext({ userId: 'runtime-user' }), runtimeId: 'node-a' }
const first = await manager.ensureRuntime(context)
const second = await manager.ensureRuntime(context)
assert.equal(first.fencingToken, second.fencingToken)
assert.equal(second.reused, true)
assert.equal(factoryCalls, 1)
console.log('runtime re-entry smoke passed')
