import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { apply, MemoryConfigStore } from '../lib/index.js'

const routes = new Map()
const taps = []
const ctx = {
  webServer: {
    fallback(_request, response) { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<html><head></head><body>DSH</body></html>') },
    register(route) { routes.set(route.path, route); return () => routes.delete(route.path) },
    tapIndex(tap) { taps.push(tap); return () => taps.splice(taps.indexOf(tap), 1) },
  },
  connection: { authenticatedUrl(baseUrl) { return `${baseUrl}?token=native-test-token` } },
  effect(factory) { return factory() },
}
const bundle = apply(ctx, {
  configStore: new MemoryConfigStore(),
  initialAdmin: { username: 'admin', password: 'adapter-admin-password' },
  sessionSecret: 'adapter-test-secret-with-at-least-32-characters',
})
await bundle.web.ready
assert.equal(bundle.webMounted, true)
assert.ok(routes.has('/dsh-auth'))
assert.ok(routes.has('/dsh-admin'))
assert.ok(routes.has('/'))
assert.equal(taps.length, 1)

function request(path, { method = 'GET', headers = {}, body = '' } = {}) {
  const stream = Readable.from(body ? [Buffer.from(body)] : [])
  stream.method = method
  stream.url = path
  stream.headers = { host: '127.0.0.1:19080', ...headers }
  stream.socket = { remoteAddress: '127.0.0.1' }
  return stream
}

function response() {
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })
  return {
    status: 0,
    headers: {},
    chunks: [],
    writeHead(status, headers = {}) { this.status = status; this.headers = headers },
    end(chunk) { if (chunk) this.chunks.push(Buffer.from(chunk)); resolveDone() },
    done,
  }
}

const guardedResponse = response()
await routes.get('/').handler(request('/'), guardedResponse)
await guardedResponse.done
assert.equal(guardedResponse.status, 302)
assert.equal(guardedResponse.headers.location, '/dsh-auth/login?returnTo=%2F')

const loginPageResponse = response()
await routes.get('/dsh-auth').handler(request('/dsh-auth/login'), loginPageResponse)
await loginPageResponse.done
assert.equal(loginPageResponse.status, 200)
const loginHtml = Buffer.concat(loginPageResponse.chunks).toString('utf8')
assert.match(loginHtml, /登录 DSH/)
const csrf = loginHtml.match(/name="csrf" value="([^"]+)"/)[1]
const csrfCookie = loginPageResponse.headers['set-cookie'].split(';')[0]

const loginResponse = response()
const body = new URLSearchParams({ username: 'admin', password: 'adapter-admin-password', csrf, returnTo: '/' }).toString()
await routes.get('/dsh-auth').handler(request('/dsh-auth/login', {
  method: 'POST',
  headers: { cookie: csrfCookie, 'content-type': 'application/x-www-form-urlencoded' },
  body,
}), loginResponse)
await loginResponse.done
assert.equal(loginResponse.status, 303)
assert.equal(loginResponse.headers.location, 'http://127.0.0.1:19080/?token=native-test-token')
const sessionCookie = loginResponse.headers['set-cookie'].split(';')[0]

const settingsResponse = response()
await routes.get('/dsh-admin').handler(request('/dsh-admin/settings/auth', { headers: { cookie: sessionCookie } }), settingsResponse)
await settingsResponse.done
assert.equal(settingsResponse.status, 200)
assert.match(Buffer.concat(settingsResponse.chunks).toString('utf8'), /本地管理员账号/)

assert.match(taps[0]('<html><head></head><body></body></html>'), /dsh-auth\/session/)

console.log('DSH web adapter forced-login smoke passed')
