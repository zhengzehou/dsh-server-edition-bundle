import { AsyncLocalStorage } from 'node:async_hooks'
import { parseCookies } from './session.js'
import { getRegisteredService } from './register.js'

// The native DSH API is shared by every browser session.  This storage is the
// bridge between the HTTP/WebSocket boundary and the native session services.
const tenantStorage = new AsyncLocalStorage()
const originalSymbol = Symbol.for('cordis.original')
const wrappedSymbol = Symbol.for('dsh-server-edition.session-isolation.wrapper')
const tenantPeerSymbol = Symbol.for('dsh-server-edition.session-isolation.tenant-peer')
const tenantPeerIdentities = new WeakMap()

function originalOf(value) {
  if (!value) return value
  try { return value[originalSymbol] || value } catch { return value }
}

function serviceOf(ctx, name) {
  let value
  try { value = getRegisteredService(ctx, name) } catch {}
  if (!value) {
    try { if (typeof ctx?.get === 'function') value = ctx.get(name, false) } catch {}
  }
  if (!value) {
    try { value = ctx?.[name] } catch {}
  }
  return originalOf(value)
}

function idOf(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (!value || typeof value !== 'object') return ''
  return String(value.id ?? value.sessionId ?? value.header?.id ?? value.record?.id ?? value.record?.header?.id ?? '')
}

function collectionFilter(value, predicate) {
  if (Array.isArray(value)) return value.filter(predicate)
  if (value && Array.isArray(value.items)) return { ...value, items: value.items.filter(predicate) }
  if (value && typeof value[Symbol.iterator] === 'function') return Array.from(value).filter(predicate)
  return value
}

function markWrapped(fn) {
  try { Object.defineProperty(fn, wrappedSymbol, { value: true }) } catch {}
  return fn
}

function isWrapped(fn) {
  try { return Boolean(fn?.[wrappedSymbol]) } catch { return false }
}

function patchMethod(target, name, makeWrapper, restores) {
  if (!target || typeof target[name] !== 'function') return false
  const original = target[name]
  if (isWrapped(original)) return false
  const wrapped = markWrapped(makeWrapper(original))
  try {
    target[name] = wrapped
  } catch {
    return false
  }
  restores.push(() => {
    try { if (target[name] === wrapped) target[name] = original } catch {}
  })
  return true
}


function patchFetch(target, restores, makeWrapper) {
  return patchMethod(target, 'fetch', makeWrapper, restores)
}

function claimsFromHeaders(web, headers) {
  const cookieName = web?.session?.cookieName || 'dsh_session'
  let cookieHeader = ''
  try {
    cookieHeader = typeof headers?.get === 'function' ? headers.get('cookie') || '' : headers?.cookie || headers?.Cookie || ''
  } catch {}
  if (Array.isArray(cookieHeader)) cookieHeader = cookieHeader.join('; ')
  const token = parseCookies(cookieHeader)[cookieName]
  try { return typeof web?.session?.verify === 'function' ? web.session.verify(token) : null } catch { return null }
}

function identityFromClaims(claims) {
  if (!claims?.userId) return null
  return Object.freeze({
    userId: String(claims.userId),
    displayName: claims.displayName == null ? '' : String(claims.displayName),
    roles: Array.isArray(claims.roles) ? claims.roles.map(String) : [],
  })
}

// The native connection shares one operator Peer. Attach a per-connection
// tenant wrapper so remote stream calls retain the browser identity.
function peerWithTenant(peer, identity) {
  if (!identity || !peer || (typeof peer !== 'object' && typeof peer !== 'function')) return peer
  try {
    const scoped = Object.create(peer)
    tenantPeerIdentities.set(scoped, identity)
    return scoped
  } catch { return peer }
}

function identityFromPeer(peer) {
  try { return tenantPeerIdentities.get(peer) || peer?.[tenantPeerSymbol] || null } catch { return null }
}

function identityFromInvocation(owner) {
  try { return identityFromPeer(owner?.ctx?.invocation?.peer) } catch { return null }
}

function unauthorizedResponse() {
  return new Response('authentication required', {
    status: 401,
    headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
  })
}

function forbiddenSession(sessionId) {
  const error = new Error('session is not available for the current user')
  error.code = 'SESSION_NOT_FOUND'
  error.status = 404
  error.name = 'SessionNotFoundError'
  return error
}

function requestWithTenant({ ctx, web, registry, registries, headers, invoke }) {
  const claims = claimsFromHeaders(web, headers)
  const identity = identityFromClaims(claims)
  if (!identity) return unauthorizedResponse()
  const loaders = (registries || [registry]).filter(Boolean)
  return Promise.all(loaders.map((item) => item.ensureLoaded(ctx, web))).then(() => tenantStorage.run(identity, invoke))
}

function extractFetchHandler(route) {
  if (route && typeof route.fetch === 'function') return route
  if (route?.handler && typeof route.handler.fetch === 'function') return route.handler
  return null
}

function patchConnectionTransport(ctx, web, registry, registries, restores) {
  const connection = serviceOf(ctx, 'connection')
  if (!connection) return false
  let changed = false
  // Keep the browser identity on the Peer admitted for remote WebSocket streams.
  changed = patchMethod(connection, 'admit', (original) => function (request, ...args) {
    const result = original.call(this, request, ...args)
    const identity = identityFromClaims(claimsFromHeaders(web, request?.headers))
    if (!identity || !result?.peer) return result
    return { ...result, peer: peerWithTenant(result.peer, identity) }
  }, restores) || changed
  const interceptors = connection.interceptors
  const apiInterceptor = typeof interceptors?.get === 'function' ? interceptors.get('/api') : null
  if (apiInterceptor?.fetchHandler) {
    changed = patchFetch(apiInterceptor.fetchHandler, restores, (original) => function (request) {
      return requestWithTenant({ ctx, web, registry, registries, headers: request?.headers, invoke: () => original.call(this, request) })
    }) || changed
  }
  const fetchRoutes = connection.fetchRoutes
  if (fetchRoutes && typeof fetchRoutes[Symbol.iterator] === 'function') {
    for (const [, route] of fetchRoutes) {
      const handler = extractFetchHandler(route)
      if (!handler) continue
      changed = patchFetch(handler, restores, (original) => function (request) {
        return requestWithTenant({ ctx, web, registry, registries, headers: request?.headers, invoke: () => original.call(this, request) })
      }) || changed
    }
  }
  return changed
}

