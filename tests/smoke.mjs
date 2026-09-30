import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AccessDeniedError,
  AuditOtelSink,
  DeviceWorkspaceRegistry,
  GatewayAuthService,
  IdempotencyLedger,
  InMemoryLeaseStore,
  LocalAgentOfflineError,
  LocalToolProvider,
  ModelPolicy,
  PluginRegistryPolicy,
  RESTRICTED_POLICY,
  RestrictedProfilePolicy,
  RuntimeManager,
  SecurityDeniedError,
  createTenantContext,
  apply,
} from '../lib/index.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const ctx = { provided: new Map(), provide(key, value) { this.provided.set(key, value) } }
const tenant = createTenantContext({ userId: 'user-1', roles: ['user'] })
assert.equal(tenant.userId, 'user-1')
assert.throws(() => createTenantContext({}), (error) => error.code === 'TENANT_CONTEXT_REQUIRED')

const gateway = new GatewayAuthService({ issuer: 'issuer', audience: 'aud' })
assert.equal(gateway.fromVerifiedClaims({ verified: true, sub: 'u2', iss: 'issuer', aud: 'aud' }).userId, 'u2')
assert.throws(() => gateway.fromVerifiedClaims({ verified: false, sub: 'u2' }), (error) => error.code === 'TENANT_CONTEXT_REQUIRED')

const registry = new DeviceWorkspaceRegistry()
const device = registry.enroll(tenant, { name: 'device-1', platform: 'test' })
const workspace = registry.createWorkspace(tenant, { displayName: 'main', permissions: ['read'] })
const grant = registry.assertGrant(tenant, workspace.workspaceId, workspace.grantId, 'read')
assert.equal(grant.userId, tenant.userId)

const restricted = new RestrictedProfilePolicy()
assert.throws(() => restricted.assertServerCapability('shell'), SecurityDeniedError)
assert.equal(RESTRICTED_POLICY.serverShell, 'deny')

const provider = new LocalToolProvider({ connections: new Map([[device.deviceId, { send: async (request) => ({ ok: true, request }) }]]) })
const response = await provider.call(tenant, { deviceId: device.deviceId, workspaceId: workspace.workspaceId, grantId: workspace.grantId, operation: 'readFile', relativePath: 'src/index.js', requestId: 'req-1' })
assert.equal(response.ok, true)
await assert.rejects(() => provider.call(tenant, { deviceId: device.deviceId, workspaceId: workspace.workspaceId, grantId: workspace.grantId, operation: 'readFile', relativePath: '../secret', requestId: 'req-2' }), (error) => error.code === 'SECURITY_DENIED')
provider.unregister(device.deviceId)
await assert.rejects(() => provider.call(tenant, { deviceId: device.deviceId, workspaceId: workspace.workspaceId, grantId: workspace.grantId, operation: 'readFile', relativePath: 'a', requestId: 'req-3' }), LocalAgentOfflineError)

const runtime = new RuntimeManager({ leaseStore: new InMemoryLeaseStore(), runtimeFactory: async ({ userId }) => ({ runtimeId: `rt-${userId}` }) })
const lease = await runtime.ensureRuntime({ ...tenant, runtimeId: 'node-a' })
assert.equal(await runtime.assertFence(tenant.userId, lease.fencingToken), true)
await assert.rejects(() => runtime.assertFence(tenant.userId, 'stale'), (error) => error.code === 'CONFLICT')

const modelPolicy = new ModelPolicy({ allowedHosts: ['models.example.com'] })
assert.equal(modelPolicy.validateModel(tenant, { provider: 'company', modelId: 'm1', endpoint: 'https://models.example.com/v1', credentialRef: 'cred-1' }).modelId, 'm1')
assert.throws(() => modelPolicy.validateModel(tenant, { provider: 'company', modelId: 'm1', endpoint: 'http://models.example.com/v1', credentialRef: 'cred-1' }), (error) => error.code === 'SECURITY_DENIED')

const pluginRegistry = new PluginRegistryPolicy()
assert.throws(() => pluginRegistry.validateManifest(tenant, { id: 'x', version: '1.0.0', sha256: 'x' }), AccessDeniedError)
assert.throws(() => pluginRegistry.validateManifest({ ...tenant, roles: ['admin'] }, { id: 'x', version: '1.0.0', sha256: 'x', signature: 's', capabilities: ['server-shell'] }), (error) => error.code === 'SECURITY_DENIED')

let auditEvent
const audit = new AuditOtelSink({ sink: (event) => { auditEvent = event } })
audit.emit({ userId: tenant.userId, token: 'secret', operation: 'test' })
assert.equal(auditEvent.token, '[REDACTED]')

const ledger = new IdempotencyLedger()
assert.equal(await ledger.run({ userId: tenant.userId, operation: 'test', key: 'k1', requestHash: 'h1', action: async () => 42 }), 42)
assert.equal(await ledger.run({ userId: tenant.userId, operation: 'test', key: 'k1', requestHash: 'h1', action: async () => 99 }), 42)
await assert.rejects(() => ledger.run({ userId: tenant.userId, operation: 'test', key: 'k1', requestHash: 'h2', action: async () => 1 }), (error) => error.code === 'IDEMPOTENCY_KEY_REUSED')

const applied = apply(ctx)
assert.equal(applied.id, 'dsh-server-edition-bundle')
const manifest = JSON.parse(await readFile(resolve(root, 'bundle-manifest.json'), 'utf8'))
assert.equal(manifest.securityDefaults.projectFiles, 'local-agent-only')
assert.ok(manifest.components.some((component) => component.id === 'dsh-persistence-mysql'))
assert.match((await readFile(resolve(root, 'components/persistence-mysql.js'), 'utf8')), /user_id/)
console.log(`smoke tests passed (${manifest.components.length} components)`)




