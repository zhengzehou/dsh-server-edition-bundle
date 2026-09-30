import { randomBytes, timingSafeEqual } from 'node:crypto'
import { DshPluginError } from '../lib/errors.js'
import { createTenantContext } from '../lib/tenant.js'
import { assertConfigStore, boolean, integer, MemoryConfigStore, requireSecretReference, resolveSecretReference } from '../lib/config.js'
import { attachAuthResponseDiagnostic, attachNonJsonResponseDiagnostic, buildAuthRequestDiagnostic } from '../lib/auth-diagnostics.js'
import { generateAdminPassword, hashAdminPassword, normalizeAdminUsername, validateAdminPassword, verifyAdminPassword } from '../lib/local-admin.js'
import { parseCookies, safeReturnTo, SignedSessionCodec } from '../lib/session.js'
import { registerService } from '../lib/register.js'

export const id = 'dsh-control-plane-web'

export const DEFAULT_CONTROL_PLANE_CONFIG = Object.freeze({
  auth: {
    enabled: false,
    loginApiUrl: '',
    method: 'POST',
    requestEncoding: 'json',
    usernameField: 'username',
    passwordField: 'password',
    headers: { 'Content-Type': 'application/json' },
    staticFields: {},
    successPath: 'code',
    successValue: '0',
    userIdPath: 'data.userId',
    displayNamePath: 'data.displayName',
    rolesPath: 'data.roles',
    messagePath: 'message',
  },
  mysql: {
    enabled: false,
    host: '127.0.0.1',
    port: 3306,
    database: 'dsh',
    username: 'dsh_runtime',
    passwordSecretRef: '',
    tlsMode: 'required',
    connectionLimit: 10,
    connectTimeoutMs: 3000,
  },
  redis: {
    enabled: false,
    host: '127.0.0.1',
    port: 6379,
    database: 0,
    username: '',
    passwordSecretRef: '',
    tls: false,
    keyPrefix: 'dsh:runtime:',
    ttlMs: 15000,
    connectTimeoutMs: 3000,
  },
})

function copy(value) {
  return JSON.parse(JSON.stringify(value))
}

function object(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : { ...fallback }
}

function valueAt(value, path) {
  if (!path) return value
  return String(path).split('.').reduce((current, key) => current == null ? undefined : current[key], value)
}

function loopback(hostname) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)
}