function rejectSocket(socket) {
  try {
    socket?.write?.('HTTP/1.1 401 Unauthorized\\r\\nConnection: close\\r\\nCache-Control: no-store\\r\\n\\r\\n')
    socket?.destroy?.()
  } catch {}
}

function wrapRemoteMuxHandler(ctx, web, registry, registries, handler) {
  if (typeof handler !== 'function' || isWrapped(handler)) return handler
  return markWrapped(function (request, socket, head) {
    const claims = claimsFromHeaders(web, request?.headers)
    const identity = identityFromClaims(claims)
    if (!identity) return rejectSocket(socket)
    return Promise.all((registries || [registry]).filter(Boolean).map((item) => item.ensureLoaded(ctx, web))).then(() => tenantStorage.run(identity, () => handler.call(this, request, socket, head)))
  })
}

function patchUpgradeRegistration(ctx, web, registry, registries, restores) {
  const server = serviceOf(ctx, 'webServer')
  if (!server) return false
  return patchMethod(server, 'registerUpgrade', (original) => function (route, ...args) {
    if (route?.path !== '/api/remote.mux') return original.call(this, route, ...args)
    const handler = typeof route === 'function' ? route : route?.handler
    const wrapped = wrapRemoteMuxHandler(ctx, web, registry, registries, handler)
    if (wrapped === handler) return original.call(this, route, ...args)
    const nextRoute = typeof route === 'function' ? wrapped : { ...route, handler: wrapped }
    return original.call(this, nextRoute, ...args)
  }, restores)
}

function patchUpgradeRoute(ctx, web, registry, registries, restores) {
  const server = serviceOf(ctx, 'webServer')
  const upgrades = server?.upgrades
  if (!upgrades || typeof upgrades.get !== 'function') return false
  const routePath = '/api/remote.mux'
  const route = upgrades.get(routePath)
  if (!route) return false
  const handler = typeof route === 'function' ? route : route.handler
  const wrapped = wrapRemoteMuxHandler(ctx, web, registry, registries, handler)
  if (wrapped === handler) return false
  try {
    if (typeof route === 'function') upgrades.set(routePath, wrapped)
    else route.handler = wrapped
  } catch { return false }
  restores.push(() => {
    try {
      if (typeof route === 'function') {
        if (upgrades.get(routePath) === wrapped) upgrades.set(routePath, route)
      } else if (route.handler === wrapped) route.handler = handler
    } catch {}
  })
  return true
}


function unauthorizedNodeResponse(res) {
  try {
    if (res?.headersSent) return
    res?.writeHead?.(401, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
    res?.end?.('authentication required')
  } catch {}
}

async function readIncomingBody(request, limit = 1 << 20) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > limit) throw Object.assign(new Error('request body too large'), { status: 413 })
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function replayIncomingRequest(request, body) {
  const replay = Object.create(request)
  Object.defineProperty(replay, Symbol.asyncIterator, {
    configurable: true,
    value: async function* () {
      if (body.length > 0) yield body
    }
  })
  return replay
}

function collectSessionReferences(value, found = new Set(), depth = 0) {
  if (depth > 5 || value === null || typeof value !== 'object') return found
  if (Array.isArray(value)) {
    for (const item of value) collectSessionReferences(item, found, depth + 1)
    return found
  }
  for (const [key, item] of Object.entries(value)) {
    if (['sessionId', 'childId', 'parentSessionId', 'sourceSessionId', 'targetSessionId'].includes(key) && typeof item === 'string' && item !== '') found.add(item)
    else if (item && typeof item === 'object') collectSessionReferences(item, found, depth + 1)
  }
  return found
}

function routeSessionReference(path, request) {
  try {
    const url = new URL(request?.url ?? '/', 'http://dsh.internal')
    const query = url.searchParams.get('sessionId')
    if (query) return query
    if (path.startsWith('/sidebar/html/')) {
      const part = url.pathname.slice('/sidebar/html/'.length).split('/')[0]
      return part ? decodeURIComponent(part) : ''
    }
  } catch {}
  return ''
}

