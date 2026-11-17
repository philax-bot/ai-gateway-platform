# 运行模式与首次安装

`pnpm dev` 是唯一本地开发入口，沿用原 PostgreSQL 开发 schema，默认在受控代理后接入 Higress，本地模型替身仍可用。页面 http://localhost:5176/，控制面 4301、受控代理 4300、模型替身 4310；前端热更新，后端修改后重启同一命令。数据库连接使用 `apps/control-plane/.env` 或进程环境中的 `DATABASE_URL`。只有显式设置 `REVIEW_ALLOW_UPSTREAM_REQUESTS=true` 才允许调用已配置且验证通过的外部模型；每次调用都会产生真实厂商费用。Higress 模式下，上游凭据由控制面发布到 Higress，代理只接收独立的内部跳转凭据；外呼开关仍按原始上游地址检查。根 `.env` 的 `REVIEW_DATA_PLANE=direct` 可使同一入口恢复直连，保留原配置与账务。详见 [正式接入与验收](architecture/higress-provider-2026-10-29.md)。持久化安装使用显式 `PLATFORM_MODE=production`。原生备份恢复、容器运行和 HTTPS API 已通过本机隔离检查；浏览器证书信任、真实内网入口及生产部署环境仍须另行验收。

独立部署 Higress 时，控制面设置 `GATEWAY_DATA_PLANE=higress`、`HIGRESS_API_URL`、`HIGRESS_API_TOKEN`、`HIGRESS_PROXY_URL`、`UPSTREAM_HIGRESS_INTERNAL`，可选 `HIGRESS_NAMESPACE`（默认 `higress-system`）。管理 API 使用受信任 HTTPS；本机回环地址可使用 HTTP。代理只需 `GATEWAY_DATA_PLANE`、`HIGRESS_PROXY_URL` 和 `UPSTREAM_HIGRESS_INTERNAL`。管理账号只授予对应命名空间内 Ingress/WasmPlugin 的读和创建、`McpBridge/default` 的读写，以及共享 `WasmPlugin/atlas-ai-proxy` 的更新权限。固定镜像、插件版本、请求 ID 保留配置和私有管理面均属于部署前置条件；本地 `pnpm dev` 自动准备这些依赖。

本地运行器启用 `HIGRESS_REQUIRE_RUNTIME_READY=true`，使用认证中继的 `/runtime/ready/<route>` 确认主路由、集群和 TCP 端点。该路径不是 Kubernetes 原生 API，生产环境需要提供等效受控观察能力后再启用此选项。当前内部跳转协议使用 `x-atlas-hop-token` 并在转发前移除；更新时控制面和代理须使用同一版本。独立部署的发布、升级和回退仍需在目标环境验收。

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

Chat Completions 支持文本和 `image_url` 输入块（远程 URL 或 Base64 data URL），包括 Pi `read` 工具之后追加的图片消息。图片原样转发，由上游校验图片格式及模型能力，网关不会下载远程图片或将图片降级成文本；音视频仍需独立计量适配。网关 JSON 正文上限为 20 MiB（含 Base64 与完整历史）；准入采用通用 BPE 文本分词加 25% 余量与 256 tokens 封装余量，每张图片另预留 8192 tokens，可能触发上下文或额度限制，最终结算采用上游真实 usage。模型端、Higress 和入口代理可能有自己的大小限制。

上游路由为 DeepSeek 官方 `api.deepseek.com` 时，网关会将 OpenAI 客户端发送的 `developer` 消息转换为 `system`，将系统消息的文本数组合并为字符串，并将已通过准入的 `max_completion_tokens` 转换为 `max_tokens`。Pi 等工具无需为此额外配置供应商兼容参数；输出上限仍须满足平台使用保护。适配依据服务的真实上游地址，其他供应商的消息角色和参数保持原协议；工具历史、思考内容与流式用量继续透传。

连接阶段的偶发失败（DNS/连接超时）只允许**一次**有界重试，且仅在明确未发出任何请求字节时进行；已开始的响应、取消和超时不会被重试，因此不会重复计费。连接验证的超时可用 `UPSTREAM_VALIDATION_TIMEOUT_MS`（1000–120000，默认 20000）调整。

