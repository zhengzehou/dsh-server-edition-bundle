import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { bundleRoot, parseArgs } from './preflight.mjs'

const args = parseArgs()
const statePath = resolve(String(args.state || resolve(bundleRoot, 'migration-journal.json')))
const domains = ['session/conversation', 'settings', 'user-model', 'plugin-config']

function stable(value) {
  if (Array.isArray(value)) return value.map(stable).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  return value
}

async function readRecords(path) {
  const raw = await readFile(resolve(String(path)), 'utf8')
  const parsed = JSON.parse(raw)
  return Array.isArray(parsed) ? parsed : parsed.records
}

if (args.verify) {
  if (!args.source || !args.target) throw new Error('--verify requires --source <json> and --target <json>')
  const [source, target] = await Promise.all([readRecords(args.source), readRecords(args.target)])
  const left = JSON.stringify(stable(source))
  const right = JSON.stringify(stable(target))
  if (left !== right) {
    console.error(JSON.stringify({ ok: false, code: 'MIGRATION_MISMATCH', sourceCount: source.length, targetCount: target.length }, null, 2))
    process.exitCode = 4
  } else {
    console.log(JSON.stringify({ ok: true, code: 'MIGRATION_MATCH', count: source.length }, null, 2))
  }
} else if (args.cutover || args.rollback) {
  if (!args.confirm) throw new Error(`${args.cutover ? '--cutover' : '--rollback'} requires --confirm`)
  let journal = {}
  try { journal = JSON.parse(await readFile(statePath, 'utf8')) } catch { /* first operation */ }
  const status = args.cutover ? 'cutover-complete' : 'rolled-back'
  const next = { ...journal, status, domains, updatedAt: new Date().toISOString(), sourcePreserved: true }
  await writeFile(statePath, JSON.stringify(next, null, 2) + '\n', 'utf8')
  console.log(JSON.stringify(next, null, 2))
} else {
  const plan = {
    status: 'planned',
    domains,
    steps: ['discover native files', 'import with userId and idempotencyKey', 'verify counts/hashes', 'admin cutover', 'export/rollback journal'],
    sourcePreserved: true,
    statePath,
  }
  console.log(JSON.stringify(plan, null, 2))
}
