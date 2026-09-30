window.__ModuleLoader__.load({
  id: '@dsh-server-edition/plugin-bundle',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    function SettingsIcon({ size = 18 } = {}) {
      return React.createElement('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      React.createElement('circle', { cx: 12, cy: 12, r: 3 }),
      React.createElement('path', { d: 'M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.6v-.1A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.1 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H2.3V9.6h.1A1.7 1.7 0 0 0 4.1 8.5a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 8.5 4.1a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V2.3h4v.1A1.7 1.7 0 0 0 15 4.1a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 8.5a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.1.4h.1v4h-.1A1.7 1.7 0 0 0 19.4 15Z' }))
    }

    function useSession() {
      const [session, setSession] = React.useState(null)
      React.useEffect(() => {
        let active = true
        fetch('/dsh-auth/session', { credentials: 'same-origin', cache: 'no-store' })
          .then((response) => response.ok ? response.json() : null)
          .then((currentSession) => { if (active) setSession(currentSession) })
          .catch(() => {})
        return () => { active = false }
      }, [])
      return session
    }

    function ServerSettingsAction({ wide }) {
      const session = useSession()
      if (!session?.roles?.includes('admin')) return null
      const label = '服务器设置'
      return React.createElement('button', {
        type: 'button',
        title: label,
        'aria-label': label,
        onClick: () => window.location.assign('/dsh-admin/settings/auth'),
        style: {
          alignItems: 'center',
          background: 'transparent',
          border: 0,
          borderRadius: 8,
          color: 'var(--dsw-alias-label-secondary, currentColor)',
          cursor: 'pointer',
          display: 'flex',
          gap: 10,
          justifyContent: wide ? 'flex-start' : 'center',
          minHeight: 36,
          padding: wide ? '8px 10px' : '8px',
          width: wide ? '100%' : 36,
        },
      }, React.createElement(SettingsIcon), wide ? React.createElement('span', null, label) : null)
    }

    function SettingsUserNamePlacement({ wide }) {
      const session = useSession()
      const displayName = String(session?.displayName || session?.userId || '').trim()
      React.useEffect(() => {
        if (!displayName || typeof document === 'undefined') return undefined
        let observer
        const apply = () => {
          const buttons = [...document.querySelectorAll('button[aria-haspopup="dialog"]')]
          const button = buttons.find((candidate) => {
            const label = String(candidate.getAttribute('aria-label') || '').trim()
            const text = String(candidate.textContent || '').trim()
            return label === '设置' || label.toLowerCase() === 'settings' || text === '设置' || text.startsWith('设置')
          })
          document.querySelectorAll('[data-dsh-auth-user]').forEach((node) => {
            if (!wide || node.parentElement !== button) node.remove()
          })
          if (!wide || !button) return
          let badge = button.querySelector('[data-dsh-auth-user]')
          if (!badge) {
            badge = document.createElement('span')
            badge.setAttribute('data-dsh-auth-user', '')
            Object.assign(badge.style, {
              marginLeft: '16px',
              opacity: '0.72',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            })
            button.appendChild(badge)
          }
          if (badge.textContent !== displayName) badge.textContent = displayName
        }
        apply()
        const Observer = globalThis.MutationObserver
        if (Observer && document.body) {
          observer = new Observer(apply)
          observer.observe(document.body, { childList: true, subtree: true })
        }
        return () => {
          observer?.disconnect()
          document.querySelectorAll('[data-dsh-auth-user]').forEach((node) => node.remove())
        }
      }, [displayName, wide])
      return null
    }

    function UserInfoSettingsSection() {
      const session = useSession()
      const userId = String(session?.userId || '').trim()
      const username = String(session?.displayName || session?.userId || '').trim()
      const row = (label, value) => React.createElement('div', {
        style: {
          alignItems: 'baseline',
          display: 'flex',
          gap: 12,
          justifyContent: 'space-between',
          padding: '9px 0',
        },
      }, React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary, #646a73)', fontSize: 13 } }, label), React.createElement('code', {
        style: {
          color: 'var(--dsw-alias-label-primary, #1f2329)',
          fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
          fontSize: 13,
          maxWidth: '70%',
          overflowWrap: 'anywhere',
          textAlign: 'right',
        },
      }, value || '未获取'))
      return React.createElement('section', {
        style: {
          background: 'var(--dsw-alias-bg-layer-1, #fff)',
          border: '1px solid var(--dsw-alias-border-l2, #dfe1e5)',
          borderRadius: 10,
          padding: 16,
        },
      }, React.createElement('h2', { style: { fontSize: 16, margin: '0 0 8px' } }, '用户信息'), React.createElement('p', {
        style: { color: 'var(--dsw-alias-label-secondary, #646a73)', fontSize: 12, margin: '0 0 8px' },
      }, session ? '当前登录会话' : '正在读取登录会话…'), row('用户 ID', userId), row('用户名', username), React.createElement('form', {
        action: '/dsh-auth/logout',
        method: 'post',
        style: { marginTop: 12 },
      }, React.createElement('button', {
        type: 'submit',
        style: {
          background: 'var(--dsw-alias-bg-danger, #fff)',
          border: '1px solid var(--dsw-alias-state-danger, #d64545)',
          borderRadius: 7,
          color: 'var(--dsw-alias-state-danger, #b42318)',
          cursor: 'pointer',
          font: 'inherit',
          fontSize: 13,
          padding: '7px 12px',
        },
      }, '退出登录'))
      )
    }

    // Client runtime services are injected by service name. Package activation
    // order remains declared in package.json via dsh.client.inject.
    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'dsh-server-edition-settings',
        order: 20,
        label: '服务器设置',
      }, ServerSettingsAction))
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'dsh-server-edition-user',
        order: 10,
        label: '当前登录用户',
      }, SettingsUserNamePlacement))
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-server-edition-account',
        order: 15,
        label: '用户信息',
      }, UserInfoSettingsSection))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