function patchNodeHttpRoutes(ctx, web, sessionOwners, workspaceOwners, restores) {
  const server = serviceOf(ctx, 'webServer')
  if (!server) return false
  let changed = false
  const tables = [server.exact, server.prefixes]
  for (const table of tables) {
    if (!table || typeof table[Symbol.iterator] !== 'function') continue
    for (const [path, route] of table) {
      if (!String(path).startsWith('/sidebar/') || String(path).startsWith('/sidebar/bundle')) continue
      const original = route?.handler
      if (typeof original !== 'function' || isWrapped(original)) continue
      const wrapped = markWrapped(async function (request, response) {
        const identity = identityFromClaims(claimsFromHeaders(web, request?.headers))
        if (!identity) return unauthorizedNodeResponse(response)
        let nextRequest = request
        try {
          await sessionOwners.ensureLoaded(ctx, web)
          await workspaceOwners.ensureLoaded(ctx, web)
          return await tenantStorage.run(identity, async () => {
            const sessionRef = routeSessionReference(String(path), request)
            if (sessionRef) assertVisible(sessionOwners, sessionRef)
            if (String(path) === '/sidebar/api') {
              const body = await readIncomingBody(request)
              let payload = {}
              try { payload = body.length === 0 ? {} : JSON.parse(body.toString('utf8')) } catch {}
              for (const sessionId of collectSessionReferences(payload)) assertVisible(sessionOwners, sessionId)
              nextRequest = replayIncomingRequest(request, body)
            }
            return original.call(this, nextRequest, response)
          })
        } catch (error) {
          const status = Number.isInteger(error?.status) ? error.status : 404
          try { response.writeHead?.(status, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' }); response.end?.(error?.message || 'not found') } catch {}
          return
        }
      })
      try {
        route.handler = wrapped
        restores.push(() => { try { if (route.handler === wrapped) route.handler = original } catch {} })
        changed = true
      } catch {}
    }
  }
  return changed
}

function patchNodeUpgradeRoutes(ctx, web, sessionOwners, workspaceOwners, restores) {
  const server = serviceOf(ctx, 'webServer')
  const upgrades = server?.upgrades
  if (!upgrades || typeof upgrades[Symbol.iterator] !== 'function') return false
  let changed = false
  for (const [path, route] of upgrades) {
    if (!String(path).startsWith('/sidebar/ws/')) continue
    const original = typeof route === 'function' ? route : route?.handler
    if (typeof original !== 'function' || isWrapped(original)) continue
    const wrapped = markWrapped(async function (request, socket, head) {
      const identity = identityFromClaims(claimsFromHeaders(web, request?.headers))
      if (!identity) return rejectSocket(socket)
      try {
        await sessionOwners.ensureLoaded(ctx, web)
        await workspaceOwners.ensureLoaded(ctx, web)
        return await tenantStorage.run(identity, () => {
          const sessionRef = routeSessionReference(String(path), request)
          if (sessionRef) assertVisible(sessionOwners, sessionRef)
          return original.call(this, request, socket, head)
        })
      } catch {
        return rejectSocket(socket)
      }
    })
    try {
      if (typeof route === 'function') upgrades.set(path, wrapped)
      else route.handler = wrapped
      restores.push(() => {
        try {
          if (typeof route === 'function') {
            if (upgrades.get(path) === wrapped) upgrades.set(path, route)
          } else if (route.handler === wrapped) route.handler = original
        } catch {}
      })
      changed = true
    } catch {}
  }
  return changed
}

function sessionIdsFrom(value) {
  if (!value) return []
  if (Array.isArray(value)) return value.map(idOf).filter(Boolean)
  if (Array.isArray(value.items)) return value.items.map(idOf).filter(Boolean)
  if (typeof value[Symbol.iterator] === 'function') return Array.from(value, idOf).filter(Boolean)
  return []
}

async function discoverWorkspaceIds(ctx) {
  const found = new Set()
  const workspaces = serviceOf(ctx, 'workspaceRegistry')
  try {
    const value = await workspaces?.list?.()
    for (const item of Array.isArray(value) ? value : []) {
      const id = workspaceIdOf(item)
      if (id) found.add(id)
    }
  } catch {}
  return found
}

async function discoverSessionIds(ctx) {
  const found = new Set()
  const sessions = serviceOf(ctx, 'sessions')
  try { for (const id of sessionIdsFrom(await sessions?.list?.())) found.add(id) } catch {}
  const query = serviceOf(ctx, 'sessionQuery')
  try { for (const id of sessionIdsFrom(await query?.listSessions?.())) found.add(id) } catch {}
  const persistence = serviceOf(ctx, 'sessionPersistence')
  for (const method of ['list', 'listSessions']) {
    try { for (const id of sessionIdsFrom(await persistence?.[method]?.())) found.add(id) } catch {}
  }
  return found
}

function adminOwner(web) {
  const username = web?.localAdmin?.username || web?.initialAdmin?.username || process.env.DSH_ADMIN_USERNAME || 'admin'
  return username ? `local-admin:${String(username)}` : ''
}

export class SessionOwnerRegistry {
  constructor({ configStore, section = 'nativeSessionOwners', logger = console, discover = discoverSessionIds } = {}) {
    this.configStore = configStore
    this.section = section
    this.logger = logger
    this.discover = discover
    this.owners = new Map()
    this.loaded = false
    this.loading = null
    this.writes = Promise.resolve()
  }

  owner(sessionId) {
    return this.owners.get(idOf(sessionId))
  }

  isOwner(sessionId, userId) {
    return Boolean(userId && this.owner(sessionId) === String(userId))
  }

  assignSync(sessionId, userId) {
    const id = idOf(sessionId)
    const owner = userId == null ? '' : String(userId)
    if (!id || !owner) return false
    const previous = this.owners.get(id)
    if (previous && previous !== owner) return false
    if (previous === owner) return true
    this.owners.set(id, owner)
    this.persistSoon()
    return true
  }

  persistSoon() {
    if (!this.configStore?.set) return
    const value = { schemaVersion: 1, owners: Object.fromEntries(this.owners), updatedAt: new Date().toISOString() }
    this.writes = this.writes.then(() => this.configStore.set(this.section, value)).catch((error) => {
      try { this.logger?.warn?.('[dsh-server-edition] unable to persist native session owners:', error?.message || error) } catch {}
    })
  }

  async ensureLoaded(ctx, web) {
    if (this.loaded) return this
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const saved = await this.configStore?.get?.(this.section)
          const values = saved?.owners && typeof saved.owners === 'object' ? saved.owners : saved
          if (values && typeof values === 'object' && !Array.isArray(values)) {
            for (const [sessionId, userId] of Object.entries(values)) {
              if (sessionId && userId && typeof userId !== 'object') this.owners.set(String(sessionId), String(userId))
            }
          }
        } catch (error) {
          try { this.logger?.warn?.('[dsh-server-edition] unable to load native session owners:', error?.message || error) } catch {}
        }
        try { await web?.ready } catch {}
        const fallback = adminOwner(web)
        let changed = false
        if (fallback) {
          for (const sessionId of await this.discover(ctx)) {
            if (!this.owners.has(sessionId)) {
              this.owners.set(sessionId, fallback)
              changed = true
            }
          }
        }
        this.loaded = true
        if (changed) this.persistSoon()
        return this
      })().catch((error) => {
        this.loaded = true
        try { this.logger?.warn?.('[dsh-server-edition] native session ownership initialization failed:', error?.message || error) } catch {}
        return this
      })
    }
    return this.loading
  }
}

