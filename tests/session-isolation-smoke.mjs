
import assert from 'node:assert/strict'
import { currentSessionUser, installSessionIsolation } from '../lib/index.js'

const users = new Map([
  ['session-alice', { id: 'session-alice', title: 'Alice private session' }],
  ['session-bob', { id: 'session-bob', title: 'Bob private session' }],
])
const codec = {
  cookieName: 'dsh_session',
  verify(token) {
    if (token === 'alice-token') return { userId: 'alice', displayName: 'Alice', roles: ['user'] }
    if (token === 'bob-token') return { userId: 'bob', displayName: 'Bob', roles: ['user'] }
    return null
  },
}
const sessions = {
  list() { return [...users.values()] },
  get(id) { return users.get(String(id)) },
  create(id) {
    const session = { id: String(id), title: String(id) }
    users.set(session.id, session)
    return session
  },
}
const query = {
  listSessions() { return [...users.values()] },
  observeSession(id) {
    const session = users.get(String(id))
    if (!session) throw new Error('not found')
    return session
  },
}
const eventListeners = new Map()
const events = {
  on(event, listener) { eventListeners.set(event, listener); return () => eventListeners.delete(event) },
}
const agents = {
  list() { return [...users.values()] },
  get(id) { return users.get(String(id)) },
  create(request = {}) { return sessions.create(request.sessionId || request.id || 'created') },
}
const apiInterceptor = {
  fetchHandler: {
    async fetch() {
      events.on('api-session/status', (sessionId) => { if (sessionId === 'session-alice') eventListeners.received = 'alice' })
      let alice
      try { alice = query.observeSession('session-alice').id } catch (error) { alice = error.code || error.name }
      return new Response(JSON.stringify({
        sessions: sessions.list().map((item) => item.id),
        alice,
        bob: sessions.get('session-bob')?.id || null,
      }), { headers: { 'content-type': 'application/json' } })
    },
  },
}
const sidebarRoute = { handler: async (_request, response) => {
  response.writeHead(200)
  response.end(currentSessionUser()?.userId || '')
} }
const sidebarApiRoute = { handler: async (request, response) => {
  let body = ''
  for await (const chunk of request) body += Buffer.from(chunk).toString('utf8')
  response.writeHead(200)
  response.end(JSON.stringify({ userId: currentSessionUser()?.userId || '', body }))
} }
const webServer = { upgrades: new Map(), prefixes: new Map([['/sidebar/file', sidebarRoute], ['/sidebar/api', sidebarApiRoute]]) }
const connection = { interceptors: new Map([['/api', apiInterceptor]]), fetchRoutes: new Map() }
const ctx = { connection, webServer, sessions, sessionQuery: query, agents, events }
const web = { session: codec, localAdmin: { username: 'admin' }, ready: Promise.resolve() }
const configStore = { values: new Map(), async get(key) { return this.values.get(key) }, async set(key, value) { this.values.set(key, value) } }
const isolation = installSessionIsolation(ctx, web, { configStore, logger: { warn() {} } })
isolation.registry.owners.set('session-alice', 'alice')
isolation.registry.owners.set('session-bob', 'bob')
isolation.registry.loaded = true

function request(cookie) {
  return new Request('http://127.0.0.1/api/session/list', { headers: { cookie } })
}
const alicePayload = await (await apiInterceptor.fetchHandler.fetch(request('dsh_session=alice-token'))).json()
assert.deepEqual(alicePayload.sessions, ['session-alice'])
assert.equal(alicePayload.alice, 'session-alice')
assert.equal(alicePayload.bob, null)
eventListeners.get('api-session/status')?.('session-bob')
assert.equal(eventListeners.received, undefined)
eventListeners.get('api-session/status')?.('session-alice')
assert.equal(eventListeners.received, 'alice')

const bobPayload = await (await apiInterceptor.fetchHandler.fetch(request('dsh_session=bob-token'))).json()
assert.deepEqual(bobPayload.sessions, ['session-bob'])
assert.equal(bobPayload.alice, 'SESSION_NOT_FOUND')
assert.equal(bobPayload.bob, 'session-bob')

const noSession = await apiInterceptor.fetchHandler.fetch(request(''))
assert.equal(noSession.status, 401)

function responseCapture() {
  return {
    status: 0,
    headersSent: false,
    body: '',
    writeHead(status) { this.status = status; this.headersSent = true },
    end(value = '') { this.body += String(value) },
  }
}
const sidebarAlice = responseCapture()
await sidebarRoute.handler({ url: '/sidebar/file?sessionId=session-alice', headers: { cookie: 'dsh_session=alice-token' } }, sidebarAlice)
assert.equal(sidebarAlice.status, 200)
assert.equal(sidebarAlice.body, 'alice')
const sidebarForeign = responseCapture()
await sidebarRoute.handler({ url: '/sidebar/file?sessionId=session-alice', headers: { cookie: 'dsh_session=bob-token' } }, sidebarForeign)
assert.equal(sidebarForeign.status, 404)
assert.equal(sidebarForeign.body, 'session is not available for the current user')
const sidebarNoAuth = responseCapture()
await sidebarRoute.handler({ url: '/sidebar/file?sessionId=session-alice', headers: {} }, sidebarNoAuth)
assert.equal(sidebarNoAuth.status, 401)
const apiAliceResponse = responseCapture()
const apiAliceRequest = { url: '/sidebar/api', headers: { cookie: 'dsh_session=alice-token' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ sessionId: 'session-alice' })) } }
await sidebarApiRoute.handler(apiAliceRequest, apiAliceResponse)
assert.equal(apiAliceResponse.status, 200)
assert.match(apiAliceResponse.body, /\"userId\":\"alice\"/)
const apiForeignResponse = responseCapture()
const apiForeignRequest = { url: '/sidebar/api', headers: { cookie: 'dsh_session=bob-token' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ sessionId: 'session-alice' })) } }
await sidebarApiRoute.handler(apiForeignRequest, apiForeignResponse)
assert.equal(apiForeignResponse.status, 404)

isolation.dispose()
console.log('session isolation smoke passed')
