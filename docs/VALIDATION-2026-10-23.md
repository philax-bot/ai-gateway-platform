# 首版缺口实施验证（A–D，附真实模型 E）

日期：2026-10-23。工作目录：`D:\Workspace\pri\ai-gateway-platform`。范围：按 [实施与交接方案](IMPLEMENTATION-PLAN-2026-10-23.md) 完成工作包 A（调用追溯）、B（连接验证计量）、C（存量方案版本迁移）、D（浏览器回归），并追加一次真实模型 E 联调（DeepSeek 官方端点）。A–D 的自动化检查使用本地模型替身、内存及隔离 PostgreSQL schema；E 使用真实 DeepSeek 请求，仍未连接真实客户环境、企业内网、目标 SDK/工具或生产数据面。

A–D 自动化检查未重启用户的人工审查实例；E 经用户确认后先备份审查 schema，再重启持久审查实例（5176/4301/4300/4310），应用迁移 010/011，保留原业务数据。所有隔离检查使用独立端口/schema，结束后清理。

## 1. 交付摘要

| 工作包 | 结果 | 主要入口 |
| --- | --- | --- |
| A 调用追溯 | 已实现 | 上游请求号采集与持久化；`x-retry-of-request-id` 显式重试关联；调用详情“上游请求号 / 关联原调用 / 查看关联调用” |
| B 连接验证计量 | 已实现 | 服务级验证运行与逐映射结果；内部成本估算；唯一运行租约与中断恢复；验证记录分页 |
| C 方案版本迁移 | 已实现 | `entitlements.migrate` 预览/执行；同方案、同周期版本迁移，不补发额度；逐权益审计 |
| D 浏览器回归 | 已实现（本机 Chrome headless） | 46 项浏览器断言；1440 / 390 截图；320–1440 无页面级横向溢出；抽屉焦点与 Escape |
| E 真实模型联调 | **已通过（部分）** | DeepSeek 官方 `deepseek-flash`：1 次验证 + 3 次真实调用；非流式、SSE、用量、价格快照、预占结算和调用日志通过。目标 SDK/工具仍未测 |
| F 内网部署与恢复 | 阻塞：缺目标与授权 | 所需输入见 [联调与交付输入](INTEGRATION-INPUTS-2026-10-23.md) |
| G 企业身份与通知 | 阻塞：缺客户协议与目标对象 | 同上 |
| Higress | 保持暂缓 | 未 clone、未启动 PoC、未替换数据面 |

## 2. 契约与数据

### 2.1 调用追溯

- `AuthorizeRequest.retryOfRequestId`、`CallLog.upstreamRequestId`、`CallLog.retryOfRequestId`；网关请求头 `x-retry-of-request-id`。
- 上游请求号只从 `x-request-id`、`request-id` 收取，按顺序取第一个合法值；其他响应头与响应正文 completion ID 不采集。非法值（超长、控制字符）视为“上游未提供”，并继续尝试下一个受支持头。
- 重试关联在控制面核对原请求的企业、主体类型、主体、用途及项目范围。不存在与越权共用同一 409 语义；自引用返回 400。
- 无重试关联的授权指纹保持升级前格式，已有幂等键不会被判为冲突；带关联时使用 `retry-v1` 扩展格式。
- 迁移 `010_call_tracing.sql` 为 `reservations` / `call_logs` 增加字段；旧记录保持 null，不伪造历史关联。

### 2.2 连接验证计量