export class WorkspaceOwnerRegistry extends SessionOwnerRegistry {
  constructor(options = {}) {
    super({ ...options, section: options.section ?? 'nativeWorkspaceOwners', discover: discoverWorkspaceIds })
    this.sessionOwners = options.sessionOwners
    this.migrated = false
  }

  async ensureLoaded(ctx, web) {
    await this.sessionOwners?.ensureLoaded?.(ctx, web)
    await super.ensureLoaded(ctx, web)
    if (this.migrated) return this
    this.migrated = true
    const fallback = adminOwner(web)
    const sessions = this.sessionOwners
    if (!sessions || !fallback) return this
    let changed = false
    const registry = serviceOf(ctx, 'workspaceRegistry')
    let workspaces = []
    try { workspaces = await registry?.list?.() || [] } catch {}
    for (const workspace of workspaces) {
      const id = workspaceIdOf(workspace)
      const sessionIds = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds.map(idOf).filter(Boolean) : []
      const owners = new Set(sessionIds.map((sessionId) => sessions.owner(sessionId)).filter((owner) => owner && owner !== fallback))
      if (owners.size !== 1 || (sessionIds.length > 0 && sessionIds.some((sessionId) => !sessions.owner(sessionId)))) continue
      const owner = [...owners][0]
      const current = this.owner(id)
      if (id && (!current || current === fallback) && owner) {
        this.owners.set(id, owner)
        changed = true
      }
    }
    if (changed) this.persistSoon()
    return this
  }
}

function workspaceIdOf(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (!value || typeof value !== 'object') return ''
  return String(value.workspaceId ?? value.id ?? '')
}

function currentUserId() {
  return tenantStorage.getStore()?.userId || ''
}

function forbiddenWorkspace(workspaceId) {
  const error = new Error('workspace is not available for the current user')
  error.code = 'WORKSPACE_NOT_FOUND'
  error.status = 404
  error.name = 'WorkspaceNotFoundError'
  error.workspaceId = idOf(workspaceId) || workspaceIdOf(workspaceId)
  return error
}

function assertWorkspaceVisible(registry, workspaceId) {
  const userId = currentUserId()
  if (userId && !registry.isOwner(workspaceId, userId)) throw forbiddenWorkspace(workspaceId)
}

function assertVisible(registry, sessionId) {
  const userId = currentUserId()
  if (userId && !registry.isOwner(sessionId, userId)) throw forbiddenSession(idOf(sessionId))
}

function assignWorkspaceResult(registry, value, userId) {
  if (!userId) return value
  const assign = (result) => {
    const workspace = result?.workspace ?? result
    const id = workspaceIdOf(workspace)
    if (id && registry.owner(id) && !registry.isOwner(id, userId)) throw forbiddenWorkspace(id)
    if (id) registry.assignSync(id, userId)
    return result
  }
  return value && typeof value.then === 'function' ? value.then(assign) : assign(value)
}

function assignResult(registry, value, userId) {
  if (!userId) return value
  if (value && typeof value.then === 'function') return value.then((result) => { registry.assignSync(idOf(result), userId); return result })
  registry.assignSync(idOf(value), userId)
  return value
}

function patchWorkspaceRegistry(ctx, workspaceOwners, sessionOwners, restores) {
  const registry = serviceOf(ctx, 'workspaceRegistry')
  if (!registry) return false
  let changed = false
  changed = patchMethod(registry, 'list', (original) => function (...args) {
    const value = original.apply(this, args)
    const userId = currentUserId()
    if (!userId) return value
    const filter = (item) => workspaceOwners.isOwner(workspaceIdOf(item), userId)
    return value && typeof value.then === 'function' ? value.then((result) => collectionFilter(result, filter)) : collectionFilter(value, filter)
  }, restores) || changed
  changed = patchMethod(registry, 'get', (original) => function (workspaceId, ...args) {
    const userId = currentUserId()
    if (userId && !workspaceOwners.isOwner(workspaceId, userId)) return undefined
    return original.call(this, workspaceId, ...args)
  }, restores) || changed
  changed = patchMethod(registry, 'resolveByPath', (original) => function (...args) {
    const value = original.apply(this, args)
    const check = (result) => {
      const userId = currentUserId()
      if (userId && result !== void 0 && !workspaceOwners.isOwner(workspaceIdOf(result), userId)) throw forbiddenWorkspace(result)
      return result
    }
    return value && typeof value.then === 'function' ? value.then(check) : check(value)
  }, restores) || changed
  changed = patchMethod(registry, 'create', (original) => function (...args) {
    const userId = currentUserId()
    return assignWorkspaceResult(workspaceOwners, original.apply(this, args), userId)
  }, restores) || changed
  changed = patchMethod(registry, 'initializeDefault', (original) => function (...args) {
    const userId = currentUserId()
    return assignWorkspaceResult(workspaceOwners, original.apply(this, args), userId)
  }, restores) || changed
  changed = patchMethod(registry, 'delete', (original) => function (workspaceId, ...args) {
    if (currentUserId()) assertWorkspaceVisible(workspaceOwners, workspaceId)
    return original.call(this, workspaceId, ...args)
  }, restores) || changed
  changed = patchMethod(registry, 'insertBefore', (original) => function (workspaceId, beforeWorkspaceId, ...args) {
    if (currentUserId()) {
      assertWorkspaceVisible(workspaceOwners, workspaceId)
      if (beforeWorkspaceId !== void 0) assertWorkspaceVisible(workspaceOwners, beforeWorkspaceId)
    }
    return original.call(this, workspaceId, beforeWorkspaceId, ...args)
  }, restores) || changed
  changed = patchMethod(registry, 'archiveSession', (original) => function (sessionId, ...args) {
    if (currentUserId()) assertVisible(sessionOwners, sessionId)
    return original.call(this, sessionId, ...args)
  }, restores) || changed
  return changed
}

