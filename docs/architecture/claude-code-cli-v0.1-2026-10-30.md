# T13 Codex / Claude Code 实际接入（Claude Code 段）— 2026-10-30

## 结论

Claude Code 走到本网关的**入口已打通**：真实 CLI 一次对话返回 200，协议模式为原生 `messages`，输出正常。
完整客户端验收**未完成**：读写文件、执行测试、连续工具调用、取消重试仍未验证；本轮新增的请求额度（42 次 / ¥1）已用尽，进一步真实验收需要新的授权。

网关侧不再有已知的阻塞缺陷；剩下的是客户端工具往返的交互式验收，需要在终端里跑一次真实任务。

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

## 未完成与边界

- **工具往返未在真实客户端闭环**：两次带工具的 headless 复现都已完成首轮请求并在客户端停滞，未发出第二轮（工具结果）请求。网关侧返回流经核对完整且事件顺序正确，停滞发生在客户端准备执行 `Bash` 之后；headless 复现用 `--settings` 覆盖了用户设置，`bypassPermissions` 的危险模式确认与工具授权都可能退回交互式提示，这与观察到的停滞一致，但**未定因**。需要一次交互式终端验收。
- **Chat 回退对 Claude Code 仍不可用**：Claude Code 固定携带 `anthropic-beta` 与 `output_config`，对没有原生 Messages 的供应商，网关按现有规则返回 `unsupported_parameter`。是否对已知安全的 beta 做降级，属于后续产品决策。
- 取消重试、费用追溯在真实客户端侧未验证（T12 已在协议层验证取消与账务）。
- 本文件不把“入口打通”混同为 T13 完成。

## 复现方式

```bash
pnpm dev                       # 复用 .runtime/review-postgres.json 工作区，Web http://localhost:5176/
claude                         # ~/.claude/settings.json 已指向 http://localhost:4300
```

故障排查入口：`x-atlas-protocol-mode` 响应头（`native` / `adapted`）、控制面服务详情的协议探测结果、`.runtime/dev-console.log`。
