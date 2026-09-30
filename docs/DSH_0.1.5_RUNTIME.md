# DSH 0.1.5 实机安装与运行

## 已验证环境

- DSH CLI：`0.1.5-rc.2`
- Profile：`web`
- 插件：`@dsh-server-edition/plugin-bundle`，以本地 link 安装
- DSH Home：由 DSH 启动器设置；插件配置写入 `$DSH_HOME/config/dsh-server-edition.json`

## 安装

Windows PowerShell：

```text
$env:DSH_CAPABILITIES_JSON='{"sessionPersistence":true,"pluginManager":true,"remoteOrToolProvider":true,"httpMiddleware":true}'
node tools/install.mjs --profile web --execute
```

安装器会执行：

```text
dsh plugin --profile web add <bundle-root>
```

Profile 的 `package.json` 会同时包含依赖和 `dsh.profile.bundles` 项。重复安装为幂等操作，并在仓库生成 `install-state.json`。

## 启动

```text
dsh --profile web
```

不要加 `--skip-auth`。插件会在外部登录成功后调用 DSH 官方 `connection.authenticatedUrl()` 完成原生浏览器会话交换，因此 `/api` 仍受 DSH 自带的 Host/Origin 与 Cookie 校验保护。

## 首次配置

1. 从运行 DSH 的同一台机器打开 `/dsh-admin/settings/auth`。
2. 认证尚未启用时，回环连接会自动获得临时 bootstrap 管理会话。
3. 填写登录 API、方法、请求头、请求字段和响应字段映射，先执行“测试连接”。
4. 保存并启用认证后，bootstrap 会话立即失效；重新通过 `/dsh-auth/login` 登录。
5. 登录成功后依次发生：插件租户会话签发 → DSH 一次性令牌交换 → DSH 原生 Cookie 签发 → 首页加载。

## 本次实机验收结果

- Bundle 可被 Cordis 加载，DSH 正常监听。
- `/dsh-auth/login` 返回 200 和插件登录页。
- `/dsh-admin/settings/auth|mysql|redis` 均返回 200。
- 认证启用后，未登录访问 `/` 返回 302 到插件登录页。
- 使用本机 mock 登录 API 登录后，最终 `/` 返回 200，并同时获得插件会话与 DSH 原生会话。
- Windows 安装器重复执行成功并生成安装状态记录。