2026-10-23 的本机代理排查曾出现 fake-IP DNS 解析停顿；该历史现象不作为当前网络状态。连接重试只覆盖确认未发送请求字节的失败，已发出的生成不自动重试。

### 长任务与准入诊断

`UPSTREAM_TIMEOUT_MS` 保留为总时限，默认 600000；首字节等待 `UPSTREAM_FIRST_BYTE_TIMEOUT_MS` 默认 120000；响应空闲 `UPSTREAM_IDLE_TIMEOUT_MS` 默认 60000。均为 100–3600000 毫秒整数，非法值在监听与创建日记前拒绝启动。正文任意字节（含 SSE 注释、reasoning 与工具增量）重置空闲预算，不延长总预算。超时记录具体阶段，未知用量继续进入待核对。停机排空与容器宽限见 [容器手册](CONTAINER-RUNBOOK.md)。

`request_limit_exceeded` 的响应增加 `error.details.requestLimits`：请求输出、允许输出、输入估算、模型上下文和限制来源；不暴露上游地址、资源 ID 或凭据引用。报价接口与两种存储使用相同诊断；已保存的拒绝在同键重放时保持原证据。价格未知与额度不足使用各自文案，不再统称无有效额度。三协议直接从原始结构化输入估算，不重复序列化 Messages/Responses，不将图片 Base64 当作文本。文本采用 cl100k_base 通用 BPE 加余量，图片为固定预留；均不是特定上游的精确 tokenizer 或用量上界，大图及不同模型可能超过预留，最终结算仍依上游 usage。

用量解析兼容 OpenAI `prompt_tokens_details.cached_tokens` 和 DeepSeek `prompt_cache_hit_tokens`；两者并存且矛盾时不确认费用。推理 token 已包含在输出总量中，不重复叠加；无效的最终 SSE 用量不退回早先的累计样本。

### 输出上限与费用预占（2026-11-10）

Chat 的 `max_tokens` / `max_completion_tokens`、Responses 的 `max_output_tokens` 保持可选，`null` 按未指定解释；Messages 仍按其协议要求提供正整数 `max_tokens`。显式输出上限按原值校验和转发，不用费用估算值替换。未指定且没有管理员输出限制时，不添加输出参数；管理员明确配置的输出限制继续执行。已移除通用于所有模型的 DeepSeek 393216 默认上限。

初始预占 = 输入估算费用 + 预计输出费用，不代表最高费用。模型定义可设置 `estimatedOutputTokens`（界面“预占费用的预计输出 Token”），必须为正整数且不超过上下文；留空使用 16384。预计输出量取该值、请求/策略输出上限（如有）和剩余上下文的较小值；它仅用于费用与 TPM 预留，不会成为生成限制。报价与准入共用计算，快照记录输入/输出估算及默认或模型配置来源，幂等重放沿用原快照。在线使用允许留空输出上限，并分别展示生成上限、预计输出和初始预占。

完整权威 usage 按预占时冻结的价格结算，超过初始预占时，从原批次原子补扣差额，不跨批次或用途借款。配额余额不足时保留原预占并进入待核对；记账应用正常补记实际费用、允许负余额。未知/不完整 usage 继续待核对，不用估算冒充实耗。该方案降低额度占用，但不承诺在途模型消费绝不超过剩余配额；配额不足的实际消费会作为待核对费用保留，不能当成免费调用。

专项验证：`node scripts/check-reservation-estimates.mjs`（需先构建后端，独立 PostgreSQL schema，无外呼）；原 `pnpm dev` 就绪后可运行 `node scripts/check-reservation-estimates-web.mjs` 检查可选参数界面、键盘与 1440/390 截图，不提交业务变更或调用模型。

### 结算 outbox 运维

只在网关可信内网入口使用服务令牌访问 `GET /internal/v1/outbox` 与 `POST /internal/v1/outbox/retry`，浏览器公开 Nginx 入口继续拒绝 `/internal/`。用户 API Key 无权访问。检查最多列出 100 条，可用 `?requestId=...` 查指定事件；只返回结算元数据。协议见 `contracts/data-plane-operations-v0.1.yaml`。