- 新增 `service_verification_runs`（迁移 `011_service_verifications.sql`），记录运行 ID、操作者、服务、配置版本、映射快照、开始/结束、运行状态、逐映射结果、上游请求号、用量、价格快照与内部成本状态。
- 外呼前先持久化运行与 `attemptedAt`；每个映射响应后追加结果。进程崩溃留下的运行恢复为“中断、用量待确认”，不会自动重发。
- 同一服务仅允许一个有效运行：数据库部分唯一索引 + 120 秒可续租约；内存模式等价。同键重试返回原运行，不重复外呼，并重新核对当前运营权限。
- 验证中配置变化：旧运行与用量证据保留，`verificationApplied=false`，不写为当前配置已通过。
- 诊断流量不进入 `call_logs`，因此默认不进入员工调用统计、模型业务告警分母和员工调用历史；不扣个人、项目或应用额度。内部成本仅为平台估算，不是厂商账单或新的财务结算系统。
- 价格未知或用量缺失时 `cost.amount` 为 null，不使用 0；明确 0 价格才记为 0。价格未知不阻止连接验证通过，页面显示“连接已通过，成本未知”。

### 2.3 方案版本迁移

- 命令 `entitlements.migrate`：显式权益 ID 列表、目标方案、必填原因，最多 200 项；仅运营可操作，预览签名绑定操作者、名单、目标版本与业务 revision。
- 只允许同一方案、同一次性/月度周期的旧版本权益迁到当前版本。已吊销、已到期、跨方案、周期不一致均在预览中列为不适用；执行时遇到不适用对象要求重新预览，不静默缩小名单。
- 更新 `planVersion`、`planSnapshot`、`range`；保留权益 ID、授予时间、到期日、来源、规则关联、已发周期与 `futureGrants` 状态。不补差、不发新额度、不重复发本月额度；月度后续应发周期按目标快照执行。
- 整批事务更新，逐权益写入 `entitlement.migrated` 审计；随后 `syncResources` 更新该权益关联批次的可调用模型。

## 3. 本轮实际执行的检查

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过（contracts、control-plane、web、gateway-sim、test-model） |
| `pnpm --filter @ai-gateway/control-plane test` | 21 个文件、108 项通过；新增调用追溯 9 项、验证计量 7 项、方案迁移 6 项 |
| `pnpm --filter @ai-gateway/web typecheck` / `build` | 通过；73 个模块，CSS 115.89 kB（gzip 20.61），JS 489.12 kB（gzip 149.90） |
| `pnpm --filter @ai-gateway/contracts test` | 11 项通过 |
| `pnpm check:isolated` | 296 项内存 HTTP 断言通过（同条件上一轮为 298；此前基线 277）；新增验证幂等、诊断不扣额度、重试关联、越权重试拒绝、关联调用范围。600ms 超时断言在并行构建负载下曾失败一次，单独复跑通过，未改产品逻辑 |
| `pnpm check:postgres` | 347 项隔离 PostgreSQL 断言通过（此前 328）；使用临时 `agp_check_*` schema，结束后删除 |
| `pnpm check:delivery` | 12 项迁移完整性 + 30 项交付断言通过；探针迁移版本改为从当前迁移集推导，避免新迁移编号冲突 |
| `pnpm check:web` | 46 项浏览器断言通过；Chrome headless + DevTools protocol，无新增依赖 |
| 收敛复跑（复核后） | 类型检查通过；控制面 108 项；内存 296 项；隔离 PostgreSQL 347 项；交付 42 项；备份 48 项；浏览器 46 项通过 |
| `PG_BIN=.runtime/pg-client-16.15/bin pnpm check:backup` | 通过；12 项迁移断言 + 48 项交付/备份断言；确认恢复后保留 `upstream_request_id` / `retry_of_request_id` 列、`service_verification_runs` 表及其运行证据，原日记补发与会话/余额/密钥继续可用 |
| `pnpm check:containers` | 未执行：本轮未修改容器、启动/停止或日记路径 |

## 4. 浏览器回归覆盖

`pnpm check:web` 自建独立内存审查环境（模型验证与外部请求开关均为 `false`），使用临时端口、目录与 Chrome profile。覆盖：

