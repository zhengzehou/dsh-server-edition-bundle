# DSH Server Edition Plugin Bundle

这是面向 DSH Server Edition 的 Local Agent First 自有插件套件 v0.2.0，已适配并实机验证 DSH `0.1.5-rc.2` 的 Cordis `webServer` 与 `connection` 服务。

## 组件

运行时组件：

- `dsh-gateway-auth`：认证上下文与可信 `userId`。
- `dsh-control-plane-web`：插件登录页、未登录跳转、认证/MySQL/Redis 配置页。
- `dsh-device-workspace`：设备注册、撤销、Workspace/grant 元数据。
- `dsh-restricted-profile`：服务端 fs/shell/PTY Fail-Closed 策略。
- `dsh-local-tool-provider`：将项目文件、命令、Git、PTY 请求路由到 Local Agent。
- `dsh-runtime-manager`：Runtime 生命周期、Redis Lease/Fencing 适配。
- `dsh-persistence-spi` 与 `dsh-persistence-mysql`：租户化持久化契约和 MySQL Provider。
- `dsh-model-policy`、`dsh-plugin-registry`、`dsh-audit-otel`：模型、插件与审计策略。

运维组件：

- `dsh-persistence-migrate`：discover/plan/import/verify/cutover/rollback 迁移骨架。

## DSH 0.1.5 Web 集成

Bundle 通过 `inject = ['webServer', 'connection']` 自动完成：

- 注册 `/dsh-auth` 与 `/dsh-admin` 路由。
- 注册根路径登录守卫；认证启用后，未登录的页面请求跳到插件登录页。
- 外部登录成功后调用 DSH 官方 `connection.authenticatedUrl()`，交换原生浏览器 Cookie。
- 保留 DSH 对 `/api` 的 Host/Origin 与浏览器会话保护；无需、也不应使用 `--skip-auth`。
- 首次尚未配置认证时，仅回环地址可获得 bootstrap 管理会话。
- 配置默认持久化到 `$DSH_HOME/config/dsh-server-edition.json`，敏感内容只保存 `secret://` 或 `env://` 引用。

页面：

- `/dsh-auth/login`
- `/dsh-admin/settings/auth`
- `/dsh-admin/settings/mysql`
- `/dsh-admin/settings/redis`

详细说明见 [配置与同机验证](docs/CONFIGURATION_AND_SAME_HOST_VALIDATION.md) 和 [DSH 0.1.5 实机运行记录](docs/DSH_0.1.5_RUNTIME.md)。

## 安装和启动

```text
node tools/install.mjs --profile web --plan
node tools/install.mjs --profile web --execute
dsh --profile web
```

执行安装时需通过 `DSH_CAPABILITIES_JSON` 声明并验证 `sessionPersistence`、`pluginManager`、`remoteOrToolProvider` 和 `httpMiddleware`。Windows 安装器已通过 `cmd.exe` 调用 `dsh.cmd`，避免 `spawn dsh ENOENT/EINVAL`。

## 重要边界

MySQL Pool 与 Redis Client 仍由目标部署注入，页面负责配置校验、持久化和触发 connector。未注入 connector 时，“测试连接”明确返回 `CONNECTOR_FACTORY_REQUIRED`。项目文件、Shell 和 Git 仍必须经 Local Agent，不允许回退到服务端执行。

## 测试

```text
npm test
npm run test:same-host
```

测试覆盖租户上下文、路径边界、幂等、MySQL Provider、Runtime fencing、登录 API 映射、管理配置页、真实 DSH WebServer 路由适配及 mock Local Agent Workspace 读取。
