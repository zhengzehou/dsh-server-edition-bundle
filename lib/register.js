const serviceRegistry = new WeakMap()

export function registerService(ctx, key, value) {
  if (!ctx || (typeof ctx !== 'object' && typeof ctx !== 'function')) return value
  let registry = serviceRegistry.get(ctx)
  if (!registry) {
    registry = {}
    serviceRegistry.set(ctx, registry)
  }
  registry[key] = value
  try {
    const provide = ctx.provide
    if (typeof provide === 'function') provide.call(ctx, key, value)
  } catch {
    // Cordis contexts reject undeclared properties; the local registry remains available.
  }
  return value
}

export function getRegisteredService(ctx, key) {
  return serviceRegistry.get(ctx)?.[key]
}
