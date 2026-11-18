# 外部参考项目功能评估：sub2api / TokenHub（2026-11-18）

参考代码只读存放于 `D:\Workspace\pri\_references`（仓库外，不进入构建与 Git）。本文只做功能与设计评估，本轮不改任何业务代码、契约或数据口径。

| 项目 | 采集 | 许可证 | 技术栈 | 定位 |
| --- | --- | --- | --- | --- |
| `Wei-Shaw/sub2api` | `69d2fae` 2026-11-18 | LGPL-3.0 | Go + Gin + Ent / Vue 3 / PostgreSQL + Redis | 订阅配额分发型 AI API 网关，偏 to-C 运营 |
| `astaxie/TokenHub` | `0e627e5` 2026-11-16 | Apache-2.0 | Go + GORM / Next.js / SQLite + PostgreSQL | 企业 Token 治理：路由、权限、成本、对账 |

**许可证按处置策略写，不按结论写**：这是本项目对两个参考仓库的采用策略，不是法律意见。sub2api 为 `LGPL-3.0-or-later`（README 与 `LICENSE` 一致），本项目**只借鉴设计与交互，不复制其源码**，这样就不涉及衍生作品与再分发义务。TokenHub 是 Apache-2.0：若真的复制并再分发代码，需要随附许可证文本、标明修改、处理适用的 `NOTICE`，并逐文件核对来源；本项目当前不复制代码，因此不触达这些义务。

## 一、先划清我们已有、不必重复建设的能力

评估前先对齐本仓库现状，避免把参考项目的功能当成缺口：

- 额度与账本：来源隔离（个人 / 项目 / 应用不互补扣）、预占与结算幂等、六位金额精度、价格快照、`pending_review` 不伪装为确认扣费、资金守恒检查。
- 组织与授权：组织层级与移动影响、职责固定角色 + `packages/contracts/src/permissions.ts` 细粒度权限、审批路由与禁止自审、操作审计与保留策略。
- 数据面：`packages/contracts/src/protocol.ts` 三协议接入（Chat / Responses / Messages）、流式与工具往返、取消、超时三段、追溯与上游请求号。
- 观测：`monitoring.ts` 告警窗口 / 最小样本 / 连续触发恢复 / 知晓 / 静默；`capacity.ts` 容量占用；`gateway-trace.ts` 请求阶段轨迹。
- 安全：`guardrail.ts` 输入围栏（关闭 / 仅记录 / 拦截、预置敏感信息、自定义词、按模型作用域、`scan_limit`）；凭据加密与版本化。
- 通知：`notifications.ts` Webhook 渠道与投递（租约、重试、抑制、HTTP 状态、最后错误）。

**不能把上面这张表说成「参考项目都没有」。** 复核已确认：sub2api 同时提供 Chat Completions、Responses、Messages 三类入口（含 `count_tokens` 与 Responses 桥接），告警评估器也有滚动窗口与连续触发/恢复；TokenHub 的审批按审批流角色与项目范围校验，RBAC 与审计同样存在。我们真正值得保留的差异是这些能力**如何与用途隔离、额度预占、幂等结算和人工核对协同**——例如同一笔调用不能同时扣个人与项目额度、待核对金额不得当作已确认收入。TokenHub 自己也把「持久化全范围资金预占与崩溃恢复」列为后续工作，说明它在这条线上并不比我们完整。所以：**借鉴它们的表层能力，同时不为对齐参考模型而弱化自己的账本口径。**

## 二、建议借鉴的功能（按投入与契合度分级）

### A. 小改动、可直接落地