function normalizeAuth(input = {}) {
  const value = { ...DEFAULT_CONTROL_PLANE_CONFIG.auth, ...object(input) }
  delete value.tokenPath
  delete value.allowInsecureHttp
  value.enabled = boolean(value.enabled)
  value.method = String(value.method || 'POST').toUpperCase()
  value.requestEncoding = String(value.requestEncoding || 'json').toLowerCase()
  value.headers = object(value.headers, DEFAULT_CONTROL_PLANE_CONFIG.auth.headers)
  value.staticFields = object(value.staticFields)
  for (const key of ['loginApiUrl', 'usernameField', 'passwordField', 'successPath', 'successValue', 'userIdPath', 'displayNamePath', 'rolesPath', 'messagePath']) value[key] = value[key] == null ? '' : String(value[key]).trim()
  if (!['GET', 'POST', 'PUT', 'PATCH'].includes(value.method)) throw new DshPluginError('INVALID_AUTH_CONFIG', '登录请求方法必须为 GET、POST、PUT 或 PATCH')
  if (!['json', 'form'].includes(value.requestEncoding)) throw new DshPluginError('INVALID_AUTH_CONFIG', '请求编码必须为 json 或 form')
  if (value.enabled) {
    let url
    try { url = new URL(value.loginApiUrl) } catch { throw new DshPluginError('INVALID_AUTH_CONFIG', '登录 API 地址无效') }
    if (!['http:', 'https:'].includes(url.protocol)) throw new DshPluginError('INVALID_AUTH_CONFIG', '登录 API 仅支持 HTTP/HTTPS')
    if (url.protocol === 'http:' && !loopback(url.hostname)) throw new DshPluginError('INVALID_AUTH_CONFIG', 'HTTP 登录 API 仅允许使用同机地址，生产登录 API 必须使用 HTTPS')
    if (!value.userIdPath) throw new DshPluginError('INVALID_AUTH_CONFIG', '必须配置用户 ID 字段映射')
  }
  for (const [name, raw] of Object.entries(value.headers)) {
    const header = String(name)
    const content = String(raw)
    if (!header || /[\r\n]/.test(header) || /[\r\n]/.test(content)) throw new DshPluginError('INVALID_AUTH_CONFIG', '请求头名称或内容无效')
    if (/^(authorization|cookie|x-api-key|proxy-authorization)$/i.test(header) && !content.includes('{{') && !/^(secret|env):\/\//.test(content)) requireSecretReference(content, `请求头 ${header}`)
  }
  return value
}

function normalizeMysql(input = {}) {
  const value = { ...DEFAULT_CONTROL_PLANE_CONFIG.mysql, ...object(input) }
  value.enabled = boolean(value.enabled)
  value.host = String(value.host || '').trim()
  value.port = integer(value.port, 3306, { min: 1, max: 65535 })
  value.database = String(value.database || '').trim()
  value.username = String(value.username || '').trim()
  value.passwordSecretRef = requireSecretReference(value.passwordSecretRef, 'MySQL 密码')
  value.tlsMode = String(value.tlsMode || 'required')
  value.connectionLimit = integer(value.connectionLimit, 10, { min: 1, max: 1000 })
  value.connectTimeoutMs = integer(value.connectTimeoutMs, 3000, { min: 100, max: 120000 })
  if (!['required', 'preferred', 'disabled'].includes(value.tlsMode)) throw new DshPluginError('INVALID_MYSQL_CONFIG', 'MySQL TLS 模式无效')
  if (value.enabled && (!value.host || !value.database || !value.username)) throw new DshPluginError('INVALID_MYSQL_CONFIG', '启用 MySQL 时主机、数据库和用户名不能为空')
  return value
}

function normalizeRedis(input = {}) {
  const value = { ...DEFAULT_CONTROL_PLANE_CONFIG.redis, ...object(input) }
  value.enabled = boolean(value.enabled)
  value.host = String(value.host || '').trim()
  value.port = integer(value.port, 6379, { min: 1, max: 65535 })
  value.database = integer(value.database, 0, { min: 0, max: 1024 })
  value.username = String(value.username || '').trim()
  value.passwordSecretRef = requireSecretReference(value.passwordSecretRef, 'Redis 密码')
  value.tls = boolean(value.tls)
  value.keyPrefix = String(value.keyPrefix || 'dsh:runtime:')
  value.ttlMs = integer(value.ttlMs, 15000, { min: 1000, max: 3600000 })
  value.connectTimeoutMs = integer(value.connectTimeoutMs, 3000, { min: 100, max: 120000 })
  if (value.enabled && !value.host) throw new DshPluginError('INVALID_REDIS_CONFIG', '启用 Redis 时主机不能为空')
  return value
}

const NORMALIZERS = { auth: normalizeAuth, mysql: normalizeMysql, redis: normalizeRedis }

function roles(value) {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean)
  return []
}

export class LoginApiClient {
  constructor({ fetchImpl = globalThis.fetch, secretResolver } = {}) {
    this.fetchImpl = fetchImpl
    this.secretResolver = secretResolver
  }

