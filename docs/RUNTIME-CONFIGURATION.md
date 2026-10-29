# 运行模式与首次安装

`pnpm dev` 是唯一本地开发入口，沿用原 PostgreSQL 开发 schema，默认在受控代理后接入 Higress，本地模型替身仍可用。页面 http://localhost:5176/，控制面 4301、受控代理 4300、模型替身 4310；前端热更新，后端修改后重启同一命令。数据库连接使用 `apps/control-plane/.env` 或进程环境中的 `DATABASE_URL`。只有显式设置 `REVIEW_ALLOW_UPSTREAM_REQUESTS=true` 才允许调用已配置且验证通过的外部模型；每次调用都会产生真实厂商费用。Higress 模式下，上游凭据由控制面发布到 Higress，代理只接收独立的内部跳转凭据；外呼开关仍按原始上游地址检查。根 `.env` 的 `REVIEW_DATA_PLANE=direct` 可使同一入口恢复直连，保留原配置与账务。详见 [正式接入与验收](architecture/higress-provider-2026-10-29.md)。持久化安装使用显式 `PLATFORM_MODE=production`。原生备份恢复、容器运行和 HTTPS API 已通过本机隔离检查；浏览器证书信任、真实内网入口及生产部署环境仍须另行验收。

独立部署 Higress 时，控制面设置 `GATEWAY_DATA_PLANE=higress`、`HIGRESS_API_URL`、`HIGRESS_API_TOKEN`、`HIGRESS_PROXY_URL`、`UPSTREAM_HIGRESS_INTERNAL`，可选 `HIGRESS_NAMESPACE`（默认 `higress-system`）。管理 API 使用受信任 HTTPS；本机回环地址可使用 HTTP。代理只需 `GATEWAY_DATA_PLANE`、`HIGRESS_PROXY_URL` 和 `UPSTREAM_HIGRESS_INTERNAL`。管理账号只授予对应命名空间内 Ingress/WasmPlugin 的读和创建，以及 `McpBridge/default` 的读写权限。固定镜像、插件版本、请求 ID 保留配置和私有管理面均属于部署前置条件；本地 `pnpm dev` 自动准备这些依赖。

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

迁移 `013_admission_lock_protocol.sql` 将准入与策略修改切换到版本 2 锁协议。升级前必须停止同一 schema 的全部旧控制面实例，再由新版启动迁移，之后启动其余新版实例；不支持新旧锁协议混跑的滚动升级。版本账本会拒绝旧发布包在已升级 schema 上重新启动，但不能阻止仍在运行的旧进程写入。本轮只升级了自动检查创建的隔离 schema，目标环境部署仍暂缓。

版本 2 中，准入持有共享策略锁，业务配置/身份/资金修改持有独占策略锁；监控和保留清理的运行记录更新仅锁工作区行，不阻塞准入读取。运行事务同时校验不能改变业务策略、资金或凭据。准入在 `READ COMMITTED` 事务中获取策略锁后读取精简策略快照，继续使用原资金行锁与限流锁。

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

构建后运行 `pnpm --filter @ai-gateway/gateway-sim start`。正式模式要求受控的模型准入路由，拒绝回退到演示模型和固定计费路径。每个网关实例需要独立持久目录；目录锁不是跨主机锁。`/health` 中正式模式显示 `dataPlane=controlled-proxy`，开发模式显示 `local-simulation`。outbox 有 queued 或 blocked 记录时 `status=degraded`；同时返回积压数量、最长积压年龄与重试次数。HTTP 200 表示健康接口可访问，应检查 JSON 的状态与 outbox，不能据此认定结算全部正常。

Web 构建使用 `VITE_CONTROL_PLANE_URL`、`VITE_GATEWAY_URL` 提供浏览器可访问的公开根地址；环境变量只能包含公开地址。已有 HTTPS 同源入口、服务健康顺序、只读容器及持久日记卷，操作见 [容器与内网运行](CONTAINER-RUNBOOK.md)。模型服务需要鉴权时，控制面和网关提供同名 `UPSTREAM_*` 变量，在服务页面填写引用名；`ALLOW_UPSTREAM_VALIDATION` 与 `ALLOW_UPSTREAM_REQUESTS` 分别控制非本机验证和调用，需在获得对应授权后显式启用。本轮没有正式部署，也没有运行真实厂商模型或 Higress。

### 数据面对外接口

网关对已签发密钥提供两个 OpenAI 兼容接口，可直接作为外部工具的自定义 OpenAI 端点：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | 非流式与 SSE；`Authorization: Bearer sa_...`；真实用量、预占与结算走同一账本 |
| `GET` | `/v1/models` | 返回该密钥当前授权的模型 ID（`{object:"list",data:[{id,...}]}`）；无效密钥返回 401。仅用于模型发现，不替代每次调用的授权检查 |
| `GET` | `/health` | 实例与持久日记 outbox 状态 |

