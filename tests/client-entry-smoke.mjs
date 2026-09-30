import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

let definition
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
vm.runInNewContext(source, {
  window: { __ModuleLoader__: { load(value) { definition = value } } },
})
assert.equal(definition.id, '@dsh-server-edition/plugin-bundle')

const React = {
  createElement(type, props, ...children) { return { type, props: props || {}, children } },
  useEffect() {},
  useState() { return [{ userId: 'local-admin:admin', displayName: '管理员', roles: ['admin'] }, () => {}] },
}
const client = definition.factory((id) => {
  assert.equal(id, 'react')
  return React
})
assert.deepEqual([...client.inject], ['slots'])

const registrations = new Map()
const ctx = {
  slots: {
    inject(name, callback) {
      assert.ok(['sidebar.footer.action', 'settings.section'].includes(name))
      return callback()
    },
    register(options, component) {
      registrations.set(options.id || options.name, { options, component })
      return () => {}
    },
  },
}
client.apply(ctx)
const serverSettings = registrations.get('dsh-server-edition-settings')
assert.equal(serverSettings.options.id, 'dsh-server-edition-settings')
assert.equal(serverSettings.options.label, '服务器设置')
const serverRendered = serverSettings.component({ wide: true })
assert.equal(serverRendered.props.title, '服务器设置')
assert.equal(serverRendered.children[1].children[0], '服务器设置')

const userPlacement = registrations.get('dsh-server-edition-user')
assert.equal(userPlacement.options.label, '当前登录用户')
assert.equal(userPlacement.component({ wide: true }), null)

const userInfo = registrations.get('dsh-server-edition-account')
assert.equal(userInfo.options.name, 'settings.section')
assert.equal(userInfo.options.label, '用户信息')
const userInfoRendered = userInfo.component({})
assert.equal(userInfoRendered.type, 'section')
const userInfoText = JSON.stringify(userInfoRendered)
assert.match(userInfoText, /用户 ID/)
assert.match(userInfoText, /用户名/)
assert.match(userInfoText, /退出登录/)

console.log('client sidebar entry smoke passed')