  async authenticate(configInput, { username, password } = {}) {
    const config = normalizeAuth(configInput)
    if (!config.enabled) throw new DshPluginError('AUTH_NOT_CONFIGURED', '登录 API 尚未启用')
    if (typeof this.fetchImpl !== 'function') throw new DshPluginError('AUTH_TRANSPORT_UNAVAILABLE', 'HTTP 客户端不可用')
    const loginName = String(username || '').trim()
    const loginPassword = String(password || '')
    if (!loginName || !loginPassword) throw new DshPluginError('AUTHENTICATION_FAILED', '请输入用户名和密码')
    const url = new URL(config.loginApiUrl)
    const headers = {}
    for (const [name, raw] of Object.entries(config.headers)) {
      let content = String(raw)
      if (/^(secret|env):\/\//.test(content)) content = await resolveSecretReference(content, this.secretResolver)
      headers[name] = content.replaceAll('{{username}}', loginName).replaceAll('{{password}}', loginPassword)
    }
    const payload = { ...config.staticFields, [config.usernameField]: loginName, [config.passwordField]: loginPassword }
    const init = { method: config.method, headers, redirect: 'error' }
    if (config.method === 'GET') {
      for (const [key, item] of Object.entries(payload)) url.searchParams.set(key, String(item))
    } else if (config.requestEncoding === 'form') {
      init.body = new URLSearchParams(Object.entries(payload).map(([key, item]) => [key, String(item)]))
      if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded'
    } else {
      init.body = JSON.stringify(payload)
      if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json'
    }
    const diagnostic = buildAuthRequestDiagnostic(url, init, config.passwordField)
    let response
    try { response = await this.fetchImpl(url, init) } catch (error) {
      throw new DshPluginError('AUTH_UPSTREAM_UNAVAILABLE', '登录 API 不可用', { cause: error?.message, trace: diagnostic.trace })
    }
    let result
    const responseText = await response.text()
    try { result = JSON.parse(responseText) } catch {
      throw new DshPluginError('AUTH_RESPONSE_INVALID', '登录 API 未返回 JSON', { trace: attachNonJsonResponseDiagnostic(diagnostic, response) })
    }
    const trace = attachAuthResponseDiagnostic(diagnostic, response, result)
    const mapped = config.successPath ? String(valueAt(result, config.successPath)) === String(config.successValue) : response.ok
    if (!response.ok || !mapped) {
      const message = valueAt(result, config.messagePath)
      throw new DshPluginError('AUTHENTICATION_FAILED', typeof message === 'string' && message ? message : '登录失败', { trace })
    }
    const userId = valueAt(result, config.userIdPath)
    if (userId == null || String(userId).trim() === '') throw new DshPluginError('AUTH_RESPONSE_INVALID', '响应中没有找到配置的用户 ID 字段', { trace })
    const displayName = valueAt(result, config.displayNamePath)
    return {
      verified: true,
      userId: String(userId),
      displayName: displayName == null ? String(userId) : String(displayName),
      roles: roles(valueAt(result, config.rolesPath)),
      source: 'external',
      trace,
    }
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } })
}

function redirect(location, status = 303, headers = {}) {
  return new Response(null, { status, headers: { location, 'cache-control': 'no-store', ...headers } })
}

