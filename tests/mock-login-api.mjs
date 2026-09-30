import { createServer } from 'node:http'

const port = Number(process.env.DSH_TEST_LOGIN_PORT || 19081)
const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/login') {
    response.writeHead(404)
    response.end()
    return
  }
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  let body
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { body = {} }
  const ok = body.username === 'admin' && body.password === 'dsh-test'
  const result = ok
    ? { code: 0, data: { userId: 'same-host-admin', displayName: 'Same Host Admin', roles: ['admin'], token: 'upstream-token-not-for-browser-cookie' }, message: 'ok' }
    : { code: 401, message: '用户名或密码错误' }
  response.writeHead(ok ? 200 : 401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(result))
})

server.listen(port, '127.0.0.1', () => console.log(`mock login API: http://127.0.0.1:${port}/login`))