模型标识使用平台模型目录中的“对外模型标识”。工具文档中的 Base URL 填到 `/v1`（例如 `http://127.0.0.1:4000/v1`）。

上游路由为 DeepSeek 官方 `api.deepseek.com` 时，网关会将 OpenAI 客户端发送的 `developer` 消息转换为 `system`，将系统消息的文本数组合并为字符串，并将已通过准入的 `max_completion_tokens` 转换为 `max_tokens`。Pi 等工具无需为此额外配置供应商兼容参数；输出上限仍须满足平台使用保护。适配依据服务的真实上游地址，其他供应商的消息角色和参数保持原协议；工具历史、思考内容与流式用量继续透传。

连接阶段的偶发失败（DNS/连接超时）只允许**一次**有界重试，且仅在明确未发出任何请求字节时进行；已开始的响应、取消和超时不会被重试，因此不会重复计费。连接验证的超时可用 `UPSTREAM_VALIDATION_TIMEOUT_MS`（1000–120000，默认 20000）调整。

2026-10-23 的本机代理排查曾出现 fake-IP DNS 解析停顿；该历史现象不作为当前网络状态。连接重试只覆盖确认未发送请求字节的失败，已发出的生成不自动重试。

### 长任务与准入诊断

`UPSTREAM_TIMEOUT_MS` 保留为总时限，默认 600000；首字节等待 `UPSTREAM_FIRST_BYTE_TIMEOUT_MS` 默认 120000；响应空闲 `UPSTREAM_IDLE_TIMEOUT_MS` 默认 60000。均为 100–3600000 毫秒整数，非法值在监听与创建日记前拒绝启动。正文任意字节（含 SSE 注释、reasoning 与工具增量）重置空闲预算，不延长总预算。超时记录具体阶段，未知用量继续进入待核对。停机排空与容器宽限见 [容器手册](CONTAINER-RUNBOOK.md)。

`request_limit_exceeded` 的响应增加 `error.details.requestLimits`：请求输出、允许输出、输入估算、模型上下文和限制来源；不暴露上游地址、资源 ID 或凭据引用。报价接口与两种存储使用相同诊断；已保存的拒绝在同键重放时保持原证据。价格未知与额度不足使用各自文案，不再统称无有效额度。输入量仍是保守传输字节估算，不宣称等于模型 tokenizer。

用量解析兼容 OpenAI `prompt_tokens_details.cached_tokens` 和 DeepSeek `prompt_cache_hit_tokens`；两者并存且矛盾时不确认费用。推理 token 已包含在输出总量中，不重复叠加；无效的最终 SSE 用量不退回早先的累计样本。

### 结算 outbox 运维

只在网关可信内网入口使用服务令牌访问 `GET /internal/v1/outbox` 与 `POST /internal/v1/outbox/retry`，浏览器公开 Nginx 入口继续拒绝 `/internal/`。用户 API Key 无权访问。检查最多列出 100 条，可用 `?requestId=...` 查指定事件；只返回结算元数据。协议见 `contracts/data-plane-operations-v0.1.yaml`。

容器中可运行 `node scripts/outbox.mjs status`、`node scripts/outbox.mjs inspect --request <ID>`。确认合同或配置已修复后，执行 `node scripts/outbox.mjs retry --request <ID> --reason <依据>`，仅补发该 blocked 事件。queued 继续自动补发。重试复用原结算与幂等键，不重新请求模型，拒绝修改金额/用量，结构化运维日志记录原因与次数。CLI 从环境读取 `SERVICE_TOKEN`；宿主运行时用 `GATEWAY_OPERATIONS_URL` 指定可信网关来源。检查/重试均不删除日记；成功投递后才清理对应事件。

## 可重复检查

`pnpm check:delivery` 先构建，再在自动创建的专属 PostgreSQL schema 中检查迁移、空安装、安装口令、受控本地模型调用、重启保持和模式隔离。它私下读取开发连接配置，停止自己的服务并清理自己的 schema 和结算日记，不消费共享开发余额。当前证据见 [安装与模型引导验证](VALIDATION-INSTALLATION-2026-10-19.md)。

备份必须把同一账本和所有网关持久日记一起保留。`pnpm backup` / `pnpm restore` 提供不覆盖已有目标的原生归档与恢复；`pnpm check:backup` 验证恢复后待结算事件去重、会话保持和原密钥继续调用。停机顺序、参数及失败处理见 [备份与恢复](BACKUP-RESTORE.md)。
