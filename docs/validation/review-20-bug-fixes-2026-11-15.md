# 20 项缺陷修复与验证

日期：2026-11-15。对应 [2026-11-14 的 20 项审查清单](D:/Workspace/pri/ai-gateway-platform/docs/validation/review-20-bugs-2026-11-14.md)，20 项均已完成代码修复和本地回归验证。原始失败证据保留，新证据单独写入 `.runtime/fix-review-20-2026-11-15/`。

## 修复结果

| 编号 | 修复后的行为 | 验证重点 |
| --- | --- | --- |
| 1 | 已受理视频失败时，使用明确的实际秒数；用量未知则保持待核对 | 内存和隔离 PostgreSQL；未知费用不再确认成零，明确 3 秒按 3 秒结算 |
| 2 | 轮询更新携带任务版本；陈旧版本不写入；同一回执再次投递不重置任务 | 取消确认、进度和终态保留，旧轮询被拒绝 |
| 3 | 取消先在存储中原子认领，使用操作 token 和 30 秒租约 | 两个 Gateway 只发送一次上游取消；PostgreSQL 并发连接仅一个认领成功，迟到旧 token 不生效 |
| 4 | 先按当前启用渠道筛选，再取 100 条回调候选 | 100 条停用渠道任务之后，正常渠道任务仍能送达；停用渠道任务保留 |
| 5 | 去除派生成本、倍率、验收快照成本及历史诊断消息中的金额 | 无 `costs.read` 的角色看不到内部成本，公开销售价格和验收状态保留 |
| 6 | 非法模型标识在写追溯前拒绝；旧的永久拒绝记录隔离保留 | 正常记录可以继续投递，拒绝记录留在 `requests/rejected/` 并计入异常状态 |
| 7 | 重复 finalize 保留最终事件、blocked 状态、次数和退避时间 | HTTP 409 后普通轮询不重发；重复调用也不绕过自动退避；保留人工重试入口和重启恢复证据 |
| 8 | 凭据解析实时检查平台 Key 状态和到期时间 | 无需其他命令触发同步，到期后任务查询、下载、取消均返回 401 |
| 9 | Embedding 区分最大单条输入和整批总 Token | 9 × 1024 Token 的批次可通过 8192 单条上下文检查；总量仍进入资金预占和 TPM |
| 10 | 原生 Messages 只有最终计量证据才能确认 usage；初始 usage 不会因 error 变为最终值 | 流内错误保持原生错误帧和待核对状态；正常最终 delta 与完成事件仍可确认结算 |
| 11 | 人工确认用量在同一事务中修正原分钟的 TPM | 估算 20、实际 100 后计数为 100；不与迟到自动核对重复修正；确认未转发时仍释放预占计数 |
| 12 | Responses 因 length 截断的工具参数保留为字符串与 incomplete 状态 | 流式和非流式都保留部分 arguments；正常完成的非法 JSON 仍被拒绝 |
| 13 | 按 SSE 消息的完整 data 负载判断 `[DONE]` | 正文中的字面量不再使不完整流通过验收，真正终止消息的对照仍通过 |
| 14 | PostgreSQL 结项返回关闭前剩余可用金额，而非累计回收金额 | 初始 20、已回收 5，结项回执和审计本次回收均为 15 |
| 15 | 个人开通审批保存方案版本，执行时核对，审批修复时重新确认版本 | 方案变更后旧审批不能直接执行；明确修复批准后才能生成新版权益和后续月度发放 |
| 16 | Octop 导入只包含 Chat 模型；托管 Agent 使用服务端核定的 Chat 模型清单 | 只有 Embedding 权限时拒绝导入和启动，不签发无用途的专用 Key；交付期间权限变化会阻止生效 |
| 17 | Chat、原生协议和 Higress 配置保留 `/api/v3` 等版本路径 | 本地实际网关请求正确路径；生成的 Higress Chat、Responses、Messages 目标均保留版本 |
| 18 | 视频时长只接受合法数字，不把 null 或空字符串转换为 0 | 成功任务缺失时长进入待核对；明确 0 与未知值区分，明确 3 秒正常结算 |
| 19 | 当前对话计量只支持省略 n 或 `n=1`；其他值在授权前返回明确错误 | `n=2` 没有预占、没有上游请求；单份输出的正常请求和结算仍成功 |
| 20 | 授权幂等键按身份、凭据和用途隔离，结算键按原预占身份隔离 | 独立客户端同 key 均能处理；同客户端重放和输入冲突保护保留；旧未加命名空间的记录仍可重放 |

## 主要实现

