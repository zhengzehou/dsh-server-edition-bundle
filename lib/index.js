import { homedir } from 'node:os'
import { join } from 'node:path'
import * as gatewayAuth from '../components/gateway-auth.js'
import * as deviceWorkspace from '../components/device-workspace.js'
import * as restrictedProfile from '../components/restricted-profile.js'
import * as localToolProvider from '../components/local-tool-provider.js'
import * as runtimeManager from '../components/runtime-manager.js'
import * as persistenceSpi from '../components/persistence-spi.js'
import * as persistenceMysql from '../components/persistence-mysql.js'
import * as modelPolicy from '../components/model-policy.js'
import * as pluginRegistry from '../components/plugin-registry.js'
import * as auditOtel from '../components/audit-otel.js'
import * as controlPlaneWeb from '../components/control-plane-web.js'
import { JsonFileConfigStore } from './file-config-store.js'
import { registerDshWebAdapter } from './dsh-web-adapter.js'
import { installSessionIsolation } from './session-isolation.js'

export const id = 'dsh-server-edition-bundle'
export const name = id
export const version = '0.3.0'
export const inject = ['webServer', 'connection']

export const componentModules = Object.freeze([
  restrictedProfile,
  gatewayAuth,
  deviceWorkspace,
  localToolProvider,
  runtimeManager,
  persistenceSpi,
  persistenceMysql,
  modelPolicy,
  auditOtel,
  pluginRegistry,
  controlPlaneWeb,
])

/** Register the stable service set plus the DSH-specific HTTP control plane. */
export function apply(ctx = {}, config = {}) {
  const services = {}
  const register = (module, key, moduleConfig = {}) => {
    const service = module.apply(ctx, moduleConfig)
    services[key] = service
    return service
  }

  register(restrictedProfile, restrictedProfile.id, config.restrictedProfile ?? config)
  const auth = register(gatewayAuth, gatewayAuth.id, config.gatewayAuth ?? config)
  const workspaceRegistry = register(deviceWorkspace, deviceWorkspace.id, config.deviceWorkspace ?? config)
  register(localToolProvider, localToolProvider.id, {
    ...(config.localToolProvider ?? {}),
    workspaceRegistry: config.workspaceRegistry ?? workspaceRegistry,
  })
  register(runtimeManager, runtimeManager.id, config.runtime ?? config)
  register(persistenceSpi, persistenceSpi.id, config.persistence ?? config)
  const persistence = register(persistenceMysql, persistenceMysql.id, {
    ...(config.persistenceMysql ?? {}),
    pool: config.pool ?? config.persistenceMysql?.pool,
  })
  register(modelPolicy, modelPolicy.id, config.modelPolicy ?? config)
  register(auditOtel, auditOtel.id, config.audit ?? config)
  register(pluginRegistry, pluginRegistry.id, config.pluginRegistry ?? config)

  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const persistedConfig = config.configStore
    ?? config.controlPlaneWeb?.configStore
    ?? new JsonFileConfigStore(join(dshHome, 'config', 'dsh-server-edition.json'))
  const web = controlPlaneWeb.apply(ctx, {
    ...(config.controlPlaneWeb ?? {}),
    authService: config.controlPlaneWeb?.authService ?? auth,
    configStore: persistedConfig,
    initial: config.infrastructure ?? config.controlPlaneWeb?.initial,
    initialAdmin: config.initialAdmin ?? config.controlPlaneWeb?.initialAdmin ?? {
      username: process.env.DSH_ADMIN_USERNAME || 'admin',
      password: process.env.DSH_ADMIN_PASSWORD,
    },
    onInitialAdmin: config.onInitialAdmin ?? config.controlPlaneWeb?.onInitialAdmin,
    sessionSecret: config.sessionSecret ?? config.controlPlaneWeb?.sessionSecret ?? process.env.DSH_SESSION_SECRET,
    secretResolver: config.secretResolver ?? config.controlPlaneWeb?.secretResolver,
    connectors: config.connectors ?? config.controlPlaneWeb?.connectors,
  })
  const nativeAuthenticatedUrl = typeof ctx.connection?.authenticatedUrl === 'function'
    ? (baseUrl) => ctx.connection.authenticatedUrl(baseUrl)
    : undefined
  const webMounted = registerDshWebAdapter(ctx, web, { nativeAuthenticatedUrl })
  const sessionIsolation = installSessionIsolation(ctx, web, { configStore: persistedConfig })

  return { id, version, services, persistence, web, webMounted, sessionIsolation }
}

export * from './errors.js'
export * from './tenant.js'
export * from './redact.js'
export * from './idempotency.js'
export * from './config.js'
export * from './session.js'
export * from './local-admin.js'
export * from './file-config-store.js'
export * from './dsh-web-adapter.js'
export * from './session-isolation.js'
export * from '../components/gateway-auth.js'
export * from '../components/device-workspace.js'
export * from '../components/restricted-profile.js'
export * from '../components/local-tool-provider.js'
export * from '../components/runtime-manager.js'
export * from '../components/persistence-spi.js'
export * from '../components/persistence-mysql.js'
export * from '../components/model-policy.js'
export * from '../components/plugin-registry.js'
export * from '../components/audit-otel.js'
export * from '../components/control-plane-web.js'
