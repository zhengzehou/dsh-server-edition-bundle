import assert from 'node:assert/strict'
import { LoginApiClient } from '../components/control-plane-web.js'

let executed
const client = new LoginApiClient({
  fetchImpl: async (url, init) => {
    executed = { url: url.toString(), init }
    return new Response(JSON.stringify({ code: 1, message: 'denied', data: { token: 'response-secret' } }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'set-cookie': 'sid=response-cookie' },
    })
  },
})

const config = {
  enabled: true,
  loginApiUrl: 'https://login.example.test/api',
  method: 'GET',
  requestEncoding: 'form',
  usernameField: 'accountName',
  passwordField: 'accountPassword',
  headers: { Authorization: 'Bearer {{password}}', Accept: 'application/json' },
  staticFields: { tenant: 'demo' },
  successPath: 'code',
  successValue: '0',
  userIdPath: 'data.userId',
  displayNamePath: 'data.displayName',
  rolesPath: 'data.roles',
  messagePath: 'message',
}

let failure
try {
  await client.authenticate(config, { username: 'alice', password: 'real-password' })
} catch (error) {
  failure = error
}

assert.ok(failure)
assert.equal(failure.code, 'AUTHENTICATION_FAILED')
assert.match(executed.url, /accountName=alice/)
assert.match(executed.url, /accountPassword=real-password/)
assert.equal(executed.init.method, 'GET')
assert.equal(executed.init.headers.Authorization, 'Bearer real-password')
assert.equal(failure.details.trace.request.method, 'GET')
assert.match(failure.details.trace.request.url, /accountPassword=\*\*\*\*\*\*/)
assert.equal(failure.details.trace.request.headers.Authorization, '******')
assert.equal(failure.details.trace.response.status, 401)
assert.equal(failure.details.trace.response.body.data.token, '******')
assert.equal(failure.details.trace.response.headers['set-cookie'], '******')

const safeTrace = JSON.stringify(failure.details.trace)
for (const secret of ['real-password', 'response-secret', 'sid=response-cookie']) assert.ok(!safeTrace.includes(secret))

console.log('login API diagnostics smoke passed')