function filterWorkspaceBaseline(value, workspaceOwners, sessionOwners, userIdOverride) {
  const userId = userIdOverride === undefined ? currentUserId() : userIdOverride
  if (!userId || !value || typeof value !== 'object') return value
  return {
    ...value,
    items: Array.isArray(value.items) ? value.items.filter((item) => workspaceOwners.isOwner(workspaceIdOf(item), userId)) : value.items,
    workspaceIds: Array.isArray(value.workspaceIds) ? value.workspaceIds.filter((id) => workspaceOwners.isOwner(id, userId)) : value.workspaceIds,
    archivedSessionIds: Array.isArray(value.archivedSessionIds) ? value.archivedSessionIds.filter((id) => sessionOwners.isOwner(id, userId)) : value.archivedSessionIds,
    pinnedSessionIds: Array.isArray(value.pinnedSessionIds) ? value.pinnedSessionIds.filter((id) => sessionOwners.isOwner(id, userId)) : value.pinnedSessionIds,
  }
}

function filterWorkspaceFrame(frame, workspaceOwners, sessionOwners, userIdOverride) {
  const userId = userIdOverride === undefined ? currentUserId() : userIdOverride
  if (!userId || !frame || typeof frame !== 'object') return frame
  if (frame.type === 'baseline') return { ...frame, value: filterWorkspaceBaseline(frame.value, workspaceOwners, sessionOwners, userId) }
  if (frame.type === 'upsert') return workspaceOwners.isOwner(workspaceIdOf(frame.workspace), userId) ? frame : null
  if (frame.type === 'remove') return workspaceOwners.isOwner(frame.workspaceId, userId) ? frame : null
  if (frame.type === 'order') return { ...frame, workspaceIds: Array.isArray(frame.workspaceIds) ? frame.workspaceIds.filter((id) => workspaceOwners.isOwner(id, userId)) : frame.workspaceIds }
  if (frame.type === 'archived') return { ...frame, archivedSessionIds: Array.isArray(frame.archivedSessionIds) ? frame.archivedSessionIds.filter((id) => sessionOwners.isOwner(id, userId)) : frame.archivedSessionIds }
  if (frame.type === 'pinned') return { ...frame, pinnedSessionIds: Array.isArray(frame.pinnedSessionIds) ? frame.pinnedSessionIds.filter((id) => sessionOwners.isOwner(id, userId)) : frame.pinnedSessionIds }
  return null
}

function workspaceFollowWrapper(original, workspaceOwners, sessionOwners) {
  return function (signal, ...args) {
    // Async-generator bodies do not run until the first .next() call. Capture
    // the request tenant in this synchronous wrapper before the RPC carrier
    // starts pulling the stream outside the HTTP handler's call stack.
    const owner = this
    const identity = tenantStorage.getStore() || identityFromInvocation(owner) || null
    const run = (work) => identity ? tenantStorage.run(identity, work) : work()
    return (async function* () {
      const iterator = run(() => original.call(owner, signal, ...args))
      try {
        while (true) {
          const step = await run(() => iterator.next())
          if (step.done) return
          const filtered = filterWorkspaceFrame(step.value, workspaceOwners, sessionOwners, identity?.userId)
          if (filtered !== null) yield filtered
        }
      } finally {
        try { await run(() => iterator.return?.()) } catch {}
      }
    })()
  }
}

function patchWorkspaceController(ctx, workspaceOwners, sessionOwners, restores) {
  const controller = serviceOf(ctx, 'workspaceController')
  if (!controller) return false
  let changed = false
  const commands = controller.commands
  changed = patchMethod(commands, 'create', (original) => function (...args) {
    return assignWorkspaceResult(workspaceOwners, original.apply(this, args), currentUserId())
  }, restores) || changed
  changed = patchMethod(commands, 'rename', (original) => function (request, ...args) {
    if (currentUserId()) assertWorkspaceVisible(workspaceOwners, request?.workspaceId)
    return original.call(this, request, ...args)
  }, restores) || changed
  changed = patchMethod(commands, 'delete', (original) => function (request, ...args) {
    if (currentUserId()) assertWorkspaceVisible(workspaceOwners, request?.workspaceId)
    return original.call(this, request, ...args)
  }, restores) || changed
  changed = patchMethod(commands, 'insertBefore', (original) => function (request, ...args) {
    if (currentUserId()) {
      assertWorkspaceVisible(workspaceOwners, request?.workspaceId)
      if (request?.beforeWorkspaceId !== void 0) assertWorkspaceVisible(workspaceOwners, request.beforeWorkspaceId)
    }
    return original.call(this, request, ...args)
  }, restores) || changed
  changed = patchMethod(commands, 'insertSessionBefore', (original) => function (request, ...args) {
    if (currentUserId()) {
      assertWorkspaceVisible(workspaceOwners, request?.workspaceId)
      assertVisible(sessionOwners, request?.sessionId)
      if (request?.beforeSessionId !== void 0) assertVisible(sessionOwners, request.beforeSessionId)
    }
    return original.call(this, request, ...args)
  }, restores) || changed
  changed = patchMethod(commands, 'archiveSession', (original) => function (request, ...args) {
    if (currentUserId()) assertVisible(sessionOwners, request?.sessionId)
    const value = original.call(this, request, ...args)
    const filter = (result) => result && Array.isArray(result.archivedSessionIds) ? { ...result, archivedSessionIds: result.archivedSessionIds.filter((id) => sessionOwners.isOwner(id, currentUserId())) } : result
    return value && typeof value.then === 'function' ? value.then(filter) : filter(value)
  }, restores) || changed
  const feed = controller.feed
  changed = patchMethod(feed, 'baseline', (original) => function (...args) {
    return filterWorkspaceBaseline(original.apply(this, args), workspaceOwners, sessionOwners)
  }, restores) || changed
  changed = patchMethod(feed, 'follow', (original) => workspaceFollowWrapper(original, workspaceOwners, sessionOwners), restores) || changed
  // DSH 0.2 exposes the stream on the remote controller itself. The client
  // calls controller.follow(), not feed.follow(), so both surfaces need the
  // same tenant capture and frame filtering.
  changed = patchMethod(controller, 'follow', (original) => workspaceFollowWrapper(original, workspaceOwners, sessionOwners), restores) || changed
  return changed
}

