import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const bundleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { plan: false, execute: false, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--plan') args.plan = true
    else if (token === '--execute') args.execute = true
    else if (token === '--json') args.json = true
    else if (token.startsWith('--')) {
      const key = token.slice(2)
      args[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
    }
  }
  if (!args.plan && !args.execute) args.plan = true
  return args
}

export async function readManifest() {
  const raw = await readFile(resolve(bundleRoot, 'bundle-manifest.json'), 'utf8')
  return JSON.parse(raw)
}

export function dependencyOrder(manifest) {
  const byId = new Map(manifest.components.map((component) => [component.id, component]))
  const visiting = new Set()
  const visited = new Set()
  const order = []
  const visit = (id) => {
    if (visited.has(id)) return
    if (visiting.has(id)) throw new Error(`Component dependency cycle at ${id}`)
    const component = byId.get(id)
    if (!component) throw new Error(`Unknown component dependency: ${id}`)
    visiting.add(id)
    for (const dependency of component.dependsOn ?? []) visit(dependency)
    visiting.delete(id)
    visited.add(id)
    order.push(component)
  }
  for (const component of manifest.components) visit(component.id)
  return order
}

async function assertEntryFiles(manifest) {
  for (const component of manifest.components) {
    await access(resolve(bundleRoot, component.entry), constants.R_OK)
  }
}

function parseCapabilities() {
  const value = process.env.DSH_CAPABILITIES_JSON
  if (!value) return null
  try { return JSON.parse(value) } catch { throw new Error('DSH_CAPABILITIES_JSON is not valid JSON') }
}

export async function runPreflight({ execute = false } = {}) {
  const checks = []
  const nodeMajor = Number(process.versions.node.split('.')[0])
  if (nodeMajor < 20) throw new Error(`Node.js 20+ is required; detected ${process.versions.node}`)
  checks.push(`node ${process.versions.node}`)

  const manifest = await readManifest()
  if (manifest.schemaVersion !== 1) throw new Error(`Unsupported bundle manifest schema: ${manifest.schemaVersion}`)
  if (manifest.securityDefaults?.failClosed !== true) throw new Error('Bundle must keep security.failClosed=true')
  if (manifest.securityDefaults?.projectFiles !== 'local-agent-only') throw new Error('projectFiles must remain local-agent-only')
  if (manifest.securityDefaults?.credentials !== 'reference-only') throw new Error('credentials must remain reference-only')
  checks.push(`manifest ${manifest.bundleId}@${manifest.version}`)
  await assertEntryFiles(manifest)
  const order = dependencyOrder(manifest)
  checks.push(`dependency graph ${order.length} components`)

  const capabilities = parseCapabilities()
  const required = manifest.dshCompatibility?.requiredCapabilities ?? []
  if (!capabilities) {
    checks.push('DSH capability probe pending (set DSH_CAPABILITIES_JSON for execute)')
    if (execute) throw new Error('DSH_CAPABILITIES_JSON is required for --execute')
  } else {
    const missing = required.filter((name) => capabilities[name] !== true)
    if (missing.length) throw new Error(`Target DSH is missing required capabilities: ${missing.join(', ')}`)
    checks.push(`DSH capabilities ${required.join(', ')}`)
  }
  return { manifest, order, checks }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs()
    const result = await runPreflight({ execute: args.execute })
    const output = {
      ok: true,
      mode: args.execute ? 'execute' : 'plan',
      checks: result.checks,
      installOrder: result.order.map((component) => component.id),
    }
    console.log(args.json ? JSON.stringify(output, null, 2) : [
      'DSH Server Edition bundle preflight: PASS',
      ...result.checks.map((check) => `- ${check}`),
      `- install order: ${output.installOrder.join(' -> ')}`,
    ].join('\n'))
  } catch (error) {
    console.error(`DSH Server Edition bundle preflight: FAIL: ${error.message}`)
    process.exitCode = 2
  }
}

