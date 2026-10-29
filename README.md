# AI Gateway Platform

企业内部 AI 资源运营平台，采用“自有控制面 + 可替换数据面”：业务后端拥有身份授权、额度预占、结算和调用日志；Higress 是待验证的数据面候选。

当前核心建设顺序与逐项验收见 [核心 TODO](docs/CORE-TODO-2026-10-27.md)，本轮实现、命令和验证边界见 [2026-10-27 核心验证](docs/VALIDATION-CORE-2026-10-27.md)。目标环境部署测试按用户要求暂缓。

后续控制面性能与授权预占恢复见 [2026-10-28 P0 清单及证据](docs/CONTROL-PLANE-P0-2026-10-28.md)。

授权意图、最终写盘失败和原生备份恢复的保护已补齐；策略锁拆分与准入查询裁剪后，六组本地模型混合负载共 1615 / 1615 成功，最高组为 4 用户 / 并发 8 / 180 秒。详情与历史失败样本见 [持续负载验证](docs/VALIDATION-CAPACITY-2026-10-28.md)。负载只使用本地 HTTP 替身，没有调用配置的 DeepSeek；管理接口仍有长尾，结果不代表生产容量。

当前正在按完整首版产品推进，进度以 [完整实现清单](docs/IMPLEMENTATION-STATUS.md) 为准。运营与个人空间已接入业务 API，受控路由/计价、月度发放、故障恢复、基本监控告警、规则与导入已实现。正式 Higress 已完成本地接入及恢复验收，生产运行交付及部分业务细节仍在推进。

```text
Signal Atlas Web -> gateway-sim -> control-plane authorize
                                  -> test-model
                                  -> control-plane settlement -> call logs
```

## 当前能力

- React + Vite + TypeScript；提供 `beacon` / `azure` / `sidebar` / `next` / `classic` 五种可切换界面，默认 `sidebar`，当前审核目标为 Beacon。登录页和界面右上角一键切换并记住选择，`?ui=<界面标识>` 可临时预览。共享组件及反模式以 [组件选型与样式契约](docs/product/ui-component-contract-v1.md) 为准，业务规则与数据口径共用同一后端。
- NestJS + Fastify 控制面，支持内存演示和 PostgreSQL 持久化。
- 个人、项目成员与应用额度各自独立，不相互补扣。项目总预算与成员分配分开记账，分配保留原批次期限。
- 授权与结算幂等，并发重复授权只产生一个预占；重复结算只生成一条日志和一次资金变化。
- 非流式、SSE、上游失败、超时、客户端取消和中断记录。用量不完整时保留预占并进入 `pending_review`，不显示为确认扣费。
- 方案支持一次性/月度、自动 AND 条件、存量显式应用、目录标识导入与逐人结果。范围发放明确区分开通和已有权益追加。
- 前端可选择用途、在线流式使用、取消、按职责分页检索历史调用，并核对不完整用量的原预占。
- 运行面板按服务/模型汇总已结束请求，显示统计分母、未知用量、TTFT 样本与在途预占；告警支持窗口、最小样本、连续触发/恢复和知晓。
- Redis 仅检查连通与健康，不参与额度权威计算。已接密码登录与会话；DeepSeek 有少量真实调用的历史证据，不能扩展为生产容量结论。Higress 已完成第一阶段隔离链路，默认数据面与正式 Provider 尚未切换；企业 SSO/目录和外部通知仍未实接。真实外呼需显式开启对应开关并使用指定目标。

## 本地运行

本地开发统一使用一个命令，安装依赖后在仓库根目录运行：

```powershell
pnpm install
pnpm dev
```