1. 蓝灰壳层登录运营账号，进入运营工作台。
2. 为人员开通选择人员 → 切到模型配置 → 返回，已选人员保留。
3. 模型服务“验证连接”：显示“最近一次连接验证”、内部成本与“成本未知”语义；打开逐模型诊断（上游请求号列）并用 Escape 关闭；打开验证记录并列出多次运行。
4. 已开通权益“迁移版本”：预览显示 `v1 → v2`、变更/跳过/不适用数量与“不补发额度”，确认后通过 API 核对权益版本为 2。
5. 员工登录 → 调用记录：详情显示上游请求号与原调用 ID；“查看原调用与重试”列出原调用与显式重试。
6. 三种非蓝灰壳层可渲染；320 / 360 / 736 / 1024 / 1440 无页面级横向溢出。
7. 390px 抽屉：打开后焦点移入，Tab 保持在抽屉内，Escape 关闭并把焦点返回菜单按钮。
8. 无未捕获浏览器异常。

截图（Chrome headless，1440 × 1000 / 390 × 844）：

- [为人员开通：切换页面后保留已选人员](validation/screenshots-2026-10-23/onboarding-continuity-1440.png)
- [模型连接验证：内部成本与诊断入口](validation/screenshots-2026-10-23/model-verification-1440.png)
- [方案迁移预览：版本变化与不补发额度](validation/screenshots-2026-10-23/entitlement-migration-preview-1440.png)
- [调用详情：关联原调用与显式重试](validation/screenshots-2026-10-23/call-tracing-1440.png)
- [窄屏调用记录](validation/screenshots-2026-10-23/calls-mobile-390.png)

## 5. 人工短路径

在重启后的审查环境（`pnpm review:postgres` 或 `pnpm review`）中：

1. **诊断验证 → 用量归属**：运营 → 模型配置 → 验证连接 → 查看逐模型诊断 / 验证记录。确认显示内部成本或“成本未知”，并确认个人/项目/应用额度未变化。
2. **显式重试 → 关联查看**：用同一用途密钥发起一次调用，再带 `x-retry-of-request-id` 发起一次；在调用记录详情中核对“上游请求号”和“关联原调用”，点击“查看关联调用”核对原调用与重试两行。
3. **方案迁移 → 范围与资金**：运营 → 为人员开通 → 开通设置与记录 → 迁移版本。核对预览的版本、模型增减、金额（已发不变 / 后续标准）与“不补发额度”，确认后核对权限益版本和原批次余额/到期日未变。
4. **真实模型（DeepSeek）**：运营 → 模型配置 → `deepseek官方` → 验证连接 → 验证记录；员工 → 在线使用选择 `deepseek-flash` 发送短任务 → 调用记录核对真实用量、费用和上游请求号（本供应商未提供，应显示“上游未提供”）。真实调用会产生少量厂商费用。

## 6. 未执行项与阻塞

| 项 | 状态 | 缺什么 |
| --- | --- | --- |
| `check:backup` / 新表与新列的备份恢复 | 已通过（需 `PG_BIN`） | 使用仓库内 `.runtime/pg-client-16.15/bin`；系统 PATH 默认没有 `pg_dump` |
| 真实模型联调（E） | 已通过（DeepSeek 官方） | 详见第 7 节；仍缺目标 SDK/工具、更多模型与容量样本 |
| 目标工具联调（E） | 阻塞 | 首个实际使用的 SDK/编程工具及版本、调用方式、所需能力（工具调用 / SSE / 模型发现） |
| 内网试运行与恢复（F） | 阻塞 | 目标主机与访问方式、域名与浏览器可用证书、数据库/备份目标、运行窗口 |
| 容量与恢复演练（F） | 阻塞 | 期望并发或负载样本、允许中断的隔离环境、恢复目标与证据保存位置 |
| 企业身份与通知（G） | 阻塞 | 客户实际 OIDC/SAML 协议与提供方、稳定外部标识、目录差异范围、通知通道与目标对象授权 |
| Higress | 按约定暂缓 | 不构成其余工作包的前置条件 |

