import { LocalAgentOfflineError, SecurityDeniedError } from '../lib/errors.js'
import { IdempotencyLedger } from '../lib/idempotency.js'
import { registerService } from '../lib/register.js'

export const id = 'dsh-local-tool-provider'

function assertRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(relativePath) || relativePath.includes('..')) {
    throw new SecurityDeniedError('Only a workspace-relative path is allowed')
  }
  return relativePath
}

export class LocalToolProvider {
  #connections
  #workspaceRegistry
  #idempotency = new IdempotencyLedger()

  constructor({ connections, workspaceRegistry } = {}) {
    this.#connections = connections || new Map()
    this.#workspaceRegistry = workspaceRegistry
  }

  register(deviceId, connection) {
    this.#connections.set(deviceId, connection)
  }

  unregister(deviceId) {
    this.#connections.delete(deviceId)
  }

  async call(context, request) {
    const { deviceId, workspaceId, grantId, requestId, operation, relativePath, idempotencyKey } = request
    if (!deviceId || !workspaceId || !grantId || !requestId || !operation) throw new Error('deviceId, workspaceId, grantId, requestId and operation are required')
    if (this.#workspaceRegistry?.assertGrant) this.#workspaceRegistry.assertGrant(context, workspaceId, grantId, request.permission || 'read')
    if (relativePath !== undefined) assertRelativePath(relativePath)
    const connection = this.#connections.get(deviceId)
    if (!connection || connection.status === 'offline') throw new LocalAgentOfflineError()
    const execute = async () => connection.send({ ...request, userId: context.userId, deviceId, workspaceId, grantId, requestId })
    return idempotencyKey ? this.#idempotency.run({ userId: context.userId, operation, key: idempotencyKey, requestHash: JSON.stringify(request), action: execute }) : execute()
  }
}

export { assertRelativePath }

export function apply(ctx, config = {}) {
  return registerService(ctx, id, new LocalToolProvider(config))
}