function patchSessionPersistence(ctx, registry, restores) {
  const persistence = serviceOf(ctx, 'sessionPersistence')
  if (!persistence) return false
  let changed = false
  changed = patchMethod(persistence, 'stat', (original) => function (sessionId, ...args) {
    const userId = currentUserId()
    if (userId && registry.owner(sessionId) && !registry.isOwner(sessionId, userId)) return undefined
    return original.call(this, sessionId, ...args)
  }, restores) || changed
  changed = patchMethod(persistence, 'list', (original) => function (...args) {
    const value = original.apply(this, args)
    const userId = currentUserId()
    if (!userId) return value
    const filter = (item) => registry.isOwner(idOf(item), userId)
    return value && typeof value.then === 'function' ? value.then((result) => collectionFilter(result, filter)) : collectionFilter(value, filter)
  }, restores) || changed
  changed = patchMethod(persistence, 'open', (original) => function (sessionId, ...args) {
    const userId = currentUserId()
    if (userId && registry.owner(sessionId) && !registry.isOwner(sessionId, userId)) throw forbiddenSession(sessionId)
    return original.call(this, sessionId, ...args)
  }, restores) || changed
  changed = patchMethod(persistence, 'create', (original) => function (header, ...args) {
    const userId = currentUserId()
    const sessionId = idOf(header)
    if (userId && registry.owner(sessionId) && !registry.isOwner(sessionId, userId)) throw forbiddenSession(sessionId)
    return assignResult(registry, original.apply(this, args.length ? [header, ...args] : [header]), userId)
  }, restores) || changed
  return changed
}

function workspaceIdFromSessionRequest(request) {
  return request && typeof request === 'object' ? request.workspaceId : undefined
}

function isSessionUnavailableError(error) {
  const seen = new Set()
  let current = error
  for (let depth = 0; current && depth < 5 && !seen.has(current); depth += 1) {
    seen.add(current)
    const code = String(current.code || '').toLowerCase()
    const name = String(current.name || '').toLowerCase()
    const message = String(current.message || '').toLowerCase()
    if (code === 'session/not-found' || code === 'session_not_found' || code === 'session-not-found' || code === 'session_not_found_error' || name === 'sessionnotfounderror' || message.includes('sessionnotfounderror') || message.includes('session is not available for the current user')) return true
    current = current.cause || current.error || current.rpcError
  }
  return false
}

function withoutSessionId(request) {
  const retry = { ...(request || {}) }
  delete retry.sessionId
  return retry
}

function patchSessionController(ctx, registry, workspaceOwners, restores) {
  const controller = serviceOf(ctx, 'sessionController')
  if (!controller) return false
  let changed = false
  const commands = controller.commands
  // DSH publishes api-session/added and the initial control-state frames from
  // inside ensureSession(), before commands.create() resolves. Claim the
  // generated identity at that earliest stable boundary so those frames reach
  // the creating browser. Claiming only after the create result makes the
  // client miss the workspace attachment and render the new Session as
  // Ungrouped until a full reconnect.
  changed = patchMethod(commands?.agents, 'ensureSession', (original) => function (sessionId, ...args) {
    const userId = currentUserId()
    if (userId) {
      const owner = registry.owner(sessionId)
      if (owner && !registry.isOwner(sessionId, userId)) throw forbiddenSession(sessionId)
      registry.assignSync(sessionId, userId)
    }
    return original.call(this, sessionId, ...args)
  }, restores) || changed
  changed = patchMethod(commands, 'create', (original) => function (request, ...args) {
    const userId = currentUserId()
    const requested = request?.sessionId
    let createRequest = request
    if (userId) {
      const workspaceId = workspaceIdFromSessionRequest(request)
      if (workspaceId !== undefined) assertWorkspaceVisible(workspaceOwners, workspaceId)
      // DSH 0.2 first tries to reuse a blank session attached to the
      // workspace. A legacy blank session can belong to another user.
      // Drop that stale hint and let the native controller allocate a new id.
      if (requested && registry.owner(requested) && !registry.isOwner(requested, userId)) createRequest = withoutSessionId(request)
    }
    const retryWithoutStaleId = (error) => {
      if (!requested || createRequest !== request || !isSessionUnavailableError(error)) throw error
      return original.call(this, withoutSessionId(request), ...args)
    }
    let value
    try {
      value = original.call(this, createRequest, ...args)
    } catch (error) {
      value = retryWithoutStaleId(error)
    }
    if (value && typeof value.then === 'function') value = value.catch(retryWithoutStaleId)
    return assignResult(registry, value, userId)
  }, restores) || changed
  changed = patchMethod(commands, 'fork', (original) => function (request, ...args) {
    if (currentUserId()) assertVisible(registry, request?.sessionId)
    return assignResult(registry, original.call(this, request, ...args), currentUserId())
  }, restores) || changed
  changed = patchMethod(controller, 'list', (original) => function (...args) {
    const value = original.apply(this, args)
    const userId = currentUserId()
    const filter = (result) => userId ? collectionFilter(result, (item) => registry.isOwner(idOf(item), userId)) : result
    return value && typeof value.then === 'function' ? value.then(filter) : filter(value)
  }, restores) || changed
  changed = patchMethod(controller, 'search', (original) => function (...args) {
    const value = original.apply(this, args)
    const userId = currentUserId()
    const filter = (result) => userId ? collectionFilter(result, (item) => registry.isOwner(idOf(item), userId)) : result
    return value && typeof value.then === 'function' ? value.then(filter) : filter(value)
  }, restores) || changed
  changed = patchMethod(controller, 'inspect', (original) => function (sessionId, ...args) {
    if (currentUserId()) assertVisible(registry, sessionId)
    return original.call(this, sessionId, ...args)
  }, restores) || changed
  return changed
}

