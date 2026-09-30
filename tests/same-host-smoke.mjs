import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  ControlPlaneWebService,
  DeviceWorkspaceRegistry,
  GatewayAuthService,
  LocalToolProvider,
  MemoryConfigStore,
  createTenantContext,
} from '../lib/index.js'

const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-same-host-'))
try {
  await writeFile(join(workspaceRoot, 'hello.txt'), 'local-agent-ok', 'utf8')
  const context = createTenantContext({ userId: 'same-host-user', roles: ['admin'] })
  const registry = new DeviceWorkspaceRegistry()
  const device = registry.enroll(context, { name: 'same-machine-agent', platform: process.platform })
  const workspace = registry.createWorkspace(context, { displayName: 'same-host-workspace', permissions: ['read', 'write', 'shell'] })
  const provider = new LocalToolProvider({ workspaceRegistry: registry })
  provider.register(device.deviceId, {
    status: 'online',
    async send(request) {
      const target = resolve(workspaceRoot, request.relativePath || '.')
      if (!target.startsWith(resolve(workspaceRoot))) throw new Error('workspace escape')
      if (request.operation === 'readFile') return { content: await readFile(target, 'utf8'), executedOn: 'local-agent' }
      return { ok: true, executedOn: 'local-agent' }
    },
  })
  const result = await provider.call(context, {
    deviceId: device.deviceId,
    workspaceId: workspace.workspaceId,
    grantId: workspace.grantId,
    requestId: 'same-host-1',
    operation: 'readFile',
    relativePath: 'hello.txt',
  })
  assert.deepEqual(result, { content: 'local-agent-ok', executedOn: 'local-agent' })

  const web = new ControlPlaneWebService({
    authService: new GatewayAuthService(),
    configStore: new MemoryConfigStore(),
    sessionSecret: 'same-host-test-secret-with-at-least-32-chars',
  })
  const response = await web.handle(new Request('http://127.0.0.1:19080/dsh'))
  assert.equal(response.status, 302)
  assert.match(response.headers.get('location'), /dsh-auth\/login/)
  console.log('same-host service/local-agent smoke passed')
} finally {
  await rm(workspaceRoot, { recursive: true, force: true })
}
