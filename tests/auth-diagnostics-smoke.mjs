import assert from 'node:assert/strict'
import { attachAuthResponseDiagnostic, buildAuthRequestDiagnostic } from '../lib/auth-diagnostics.js'

const url = new URL('https://login.example.test/api?tenant=demo')
url.searchParams.set('accountName', 'alice')
url.searchParams.set('accountPassword', 'real-password')
const diagnostic = buildAuthRequestDiagnostic(url, {
  method: 'GET',
  headers: { Authorization: 'Bearer secret-token', Accept: 'application/json' },
}, 'accountPassword')
attachAuthResponseDiagnostic(diagnostic, new Response('{}', {
  status: 401,
  headers: { 'content-type': 'application/json', 'set-cookie': 'sid=secret' },
}), { code: 1, data: { token: 'response-token' }, message: 'denied' })

const serialized = JSON.stringify(diagnostic.trace)
assert.equal(diagnostic.trace.request.method, 'GET')
assert.match(diagnostic.trace.request.url, /accountName=alice/)
assert.match(diagnostic.trace.request.url, /accountPassword=\*\*\*\*\*\*/)
assert.equal(diagnostic.trace.request.headers.Authorization, '******')
assert.equal(diagnostic.trace.response.status, 401)
assert.equal(diagnostic.trace.response.body.data.token, '******')
assert.equal(diagnostic.trace.response.headers['set-cookie'], '******')
for (const secret of ['real-password', 'secret-token', 'response-token', 'sid=secret']) assert.ok(!serialized.includes(secret))

console.log('auth diagnostics redaction smoke passed')
