import { SecurityDeniedError } from '../lib/errors.js'
import { registerService } from '../lib/register.js'

export const id = 'dsh-restricted-profile'

export const RESTRICTED_POLICY = Object.freeze({
  serverFilesystem: 'deny',
  serverShell: 'deny',
  serverTerminal: 'deny',
  workspaceFiles: 'deny',
  localAgentOfflineFallback: 'deny',
  allowedProviders: ['local-tool-provider'],
  projectDataPlane: 'local-agent'
})

export class RestrictedProfilePolicy {
  constructor(policy = RESTRICTED_POLICY) {
    this.policy = Object.freeze({ ...RESTRICTED_POLICY, ...policy })
  }

  assertServerCapability(capability) {
    const denied = new Set(['fs', 'filesystem', 'shell', 'exec', 'pty', 'terminal', 'workspace-files'])
    if (denied.has(String(capability).toLowerCase())) throw new SecurityDeniedError(`Server capability ${capability} is disabled`)
    return true
  }

  assertLocalAgentOnline(online) {
    if (!online) throw new SecurityDeniedError('LOCAL_AGENT_OFFLINE: server fallback is disabled')
  }
}

export function apply(ctx, config = {}) {
  return registerService(ctx, id, new RestrictedProfilePolicy(config))
}