**A1 成本优先路由（先只做试算，不参与真实选路）**
- 来源：TokenHub `frontend/features/admin/views/model-routing-policy.tsx`、`route-management.tsx`。**复核修正**：TokenHub 的 `cost` 实际按管理员配置的 `CostScore` 排序（`backend/internal/server/gateway_http.go` 的 `sortRouteGroupByStrategy` / `routeCostScore`），不是按真实成本价；本报告原先写的「按 `costPrice` 排序」是我们自己的新策略，不能挂在「参考项目已有」名下。
- 现状：`packages/contracts/src/model-kinds.ts` 的 `ROUTING_STRATEGIES` 有稳定 / 加权 / 低并发 / 低容量 / 低延迟 / 主备，没有成本维；`ServiceModel.costPrice` 已存在，只用于成本可见性。
- **为什么不能直接进入选路**：输入便宜、输出贵的服务是否更省取决于这次请求的输入/输出量；换成另一个服务还会改变用户看到的价格快照、预占金额和可用额度，属于账本语义变更，不是排序优化。
- 做法：先只扩展**路由试算**——明确展示按什么输入量、输出量或非 Token 计量单位估算，区分「免费（显式 0）」与「成本未知」，成本差额按 `costs.read` 收口。用典型请求确认排序符合预期后，再单独立项决定是否接入选路，并在 `admission.ts` 的成本快照与预占上补证据。
- 成本：试算小、接入选路大。风险：试算低；选路会触碰预占与额度口径，必须单独验收。

**A2 错误原因分布 + 精确下钻（第一项做，只做分布与下钻，不做趋势图）**
- 来源：sub2api `frontend/src/views/admin/ops/OpsDashboard.vue`（错误分布、错误趋势、请求明细下钻）。
- 现状与缺口：`call_logs` 已有 `error_code`，`CallQuery` 已支持服务、模型、时间和「异常调用」，但**还不能按具体错误码筛选**（`apps/control-plane/src/store/call-query.ts` 的 `filterColumns` 里没有它）。因此直接加两张图会出现「点了某个原因、列表却是一批无关调用」。
- 做法（先查询与下钻，后图形）：① 契约增加 `errorCode` / `errorCodeMissing`（错误码未采集）/ `serviceMissing`（未记录路由服务）三个精确筛选；② 新增只读聚合端点，按「服务 × 模型 × 结果 × 错误码」分组，与列表**共用同一个 WHERE 构造器**；③ 监控页首屏放一张紧凑分布表，行内即下钻入口；④ 下钻统一用 `CallExplorer`，沿用时间窗、权限（`callScope`）与统计口径。
- 口径：`errors` 仍按现有定义（`outcome not in (completed, client_cancelled)`），**客户端取消单列**、不计入错误率；`error_code` 缺失的显示「未知（未采集）」，不并入某个具体原因，也不当作免费或成功。
- 验收（一个动作）：点某服务的某类错误，明细笔数与分布行笔数一致；行内分布之和等于同一窗口的 `errors`（或 `cancelled`）。
- 成本：小-中。风险：聚合查询必须走只读事务与既有 `statisticsWithin` 路径，不能拖进工作区写锁（此前踩过监控读锁嵌套申请连接）。

**A3 通知渠道与投递（拆成两项，分别排期）**
- 来源：TokenHub `frontend/features/admin/core/notification-channel-templates.ts`、`frontend/features/admin/resources/notification-channel.test.tsx`、`(console)/alert-deliveries`；sub2api 公告页 `AnnouncementsView.vue`。
- 现状：投递核心已具备（租约、8 次退避重试、`suppressed`、`nextAttemptAt`、`httpStatus`、`lastError`），监控页也已展示状态、最近尝试与下次重试。
- **A3a 低成本部分（可先做）**：从告警/事件直达对应投递记录；把 `suppressed` 的三种原因（接收端停用、接收端版本变化、规则静默）在 UI 上分开解释。不动投递状态机。
- **A3b 渠道适配（单独估算）**：飞书、企业微信要分别验证凭据形式、消息体格式和**业务回执**。现有发送器用自定义 HMAC-SHA256 签名、以 HTTP 状态判定成功、接收地址禁止查询参数（`apps/control-plane/src/platform/webhook-notifications.ts`），这三条都要为每家渠道重新确认，否则会出现平台显示「投递成功」、接收方实际拒收。
- 成本：A3a 小、A3b 每家单独估算。风险：A3b 的主要风险是把 HTTP 200 当成送达。

### B. 需改造后借鉴（中期）

