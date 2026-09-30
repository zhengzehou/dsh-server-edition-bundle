import assert from 'node:assert/strict'
import { installSessionIsolation, tenantStorage } from '../lib/index.js'

const workspaces = new Map([
  ['workspace-alice', { id: 'workspace-alice', path: 'C:/alice', title: 'Alice', sessionIds: ['session-alice'] }],
  ['workspace-bob', { id: 'workspace-bob', path: 'C:/bob', title: 'Bob', sessionIds: ['session-bob'] }],
])
const sessions = new Map([
  ['session-alice', { id: 'session-alice', title: 'Alice session' }],
  ['session-bob', { id: 'session-bob', title: 'Bob session' }],
])
const codec = {
  cookieName: 'dsh_session',
  verify(token) {
    if (token === 'alice-token') return { userId: 'alice', displayName: 'Alice', roles: ['user'] }
    if (token === 'bob-token') return { userId: 'bob', displayName: 'Bob', roles: ['user'] }
    return null
  },
}
const workspaceRegistry = {
  archivedSessionIds: ['session-alice', 'session-bob'],
  list() { return [...workspaces.values()] },
  get(id) { return workspaces.get(String(id)) },
  async resolveByPath(path) { return [...workspaces.values()].find((item) => item.path === path) },
  async create(path) {
    const workspace = { id: 'workspace-new', path, title: 'New', sessionIds: [] }
    workspaces.set(workspace.id, workspace)
    return workspace
  },
  async delete(id) { return workspaces.delete(String(id)) },
  async insertBefore() { return [...workspaces.keys()] },
  async archiveSession() {},
}
const workspaceFeed = {
  baseline() {
    return {
      items: [...workspaces.values()].map((workspace) => ({ workspaceId: workspace.id, path: workspace.path, title: workspace.title, sessionIds: workspace.sessionIds })),
      archivedSessionIds: [...workspaceRegistry.archivedSessionIds],
      pinnedSessionIds: ['session-alice', 'session-bob'],
    }
  },
  async *follow() {
    yield { type: 'baseline', value: this.baseline() }
    yield { type: 'upsert', workspace: { workspaceId: 'workspace-bob', path: 'C:/bob', title: 'Bob', sessionIds: [] } }
    yield { type: 'order', workspaceIds: ['workspace-bob', 'workspace-alice'] }
    yield { type: 'archived', archivedSessionIds: ['session-bob', 'session-alice'] }
  },
}
const workspaceController = {
  commands: {
    create(request) { return { workspace: workspaces.get(request.path) } },
    rename(request) { return { workspace: workspaces.get(request.workspaceId) } },
    delete() { return { deleted: true } },
    insertBefore() { return { workspaceIds: [...workspaces.keys()] } },
    insertSessionBefore() { return { workspace: workspaces.get('workspace-alice') } },
    archiveSession() { return { archivedSessionIds: [...workspaceRegistry.archivedSessionIds] } },
  },
  feed: workspaceFeed,
  follow(signal) { return this.feed.follow(signal) },
}
let createdSessionRequest
let createRequests = []
let retryLegacyOnce = false
const sessionEventListeners = new Map()
const events = {
  on(event, listener) {
    sessionEventListeners.set(event, listener)
    return () => sessionEventListeners.delete(event)
  },
  emit(event, ...args) { return sessionEventListeners.get(event)?.(...args) },
}
const sessionAgentManager = {
  ensureSession(sessionId) {
    events.emit('api-session/added', sessionId)
    return { session: { header: { id: sessionId } } }
  },
}
const sessionController = {
  commands: {
    agents: sessionAgentManager,
    create(request) {
      createdSessionRequest = request
      createRequests.push(request)
      if (retryLegacyOnce && request.sessionId === 'session-missing') {
        retryLegacyOnce = false
        throw Object.assign(new Error('session is not available for the current user'), { name: 'SessionNotFoundError' })
      }
      const sessionId = request.sessionId || 'session-new'
      this.agents.ensureSession(sessionId)
      return { sessionId }
    },
  },
}
const sessionsService = {
  list() { return [...sessions.values()] },
  get(id) { return sessions.get(String(id)) },
}
const query = {
  listSessions() { return [...sessions.values()] },
  observeSession(id) { return sessions.get(String(id)) },
}
const apiInterceptor = {
  fetchHandler: {
    async fetch(request) {
      const frames = []
      for await (const frame of workspaceController.follow(new AbortController().signal)) frames.push(frame)
      return Response.json({
        list: workspaceRegistry.list().map((item) => item.id),
        bob: workspaceRegistry.get('workspace-bob')?.id || null,
        frames,
      })
    },
  },
}
const basePeer = { ctx: {} }
const connection = { interceptors: new Map([['/api', apiInterceptor]]), fetchRoutes: new Map(), admit() { return { peer: basePeer } } }
const ctx = { connection, webServer: { upgrades: new Map() }, sessions: sessionsService, sessionQuery: query, workspaceRegistry, workspaceController, sessionController, events }
const web = { session: codec, localAdmin: { username: 'admin' }, ready: Promise.resolve() }
const configStore = { values: new Map(), async get(key) { return this.values.get(key) }, async set(key, value) { this.values.set(key, value) } }
const isolation = installSessionIsolation(ctx, web, { configStore, logger: { warn() {} } })
isolation.registry.owners.set('session-alice', 'alice')
isolation.registry.owners.set('session-bob', 'bob')
isolation.registry.loaded = true
isolation.workspaceOwners.owners.set('workspace-alice', 'alice')
isolation.workspaceOwners.owners.set('workspace-bob', 'bob')
isolation.workspaceOwners.loaded = true