function htmlEscape(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function documentShell(title, body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(title)}</title><style>
  :root{font-family:Inter,"PingFang SC","Microsoft YaHei",sans-serif;color:#172033;background:#f3f6fb}*{box-sizing:border-box}body{margin:0}a{color:inherit}.top{height:62px;background:#102a43;color:#fff;display:flex;align-items:center;padding:0 28px;gap:24px}.top a{text-decoration:none;opacity:.82}.top a:hover{opacity:1}.brand{font-weight:700;margin-right:auto}.wrap{max-width:1040px;margin:36px auto;padding:0 20px}.card{background:#fff;border:1px solid #d9e2ec;border-radius:14px;padding:26px;box-shadow:0 8px 28px #102a430d}.login{max-width:440px;margin:10vh auto}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.full{grid-column:1/-1}label{display:block;font-size:13px;font-weight:650;margin-bottom:7px}input,select,textarea{width:100%;padding:11px 12px;border:1px solid #bcccdc;border-radius:8px;background:#fff;font:inherit}textarea{min-height:104px;resize:vertical;font-family:ui-monospace,monospace;font-size:13px}.check{display:flex;gap:9px;align-items:center}.check input{width:auto}.actions{display:flex;gap:10px;align-items:center;margin-top:22px}.btn{border:0;border-radius:8px;padding:11px 18px;background:#1677ff;color:#fff;font-weight:650;cursor:pointer}.btn.alt{background:#e9f2ff;color:#1554ad}.hint{color:#627d98;font-size:13px;line-height:1.6}.status{min-height:22px;margin-top:14px;font-size:14px}.bad{color:#b42318}.good{color:#067647}h1{font-size:25px;margin:0 0 8px}h2{font-size:18px;margin:28px 0 10px;padding-top:24px;border-top:1px solid #d9e2ec}@media(max-width:720px){.grid{grid-template-columns:1fr}.full{grid-column:auto}.top{padding:0 16px}.wrap{margin-top:20px}}
  </style></head><body>${body}</body></html>`
}

function loginPage({ returnTo, csrf, error = '' }) {
  return documentShell('登录 DSH', `<main class="wrap login"><section class="card"><h1>登录 DSH</h1><p class="hint">可使用本地管理员账号登录；启用登录 API 后，也可使用企业账号登录。</p>${error ? `<p class="bad">${htmlEscape(error)}</p>` : ''}<form method="post" action="/dsh-auth/login"><input type="hidden" name="returnTo" value="${htmlEscape(returnTo)}"><input type="hidden" name="csrf" value="${htmlEscape(csrf)}"><p><label>用户名</label><input name="username" autocomplete="username" required autofocus></p><p><label>密码</label><input name="password" type="password" autocomplete="current-password" required></p><button class="btn" type="submit">登录</button></form></section></main>`)
}

const FIELD_DEFINITIONS = {
  auth: [
    ['enabled','启用登录 API','checkbox'],['loginApiUrl','登录 API','text'],['method','请求方法','select:POST,GET,PUT,PATCH'],['requestEncoding','请求编码','select:json,form'],
    ['usernameField','用户名请求字段','text'],['passwordField','密码请求字段','text'],['headers','请求头（JSON）','json'],['staticFields','固定请求字段（JSON）','json'],
    ['successPath','成功标志路径','text'],['successValue','成功标志值','text'],['userIdPath','用户 ID 路径','text'],['displayNamePath','显示名路径','text'],
    ['rolesPath','角色路径','text'],['messagePath','错误消息路径','text'],
  ],
  mysql: [
    ['enabled','启用 MySQL','checkbox'],['host','主机','text'],['port','端口','number'],['database','数据库','text'],['username','用户名','text'],
    ['passwordSecretRef','密码引用（secret:// 或 env://）','text'],['tlsMode','TLS 模式','select:required,preferred,disabled'],['connectionLimit','连接池上限','number'],['connectTimeoutMs','连接超时（毫秒）','number'],
  ],
  redis: [
    ['enabled','启用 Redis','checkbox'],['host','主机','text'],['port','端口','number'],['database','库编号','number'],['username','用户名','text'],
    ['passwordSecretRef','密码引用（secret:// 或 env://）','text'],['tls','启用 TLS','checkbox'],['keyPrefix','Key 前缀','text'],['ttlMs','租约 TTL（毫秒）','number'],['connectTimeoutMs','连接超时（毫秒）','number'],
  ],
}

function field([name, label, type], value) {
  if (type === 'checkbox') return `<div><label class="check"><input name="${name}" type="checkbox" ${value ? 'checked' : ''}>${htmlEscape(label)}</label></div>`
  if (type === 'json') return `<div class="full"><label>${htmlEscape(label)}</label><textarea name="${name}">${htmlEscape(JSON.stringify(value, null, 2))}</textarea></div>`
  if (type.startsWith('select:')) {
    const options = type.slice(7).split(',').map((item) => `<option value="${htmlEscape(item)}" ${String(value) === item ? 'selected' : ''}>${htmlEscape(item)}</option>`).join('')
    return `<div><label>${htmlEscape(label)}</label><select name="${name}">${options}</select></div>`
  }
  return `<div><label>${htmlEscape(label)}</label><input name="${name}" type="${type}" value="${htmlEscape(value)}"></div>`
}

function localAdminPanel(localAdmin) {
  return `<h2>本地管理员账号</h2><p class="hint">恢复管理员账号始终可用，密码使用 scrypt 哈希保存。当前用户名：<strong>${htmlEscape(localAdmin.username)}</strong></p><form id="admin-password" class="grid"><div><label>当前密码</label><input name="currentPassword" type="password" autocomplete="current-password" required></div><div><label>新密码（至少 12 个字符）</label><input name="newPassword" type="password" autocomplete="new-password" minlength="12" required></div><div><label>确认新密码</label><input name="confirmPassword" type="password" autocomplete="new-password" minlength="12" required></div></form><div class="actions"><button class="btn alt" id="change-admin-password">修改管理员密码</button></div><div id="account-status" class="status"></div>`
}

function settingsPage(section, config, csrfToken, localAdmin) {
  const titles = { auth: '认证配置', mysql: 'MySQL 配置', redis: 'Redis 配置' }
  const fields = FIELD_DEFINITIONS[section].map((definition) => field(definition, config[definition[0]])).join('')
  const definitions = JSON.stringify(FIELD_DEFINITIONS[section]).replaceAll('<', '\\u003c')
  const accountPanel = section === 'auth' ? localAdminPanel(localAdmin) : ''
  return documentShell(titles[section], `<header class="top"><span class="brand">DSH 管理配置</span><a href="/">返回 DSH</a><a href="/dsh-admin/settings/auth">认证</a><a href="/dsh-admin/settings/mysql">MySQL</a><a href="/dsh-admin/settings/redis">Redis</a><form method="post" action="/dsh-auth/logout"><button class="btn alt" type="submit">退出</button></form></header><main class="wrap"><section class="card"><h1>${titles[section]}</h1><p class="hint">密码和敏感请求头只接受 secret:// 或 env:// 引用，不在页面或业务配置中保存明文。</p><form id="settings" class="grid">${fields}</form><div class="actions"><button class="btn" id="save">保存配置</button><button class="btn alt" id="test">测试连接</button></div><div id="status" class="status" style="white-space:pre-wrap;overflow-wrap:anywhere"></div>${accountPanel}</section></main><script>
  const section=${JSON.stringify(section)}, csrf=${JSON.stringify(csrfToken)}, defs=${definitions};
  const status=document.querySelector('#status');
  function collect(){const form=document.querySelector('#settings'), result={}; for(const [name,,type] of defs){const el=form.elements[name]; if(type==='checkbox') result[name]=el.checked; else if(type==='number') result[name]=Number(el.value); else if(type==='json'){try{result[name]=JSON.parse(el.value||'{}')}catch{throw new Error(name+' 不是有效 JSON')}} else result[name]=el.value} return result}
  const responseData=document.createElement('pre'); responseData.className='response-data'; responseData.style.cssText='margin:14px 0 0;padding:12px;border:1px solid #d9e2ec;border-radius:8px;background:#f8fafc;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.55 ui-monospace,monospace;display:none'; status.parentNode.insertBefore(responseData,status.nextSibling);
  const settingsForm=document.querySelector('#settings');
  if(section==='auth'){settingsForm.insertAdjacentHTML('beforeend','<div class="full"><label>测试用户名（测试连接）</label><input name="testUsername" type="text" autocomplete="username" value="admin"></div><div class="full"><label>测试密码（测试连接）</label><input name="testPassword" type="password" autocomplete="current-password"></div>'); try{settingsForm.elements.testUsername.value=localStorage.getItem('dsh-auth-test-username')||'admin'}catch{}}
  function collect(){const result={}; for(const [name,,type] of defs){const el=settingsForm.elements[name]; if(type==='checkbox') result[name]=el.checked; else if(type==='number') result[name]=Number(el.value); else if(type==='json'){try{result[name]=JSON.parse(el.value||'{}')}catch{throw new Error(name+' 不是有效 JSON')}} else result[name]=el.value} return result}
  function syncEncodingHeader(){if(section!=='auth')return; const headersEl=settingsForm.elements.headers; const encodingEl=settingsForm.elements.requestEncoding; if(!headersEl||!encodingEl)return; let headers; try{headers=JSON.parse(headersEl.value||'{}')}catch{return} const contentTypeKey=Object.keys(headers).find((name)=>name.toLowerCase()==='content-type')||'Content-Type'; headers[contentTypeKey]=encodingEl.value==='form'?'application/x-www-form-urlencoded':'application/json'; headersEl.value=JSON.stringify(headers,null,2)}
  const encodingField=settingsForm.elements.requestEncoding; if(encodingField){encodingField.addEventListener('change',syncEncodingHeader); syncEncodingHeader()}
  function showResponse(trace,fallback){const value=trace||fallback; if(value==null){responseData.textContent=''; responseData.style.display='none'; return} responseData.style.display='block'; responseData.textContent='实际执行信息（敏感值已隐藏）： '+JSON.stringify(value,null,2)}
  async function request(action){status.className='status'; status.textContent='处理中…'; responseData.style.display='none'; try{const payload={config:collect()}; if(section==='auth'&&action==='test'){const username=String(settingsForm.elements.testUsername?.value||'').trim(); const password=String(settingsForm.elements.testPassword?.value||''); if(!username||!password)throw new Error('请输入测试用户名和测试密码'); payload.credentials={username,password}; try{localStorage.setItem('dsh-auth-test-username',username)}catch{}} const response=await fetch('/dsh-admin/api/settings/'+section+(action==='test'?'/test':''),{method:action==='test'?'POST':'PUT',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify(payload)}); const result=await response.json(); const trace=result.result?.trace||result.details?.trace; if(!response.ok){const error=new Error(result.message||result.code||'请求失败'); error.trace=trace; error.fallback=result; throw error} status.className='status good'; status.textContent=action==='test'?'测试成功':'保存成功'; showResponse(action==='test'?trace:null,action==='test'?result.result:null)}catch(error){status.className='status bad'; status.textContent=(action==='test'?'测试失败：':'保存失败：')+error.message; showResponse(error.trace,error.fallback)}}
  const saveButton=document.querySelector('#save'), testButton=document.querySelector('#test'); saveButton.type='button'; testButton.type='button'; saveButton.onclick=()=>request('save'); testButton.onclick=()=>request('test');
  document.querySelectorAll('.top a').forEach((link)=>{if(link.pathname===location.pathname){link.setAttribute('aria-current','page'); Object.assign(link.style,{background:'#1f4b73',borderRadius:'8px',opacity:'1',padding:'10px 12px'})}})
  const changeButton=document.querySelector('#change-admin-password'); if(changeButton) changeButton.onclick=async()=>{const form=document.querySelector('#admin-password'), accountStatus=document.querySelector('#account-status'); accountStatus.className='status'; accountStatus.textContent='处理中…'; try{const currentPassword=form.elements.currentPassword.value,newPassword=form.elements.newPassword.value,confirmPassword=form.elements.confirmPassword.value;if(newPassword!==confirmPassword)throw new Error('两次输入的新密码不一致');const response=await fetch('/dsh-admin/api/local-admin/password',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({currentPassword,newPassword})});const result=await response.json();if(!response.ok)throw new Error(result.message||result.code||'修改失败');form.reset();accountStatus.className='status good';accountStatus.textContent='管理员密码已更新'}catch(error){accountStatus.className='status bad';accountStatus.textContent=error.message}};
  </script>`)
}

function csrfEqual(expected, actual) {
  const a = Buffer.from(String(expected || ''))
  const b = Buffer.from(String(actual || ''))
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b)
}

export class ControlPlaneWebService {
  constructor({ authService, configStore = new MemoryConfigStore(), initial = {}, initialAdmin = {}, onInitialAdmin, session = {}, sessionSecret, fetchImpl, secretResolver, connectors = {}, publicPaths = ['/health', '/ready'] } = {}) {
    this.authService = authService
    this.configStore = assertConfigStore(configStore)
    this.session = new SignedSessionCodec({ ...session, secret: sessionSecret || session.secret })
    this.loginClient = new LoginApiClient({ fetchImpl, secretResolver })
    this.connectors = connectors
    this.publicPaths = new Set(publicPaths)
    this.initialAdmin = initialAdmin
    this.onInitialAdmin = onInitialAdmin
    this.localAdmin = null
    this.initialAdminCredentials = null
    this.settings = {}
    this.ready = this.#initialize(initial)
  }

  async #initialize(initial) {
    for (const section of Object.keys(NORMALIZERS)) {
      const stored = await this.configStore.get(section)
      const normalized = NORMALIZERS[section](stored ?? initial[section] ?? DEFAULT_CONTROL_PLANE_CONFIG[section])
      this.settings[section] = normalized
      if (stored && JSON.stringify(stored) !== JSON.stringify(normalized)) await this.configStore.set(section, normalized)
    }
    const storedAdmin = await this.configStore.get('localAdmin')
    if (storedAdmin?.username && storedAdmin?.passwordHash) {
      this.localAdmin = { ...storedAdmin, username: normalizeAdminUsername(storedAdmin.username) }
      return
    }
    const username = normalizeAdminUsername(this.initialAdmin.username || 'admin')
    const suppliedPassword = this.initialAdmin.password ? validateAdminPassword(this.initialAdmin.password) : null
    const password = suppliedPassword || generateAdminPassword()
    const now = new Date().toISOString()
    this.localAdmin = { schemaVersion: 1, username, passwordHash: await hashAdminPassword(password), createdAt: now, updatedAt: now }
    await this.configStore.set('localAdmin', this.localAdmin)
    this.initialAdminCredentials = Object.freeze({ username, password, generated: !suppliedPassword })
    if (typeof this.onInitialAdmin === 'function') await this.onInitialAdmin(this.initialAdminCredentials)
    else if (!suppliedPassword) console.warn(`[dsh-server-edition] Initial local administrator created: username=${username} password=${password}`)
  }

  contextFromRequest(request) {
    const claims = this.session.fromRequest(request)
    if (!claims) return null
    return createTenantContext({ userId: claims.userId, roles: claims.roles })
  }

  async authenticate({ username, password } = {}) {
    const loginName = String(username || '').trim()
    const loginPassword = String(password || '')
    if (loginName === this.localAdmin.username) {
      if (!await verifyAdminPassword(loginPassword, this.localAdmin.passwordHash)) throw new DshPluginError('AUTHENTICATION_FAILED', '用户名或密码错误')
      return { verified: true, userId: `local-admin:${loginName}`, displayName: loginName, roles: ['admin'], source: 'local' }
    }
    if (this.settings.auth.enabled) return this.loginClient.authenticate(this.settings.auth, { username: loginName, password: loginPassword })
    throw new DshPluginError('AUTHENTICATION_FAILED', '用户名或密码错误')
  }

  async changeLocalAdminPassword({ currentPassword, newPassword } = {}, claims) {
    if (claims?.userId !== `local-admin:${this.localAdmin.username}` || !claims.roles?.includes('admin')) throw new DshPluginError('ACCESS_DENIED', '仅本地管理员可修改该密码')
    if (!await verifyAdminPassword(currentPassword, this.localAdmin.passwordHash)) throw new DshPluginError('AUTHENTICATION_FAILED', '当前密码错误')
    this.localAdmin = { ...this.localAdmin, passwordHash: await hashAdminPassword(newPassword), updatedAt: new Date().toISOString() }
    await this.configStore.set('localAdmin', this.localAdmin)
    return { username: this.localAdmin.username, updatedAt: this.localAdmin.updatedAt }
  }

  async save(section, config, context) {
    if (!context?.roles?.includes('admin')) throw new DshPluginError('ACCESS_DENIED', '仅管理员可修改配置')
    const normalize = NORMALIZERS[section]
    if (!normalize) throw new DshPluginError('CONFIG_SECTION_NOT_FOUND', '未知配置区域')
    const normalized = normalize(config)
    if (section === 'auth') this.settings.auth = normalized
    else if (this.connectors[section]?.apply) await this.connectors[section].apply(normalized)
    await this.configStore.set(section, normalized)
    this.settings[section] = normalized
    return copy(normalized)
  }

  async test(section, config, credentials, context) {
    if (!context?.roles?.includes('admin')) throw new DshPluginError('ACCESS_DENIED', '仅管理员可测试配置')
    const normalized = NORMALIZERS[section]?.(config)
    if (!normalized) throw new DshPluginError('CONFIG_SECTION_NOT_FOUND', '未知配置区域')
    if (section === 'auth') {
      const claims = await this.loginClient.authenticate(normalized, credentials)
      return { ok: true, userId: claims.userId, displayName: claims.displayName, roles: claims.roles, trace: claims.trace }
    }
    if (!this.connectors[section]?.test) throw new DshPluginError('CONNECTOR_FACTORY_REQUIRED', `目标 DSH 尚未注入 ${section} 连接器测试适配器`)
    return this.connectors[section].test(normalized)
  }

  async handle(request, next) {
    await this.ready
    const url = new URL(request.url)
    const pathname = url.pathname
    if (this.publicPaths.has(pathname)) return next ? next(request, null) : null
    if (pathname === '/dsh-auth/login' && request.method === 'GET') {
      const returnTo = safeReturnTo(url.searchParams.get('returnTo'))
      const csrf = randomBytes(24).toString('base64url')
      const secure = url.protocol === 'https:' ? '; Secure' : ''
      return new Response(loginPage({ returnTo, csrf }), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'set-cookie': `dsh_login_csrf=${csrf}; Path=/dsh-auth; HttpOnly; SameSite=Lax; Max-Age=600${secure}` } })
    }
    if (pathname === '/dsh-auth/login' && request.method === 'POST') {
      const form = await request.formData()
      const csrf = parseCookies(request.headers.get('cookie')).dsh_login_csrf
      if (!csrfEqual(csrf, form.get('csrf'))) return new Response(loginPage({ returnTo: '/', csrf: '', error: '登录页面已过期，请刷新后重试。' }), { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } })
      try {
        const claims = await this.authenticate({ username: form.get('username'), password: form.get('password') })
        const context = this.authService?.fromVerifiedClaims ? this.authService.fromVerifiedClaims({ verified: true, userId: claims.userId, roles: claims.roles }) : createTenantContext(claims)
        const token = this.session.issue({ ...context, displayName: claims.displayName })
        return redirect(safeReturnTo(form.get('returnTo')), 303, { 'set-cookie': this.session.cookie(token, request.url) })
      } catch (error) {
        const nextCsrf = randomBytes(24).toString('base64url')
        const secure = url.protocol === 'https:' ? '; Secure' : ''
        return new Response(loginPage({ returnTo: safeReturnTo(form.get('returnTo')), csrf: nextCsrf, error: error.message }), { status: 401, headers: { 'content-type': 'text/html; charset=utf-8', 'set-cookie': `dsh_login_csrf=${nextCsrf}; Path=/dsh-auth; HttpOnly; SameSite=Lax; Max-Age=600${secure}` } })
      }
    }
    if (pathname === '/dsh-auth/logout' && request.method === 'POST') return redirect('/dsh-auth/login', 303, { 'set-cookie': this.session.cookie('', request.url, { clear: true }) })

    const claims = this.session.fromRequest(request)
    if (!claims) {
      const target = safeReturnTo(`${pathname}${url.search}`)
      if (pathname.startsWith('/dsh-admin/api/')) return json({ code: 'AUTHENTICATION_REQUIRED', message: '请先登录' }, 401)
      return redirect(`/dsh-auth/login?returnTo=${encodeURIComponent(target)}`, 302)
    }
    const context = createTenantContext({ userId: claims.userId, roles: claims.roles })
    if (pathname === '/dsh-auth/session' && request.method === 'GET') return json({ userId: context.userId, displayName: claims.displayName, roles: context.roles })
    if (pathname === '/dsh-admin') return redirect('/dsh-admin/settings/auth')
    const pageMatch = pathname.match(/^\/dsh-admin\/settings\/(auth|mysql|redis)$/)
    if (pageMatch && request.method === 'GET') {
      if (!context.roles.includes('admin')) return new Response('Forbidden', { status: 403 })
      return new Response(settingsPage(pageMatch[1], this.settings[pageMatch[1]], claims.csrfToken, this.localAdmin), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
    }
    if (pathname === '/dsh-admin/api/local-admin/password' && request.method === 'POST') {
      if (!csrfEqual(claims.csrfToken, request.headers.get('x-csrf-token'))) return json({ code: 'CSRF_FAILED', message: '页面令牌无效，请刷新页面' }, 403)
      try {
        return json({ ok: true, result: await this.changeLocalAdminPassword(await request.json(), claims) })
      } catch (error) {
        return json({ code: error.code || 'ACCOUNT_ERROR', message: error.message }, error.code === 'ACCESS_DENIED' ? 403 : 400)
      }
    }
    const apiMatch = pathname.match(/^\/dsh-admin\/api\/settings\/(auth|mysql|redis)(\/test)?$/)
    if (apiMatch) {
      if (!context.roles.includes('admin')) return json({ code: 'ACCESS_DENIED', message: '仅管理员可访问' }, 403)
      if (!csrfEqual(claims.csrfToken, request.headers.get('x-csrf-token'))) return json({ code: 'CSRF_FAILED', message: '页面令牌无效，请刷新页面' }, 403)
      try {
        const body = await request.json()
        const result = apiMatch[2] ? await this.test(apiMatch[1], body.config, body.credentials, context) : await this.save(apiMatch[1], body.config, context)
        return json({ ok: true, result })
      } catch (error) {
        return json({ code: error.code || 'CONFIG_ERROR', message: error.message, details: error.details }, error.code === 'ACCESS_DENIED' ? 403 : 400)
      }
    }
    return next ? next(request, context) : json({ ok: true, userId: context.userId })
  }
}

export function apply(ctx, config = {}) {
  return registerService(ctx, id, new ControlPlaneWebService(config))
}