**B1 供应商账单对账（外部账单 vs 内部用量）**
- **投入前提（先做，不是实现前提）**：先要一份**真实供应商账单样本**，确认它是否带逐请求标识。若只给「账号 × 模型 × 日」汇总，首版对账粒度就应该是这个粒度，而不是照搬 TokenHub 的 `request_id` 维度。没有样本就不开工。
- 来源：TokenHub `backend/internal/reconciliation/{types,policy,engine,scope,money,audit}.go`、`frontend/features/admin/views/billing-reconciliation.tsx`。
- 关键语义值得照搬：规则化（匹配维度 `request_id / provider / resource_account / model / project / currency`、金额与比例容差、时间窗 + 账单延迟、调度间隔 + 时区、版本 + 规则哈希）；差异四分类 `matched / provider_only / tokenhub_only / amount_mismatch`；运行成功后可重算，**锁定（`locked_at` / `locked_by`）后不可重算**；导出差异报告；金额字符串定点运算。
- 现状：`analytics.ts` 的 `cost.comparable*` 只做「本平台计费 vs 估算成本」的内部可比差异，没有外部供应商账单口径。
- 做法：第一阶段只做 CSV / 手工导入账单 + 规则匹配 + 四分类 + 锁定 + 审计，不做 connector 自动拉取。
- 成本：中-大。价值：财务能解释「为什么账单和平台记的不一样」，能发现漏计/多计。

**B2 改价的影子对比与证据链（三件事分开决策）**
- 来源：TokenHub `docs/billing-pricing.md`（exact shadow pricing：18 位整数 / 12 位小数、half-even、不可变版本、**发布前必须预览**、表单变更即失效预览、每请求证据 admission / prepared attempts / shadow settlement、`legacy_float_configuration` 显式标记）。
- **前提**：TokenHub 文档只支持「指定用量预览」和「为新请求记录影子费用」两种；**历史 N 天回算是额外建设**，需要先统计有多少旧记录同时具备完整用量与价格证据，否则算出来的差异会被误读为「改价影响」。
- 现状：我们已有价格快照、可信计价、预览签名（绑定输入 / 操作者 / revision / 有效期），但没有改价前的影子对比。
- 做法：先做「指定用量预览」（不依赖历史），确认无误后再做「新请求影子记录」；历史回算单独立项，并显式标出「证据不完整的记录不参与比较」。
- 成本：预览小、影子记录中、历史回算大。风险：中（计价回归面，且结论容易被当成供应商账单等价）。

**B3 安全围栏 V0.2：脱敏动作、作用域与可选模型检测器（三件事分开决策）**
- 来源：TokenHub `backend/internal/guardrails/{policy,engine,qwen_detector}.go`（detector：`pattern / sensitive_data / model`；action：`audit / mask / block`；scope：`all_projects / project`；checkpoint `before_provider`；工作预算 `64MiB/128MiB`、正则复杂度估算、findings 上限、模型不可用 `fail-closed`）；sub2api `frontend/src/i18n/locales/zh/admin/promptAudit.ts`（`off / async_audit / blocking`、9 类风险分类、节点池 + 连接探测、持久队列 + worker、运行态指标）。
- **三项分别决策**：① `mask`（本地脱敏后转发）——纯本地，可先做；② 项目/应用作用域——改的是策略求值范围，需与我们 `modelIds` 作用域共存；③ 外部模型检测器——**新增一个数据接收方**，会改变隐私边界，必须单独评审（默认关闭、显式开启、只发必要片段、失败 fail-closed），不能因为「参考项目有」就默认接受。
- 现状：我们只有 `observe / block`、按模型作用域、纯本地文本扫描 + `scan_limit`。T10 已明确「输出审核、语义攻击识别、自动脱敏」为后置项，这条正好是那条后置线的下一步。
- 做法：(1) 增加 `mask` 动作（脱敏后转发，原文不落库）；(2) 作用域下钻到项目 / 应用；(3) 可选外部 OpenAI 兼容检测器，默认关闭、显式开启、超时与失败按 fail-closed 且不改计费；(4) 把 `scan_limit` 升级为预算制（字节 × 复杂度）。
- 成本：mask 中；模型检测器中-大。风险：隐私与延迟，必须默认关闭 + 只记录命中标识（这条约束我们已经守住，别退让）。