function patchNativeServices(ctx, registry, restores) {
  let changed = false
  const sessions = serviceOf(ctx, 'sessions')
  changed = patchMethod(sessions, 'get', (original) => function (sessionId, ...args) {
    if (currentUserId() && !registry.isOwner(sessionId, currentUserId())) return undefined
    return original.call(this, sessionId, ...args)
  }, restores) || changed
  changed = patchMethod(sessions, 'list', (original) => function (...args) {
    const value = original.apply(this, args)
    const userId = currentUserId()
    if (!userId) return value
    const filter = (item) => registry.isOwner(idOf(item), userId)
    return value && typeof value.then === 'function' ? value.then((result) => collectionFilter(result, filter)) : collectionFilter(value, filter)
  }, restores) || changed
  changed = patchMethod(sessions, 'create', (original) => function (...args) {
    const userId = currentUserId()
    const requested = idOf(args[0])
    if (userId && requested && registry.owner(requested) && !registry.isOwner(requested, userId)) throw forbiddenSession(requested)
    return assignResult(registry, original.apply(this, args), userId)
  }, restores) || changed
  changed = patchMethod(sessions, 'prepare', (original) => function (...args) {
    const userId = currentUserId()
    const result = original.apply(this, args)
    return assignResult(registry, result, userId)
  }, restores) || changed
  changed = patchMethod(sessions, 'enter', (original) => function (...args) {
    const userId = currentUserId()
    const sessionId = idOf(args[0])
    if (userId && registry.owner(sessionId) && !registry.isOwner(sessionId, userId)) throw forbiddenSession(sessionId)
    if (userId && sessionId) registry.assignSync(sessionId, userId)
    return original.apply(this, args)
  }, restores) || changed
  changed = patchMethod(sessions, 'fork', (original) => function (...args) {
    const userId = currentUserId()
    const sourceId = idOf(args[0])
    if (userId) assertVisible(registry, sourceId)
    return assignResult(registry, original.apply(this, args), userId)
  }, restores) || changed

  const agents = serviceOf(ctx, 'agents')
  changed = patchMethod(agents, 'get', (original) => function (sessionId, ...args) {
    if (currentUserId() && !registry.isOwner(sessionId, currentUserId())) return undefined
    return original.call(this, sessionId, ...args)
  }, restores) || changed
  changed = patchMethod(agents, 'list', (original) => function (...args) {
    const value = original.apply(this, args)
    const userId = currentUserId()
    if (!userId) return value
    const filter = (item) => registry.isOwner(idOf(item), userId)
    return value && typeof value.then === 'function' ? value.then((result) => collectionFilter(result, filter)) : collectionFilter(value, filter)
  }, restores) || changed
  changed = patchMethod(agents, 'create', (original) => function (...args) {
    const userId = currentUserId()
    const request = args[0]
    const requested = idOf(request?.sessionId ?? request?.id)
    if (userId && requested && registry.owner(requested) && !registry.isOwner(requested, userId)) throw forbiddenSession(requested)
    return assignResult(registry, original.apply(this, args), userId)
  }, restores) || changed
  changed = patchMethod(agents, 'resume', (original) => function (...args) {
    const userId = currentUserId()
    const request = args[0]
    const requested = idOf(request?.sessionId ?? request?.id ?? request)
    if (userId) assertVisible(registry, requested)
    return assignResult(registry, original.apply(this, args), userId)
  }, restores) || changed

  const query = serviceOf(ctx, 'sessionQuery')
  changed = patchMethod(query, 'listSessions', (original) => function (...args) {
    const value = original.apply(this, args)
    const userId = currentUserId()
    const filter = (result) => userId ? collectionFilter(result, (item) => registry.isOwner(idOf(item), userId)) : result
    return value && typeof value.then === 'function' ? value.then(filter) : filter(value)
  }, restores) || changed
  changed = patchMethod(query, 'searchSessions', (original) => function (...args) {
    const value = original.apply(this, args)
    const userId = currentUserId()
    const filter = (result) => userId ? collectionFilter(result, (item) => registry.isOwner(idOf(item), userId)) : result
    return value && typeof value.then === 'function' ? value.then(filter) : filter(value)
  }, restores) || changed
  for (const name of ['observeSession', 'readSession', 'readTitle', 'readTitleSnapshot', 'listEvents', 'filterEvents', 'readSurface', 'traceSession']) {
    changed = patchMethod(query, name, (original) => function (...args) {
      const first = args[0]
      const sessionId = first && typeof first === 'object' ? first.sessionId ?? first.address?.sessionId : first
      if (currentUserId() && sessionId != null) assertVisible(registry, sessionId)
      return original.apply(this, args)
    }, restores) || changed
  }

  return changed
}

