const SENSITIVE_KEY = /(?:password|passwd|pwd|token|secret|authorization|cookie|api[-_]?key)/i

export function redactDiagnosticValue(value, sensitiveNames = new Set(), depth = 0) {
  if (depth > 8) return '[depth limit]'
  if (typeof value === 'string') return value.length > 4096 ? `${value.slice(0, 4096)}…[truncated]` : value
  if (Array.isArray(value)) return value.map((item) => redactDiagnosticValue(item, sensitiveNames, depth + 1))
  if (!value || typeof value !== 'object') return value
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key) || sensitiveNames.has(key.toLowerCase())
      ? '******'
      : redactDiagnosticValue(item, sensitiveNames, depth + 1)
  }
  return result
}

export function buildAuthRequestDiagnostic(url, init, passwordField) {
  const sensitiveNames = new Set([String(passwordField || '').toLowerCase()].filter(Boolean))
  const safeUrl = new URL(url)
  for (const key of [...safeUrl.searchParams.keys()]) {
    if (SENSITIVE_KEY.test(key) || sensitiveNames.has(key.toLowerCase())) safeUrl.searchParams.set(key, '******')
  }
  let body = null
  if (init.body instanceof URLSearchParams) body = redactDiagnosticValue(Object.fromEntries(init.body.entries()), sensitiveNames)
  else if (typeof init.body === 'string') {
    try { body = redactDiagnosticValue(JSON.parse(init.body), sensitiveNames) } catch { body = '[non-JSON request body]' }
  }
  return {
    trace: {
      request: {
        method: init.method,
        url: safeUrl.toString(),
        headers: redactDiagnosticValue(init.headers || {}, sensitiveNames),
        body,
      },
      response: null,
    },
    sensitiveNames,
  }
}

export function attachAuthResponseDiagnostic(diagnostic, response, result) {
  diagnostic.trace.response = {
    status: response.status,
    statusText: response.statusText,
    headers: redactDiagnosticValue(Object.fromEntries(response.headers.entries()), diagnostic.sensitiveNames),
    body: redactDiagnosticValue(result, diagnostic.sensitiveNames),
  }
  return diagnostic.trace
}

export function attachNonJsonResponseDiagnostic(diagnostic, response) {
  diagnostic.trace.response = {
    status: response.status,
    statusText: response.statusText,
    headers: redactDiagnosticValue(Object.fromEntries(response.headers.entries()), diagnostic.sensitiveNames),
    body: '[non-JSON response]',
  }
  return diagnostic.trace
}
