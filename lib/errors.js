export class DshPluginError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'DshPluginError'
    this.code = code
    this.details = details
  }
}

export class TenantContextError extends DshPluginError {
  constructor(message = 'A trusted userId is required') {
    super('TENANT_CONTEXT_REQUIRED', message)
  }
}

export class AccessDeniedError extends DshPluginError {
  constructor(message = 'Access denied') {
    super('ACCESS_DENIED', message)
  }
}

export class ConflictError extends DshPluginError {
  constructor(message = 'Optimistic concurrency conflict') {
    super('CONFLICT', message)
  }
}

export class IdempotencyConflictError extends DshPluginError {
  constructor(message = 'Idempotency key was reused with a different request') {
    super('IDEMPOTENCY_KEY_REUSED', message)
  }
}

export class LocalAgentOfflineError extends DshPluginError {
  constructor(message = 'Local Agent is offline') {
    super('LOCAL_AGENT_OFFLINE', message)
  }
}

export class SecurityDeniedError extends DshPluginError {
  constructor(message = 'Security policy denied the operation') {
    super('SECURITY_DENIED', message)
  }
}
