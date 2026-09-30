import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnFile } from './process.mjs'
import { bundleRoot, parseArgs, runPreflight } from './preflight.mjs'

const args = parseArgs()

try {
  const result = await runPreflight({ execute: args.execute })
  const profile = String(args.profile || 'web')
  const packageName = result.manifest.packageName || '@dsh-server-edition/plugin-bundle'
  const plan = [
    `profile: ${profile}`,
    `package: ${packageName}`,
    `install order: ${result.order.map((component) => component.id).join(' -> ')}`,
    'command: dsh plugin --profile <profile> add <bundle-root>',
    'data policy: keep existing MySQL data on uninstall unless an approved purge job is run',
  ]
  if (!args.execute) {
    console.log(['DSH Server Edition bundle install plan', ...plan.map((line) => `- ${line}`)].join('\n'))
    process.exit(0)
  }

  await spawnFile('dsh', ['plugin', '--profile', profile, 'add', bundleRoot], { cwd: bundleRoot, stdio: 'inherit' })
  await writeFile(resolve(bundleRoot, 'install-state.json'), JSON.stringify({
    bundleId: result.manifest.bundleId,
    version: result.manifest.version,
    packageName,
    profile,
    installedAt: new Date().toISOString(),
    dataPolicy: 'keep-by-default',
  }, null, 2) + '\n', 'utf8')
  console.log(`Installed ${packageName} into profile ${profile}`)
} catch (error) {
  console.error(`Install failed: ${error.message}`)
  process.exitCode = 2
}
