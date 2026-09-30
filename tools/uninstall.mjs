import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnFile } from './process.mjs'
import { bundleRoot, parseArgs, readManifest } from './preflight.mjs'

const args = parseArgs()
const profile = String(args.profile || 'web')
const manifest = await readManifest()
const packageName = manifest.packageName || '@dsh-server-edition/plugin-bundle'

if (args['purge-data'] && !args.confirm) {
  console.error('Refusing purge-data without --confirm. Data deletion is a separate reviewed operation.')
  process.exitCode = 3
} else if (args['purge-data']) {
  console.error('Purge-data is intentionally not automated by this bundle; review the MySQL deletion runbook and execute it separately.')
  process.exitCode = 3
} else if (!args.execute) {
  console.log([
    'DSH Server Edition bundle uninstall plan',
    `- profile: ${profile}`,
    `- command: dsh plugin --profile ${profile} remove ${packageName}`,
    '- order: drain -> disable -> remove -> preserve MySQL data',
    '- use --execute to perform the removal',
  ].join('\n'))
} else {
  try {
    await spawnFile('dsh', ['plugin', '--profile', profile, 'remove', packageName], { cwd: bundleRoot, stdio: 'inherit' })
    let state = {}
    try { state = JSON.parse(await readFile(resolve(bundleRoot, 'install-state.json'), 'utf8')) } catch { /* state is optional */ }
    await writeFile(resolve(bundleRoot, 'install-state.json'), JSON.stringify({
      ...state,
      status: 'uninstalled',
      uninstalledAt: new Date().toISOString(),
      dataPolicy: 'preserved',
    }, null, 2) + '\n', 'utf8')
    console.log(`Uninstalled ${packageName} from profile ${profile}; MySQL data preserved`)
  } catch (error) {
    console.error(`Uninstall failed: ${error.message}`)
    process.exitCode = 2
  }
}