打开 [本地开发页面](http://localhost:5176/)。首次自动准备五个开发账号，账号和任务路径见 [人工审查清单](docs/MANUAL-REVIEW.md)，统一初始密码 `Review-local-2026!`。

- 固定端口：Web `5176`、控制面 `4301`、网关 `4300`、本地模型替身 `4310`，全部仅监听本机。
- 使用 `apps/control-plane/.env` 或进程环境中的 `DATABASE_URL`，沿用既有 `.runtime/review-postgres.json` 指向的独立开发 schema；重启保留账号、资金、Key、配置和调用记录。数据库不可达或端口占用会直接报错，不切换到内存、不另起端口。
- 前端源码修改后自动更新；后端或共享契约改动后按 Ctrl+C，再运行 `pnpm dev`，自动重新构建。Ctrl+C 统一停止本次启动的服务。
- Web、网关、控制面及 Octop 导入地址由启动器统一生成，不必分别设置 `STORE_MODE`、`SERVICE_TOKEN` 和 `VITE_*`。运行目录与网关结算日记保持原位置。
- 默认使用本地模型替身。根 `.env` 中已有的 `REVIEW_ALLOW_UPSTREAM_VALIDATION` / `REVIEW_ALLOW_UPSTREAM_REQUESTS` 显式开关继续生效，开启后真实模型调用会产生费用；启动日志会显示状态。

原 `pnpm review`、`pnpm review:postgres` 和根目录 `dev:*` 分服务入口已移除。专项 `check:*` 仍独立创建临时环境并清理，不作为日常启动方式；`scripts/review.mjs` 是开发启动器及历史隔离检查复用的内部实现。

新业务 Key 使用准入时的服务价格快照，按输入、输出及缓存子集结算；工具 Base URL 填 `http://localhost:4300/v1`。正式环境配置、迁移和首次安装见 [运行模式与首次安装](docs/RUNTIME-CONFIGURATION.md)，备份见 [备份与恢复](docs/BACKUP-RESTORE.md)，部署见 [容器与内网运行](docs/CONTAINER-RUNBOOK.md)。

## 可重复验收

推荐使用隔离检查，自动启动随机本地端口并在结束后停止服务：

```powershell
pnpm typecheck
pnpm test
pnpm check:isolated
pnpm check:postgres
pnpm check:delivery
pnpm check:backup
pnpm check:containers
pnpm check:web
pnpm check:gateway
pnpm check:load
pnpm check:load:postgres
```

`check:isolated` 构建并运行内存控制面、真实模拟网关和仓库内 HTTP 模型替身，无需数据库。`check:postgres` 从控制面配置读取数据库连接，只创建本次专属 `agp_check_<uuid>` schema；测试后移除该 schema，不重置或消费共享演示批次。需要账号具有创建 schema 权限。

`check:gateway` 覆盖本地工具协议、超时/取消和 outbox 运维边界。`check:load` / `check:load:postgres` 使用独立工作空间、平台签发密钥和确定性本地模型，混合非流式/SSE、工作区读取与手动维护，核对每笔已确认调用、资金守恒、未最终结算预占和 outbox；数据库模式只创建并清理 `agp_load_<uuid>` schema。默认并发 4、48 个请求，可追加 `--concurrency 8 --requests 120`；持续多用户样本使用 `--concurrency 8 --users 4 --duration 60`，按时长停止发起新请求并等候在途完成，默认最多 2000 次，可显式降低请求上限。报告包含环境、工作区是否有未提交修改和有界 SQL/连接池耗时诊断，默认保存在 `.runtime/load-results/`；样本不代表真实模型或生产容量上限。GitHub 核心回归配置位于 `.github/workflows/core.yml`，远端运行状态单独验收。

`check:isolated` / `check:postgres` 另用本地响应丢失代理，验证授权已提交但响应丢失、晚于 5 秒 RPC 预算提交、授权期间强制退出/重启、双网关相同请求、旧记录缺少归属和结算确认丢失。检查恢复前后资金、模型转发次数、原事件重试和数据库账目；不会外呼真实模型。

真实 Pi + DeepSeek 检查另有 `node scripts/check-live-deepseek.mjs --allow-upstream <Pi CLI 的绝对路径>`；必须显式选择外呼，使用已有审查配置中的官方 DeepSeek 路由/受控凭据引用，在独立内存工作空间发出最多 8 次请求，按配置价格保守估算上限 ¥0.10。原 Pi / CC Switch 配置只读，临时密钥与运行目录在结束后清理，报告写入 `.runtime/live-results/`（可用 `LIVE_REPORT_PATH` 指定新文件）。该估算不是供应商账单或未知取消费用的最终确认；真实测试不进入 CI，也不自动重复执行。

`check:delivery` 同样只使用本次专属 schema，验证迁移完整性、并发/回滚、正式空安装、受控本地调用、重启保持和安装模式隔离。当前结果为 30 项通过，见 [安装与模型引导验证](docs/VALIDATION-INSTALLATION-2026-10-19.md)；不包含真实 TLS、备份恢复或正式部署。2026-10-23 新增迁移 010/011 后，探针迁移版本改为从当前迁移集推导，迁移完整性断言 12 项与交付断言 30 项通过。

`check:backup` 在上述安装检查中追加原生 PostgreSQL 归档/恢复、日记补发、原会话和密钥继续使用等检查，共 48 项交付/备份断言通过，并确认恢复保留调用追溯列与验证运行证据。需要 `pg_dump` / `pg_restore`；系统 PATH 没有时可用 `PG_BIN=.runtime/pg-client-16.15/bin pnpm check:backup`。`pnpm backup` / `pnpm restore` 用于明确目标后的运维操作，具体参数、停机要求与目标保护见 [备份与恢复](docs/BACKUP-RESTORE.md)。

2026-10-28 已在迁移 012 上重新通过 12 项迁移完整性及 55 项交付/原生备份恢复断言，新增授权子目录、完整结算临时文件及归属篡改保护。原 48 项为此前发布的历史记录。

`check:containers` 构建三个交付镜像，在独立 Compose 项目验证 HTTPS、正式安装、凭据传递、流式分段、停止时在途结算、持久卷与容器内原生恢复，共 19 项通过。它使用专属 PostgreSQL 容器和本地模型替身，不读取开发数据库；默认清理自己的测试项目。运行条件与证据见 [容器停止与恢复复核](docs/VALIDATION-CONTAINERS-2026-10-20.md)。

`check:web` 使用本机 Chrome headless（DevTools protocol，不新增测试依赖）启动独立内存审查环境，覆盖登录、开通连续性、连接验证记录、方案版本迁移预览/确认、调用追溯、三种壳层、320–1440 横向溢出、390 抽屉键盘路径与 Escape，并把 1440/390 截图写入 `docs/validation/screenshots-2026-10-23/`。当前 46 项断言通过；需要 Chrome，缺失时可用 `CHROME_PATH` 指定。它不访问真实模型，`ALLOW_UPSTREAM_VALIDATION` / `ALLOW_UPSTREAM_REQUESTS` 固定为 `false`。

检查覆盖原纵向闭环、双用途隔离、并发重复授权/结算、幂等冲突、六位金额精度、JSON/HTML 上游错误、不可达、超时、SSE 中断、客户端取消及重复转发保护。PostgreSQL 模式还验证进程重启后的余额与日志。2026-10-23 起另覆盖上游请求号采集、显式重试关联与越权拒绝、诊断验证幂等与不扣业务额度。详见 [本轮验证](docs/VALIDATION-2026-10-23.md)。

已有服务运行时也可执行 `pnpm check:local`，但它会消费所连接环境的个人演示额度，隔离回归更适合日常开发。

仓库提供同一个模型替身的 Postman simulation：

```powershell
postman simulation run postman/simulations/gateway-failures.sim.yaml --port 19410 --no-history --output ndjson
```

另一个终端：

```powershell
$env:SIMULATION_MODEL_URL = 'http://127.0.0.1:19410/model'
pnpm check:isolated
pnpm check:postgres
```

当前 mock 来自本仓库的测试模型响应格式，不依赖外部厂商或工作区资源。以上命令只在本地运行，不发布、部署或推送 Postman 资源。模拟器请求日志用于确认实际依赖路径已执行。

## 合同与当前边界

- 合同：`contracts/gateway-control-plane-v0.1.yaml`；共享类型：`packages/contracts/src/index.ts`。
- 用途额度演示查询：`GET /api/v1/calls/quota?purpose=personal|project`；演示日志：`GET /api/v1/calls`。这些旧接口要求服务令牌；浏览器使用登录会话。`/api/v1/platform/state` 为工作空间快照，`POST /api/v1/platform/calls/query` 先按职责收窄，再返回游标分页与全部筛选结果汇总。
- 身份和用途来自控制面解析的 API Key，不能由请求正文改写。
- 重复授权返回 `replayed=true`；模拟网关返回 `409`，避免用同一预占重复请求上游。当前不缓存并重放模型正文。
- 中断或租约过期且最终用量未知时，保留预占并进入 `pending_review`。费用核对页可按原价格确认完整用量，或填写依据释放预占；补扣仅使用原资金批次。
- 模拟网关在授权 RPC 前持久化意图，并用 `admissionAttemptId` 识别第一笔授权的物理归属；授权响应丢失后只恢复授权结果，不重发模型请求。已知未转发且归属吻合才释放原预占；其他网关的归属不触发资金操作，缺少归属的旧记录阻塞供核查。转发前保存准入/分派事件，结算失败保留原事件并在重启后补发。每个实例必须配置独立、持久化的 `GATEWAY_JOURNAL_DIR`；目录写锁只保护本地单实例。已验证进程重启，未验证整机断电/存储损坏。检查/重试用 `scripts/outbox.mjs`，授权意图重试额外指定 `--attempt`；仅接受服务令牌，不能修改原事件或金额。
- 监控只统计已识别身份、控制面已记录的请求；无流量/采集失败/样本不足不会自动宣称恢复。面板在途是有效预占数量，吞吐为五分钟窗口平均值，不能作为模型容量结论。
- 新业务 API 已接入密码登录、固定职责与对象范围；新签发密钥仅保存 SHA-256 哈希，完整值只在签发响应出现一次。正式模式已禁用演示种子并拒绝默认服务令牌，开发默认配置仅用于本地/隔离回归；完整权限、部署和运维验收仍未完成。
- `GatewayProvider` 保持业务对象与 Higress 对象隔离；正式 `HigressProvider` 已接入认证管理 API，配置状态与操作保存在 PostgreSQL。首次 PostgreSQL/DeepSeek 验收及后续 75 项恢复检查通过，180 秒本地替身负载 1081/1081 成功。日常 `pnpm dev` 默认使用 Higress，原准入、价格快照、持久日记和结算继续生效。见 [接入记录](docs/architecture/higress-provider-2026-10-29.md)、[恢复与负载证据](docs/architecture/higress-stability-2026-10-29.md)；[第一阶段 PoC](docs/architecture/higress-poc-2026-10-29.md) 保留为历史记录。 实际 Pi 工具任务、31.863 秒完整长流及取消后关联重试见 [真实任务验收](docs/architecture/higress-pi-deepseek-2026-10-29.md)。

验证层级见 [开发边界](docs/DEVELOPMENT-BOUNDARIES.md)，最新证据见 [2026-10-19 验证记录](docs/VALIDATION-ONBOARDING-2026-10-19.md)。本地/Mock/开发数据库结果不等于生产验收。