容器中可运行 `node scripts/outbox.mjs status`、`node scripts/outbox.mjs inspect --request <ID>`。确认合同或配置已修复后，执行 `node scripts/outbox.mjs retry --request <ID> --reason <依据>`，仅补发该 blocked 事件。queued 继续自动补发。重试复用原结算与幂等键，不重新请求模型，拒绝修改金额/用量，结构化运维日志记录原因与次数。CLI 从环境读取 `SERVICE_TOKEN`；宿主运行时用 `GATEWAY_OPERATIONS_URL` 指定可信网关来源。检查/重试均不删除日记；成功投递后才清理对应事件。

## 可重复检查

`pnpm check:delivery` 先构建，再在自动创建的专属 PostgreSQL schema 中检查迁移、空安装、安装口令、受控本地模型调用、重启保持和模式隔离。它私下读取开发连接配置，停止自己的服务并清理自己的 schema 和结算日记，不消费共享开发余额。当前证据见 [安装与模型引导验证](VALIDATION-INSTALLATION-2026-10-19.md)。

备份必须把同一账本和所有网关持久日记一起保留。`pnpm backup` / `pnpm restore` 提供不覆盖已有目标的原生归档与恢复；`pnpm check:backup` 验证恢复后待结算事件去重、会话保持和原密钥继续调用。停机顺序、参数及失败处理见 [备份与恢复](BACKUP-RESTORE.md)。


## 调用追溯与容量指标（2026-11-12）

- `GET /api/v1/platform/monitoring/capacity` 和 `POST /api/v1/platform/traces/query` 使用运营会话；普通用户无权读取系统访问链路和容量。
- `GET /internal/v1/telemetry/metrics` 使用现有 `SERVICE_TOKEN` Bearer 鉴权，返回 Prometheus 文本。采集器应按网关/控制面实例分别配置 target；容量读数为共享数据库的全局 scope，多个控制面 target 的同一资源 gauge 不应求和。
- 网关追溯日记位于 `GATEWAY_JOURNAL_DIR/requests/`，与授权/结算日记共用父目录写入所有权；备份与恢复现支持含追溯日记的格式 v3，并兼容 v1/v2。`gateway_request_traces` 表由迁移 018 创建。
- 可选 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 指向 OTLP/HTTP JSON 的完整 `/v1/traces` URL。默认未设置，不向外部系统导出。网关导出一个 SERVER span 和阶段事件，接受有效 `traceparent`，并向实际上游传播；下游需要支持同一协议才能补上其内部 span。
- OTLP 仅导出有界身份/路由元数据，不含 API Key、提示词或响应正文。配置了采集器但投递失败时，本地快照保留重送；网关 `/health` 的 `traces` 显示 pending、lastStatus、deliveryFailed 和 lastFailureAt。
- RPM/TPM 使用当前固定分钟；TPM 是限流器占用（含预估和结算调整），并发是有效预占。`mode=none` 仍统计新请求但不施加上限；旧版本未记录的无上限 scope 不回填历史流量。
- 本轮没有部署外部 Prometheus、Grafana 或链路采集后端。完整验证和接口边界见 [调用追溯与实时容量验收](validation/observability-2026-11-12.md)。

## 供应商、路由和多模态（2026-11-12）

- 模型管理新增供应商；旧服务默认 OpenAI 兼容，旧模型默认对话，旧池维持稳定分流。新策略、供应商关联与类型需要显式配置。
- 迁移 019 增加数量计量与路由查询索引；020 增加持久化视频任务。保留现有 PostgreSQL 工作区，使用原 `pnpm dev` 启动并自动迁移。
- 视频生成回执位于 `GATEWAY_JOURNAL_DIR/media-receipts`；备份格式 v4 支持该目录，恢复继续兼容 v1/v2/v3。`/health.media` 显示待投递回执和最近工作批次失败数。
- 六类新接口走受控适配器；聊天继续按既有 Higress 或受控转发设置。新增非聊天类型尚未经过 Higress 原生协议插件验证。外部非聊天调用同样要求 `ALLOW_UPSTREAM_REQUESTS=true`，网关进程持有服务绑定的 `UPSTREAM_` 引用；`pnpm dev` 在现有外部调用开关开启时也向网关传递受控引用，以支持 Higress 聊天与非聊天直连并存。
- 不自动触发外部生成。连接验证只检查非聊天模型目录；接口、计价单位、异步处理、验证命令和已知限制见 [多模态验收](validation/routing-providers-multimodal-2026-11-12.md)。
