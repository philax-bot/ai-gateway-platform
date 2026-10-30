# T13 Codex / Claude Code 实际接入（Claude Code 段）— 2026-10-30

## 结论

Claude Code 的接入已闭环：入口打通，且真实交互式对话完成了多轮工具往返与连续调用（6 次请求全部 `native` / `completed`，账务逐次确认），读写文件、执行测试这类真实任务在网关侧不再有已知阻塞缺陷。

T13 仍未整体完成：Codex 段（Responses 协议的真实客户端）与取消重试未验收。

## 复现的三层故障

用户症状：`claude` 启动后任何消息都报 `There's an issue with the selected model (deepseek-flash)`。

| 层 | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| 路由 | `POST /v1/messages?beta=true` 返回 404 | 网关用 `request.url` 全等匹配，Claude Code 的 SDK 会附加 `?beta=true` | `serveRequest` 改用 `pathname` 匹配；`?beta=true` 不再改变公共路由 |
| 适配器 | 回退到 Chat 时返回 `unsupported_parameter` | `normalizeProtocolRequest` 的返回值被丢弃，上游收到的是准入估算体的副本 | 回退路径使用转换后的请求体（`body=normalizeProtocolRequest(...)`） |
| 协议选择 | Chat 适配器收到 `output_config.effort=high` 后拒绝 | 服务缺少原生协议探测结果，网关只能按“未确认”走 Chat 回退 | 对既有 DeepSeek 服务执行三协议探测，结果落库（`configVersion: 2`），原生 `messages` 生效 |

附带的一层：CLI 的前几轮请求在控制面授权阶段超时，网关返回 `503 control_plane_unavailable`（未转发模型、预算预占已释放）。日启动脚本此前使用网关 5 秒默认超时，现已随 `pnpm dev` 注入 `CONTROL_PLANE_RPC_TIMEOUT_MS=15000`，并把启动等待上限从 12 秒放宽到 90 秒。控制面长尾本身的定因仍归属 T14。

## 证据

| 项 | 结果 | 记录 |
| --- | --- | --- |
| 三协议探测（真实 DeepSeek） | chat / messages / responses 全部 `supported`，`configVersion: 2` | `docs/validation/claude-cli-2026-10-30/service-probe.json` |
| 故障基线（本轮修复前） | 6 次请求全部 `503 control_plane_unavailable`，`protocolMode: null`，无一次转发 | `run-b5091fac-a249-45d4-8b97-83802381f774.json` |
| Claude Code 实连（修复后） | 退出码 0，`200` + `x-atlas-protocol-mode: native`，305 输入 / 3 输出 token，返回“连接成功” | `run-634c003c-4767-4d9c-b5ad-51f7a860efba.json` |
| 带工具请求（headless） | `200` + 原生，请求含 `DeferredToolPlaceholder` / `Bash` 两个工具；网关返回含 `content_block_stop` / `message_delta(tool_use)` / `message_stop` 的完整流 | `run-tools-e5d58a9c-…`、`run-tools2-fa31bac1-…` |
| 网关回归 | `@ai-gateway/gateway-sim` 69/69；`pnpm typecheck` 5 个工作区全通过 | 本地命令 |

真实请求账务：累计 **42 / 42 次**，配置价保守估算上界 **¥0.530514 / ¥1**，明细见 `.runtime/higress-live-budget-2026-10-29.json`。

## 交互式验收（2026-10-30 16:57–17:02）

用户在自己的终端用 `claude` 完成一次真实对话，网关侧记录如下（全部 `outcome: completed`、`forwarded: true`、`billableState: confirmed`、`protocol.mode: native` / `upstream: messages`）：

| 时间（CST） | 输入 token | 输出 token | 命中缓存 | 确认金额 |
| --- | --- | --- | --- | --- |
| 16:57:55 | 791 | 110 | 0 | ¥0.002462 |
| 16:57:55 | 23,535 | 290 | 0 | ¥0.049390 |
| 16:58:07 | 23,843 | 16,006 | 23,680 | ¥0.129322 |
| 16:59:23 | 39,905 | 348 | 39,680 | ¥0.004822 |
| 16:59:27 | 40,575 | 89 | 40,192 | ¥0.003086 |
| 17:02:27 | 40,320 | 63 | 40,064 | ¥0.002619 |

合计 6 次、168,969 输入 / 16,906 输出 token、143,616 命中缓存、确认金额 ¥0.191701。上下文逐轮增长并出现缓存命中，说明工具结果被回填并继续多轮调用——**客户端工具往返与连续调用在真实客户端成立**，此前 headless 复现中的停滞可归因于该复现自带的 headless 参数（`--settings` 覆盖用户设置、权限提示无 TTY），不是网关缺陷。

这 6 次由用户交互式发起，不计入脚本化验收的 42 次额度台账。

## 未完成与边界

- 取消重试、Codex 段（Responses 协议的真实客户端）未验收。
- **Chat 回退对 Claude Code 仍不可用**：Claude Code 固定携带 `anthropic-beta` 与 `output_config`，对没有原生 Messages 的供应商，网关按现有规则返回 `unsupported_parameter`。是否对已知安全的 beta 做降级，属于后续产品决策。
- 控制面长尾（偶发授权超时）未定因，归 T14；本轮只是把日启动超时放宽到 15 秒。
- 本文件不把“Claude Code 段通过”混同为 T13 完成（Codex 段、取消重试仍未验）。

## 复现方式

```bash
pnpm dev                       # 复用 .runtime/review-postgres.json 工作区，Web http://localhost:5176/
claude                         # ~/.claude/settings.json 已指向 http://localhost:4300
```

故障排查入口：`x-atlas-protocol-mode` 响应头（`native` / `adapted`）、控制面服务详情的协议探测结果、`.runtime/dev-console.log`。
