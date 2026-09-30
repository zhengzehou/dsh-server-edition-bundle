import { redact } from '../lib/redact.js'
import { registerService } from '../lib/register.js'

export const id = 'dsh-audit-otel'

export class AuditOtelSink {
  constructor({ sink = undefined, serviceName = 'dsh-server-edition' } = {}) {
    this.sink = sink || (() => {})
    this.serviceName = serviceName
  }

  emit(event) {
    const record = {
      serviceName: this.serviceName,
      timestamp: new Date().toISOString(),
      ...redact(event)
    }
    this.sink(record)
    return record
  }
}

export function apply(ctx, config = {}) {
  return registerService(ctx, id, new AuditOtelSink(config))
}
