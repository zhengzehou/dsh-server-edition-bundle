import assert from 'node:assert/strict'
import {
  ControlPlaneWebService,
  GatewayAuthService,
  MemoryConfigStore,
  parseCookies,
} from '../lib/index.js'

const initialAdminPassword = 'initial-admin-password'
const store = new MemoryConfigStore({
  auth: {
    enabled: true,
    loginApiUrl: 'http://127.0.0.1:19081/login',
    method: 'POST',
    requestEncoding: 'json',
    usernameField: 'account',
    passwordField: 'password',
    headers: { 'X-Client': 'dsh-test' },
    successPath: 'ok',
    successValue: 'true',
    userIdPath: 'result.id',
    displayNamePath: 'result.name',
    rolesPath: 'result.roles',
    messagePath: 'message',
  },
})

let upstreamRequest
const fetchImpl = async (url, init) => {
  upstreamRequest = { url: String(url), init, body: JSON.parse(init.body) }
  return new Response(JSON.stringify({ ok: true, result: { id: 'admin-1', name: '管理员', roles: ['admin'], token: 'not-put-in-browser-cookie' } }), {
    headers: { 'content-type': 'application/json' },
  })
}

const applied = []
const web = new ControlPlaneWebService({
  authService: new GatewayAuthService(),
  configStore: store,
  initialAdmin: { username: 'admin', password: initialAdminPassword },
  sessionSecret: 'test-session-secret-with-at-least-32-characters',
  fetchImpl,
  connectors: {
    mysql: {
      async apply(config) { applied.push(config) },
      async test() { return { ok: true, provider: 'mysql' } },
    },
    redis: { async test() { return { ok: true, provider: 'redis' } } },
  },
})
await web.ready

const storedAdmin = await store.get('localAdmin')
assert.equal(storedAdmin.username, 'admin')
assert.match(storedAdmin.passwordHash, /^scrypt\$/)
assert.ok(!JSON.stringify(storedAdmin).includes(initialAdminPassword))

const protectedResponse = await web.handle(new Request('http://127.0.0.1:19080/dsh'))
assert.equal(protectedResponse.status, 302)
assert.match(protectedResponse.headers.get('location'), /^\/dsh-auth\/login/)

async function login(username, password, returnTo = '/dsh') {
  const page = await web.handle(new Request(`http://127.0.0.1:19080/dsh-auth/login?returnTo=${encodeURIComponent(returnTo)}`))
  const html = await page.text()
  const csrf = html.match(/name="csrf" value="([^"]+)"/)[1]
  const csrfCookie = page.headers.get('set-cookie').split(';')[0]
  const response = await web.handle(new Request('http://127.0.0.1:19080/dsh-auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: csrfCookie },
    body: new URLSearchParams({ username, password, csrf, returnTo }),
  }))
  return response
}

const localLogin = await login('admin', initialAdminPassword)
assert.equal(localLogin.status, 303)
const localSessionCookie = localLogin.headers.get('set-cookie').split(';')[0]
const localClaims = web.session.verify(parseCookies(localSessionCookie).dsh_session)
assert.equal(localClaims.userId, 'local-admin:admin')
assert.deepEqual(localClaims.roles, ['admin'])

const authPage = await web.handle(new Request('http://127.0.0.1:19080/dsh-admin/settings/auth', { headers: { cookie: localSessionCookie } }))
assert.equal(authPage.status, 200)
const authHtml = await authPage.text()
assert.match(authHtml, /本地管理员账号/)
assert.match(authHtml, /返回 DSH/)

const nextPassword = 'updated-admin-password'
const passwordResponse = await web.handle(new Request('http://127.0.0.1:19080/dsh-admin/api/local-admin/password', {
  method: 'POST',
  headers: { cookie: localSessionCookie, 'content-type': 'application/json', 'x-csrf-token': localClaims.csrfToken },
  body: JSON.stringify({ currentPassword: initialAdminPassword, newPassword: nextPassword }),
}))
assert.equal(passwordResponse.status, 200)
assert.equal((await login('admin', initialAdminPassword)).status, 401)
assert.equal((await login('admin', nextPassword)).status, 303)

const loginResponse = await login('alice', 'correct')
assert.equal(loginResponse.status, 303)
assert.deepEqual(upstreamRequest.body, { account: 'alice', password: 'correct' })
const sessionCookie = loginResponse.headers.get('set-cookie').split(';')[0]
assert.ok(!sessionCookie.includes('not-put-in-browser-cookie'))
assert.equal(web.session.verify(parseCookies(sessionCookie).dsh_session).upstreamToken, undefined)

const appResponse = await web.handle(new Request('http://127.0.0.1:19080/dsh', { headers: { cookie: sessionCookie } }), (_request, context) => Response.json({ userId: context.userId }))
assert.deepEqual(await appResponse.json(), { userId: 'admin-1' })

const sessionClaims = web.session.verify(parseCookies(sessionCookie).dsh_session)
const mysqlConfig = {
  enabled: true,
  host: '127.0.0.1',
  port: 3306,
  database: 'dsh',
  username: 'dsh_runtime',
  passwordSecretRef: 'env://DSH_MYSQL_PASSWORD',
  tlsMode: 'required',
  connectionLimit: 8,
  connectTimeoutMs: 3000,
}
const saveResponse = await web.handle(new Request('http://127.0.0.1:19080/dsh-admin/api/settings/mysql', {
  method: 'PUT',
  headers: { cookie: sessionCookie, 'content-type': 'application/json', 'x-csrf-token': sessionClaims.csrfToken },
  body: JSON.stringify({ config: mysqlConfig }),
}))
assert.equal(saveResponse.status, 200)
assert.equal(applied.length, 1)
assert.equal((await store.get('mysql')).passwordSecretRef, 'env://DSH_MYSQL_PASSWORD')

console.log('control plane local-admin/login/config smoke passed')
