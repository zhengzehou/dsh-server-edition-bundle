# DSH Server Edition 自有插件设计

本目录是可移植的 out-of-tree 插件适配层。它不修改 DSH 核心，不把服务端文件系统、Shell、PTY 或任意命令执行能力暴露给模型；项目文件和终端操作始终通过用户设备上的 Local Agent 完成。

## 插件清单

| 插件 | 功能 | 原理与边界 |
| --- | --- | --- |
| `dsh-gateway-auth` | 校验已验证的 issuer/audience/subject，生成不可伪造的 `userId` 租户上下文 | 认证在网关完成；后续所有服务必须接收同一个 `TenantContext`，缺少 `userId` 直接 fail-closed |
| `dsh-device-workspace` | 设备注册、撤销、工作区创建、短期授权 grant | 服务端只保存 opaque workspace/grant 元数据，不保存本地绝对路径；每次 Local Agent 请求都重新校验 grant |
| `dsh-restricted-profile` | 禁止 server fs、shell、exec、pty、terminal 和 workspace-files | 能力策略采用 deny-by-default；Local Agent 离线时不降级为服务端执行 |
| `dsh-local-tool-provider` | 将文件、Shell、Git 等请求路由到用户 Local Agent | 仅允许相对路径、绑定 `userId/deviceId/workspaceId/grantId/requestId`，支持幂等键；连接断开返回明确错误 |
| `dsh-runtime-manager` | 为活跃用户分配 Runtime，管理 Lease、TTL、续租、释放和 fencing token | 单节点使用内存 Lease；集群注入 Redis，Redis 只协调短期租约，不保存 Session/Conversation |
| `dsh-persistence-spi` | 统一 Session/Conversation、Settings、User Model、Plugin Config 的 Provider 契约 | 持久化方法必须携带租户上下文和版本；Provider 不得读取未授权租户记录 |
| `dsh-persistence-mysql` | MySQL 长期持久化、事务、连接池健康检查、幂等记录和 schema | 通过注入的 mysql2 兼容连接池工作；表中显式保留 `user_id`，消息 append 使用唯一键/版本条件；无池时保持 disabled |
| `dsh-model-policy` | 校验模型 endpoint、allowlist、HTTPS 和 credential reference | 数据库只保存 `credentialRef`，不保存明文密钥；HTTP 仅在显式开发配置下允许 |
| `dsh-plugin-registry` | 管理员安装前校验插件 manifest、sha256、签名和能力 | 默认拒绝 server-filesystem、server-shell、unrestricted child-process；普通用户不能改变安装策略 |
| `dsh-audit-otel` | 输出结构化审计事件并脱敏 | 只记录 operation、userIdHash、requestId、结果和耗时等元数据；token/password/cookie/private key 等字段递归脱敏 |
| `dsh-persistence-migrate` | 原生文件发现、计划、校验、切换和回滚编排 | 迁移是显式管理员作业；校验失败停止切换，默认不删除原始文件，切换后不静默回退 |

## 统一安装/卸载

`tools/preflight.mjs` 先检查 Node、清单、依赖图、能力声明和安全默认值。`tools/install.mjs --plan` 输出顺序，`--execute` 才调用 DSH Plugin Manager。卸载按逆拓扑顺序停用组件；默认只移除代码和注册，不删除 MySQL 数据，必须显式执行并确认数据清理作业。

## 当前交付边界

本包已经提供可运行的契约实现、内存测试替身、MySQL schema/Provider 适配器、Redis Lease 适配器、迁移状态机和安装脚本。由于交付环境没有目标 DSH Server Edition 源码，真正接入时必须先用目标 DSH 版本的能力探针确认 `sessionPersistence`、`pluginManager` 和 `remoteOrToolProvider` 扩展点，再把 `cordis.patch.yml` 的声明映射到目标 profile；探针未通过时禁止执行安装。