// DSH emits the new-session notification from ensureSession() before the
// outer create command resolves. The creating tenant must own the generated
// id early enough for the event filter to forward that notification.
let addedForAlice = ''
await tenantStorage.run({ userId: 'alice' }, async () => {
  events.on('api-session/added', (sessionId) => { addedForAlice = sessionId })
  const created = await sessionController.commands.create({ workspaceId: 'workspace-alice' })
  assert.equal(created.sessionId, 'session-new')
})
assert.equal(addedForAlice, 'session-new')
assert.equal(isolation.registry.owner('session-new'), 'alice')

async function request(cookie) {
  return (await apiInterceptor.fetchHandler.fetch(new Request('http://127.0.0.1/api/workspace', { headers: { cookie } }))).json()
}
const alice = await request('dsh_session=alice-token')
assert.deepEqual(alice.list, ['workspace-alice'])
assert.equal(alice.bob, null)
assert.deepEqual(alice.frames[0].value.items.map((item) => item.workspaceId), ['workspace-alice'])
assert.deepEqual(alice.frames.slice(1).map((frame) => frame.type), ['order', 'archived'])
assert.deepEqual(alice.frames[1].workspaceIds, ['workspace-alice'])
assert.deepEqual(alice.frames[2].archivedSessionIds, ['session-alice'])
assert.deepEqual(alice.frames[0].value.pinnedSessionIds, ['session-alice'])

const bob = await request('dsh_session=bob-token')
assert.deepEqual(bob.list, ['workspace-bob'])
assert.equal(bob.bob, 'workspace-bob')
assert.deepEqual(bob.frames[0].value.items.map((item) => item.workspaceId), ['workspace-bob'])
assert.deepEqual(bob.frames.slice(1).map((frame) => frame.type), ['upsert', 'order', 'archived'])
assert.deepEqual(bob.frames[1].workspace.workspaceId, 'workspace-bob')
assert.deepEqual(bob.frames[2].workspaceIds, ['workspace-bob'])
assert.deepEqual(bob.frames[3].archivedSessionIds, ['session-bob'])
assert.deepEqual(bob.frames[0].value.pinnedSessionIds, ['session-bob'])

// The browser Workspace stream is consumed after the HTTP handler returns.
// The wrapper must retain the captured tenant rather than relying on ambient
// AsyncLocalStorage at the later iterator pull.
const delayed = tenantStorage.run({ userId: 'alice' }, () => workspaceController.follow(new AbortController().signal))
const delayedBaseline = await delayed.next()
assert.deepEqual(delayedBaseline.value.value.items.map((item) => item.workspaceId), ['workspace-alice'])
assert.deepEqual(delayedBaseline.value.value.pinnedSessionIds, ['session-alice'])
await delayed.return?.()

// A remote WebSocket invocation can pull after the upgrade callback returns.
// Its admitted Peer must still carry the tenant when AsyncLocalStorage is empty.
const alicePeer = connection.admit({ headers: { cookie: 'dsh_session=alice-token' } }).peer
const remoteAlice = workspaceController.follow.call({ feed: workspaceFeed, ctx: { invocation: { peer: alicePeer } } }, new AbortController().signal)
const remoteAliceBaseline = await remoteAlice.next()
assert.deepEqual(remoteAliceBaseline.value.value.items.map((item) => item.workspaceId), ['workspace-alice'])
await remoteAlice.return?.()

// DSH 0.2 may retry a blank session id from a workspace created before
// ownership isolation. A foreign id must be discarded and replaced by a
// fresh session in the visible workspace.
isolation.registry.owners.set('session-legacy', 'bob')
await tenantStorage.run({ userId: 'alice' }, async () => {
  await sessionController.commands.create({ workspaceId: 'workspace-alice', sessionId: 'session-legacy' })
})
assert.deepEqual(createdSessionRequest, { workspaceId: 'workspace-alice' })

// Unknown legacy ids are retried once when the native controller reports the
// same SessionNotFoundError, covering stores that have not indexed the header.
createRequests = []
retryLegacyOnce = true
await tenantStorage.run({ userId: 'alice' }, async () => {
  await sessionController.commands.create({ workspaceId: 'workspace-alice', sessionId: 'session-missing' })
})
assert.deepEqual(createRequests, [
  { workspaceId: 'workspace-alice', sessionId: 'session-missing' },
  { workspaceId: 'workspace-alice' },
])

isolation.dispose()
console.log('workspace isolation smoke passed')