**B4 上游资源视图：多凭据与配额窗口（先只读）**
- 来源：TokenHub `frontend/features/admin/views/{provider-api-key-pool,provider-quota-usage,provider-quota-window-details,provider-resource-probe-panel,provider-account-quota-reset,provider-subscription-reauthorization}.tsx`；sub2api `backend/internal/service/account_{scheduling_threshold_eval,quota_schedulable,quota_reset,rpm}.go` 与 `codex_7d_used_percent` / `codex_7d_reset_at` 快照口径。
- 现状：`ModelService` 是单 `credentialRef/credentialId` + 共享版本化凭据；没有「同供应商多 Key / 多订阅账号」的资源池，也没有上游剩余配额窗口与主动探测。
- 做法：第一步只读——凭据健康、最近探测结果、订阅窗口剩余与重置时间（未知就显示未知，不填 0）。第二步再评估调度，因为调度要改准入与限流模型，会碰到资金守恒与并发语义。
- 成本：只读小；调度大。价值：接入订阅型上游（Codex / Claude / Gemini CLI）时这才是真正的前置条件。

**B5 分时段计价与缓存写入细分（条件触发的低优先项）**
- 来源：TokenHub `docs/billing-pricing.md`（weekday + IANA 时区 + RFC3339 生效区间、最多 64 段、重叠拒绝、隔夜归属起始日、区间左闭右开、六种费率含 cache-write 5m/1h、显式 `0` 表示免费、缺省继承）。
- 现状：`inputPrice / outputPrice / cachedInputPrice` + `billingMultiplier` + 计量单位，没有时段与缓存写入细分。
- 判断：只有当上游真的存在错峰价（如夜间折扣）或缓存写入分档计费时才做，否则就是配置复杂度。若做，先做服务级最小版本。

**B6 可配置审批流**
- 来源：TokenHub `frontend/app/(console)/approval-flows/page.tsx`、`frontend/features/admin/resources/governance-config.tsx`。
- 现状：`ApprovalKind` 固定 10 类 + 职责路由 + 禁止自审 + 调整/撤回/重试，一致性证据完整。
- 判断：客户要自定义审批链（金额阈值、多级）时再做；改造会牵动审批幂等与「当前操作能力由服务端返回」这套已验证语义，成本大、风险高。

### C. 长期 / 有前提条件

- **C1 身份源（OIDC / SSO）**：TokenHub `(console)/identity-providers` + `backend/internal/admin`；sub2api 多 OAuth 回调（OIDC / 企业微信 / 钉钉类）。这正对应我们 T8 的阻塞项，参考价值在 discovery、state/nonce、claim→角色映射、首登绑定与撤销。仍等客户协议与目录范围。
- **C2 订阅型上游适配**：TokenHub `docs/subscription-providers.md` + `backend/internal/subscriptionworker/*`（原生 6 个 + 29 个社区适配、Node worker、CLI 依赖、重授权、隔离与超时）。若未来经我们平台分发订阅账号，这套「重授权 / 隔离 / 超时 / 配额窗口」是必读；但服务条款风险要单独立项评估。
- **C3 插件与 hook 体系**：TokenHub `(console)/plugins/**`、`backend/internal/plugin`、`plugin-devkit/`、`docs/plugin-development`；sub2api `docs/PLUGIN_DEVELOPMENT.md`、`PluginsView.vue`。我们当前是「受控数据面 + 固定适配器」，插件会扩大供应链与权限面，只作为远期扩展点记录，不建议近期引入。
- **C4 语义路由（LLM 分类选模型）**：TokenHub `docs/semantic-routing.md`。**不建议近期引入**：正文片段会出域给第三方分类器、选路不可预测导致计费归属难解释、超时/降级组合复杂。但它的失败语义值得写进我们的路由文档——候选集先由权限/健康/协议收窄，分类器只能在候选内选，低于置信度回落默认模型，失败不重复调用分类器，会话/续写绑定不走二次分类。
- **C5 多币种与汇率报表**：TokenHub `docs/billing-pricing.md`（cost statements）。我们是 CNY 单币种内部平台，价值低；但三条口径值得搬到 `UsageCostReport`：预览与导出必须同源、超行数上限就失败而不是截断、本地估算与供应商金额分列不相加。

## 三、明确不借鉴

