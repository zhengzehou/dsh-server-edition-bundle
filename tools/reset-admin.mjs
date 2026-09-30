#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { hashAdminPassword, normalizeAdminUsername, validateAdminPassword } from '../lib/local-admin.js'

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const configPath = resolve(option('--config') || join(dshHome, 'config', 'dsh-server-edition.json'))
const username = normalizeAdminUsername(option('--username') || process.env.DSH_ADMIN_USERNAME || 'admin')
const password = validateAdminPassword(process.env.DSH_ADMIN_PASSWORD)

let config = {}
try {
  config = JSON.parse(await readFile(configPath, 'utf8'))
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

const now = new Date().toISOString()
config.localAdmin = {
  schemaVersion: 1,
  username,
  passwordHash: await hashAdminPassword(password),
  createdAt: config.localAdmin?.createdAt || now,
  updatedAt: now,
}

await mkdir(dirname(configPath), { recursive: true })
const temporary = `${configPath}.${process.pid}.tmp`
await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
await rename(temporary, configPath)
console.log(`Local administrator password reset: ${username} (${configPath})`)
