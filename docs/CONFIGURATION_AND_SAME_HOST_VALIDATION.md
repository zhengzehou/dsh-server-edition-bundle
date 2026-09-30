# 配置页面与服务/Local Agent 同机验证

## 1. Web 控制面

`dsh-control-plane-web` 已适配 DSH `0.1.5-rc.2`，通过 Cordis 注入 `webServer` 和 `connection` 后自动注册：

- `/dsh-auth/login`：插件登录页。
- `/dsh-admin/settings/auth`：登录 API 与字段映射。
- `/dsh-admin/settings/mysql`：MySQL 连接与池参数。
- `/dsh-admin/settings/redis`：Redis 连接与租约参数。
- `/dsh-admin/api/settings/{auth|mysql|redis}`：管理员配置接口。

认证启用后，根路径守卫会把没有插件会话的页面请求跳转到登录页。外部登录成功后，插件调用 DSH 官方 `connection.authenticatedUrl()` 完成原生 Token/Cookie 交换，因此 `/api` 仍由 DSH 自身的 Host/Origin 和浏览器会话机制保护。禁止以 `--skip-auth` 代替该流程。

首次尚未配置认证时，仅来自回环地址的访问可以自动获得 bootstrap 管理会话。认证一旦启用，bootstrap 会话立即失效。

配置默认保存到：

```text
$DSH_HOME/config/dsh-server-edition.json
```

写入采用临时文件加原子替换。密码、Token 和敏感请求头不接受明文，只允许 `secret://NAME` 或 `env://NAME` 引用。

## 2. 认证字段映射

假设登录 API 返回：

```json
{
  "code": 0,
  "data": {
    "token": "...",
    "user": {
      "id": "u-1001",
      "name": "张三",
      "roles": ["user", "admin"]
    }
  },
  "message": "ok"
}
```

页面配置：

- `successPath=code`、`successValue=0`
- `userIdPath=data.user.id`
- `displayNamePath=data.user.name`
- `rolesPath=data.user.roles`
- `messagePath=message`

登录成功后由 DSH 自己签发签名会话 Cookie；上游 API 返回的 Token 不参与 DSH 会话，也不需要配置 Token 路径。插件 Cookie 仅含签名后的用户标识、角色、有效期和 CSRF Token。生产环境必须通过 `DSH_SESSION_SECRET` 注入稳定会话密钥。

登录 API 默认必须使用 HTTPS；仅 `127.0.0.1`、`localhost` 或 `::1` 的同机验证地址自动允许 HTTP，不再需要单独开关。

## 3. 安装与运行

```text
$env:DSH_CAPABILITIES_JSON='{"sessionPersistence":true,"pluginManager":true,"remoteOrToolProvider":true,"httpMiddleware":true}'
node tools/install.mjs --profile web --execute
dsh --profile web
```

Windows 安装器会经 `cmd.exe` 调用 `dsh.cmd`。重复安装不会重复添加依赖，并会生成 `install-state.json`。

## 4. 自动化同机验证

```text
npm test
npm run test:same-host
```

自动化覆盖：

1. 未登录重定向和插件登录页。
2. CSRF、登录 API 请求和嵌套字段映射。
3. 上游 Token 不进入浏览器 Cookie。
4. 管理员配置页及 secret reference 校验。
5. DSH `webServer` 路由注册和 bootstrap 管理会话。
6. mock Local Agent 注册、Workspace grant 和本地文件读取。
7. Local Agent 离线、撤销和路径逃逸的 Fail-Closed 语义。

## 5. 真实服务与 Local Agent 同机验收

建议端口：

```text
DSH/Gateway       127.0.0.1:3080（或 --port 0）
测试登录 API      127.0.0.1:19081
MySQL             127.0.0.1:3306
Redis             127.0.0.1:6379
Local Agent       主动连接 DSH Tool Gateway
```

验收步骤：

1. 启动 DSH，打开 `/dsh-admin/settings/auth`，配置并测试真实登录 API。
2. 配置 MySQL 和 Redis；密码使用环境变量或 Secret Manager 引用。
3. 保存认证后访问 `/`，应跳到 `/dsh-auth/login`。
4. 登录后应经过 DSH 原生令牌交换并回到首页；浏览器中不应出现上游 Token。
5. 启动 Local Agent，显式选择专用测试目录并授予 read/write/shell 权限。
6. 在 DSH 会话绑定 device/workspace，验证读取、写入和无副作用命令；工作目录必须是授权目录。
7. 停止 Local Agent 后，工具必须返回 `LOCAL_AGENT_OFFLINE`，不得在服务端执行。
8. 撤销 grant 后应返回 `SECURITY_DENIED`；`../` 和绝对路径也必须被拒绝。
9. 检查审计记录可关联 user/device/workspace/request，且不包含密码、Token、Cookie 或本地绝对路径。

MySQL Pool 与 Redis Client 的创建仍由部署适配器注入。未提供 connector 时，页面保存配置但“测试连接”返回 `CONNECTOR_FACTORY_REQUIRED`，不会伪报成功。