媒体状态、取消认领和时长计量在 [media.ts](D:/Workspace/pri/ai-gateway-platform/services/gateway-sim/src/media.ts)、[media-jobs.ts](D:/Workspace/pri/ai-gateway-platform/apps/control-plane/src/store/media-jobs.ts)、[DemoStore](D:/Workspace/pri/ai-gateway-platform/apps/control-plane/src/store/demo.store.ts) 与 [PostgresStore](D:/Workspace/pri/ai-gateway-platform/apps/control-plane/src/store/postgres.store.ts)。版本和取消租约保存在现有任务 JSON 中，旧任务缺失版本时按 0 处理，无需清空或重建工作区。

计量与协议修复在 [protocol-native.ts](D:/Workspace/pri/ai-gateway-platform/services/gateway-sim/src/protocol-native.ts)、[protocol-output.ts](D:/Workspace/pri/ai-gateway-platform/services/gateway-sim/src/protocol-output.ts)、[journal.ts](D:/Workspace/pri/ai-gateway-platform/services/gateway-sim/src/journal.ts)、[media-input.ts](D:/Workspace/pri/ai-gateway-platform/services/gateway-sim/src/media-input.ts) 和 [admission.ts](D:/Workspace/pri/ai-gateway-platform/apps/control-plane/src/store/admission.ts)。可选输出参数仍保持可选，没有增加默认生成上限。

权限、审批、结项和幂等修复分别在 [billing-visibility.ts](D:/Workspace/pri/ai-gateway-platform/apps/control-plane/src/platform/billing-visibility.ts)、[workflow-actions.ts](D:/Workspace/pri/ai-gateway-platform/apps/control-plane/src/platform/workflow-actions.ts)、[workspace.repository.ts](D:/Workspace/pri/ai-gateway-platform/apps/control-plane/src/platform/workspace.repository.ts)、[accounting.ts](D:/Workspace/pri/ai-gateway-platform/apps/control-plane/src/store/accounting.ts)。

## 验证结果

- 构建：全仓构建通过，包含 Web 生产构建。现有 bundle 大小提示仍存在，没有构建错误。
- 类型：`pnpm -r typecheck` 通过。
- 单测：最新各包结果合计 **476 项通过**，contracts 47、control-plane 320、gateway-sim 109；Web 和 test-model 当前测试脚本没有独立测试用例，不计入数量。见 [全仓测试日志](D:/Workspace/pri/ai-gateway-platform/.runtime/fix-review-20-2026-11-15/all-tests-final.log) 和 [最终控制面测试日志](D:/Workspace/pri/ai-gateway-platform/.runtime/fix-review-20-2026-11-15/control-plane-tests-final.log)。
- 原失败场景：16 个脚本覆盖 20 项，全部按修复后的行为通过，见 [验收清单](D:/Workspace/pri/ai-gateway-platform/.runtime/fix-review-20-2026-11-15/validation-results.json)。重跑入口为 `node .runtime/fix-review-20-2026-11-15/run-validation.mjs`，不会覆盖原始失败证据。
- PostgreSQL 集成：`pnpm check:postgres` 的 **429 项断言通过**，包含实际网关、控制面、本地模型、授权响应丢失、并发预占、审批、权限和控制面重启恢复。见 [日志](D:/Workspace/pri/ai-gateway-platform/.runtime/fix-review-20-2026-11-15/postgres-integration.log)。
- 补充真实 PostgreSQL 检查：跨连接取消只有一个成功认领，旧轮询拒绝；迟到未转发证据释放原 TPM；旧幂等记录兼容重放。见 [并发与释放检查](D:/Workspace/pri/ai-gateway-platform/.runtime/fix-review-20-2026-11-15/postgres-concurrency-extra.log)、[旧记录兼容检查](D:/Workspace/pri/ai-gateway-platform/.runtime/fix-review-20-2026-11-15/legacy-compatibility-extra.log)。

永久回归用例新增于 [控制面边界测试](D:/Workspace/pri/ai-gateway-platform/apps/control-plane/src/store/review-regressions.spec.ts)、[网关边界测试](D:/Workspace/pri/ai-gateway-platform/services/gateway-sim/test/review-regressions.test.mjs)，并扩展了既有验收、Higress、Octop 和结算日志测试。

## 兼容性与范围

旧的个人开通审批如果没有固定方案版本，或方案版本已经变化，需要先走现有“修复审批”核对当前方案后再执行。未知取消结果的再次请求需等待 30 秒认领租约到期，避免两个执行器重复请求上游。Chat 多份输出暂时明确拒绝，其他已支持请求继续按原协议处理。

没有自动改写历史账目、回填历史费用或重放历史生成请求。已发生的漏计需要供应商真实用量证据后另行核对；代码修复不能替代该证据。

所有运行验证使用本地回环 HTTP 上游及随机隔离 PostgreSQL schema。验证脚本核对原工作区状态指纹不变，并删除本次 schema、停止本次服务；现有开发数据、上游开关和无关改动保留。未启动日常开发服务，未提交或推送 Git，未访问真实供应商，未做生产上线或真实 Higress 代理联调。没有修改 Web 页面，本轮不声称完成浏览器视觉或交互验收。