信息缺失只阻塞对应实接步骤。E 已按授权对 DeepSeek 官方端点发出真实验证与调用请求（3 次调用，合计约 ¥0.00113），未发出外部工具或通知请求；不把单模型通过当作容量、内网部署或生产验收完成。所需输入的模板与结果表见 [联调与交付输入](INTEGRATION-INPUTS-2026-10-23.md)。


## 7. 真实模型联调（E，2026-10-23）

用户确认后，先备份审查 schema，再以 `pnpm review:postgres` 重启持久审查实例。备份文件：`.runtime/backups-2026-10-23/review-2026-10-23T15-39-53-597Z.dump`（54 KB，66 个恢复条目）；审查 schema 从迁移 9 升到 11，原 6 名成员、方案、权益、资金和密钥数据保留。

| 项 | 实际值 |
| --- | --- |
| 服务 | `deepseek官方`，`https://api.deepseek.com/v1`，凭据引用 `UPSTREAM_DEEPSEEK` |
| 上游模型 | `deepseek-flash`（官方端点接受；响应含 `reasoning_tokens`，行为接近推理模型） |
| 价格快照 | 输入 2 / 输出 8 / 缓存输入 0.04 元每百万 Token；价格版本 `b4cec710f89784548b95423d` |
| 连接验证 | 通过；运行 `verification-b0898b85-34ec-4234-8284-0a856523d43c`；内部成本 0.000072 元；上游请求号 null |
| 非流式调用 | HTTP 200；usage 41 / 32 / 0；实际费用 0.000338 元；已结算 |
| 流式调用 | HTTP 200；35 个 SSE 事件；`[DONE]`；usage 41 / 32 / 0；实际费用 0.000338 元；已结算 |
| 正文调用（max_tokens 256） | HTTP 200；正文“是”；usage 48 / 36（其中 reasoning 34）；实际费用 0.000384 元；已结算 |
| 余额变化 | `review-employee` 个人用途 19.99941 → 19.99835 元；与三次费用合计 0.00106 元一致 |
| 调用日志 | 3 条 `completed` / `confirmed`；`forwarded=true`；`usageFinal=true`；`upstreamRequestId=null` |

发现的真实兼容性事实：

1. DeepSeek 未返回 `x-request-id` 或 `request-id` 响应头，因此平台记录“上游未提供”，不伪造 completion ID。调用详情的“上游请求号”必须按未提供展示。
2. `deepseek-flash` 会返回 `reasoning_content` 和 `completion_tokens_details.reasoning_tokens`。首次非流式测试把 `max_tokens` 设为 32，32 个输出 token 全部用于 reasoning，正文为空；把 `max_tokens` 提高到 256 后正文正常。目标工具联调时应按推理模型预留输出预算。
3. DeepSeek 同时返回 `prompt_tokens_details.cached_tokens` 与 `prompt_cache_hit_tokens`；本次缓存命中为 0。缓存命中计费仍建议用重复长提示单独验证。
4. 非流式日志的 `ttftMs` 为空，流式请求应记录 TTFT；本次未单独断言该字段。

未覆盖：目标 SDK/编程工具、工具调用/工具结果回传、其他模型、并发与容量、流式取消后的真实上游行为、缓存命中、真实内网/TLS。E 的结论只能记为“一个真实模型、一个测试账号、三个短请求通过”。

## 8. 工具接入（用户 key，2026-10-23）

在审查实例（5176/4301/4300/4310）上用**平台签发的用户密钥**直接调用数据面，验证外部工具能否接入。测试密钥在验证后已停用，用户 key 列表回到原状。

