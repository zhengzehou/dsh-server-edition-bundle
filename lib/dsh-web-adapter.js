import { parseCookies, safeReturnTo } from './session.js'

const MAX_BODY_BYTES = 1024 * 1024

function isLoopback(address = '') {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

async function readBody(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body exceeds 1 MiB')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function toWebRequest(request) {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item)
    else if (value !== undefined) headers.set(name, value)
  }
  return new Request(new URL(request.url || '/', 'http://127.0.0.1'), {
    method: request.method || 'GET',
    headers,
    body: await readBody(request),
  })
}

async function sendWebResponse(response, serverResponse) {
  const headers = {}
  for (const [name, value] of response.headers.entries()) headers[name] = value
  serverResponse.writeHead(response.status, headers)
  if (response.body) serverResponse.end(Buffer.from(await response.arrayBuffer()))
  else serverResponse.end()
}

function browserOrigin(request) {
  const authority = typeof request.headers.host === 'string' ? request.headers.host : '127.0.0.1'
  return `http://${authority}/`
}

function routeHandler(web, nativeAuthenticatedUrl) {
  return async (request, response) => {
    await web.ready
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    let webResponse = await web.handle(await toWebRequest(request))
    if (url.pathname === '/dsh-auth/login' && request.method === 'POST' && webResponse.status === 303 && typeof nativeAuthenticatedUrl === 'function') {
      const headers = new Headers(webResponse.headers)
      headers.set('location', nativeAuthenticatedUrl(browserOrigin(request)))
      webResponse = new Response(null, { status: 303, headers })
    }
    await sendWebResponse(webResponse, response)
  }
}

function applicationGuard(ctx, web) {
  return async (request, response) => {
    await web.ready
    const fallback = ctx.webServer.fallback
    if (typeof fallback !== 'function') {
      response.writeHead(404)
      response.end()
      return
    }
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    if (web.publicPaths.has(url.pathname)) {
      await fallback(request, response)
      return
    }
    const claims = web.session.verify(parseCookies(request.headers.cookie).dsh_session)
    if (!claims) {
      const returnTo = safeReturnTo(`${url.pathname}${url.search}${url.hash}`)
      response.writeHead(302, { location: `/dsh-auth/login?returnTo=${encodeURIComponent(returnTo)}`, 'cache-control': 'no-store' })
      response.end()
      return
    }
    await fallback(request, response)
  }
}

function injectLoginGuard(html) {
  const script = `<script>(()=>{const p=location.pathname;if(p.startsWith('/dsh-auth/')||p.startsWith('/dsh-admin/'))return;fetch('/dsh-auth/session',{credentials:'same-origin',cache:'no-store',redirect:'manual'}).then(r=>{if(!r.ok)location.replace('/dsh-auth/login?returnTo='+encodeURIComponent(location.pathname+location.search+location.hash))}).catch(()=>location.replace('/dsh-auth/login?returnTo='+encodeURIComponent(location.pathname+location.search+location.hash)))})();</script>`
  const index = html.search(/<\/head\s*>/i)
  return index < 0 ? `${script}${html}` : `${html.slice(0, index)}${script}${html.slice(index)}`
}

export function registerDshWebAdapter(ctx, web, { nativeAuthenticatedUrl } = {}) {
  if (!ctx?.webServer?.register || typeof ctx.effect !== 'function') return false
  const handler = routeHandler(web, nativeAuthenticatedUrl)
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/dsh-auth', handler }), 'dsh-server-edition: auth routes')
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/dsh-admin', handler }), 'dsh-server-edition: admin routes')
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/', handler: applicationGuard(ctx, web) }), 'dsh-server-edition: application login guard')
  ctx.effect(() => ctx.webServer.tapIndex((html) => injectLoginGuard(html)), 'dsh-server-edition: login guard')
  return true
}

export { applicationGuard, injectLoginGuard, isLoopback, toWebRequest }
