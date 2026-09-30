import assert from 'node:assert/strict'
import { MysqlPersistenceProvider, createTenantContext } from '../lib/index.js'

const calls = []
const pool = {
  async query(sql, params) {
    calls.push({ sql, params })
    if (sql.startsWith('SELECT *')) return [[]]
    return [{ affectedRows: 1 }]
  },
}

const provider = new MysqlPersistenceProvider({ pool, schema: 'dsh' })
const tenant = createTenantContext({ userId: 'mysql-user' })
assert.deepEqual(await provider.health(), { ok: true, provider: 'mysql', schema: 'dsh' })
assert.deepEqual(await provider.putSetting(tenant, { namespace: 'ui', settingKey: 'theme', value: { mode: 'dark' } }), {
  userId: 'mysql-user', namespace: 'ui', settingKey: 'theme', value: { mode: 'dark' }, version: 0,
})
assert.deepEqual(await provider.appendMessage(tenant, { conversationId: 'c1', seq: 0, role: 'user', content: { text: 'hi' }, requestId: 'r1' }), {
  userId: 'mysql-user', conversationId: 'c1', seq: 0,
})
assert.deepEqual(await provider.appendMessage(tenant, { conversationId: 'c1', seq: 0, role: 'user', content: { text: 'hi' }, requestId: 'r1' }), {
  userId: 'mysql-user', conversationId: 'c1', seq: 0,
})
assert.ok(calls.some(({ sql }) => sql.includes('dsh_user_setting')))
assert.equal(calls.filter(({ sql }) => sql.includes('dsh_message')).length, 1)
await assert.rejects(() => provider.getSetting({}, 'ui', 'theme'), (error) => error.code === 'TENANT_CONTEXT_REQUIRED')
console.log('mysql provider smoke passed')
