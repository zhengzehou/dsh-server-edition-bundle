const SECRET_KEY = /(password|passwd|secret|token|api[-_]?key|authorization|cookie|private[-_]?key|credential)/i

export function redact(value, depth = 0) {
  if (depth > 8) return '[MAX_DEPTH]'
  if (Array.isArray(value)) return value.map(item => redact(item, depth + 1))
  if (!value || typeof value !== 'object') return value
  const output = {}
  for (const [key, item] of Object.entries(value)) {
    output[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redact(item, depth + 1)
  }
  return output
}