function eventSessionId(event, args) {
  if (!String(event).startsWith('api-session/')) return ''
  return idOf(args?.[0])
}

function patchRemoteEvents(ctx, registry, restores) {
  const events = serviceOf(ctx, 'events')
  const names = new Set(['api-session/activity', 'api-session/added', 'api-session/error', 'api-session/removed', 'api-session/status'])
  return patchMethod(events, 'on', (original) => function (event, listener, ...args) {
    const userId = currentUserId()
    if (!userId || !names.has(event) || typeof listener !== 'function') return original.call(this, event, listener, ...args)
    const filtered = (...eventArgs) => {
      const sessionId = eventSessionId(event, eventArgs)
      if (sessionId && !registry.isOwner(sessionId, userId)) return undefined
      return listener(...eventArgs)
    }
    return original.call(this, event, filtered, ...args)
  }, restores)
}

function patchControlState(ctx, registry, restores) {
  const controller = serviceOf(ctx, 'sessionController')
  const state = controller?.controlState
  if (!state) return false
  const owners = new Map()
  let changed = false
  changed = patchMethod(state, 'control', (original) => async function* (signal) {
    const userId = currentUserId()
    const before = new Set(this.streams || [])
    const added = []
    const iterator = original.call(this, signal)
    let step
    try {
      step = await iterator.next()
      for (const stream of this.streams || []) if (!before.has(stream)) {
        owners.set(stream, userId)
        added.push(stream)
      }
      while (!step.done) {
        yield step.value
        step = await iterator.next()
      }
    } finally {
      try { await iterator.return?.() } catch {}
      for (const stream of added) owners.delete(stream)
    }
  }, restores) || changed
  changed = patchMethod(state, 'broadcast', (original) => function (frame, ...args) {
    const sessionId = frame?.sessionId ?? frame?.id ?? frame?.record?.sessionId
    if (!sessionId || !this.streams || typeof this.streams[Symbol.iterator] !== 'function') return original.call(this, frame, ...args)
    const originalStreams = this.streams
    const allowed = []
    for (const stream of originalStreams) {
      const owner = owners.get(stream)
      if (!owner || registry.isOwner(sessionId, owner)) allowed.push(stream)
    }
    if (allowed.length === originalStreams.size) return original.call(this, frame, ...args)
    const saved = this.streams
    try {
      this.streams = new Set(allowed)
      return original.call(this, frame, ...args)
    } finally {
      this.streams = saved
    }
  }, restores) || changed
  return changed
}

function installPatches(ctx, web, registry, workspaceOwners, restores) {
  const registries = [registry, workspaceOwners]
  const changed = patchConnectionTransport(ctx, web, registry, registries, restores)
    || patchUpgradeRegistration(ctx, web, registry, registries, restores)
    || patchUpgradeRoute(ctx, web, registry, registries, restores)
    || patchSessionPersistence(ctx, registry, restores)
    || patchSessionController(ctx, registry, workspaceOwners, restores)
    || patchNativeServices(ctx, registry, restores)
    || patchWorkspaceRegistry(ctx, workspaceOwners, registry, restores)
    || patchWorkspaceController(ctx, workspaceOwners, registry, restores)
    || patchNodeHttpRoutes(ctx, web, registry, workspaceOwners, restores)
    || patchNodeUpgradeRoutes(ctx, web, registry, workspaceOwners, restores)
    || patchRemoteEvents(ctx, registry, restores)
    || patchControlState(ctx, registry, restores)
  // The OR above is intentionally followed by all patch calls on the next
  // passes; each patch is independently idempotent, and services can appear at
  // different points during Cordis startup.
  patchConnectionTransport(ctx, web, registry, registries, restores)
  patchUpgradeRegistration(ctx, web, registry, registries, restores)
  patchUpgradeRoute(ctx, web, registry, registries, restores)
  patchSessionPersistence(ctx, registry, restores)
  patchSessionController(ctx, registry, workspaceOwners, restores)
  patchNativeServices(ctx, registry, restores)
  patchWorkspaceRegistry(ctx, workspaceOwners, registry, restores)
  patchWorkspaceController(ctx, workspaceOwners, registry, restores)
  patchNodeHttpRoutes(ctx, web, registry, workspaceOwners, restores)
  patchNodeUpgradeRoutes(ctx, web, registry, workspaceOwners, restores)
  patchRemoteEvents(ctx, registry, restores)
  patchControlState(ctx, registry, restores)
  return changed
}

export function currentSessionUser() {
  return tenantStorage.getStore() || null
}

export function installSessionIsolation(ctx, web, { configStore, logger = console } = {}) {
  const registry = new SessionOwnerRegistry({ configStore, logger })
  const workspaceOwners = new WorkspaceOwnerRegistry({ configStore, logger, sessionOwners: registry })
  const restores = []
  let disposed = false
  const attempt = () => {
    if (disposed) return
    installPatches(ctx, web, registry, workspaceOwners, restores)
  }
  attempt()
  // Native gateway routes and session services are registered by other
  // plugins. Retry briefly across the normal Cordis startup window so the
  // wrappers attach regardless of plugin ordering.
  if (typeof ctx?.effect === 'function') {
    const timers = [0, 25, 100, 250, 500, 1000, 2000].map((delay) => setTimeout(attempt, delay))
    restores.push(() => timers.forEach((timer) => clearTimeout(timer)))
  }
  const dispose = () => {
    disposed = true
    for (const restore of restores.splice(0)) restore()
  }
  return { registry, workspaceOwners, dispose }
}

export { tenantStorage }
