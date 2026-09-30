import { SecurityDeniedError } from '../lib/errors.js'
import { registerService } from '../lib/register.js'

export const id = 'dsh-model-policy'

export class ModelPolicy {
  constructor({ allowedHosts = [], allowHttp = false } = {}) {
    this.allowedHosts = new Set(allowedHosts.map(String))
    this.allowHttp = allowHttp
  }

  validateEndpoint(endpoint) {
    let url
    try { url = new URL(endpoint) } catch { throw new SecurityDeniedError('Model endpoint must be a valid URL') }
    if (!this.allowHttp && url.protocol !== 'https:') throw new SecurityDeniedError('Model endpoint must use HTTPS')
    if (this.allowedHosts.size && !this.allowedHosts.has(url.hostname)) throw new SecurityDeniedError('Model endpoint host is not allowlisted')
    if (url.username || url.password) throw new SecurityDeniedError('Credentials must not be embedded in the endpoint URL')
    return url.toString()
  }

  validateModel(context, model) {
    if (!model || !model.modelId || !model.provider || !model.credentialRef) throw new SecurityDeniedError('Model requires modelId, provider and credentialRef')
    return { userId: context.userId, modelId: String(model.modelId), provider: String(model.provider), endpoint: this.validateEndpoint(model.endpoint), credentialRef: String(model.credentialRef) }
  }
}

export function apply(ctx, config = {}) {
  return registerService(ctx, id, new ModelPolicy(config))
}
