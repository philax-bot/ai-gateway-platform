# 运行模式与首次安装

`pnpm review` 用于本机人工审查，默认使用隔离内存和本地模型替身。只有显式设置 `REVIEW_ALLOW_UPSTREAM_REQUESTS=true` 时，启动脚本才会把 `ALLOW_UPSTREAM_REQUESTS=true` 和同名 `UPSTREAM_*` 凭据一并传给网关，允许数据面调用已配置且验证通过的外部模型服务；每次调用都会产生真实厂商费用。持久化安装使用显式 `PLATFORM_MODE=production`。原生备份恢复、容器运行和 HTTPS API 已通过本机隔离检查；浏览器证书信任、真实内网入口与正式数据面仍须另行验收，不能只凭模式名称认定已达到生产条件。

## 控制面配置

通过服务环境变量或受控配置文件提供以下值，不将真实口令提交到仓库。`PLATFORM_MODE` 未设置时，`NODE_ENV=production` 推导为正式模式，其余为开发模式。

```env
PLATFORM_MODE=production
STORE_MODE=postgres
DATABASE_URL=postgresql://<user>:<url-encoded-password>@<db-host>:5432/<database>
DATABASE_SCHEMA=signal_atlas
SERVICE_TOKEN=<independent-random-secret-at-least-32-characters>
BOOTSTRAP_TOKEN=<different-random-secret-at-least-32-characters>
WEB_ORIGIN=https://atlas.example.com
COOKIE_SECURE=true
HOST=127.0.0.1
PORT=4001
```

安装负责人先在目标数据库中建立专用 schema，并授予运行账号使用和建表权限。应用不会自动创建数据库或 schema。`DATABASE_SCHEMA` 只能包含小写字母、数字和下划线，首字符不能为数字；正式模式不接受 `PGOPTIONS`。本机开发可沿用原配置，隔离测试继续使用本次生成的专属 schema。

正式模式在打开服务和写数据库前检查配置：禁止内存存储、默认服务令牌、相同的服务/安装口令、`DEV_LOGIN=true`、非 HTTPS 页面来源或非 Secure Cookie。口令至少 32 字符并应随机生成；例如安装负责人可分别运行 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` 生成两个不同值。`WEB_ORIGIN` 填精确来源，不含末尾斜线、路径或查询参数。

构建后运行 `pnpm --filter @ai-gateway/control-plane start`。错误配置或数据库初始化失败会退出并关闭连接池，启动失败提示不回显数据库连接串。排查顺序为配置、schema 存在性和权限、数据库连通性、发布包迁移文件与已执行版本的一致性。

## 首次管理员与空工作空间

正式模式从一个根组织开始，没有演示人员、模型、服务、模型池、方案、密钥或预置额度。首次访问页面输入安装负责人提供的安装口令、管理员姓名、登录账号和至少 12 位的密码。管理员创建只允许成功一次；之后使用普通登录。管理员已创建而登录请求失败时，页面转为登录状态，可直接重试登录。

首次开通按模型页面引导完成登记、连接与价格确认、模型池开放，再创建方案、成员并开通。新成员默认归属当前管理员的组织，不引用开发演示部门。

数据库保存安装模式。正式库以开发模式启动、开发库直接改为正式模式都会拒绝；正式模式还会拒绝检测到的旧演示凭据、固定资金批次和开发工作空间。请使用独立干净 schema，应用不会自动删除演示数据或把它当作正式余额。

## 迁移

`apps/control-plane/migrations` 是发布包的一部分。启动在同一事务和 schema 级互斥锁中应用迁移，并在 `schema_migrations` 记录版本、文件名、SHA-256 和时间。CRLF/LF 换行差异会归一化；已记录的脚本不重复执行。

迁移失败会回滚本轮 DDL、数据和版本账本。已执行脚本被改名/修改、发布包缺失已执行版本、向历史中插入未执行版本时拒绝启动。后续修改通过新增更高编号 SQL 完成，不修改已执行文件；不要通过删除版本账本绕过检查。

原先未建版本账本的开发 schema 首次升级时，会执行现有可重复的 001–008 基线，再记录版本和 009 安装模式；隔离检查已验证既有余额保持。该兼容路径不等于把开发库转为正式库，也不能替代升级前的备份与恢复演练。

## 数据面配置

```env
PLATFORM_MODE=production
CONTROL_PLANE_URL=http://127.0.0.1:4001
SERVICE_TOKEN=<same-service-secret-as-control-plane>
WEB_ORIGIN=https://atlas.example.com
GATEWAY_JOURNAL_DIR=<absolute-persistent-directory-for-this-instance>
HOST=127.0.0.1
PORT=4000
```

构建后运行 `pnpm --filter @ai-gateway/gateway-sim start`。正式模式要求受控的模型准入路由，拒绝回退到演示模型和固定计费路径。每个网关实例需要独立持久目录；目录锁不是跨主机锁。`/health` 中正式模式显示 `dataPlane=controlled-proxy`，开发模式显示 `local-simulation`。

Web 构建使用 `VITE_CONTROL_PLANE_URL`、`VITE_GATEWAY_URL` 提供浏览器可访问的公开根地址；环境变量只能包含公开地址。已有 HTTPS 同源入口、服务健康顺序、只读容器及持久日记卷，操作见 [容器与内网运行](CONTAINER-RUNBOOK.md)。模型服务需要鉴权时，控制面和网关提供同名 `UPSTREAM_*` 变量，在服务页面填写引用名；`ALLOW_UPSTREAM_VALIDATION` 与 `ALLOW_UPSTREAM_REQUESTS` 分别控制非本机验证和调用，需在获得对应授权后显式启用。本轮没有正式部署，也没有运行真实厂商模型或 Higress。

## 可重复检查

`pnpm check:delivery` 先构建，再在自动创建的专属 PostgreSQL schema 中检查迁移、空安装、安装口令、受控本地模型调用、重启保持和模式隔离。它私下读取开发连接配置，停止自己的服务并清理自己的 schema 和结算日记，不消费共享开发余额。当前证据见 [安装与模型引导验证](VALIDATION-INSTALLATION-2026-10-19.md)。

备份必须把同一账本和所有网关持久日记一起保留。`pnpm backup` / `pnpm restore` 提供不覆盖已有目标的原生归档与恢复；`pnpm check:backup` 验证恢复后待结算事件去重、会话保持和原密钥继续调用。停机顺序、参数及失败处理见 [备份与恢复](BACKUP-RESTORE.md)。