| 场景 | 结果 |
| --- | --- |
| `GET /v1/models`（有效 key） | 200，返回该密钥授权的模型：`test-model`、`deepseek-flash` |
| `GET /v1/models`（无效 key） | 401 `authentication_error` |
| `POST /v1/chat/completions`（无效 key） | 401 |
| 本地替身 `test-model` | 200，真实用量与结算 |
| 真实 `deepseek-flash` 非流式 ×3 | 全部 200；用量 34/16、34/33、34/32；费用 0.000196 / 0.000332 / 0.000324 元，均已结算 |
| 真实 `deepseek-flash` SSE | 200，52 个事件，`[DONE]`；用量 33/50；TTFT 15070 ms；费用 0.000466 元，已结算 |
| 余额 | `review-employee` 个人用途 19.996896 元，与四次费用合计一致 |

### 8.1 修复的真实缺陷

1. **缺少模型发现接口**：网关只有 `/v1/chat/completions`，很多工具启动时会先请求 `/v1/models` 并因此失败。已新增 `GET /v1/models`：用该密钥解析凭据后返回其当前授权模型 ID，无效密钥 401，仅用于发现，每次调用仍重新校验授权。控制面 `credentials/resolve` 相应返回 `modelIds`（内存与 PostgreSQL 两种存储一致）。
2. **上游连接阶段偶发 502**：首次用用户密钥调用时出现 `upstream_http_connection`。定位为**本机网络条件**：`api.deepseek.com` 被 TUN 类代理解析到 fake-IP 段 `198.18.0.82`，DNS 解析间歇性停顿约 **11 秒**（实测 4 次里 2 次 ~11.1 秒，其余 2–3 ms），超过 undici 默认 10 秒连接超时，抛出 `UND_ERR_CONNECT_TIMEOUT`；TCP 连通本身仅 6 ms。

修复方式（只影响连接建立阶段，不改变计费语义）：

- 共享 `definitelyNotSent`/`shouldRetryConnect`：把分类从网关提升到 `packages/contracts`，数据面与控制面使用同一实现。
- 数据面对上游只允许**一次**有界重试，且仅在明确“未发出任何请求字节”时进行；部分响应、取消、超时一律不重试，因此不会重复计费。
- 验证流程同样重试一次，超时从固定 5 秒改为 `UPSTREAM_VALIDATION_TIMEOUT_MS`（1000–120000，默认 20000）。
- 新增脱敏诊断日志：只记录错误类名与 cause code，不记录 URL、请求头或凭据。

修复后同一用户密钥的四次真实调用全部成功；由于代理 DNS 仍会间歇停顿，首字节延迟可达 10–17 秒，第二次尝试通常在 5 秒内完成。这是本机代理环境的表现，不是上游模型或数据面的容量结论。

### 8.2 复跑检查

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm --filter @ai-gateway/contracts test` | 15 项通过（新增 4 项连接失败分类与重试边界） |
| `pnpm --filter @ai-gateway/gateway-sim test` | 7 项通过 |
| `pnpm --filter @ai-gateway/control-plane test` | 108 项通过 |

## 9. 边界

- 调用追溯只记录平台请求 ID、上游受支持请求头和显式重试关系；不保存提示词、回答、密钥或完整响应头集合。
- 验证计量是平台诊断证据与内部成本估算，不是厂商账单、不是第四种额度用途，也不改变既有财务结算。
- 方案迁移只处理同一方案内的版本迁移；跨方案搬迁与一次性/月度互转不在首版。
- 浏览器检查只关闭本次创建的 Chrome 上下文/进程，不按名称停止用户 Chrome；截图不含真实密钥。
- A–D 结论基于本机内存或隔离 PostgreSQL schema 与本地模型替身；E 只证明一个真实模型（DeepSeek `deepseek-flash`）在一个测试账号、一个网关和少量请求下可用，不代表其他模型、目标 SDK/工具、容量、内网部署或生产验收。
- 工具接入验证使用平台签发的用户密钥与 `curl`/Node 直连数据面，并用临时密钥完成；尚未在真实 IDE/编程工具中走通，也未验证工具侧的模型发现缓存、重试与超时行为。
- 上游延迟结论受本机代理（fake-IP DNS）影响；换到直连或稳定 DNS 环境后需重新测延迟。
