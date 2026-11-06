# Pi 图片输入修复与验证（2026-11-05）

## 原因与修改

Pi 的 `token-run-test/deepseek-flash` 已声明 `input: ["text", "image"]`，使用 `http://localhost:4300/v1` 的 Chat Completions。网关此前只允许文本块，因此 `read` 图片后的请求在准入前被 `unsupported_content` 拒绝。

- Chat 入口接受并原样转发 `image_url`（data URL、远程 URL），不下载图片、不丢弃图片内容；音视频保持拒绝。
- JSON 正文上限从 1 MiB 调整为 20 MiB，包括完整历史及 Base64。准入仍按传输字节保守估算，最终费用依上游 usage；不将估算宣称为视觉 token 数。
- DeepSeek 的系统文本数组仅在全部为文本块时合并，避免图片块被压成空文本。
- 未修改 Pi、CC Switch 配置、既有数据或上游启用设置。已通过 `pnpm dev` 重启原持久工作区。

## 验证

- `pnpm check:gateway`：80/80 通过，包含新增 4 项图片 HTTP 检查：流式/非流式工具历史与超过 1 MiB 正文、非法图片和音视频拒绝、上游图片拒绝不重试。
- 随后新增 DeepSeek 图片保留回归，`node --test services/gateway-sim/test/upstream-compat.test.mjs`：4/4 通过。
- `pnpm --filter @ai-gateway/gateway-sim typecheck`、相关文件 `git diff --check` 通过。
- 实际 Pi CLI：指定原 `token-run-test/deepseek-flash`，临时关闭扩展与上下文加载，仅开放 `read`，不保存会话，读取用户附图。工具返回 `image/png`，Base64 长度 340676；模型准确识别图中 `unsupported_content` 及完整英文原因。运行原始输出留在本地 `.runtime/image-fix-pi.jsonl`（包含图片，不作为对外报告）。
- 控制面调用记录：首轮工具调用 `request-01cd9965-2227-4f6e-b65a-340efa234055` completed，input/output 957/78；图片识别轮 `request-931b53ad-e112-46ba-aac4-2aab635794b9` completed，input/output 2041/42，错误为空。
- 重启后 Higress 4/4 路由就绪；最终网关 health 为 `ok`，outbox queued/blocked/active 均为 0。

本次证明当前 Pi → 本地网关/Higress → 配置上游的图片识别链路有效；未测试其他模型的视觉能力、协议 Chat 回退的图片转换或正式部署入口。部署模板的 Nginx 仍有独立的 1m 限制，正式环境大图需按部署方案同步调整。