| 内容 | 原因 |
| --- | --- |
| 支付 / 充值 / 订单 / 优惠码 / 兑换码 / 推广返利 / 订阅售卖（sub2api 大量 to-C 模块） | 与我们「企业额度批次 + 审批 + 组织分配」的模型冲突，且引入外部支付合规面 |
| 账号指纹、代理池、多账号隔离等规避上游条款的手段（sub2api `ProxiesView` / `codexFingerprintSignals` / 部分风控） | 合规红线，不做 |
| 开放注册、邮箱验证、4 语言 i18n、公众 API 文档站 | 单语言企业内部平台，不属当前边界 |
| SQLite-first 单机部署与自动迁移（TokenHub） | 我们已定 PostgreSQL 为权威账本 + 显式迁移 |
| 影子计价里「供应商账单等价」类结论性表述 | 未经验证的结论不能写成产品承诺 |

## 四、工程实践借鉴（非功能，性价比最高）

1. **资源安全清单**：sub2api `docs/agent-resource-safety.md` 可逐条映射到我们的 gateway / control-plane 审查项：不可变快照（`c.Copy()` 不算所有权转移）、入口内存预算先扣后读、解码器内外都限量、流式三层上限（行 / 事件 / 排队字节）、下游写超时与取消后的有限排空预算、**财务工作不得静默丢弃而通知可 best-effort 但需可观测丢弃**、缓存主动过期与字节上限、禁止无界 goroutine / 队列、借用缓冲的不可变假设。
   **交付形态不是抄清单，而是逐项写三列**：本项目哪个入口负责 → 已有哪条测试（例如结算积压与重放已有 `services/gateway-sim/test/outbox.test.mjs` 的阻塞/边界重放回归可直接引用）→ 还缺什么（入口内存与流式缓冲预算是当前最可能没有对应测试的一段）。
2. **迁移兼容的边界（原稿建议已作废）**：不要再把「checksum 兼容」当成缓解迁移 013 停旧实例的手段。013 的约束来自锁协议本身——新旧版本锁的不是同一个对象（工作区行 vs 策略栅栏，见 `apps/control-plane/migrations/013_admission_lock_protocol.sql` 的注释），校验和兼容只会让新旧版本都能启动，**并不会恢复并发互斥**。可借鉴的只是「已应用迁移不强制改写」这一条迁移卫生习惯。
3. **fail-closed 错误语义**：TokenHub 价格来源不可用时返回 503 `model_pricing_source_unavailable`，不静默回落 0 或旧价——与我们「价格未知不按 0 计费」同源，可统一错误码与文案。
4. **未知与证据口径**：prepared attempt 未完成 = 可能已发出，不得自动重试、不得视为免费；未知成本抑制毛利数字。这正好是我们 `pending_review` 的对外表述模板。
5. **围栏工作预算**：TokenHub 用「输入字节 × 匹配器复杂度」做总量预算并用 `regexp/syntax` 估算正则代价，比我们当前的 `scan_limit` 更可控，可作为 V0.2 的实现参考。
6. **测试组织**：TokenHub 每个管理视图配 `.test.tsx` + Playwright 用例，sub2api 每个服务文件配 `*_test.go` 覆盖取消 / 过期 / 并发边界。我们的隔离 `check:*` 已具备同等能力，可借鉴的是「边界用例清单化」而不是工具。

## 五、建议推进顺序（复核后）

1. **A2 第一项**：先交付「错误原因分布 + 精确下钻」的查询契约，再决定是否加趋势图。它直接回答值班问题——「刚才哪类错误最多，点进去是哪几笔」——也能配合监控页改版把异常放到首屏，而不是继续往容量表后面堆图。
2. **A3 拆开排期**：A3a（事件关联 + 抑制原因解释）可以随后做；A3b（飞书 / 企业微信适配）按渠道单独估算并各自验收回执。
3. **A1 只做试算**：先用典型请求验证「按什么用量估算」的排序是否符合预期，再接入选路；接入选路要单独过预占与额度口径。
4. **资源安全清单做一次短走查**：按「入口 / 已有测试 / 缺口」三列落文档，不重写测试。
5. **B 组按前提触发**：B1 等真实账单样本；B2 先做指定用量预览；B3 三项分开；B4 只读视图随订阅型上游一起做。
6. **B6 / C 组**保持条件触发：可配置审批流、插件、语义路由、多币种暂不排期。

任何一项进入实现前，按 `AGENTS.md` 的契约优先流程：先改 `packages/contracts`，再改控制面与页面，最后跑 `pnpm typecheck` / `pnpm test` / 对应 `check:*` 并留下证据。
