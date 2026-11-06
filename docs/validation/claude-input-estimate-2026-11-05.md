# Claude Code 输入估算修复（2026-11-05）

用户反馈短会话在读取图片后收到 `requested output 32000 exceeds allowed 0 tokens (model_context); estimated input 1268236, model context 1000000`。

## 根因与处理

旧实现将 UTF-8 JSON 字节数直接作为 token 数；Messages/Responses 的准入投影还先把原始请求变成字符串再序列化。图片 Base64 被当作文本，并产生额外转义开销。

对应本机会话在报错前一轮上游总输入为 54189 tokens，随后新增图片；两张图片的 Base64 分别为 326880 和 327092 字符。沿父消息链重建报错前 54 条会话消息（不含系统提示和工具定义）后，旧投影估算 1084791，新估算 66095。此数值对比不是原始线上请求的完整重放。

本次修改：

- 共享估算器用 `js-tiktoken/lite` 的 `cl100k_base` 文本分词，加 25% 与 256 tokens 余量；报价和网关共用。
- 三协议直接估算原始结构化输入，覆盖系统提示、消息、工具定义及工具结果。
- 识别 Chat `image_url`、Messages `image`、Responses `input_image`，包括嵌套工具结果。Base64 与图片 URL 不进入文本分词，每张图片暂预留 8192 tokens，不访问远程 URL。
- 这是通用预估，不是 DeepSeek/Claude 的精确 tokenizer，也不保证覆盖所有图像分辨率和上游模型；保留上下文与额度准入，最终结算继续采用上游 usage。
- 两个真实模型验证脚本继续以传输字节数和新估算的较大值计算测试费用预算，避免本次估算变化放宽已有测试预算。
- 已按 `pnpm dev` 重启原 PostgreSQL 工作区，未更改模型上下文或客户端配置。

## 检查与实际客户端验证

- Contracts 46/46，网关 84/84，控制面 216/216 测试通过；控制面 typecheck、前端 build 和本次文件 diff 检查通过。前端仍有构建 chunk 大小提示。
- 三协议 HTTP 回归使用超过 120 万字符的图片 Base64，验证准入估算小于 1 万、原始图片完整到达上游、输出请求仍为 32000、结算采用上游 usage。
- 实际 Claude Code CLI 使用既有 `deepseek-flash` 配置，通过本机只记录元数据的验证中继调用当前网关，允许 `Read` 读取用户两张截图。模型正确读出第一张的 `unsupported_content` 与第二张的 `1268236`。第二次请求正文 1024024 bytes；旧投影估算 1024679，新估算 20870。CLI 正常结束，`is_error=false`。
- 控制面：`request-aa16cc5b-0506-4f37-a061-96bc3293502c` completed，input/output 3020/158；图片识别轮 `request-11717274-00fb-4300-ac33-cf3836ad9b9a` completed，input/output 5180/33。两次金额分别为 0.007304、0.004603（账本配置币种）；客户端对非标准模型显示的费用估计不作为账本证明。
- 首次 CLI 验证的两次网关请求也均 completed，但客户端自行按未知模型价格估价触发本次临时 0.03 USD 测试限额，未输出最终结果；调整本次 CLI 验证限额为 0.10 USD 后完成上述复验。两轮共四次请求，账本实际金额合计 0.023706。
- 最终 `/health` 为 `ok`，Higress 路由就绪，outbox queued/blocked/active 均为 0。正式环境未部署。

仅含元数据的 CLI 报告：[claude-image-estimate-2026-11-05.json](claude-image-estimate-2026-11-05.json)。本地复验脚本与测试日志保存在 `.runtime/input-estimate-*`；没有在报告内复制图片 Base64、用户会话正文或密钥。
