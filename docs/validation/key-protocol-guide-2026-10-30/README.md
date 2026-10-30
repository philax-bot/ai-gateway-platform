# 三协议接入指引与 Claude 查询参数路由修复

日期：2026-10-30。

- 密钥详情新增 Chat Completions、OpenAI Responses、Anthropic Messages 切换说明，展示各自 Base URL、完整 POST 地址、认证及 PowerShell 示例；示例只读取 `AI_API_KEY`，不嵌入实际密钥。
- OpenAI Base URL 为 `http://localhost:4300/v1`；Anthropic SDK Base URL 为 `http://localhost:4300`，完整 Messages 地址为 `/v1/messages`。Messages 要求 `anthropic-version: 2023-06-01`。
- 修复网关按完整 `request.url` 匹配造成 `/v1/messages?beta=true` 返回 404 的缺陷，统一按 URL pathname 路由，不改变认证、模型授权和计费流程。

## 本地验证

- 修复前新增路由回归失败：带查询参数的 Messages/Responses 请求返回 404，而预期为请求体校验的 400。
- 修复后 `pnpm --filter @ai-gateway/gateway-sim test`：67/67 通过。新增覆盖 Claude beta 参数、无效密钥拒绝、Messages 本地适配与结算、错误方法/未知子路径拒绝、其他协议/模型发现/CORS 查询参数。
- `pnpm --filter @ai-gateway/web typecheck`、`pnpm --filter @ai-gateway/web build` 通过；构建仍有既有 bundle 大于 500 kB 提示。
- 浏览器检查见 `browser.json`：22 项通过，五种界面桌面检查、390px 检查、键盘激活/焦点/Escape、空模型选择提示，运行异常为零；四张截图已人工检查。
- 浏览器操作未发送模型生成请求。网关测试使用本地替身，不代表真实 Claude Code/DeepSeek 验收。

## 待用户运行态验证

当前用户手动启动的网关进程没有重启；检查时 `/v1/messages` 空请求体返回 400，`/v1/messages?beta=true` 仍返回 404。需要在原终端重新运行根目录 `pnpm dev` 加载后端修复，再用 Claude Code 验证。未修改 Claude 配置，未调用真实模型，未扩大原 36 次请求预算。
