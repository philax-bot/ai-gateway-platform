# Octop 最小接入验证（2026-10-28）

后续决策：用户已选择每用户独立 Octop 实例，85 项本地检查已完成，见 [独立实例验证](OCTOP-PER-USER-2026-10-28.md)。本文保留首次共享实例的 42 项历史证据；当前 `pnpm check:octop` 默认验证独立实例，显式传入 `--shared` 才复现共享实例问题，当前脚本的检查数量随覆盖扩展而增加。

后续真实模型与错误适配结果见 [Octop + DeepSeek 实接](OCTOP-LIVE-DEEPSEEK-2026-10-28.md)，不将本文的共享实例问题结论扩展为独立实例无法接入。

## 结论

真实 Octop → 当前网关 → 本地确定性模型的文本、工具和计费链路已经跑通，42 项检查通过。**固定版本的共享实例不能直接托管不同用户的个人 API Key**：Provider 为实例级配置，普通用户可以读取其他 Provider 的完整测试 Key。此前仅根据 Octop API 文档作出的“原生用户级 Provider 可直接使用”判断由本轮源码和 HTTP 实测修正。

本轮交付可复用的联调脚本和隔离问题证据，没有实施 SSO、自动签发/交付 Key、云端部署或生产沙箱。脚本的 `success: true` 表示兼容性及问题复现检查完成；`sharedInstanceReadiness.ready: false` 才是共享实例接入结论，不能将前者作为上线门禁通过。

## 版本与环境

- 官方源码：https://github.com/TencentCloud/Octop
- 固定 commit：`890111b7879665840414ca28ab168b05b0db0921`，包版本 `1.0.3b1`。
- Python `3.12.13`，依赖按上游 `uv.lock` 使用 `uv sync --frozen --no-dev --python 3.12` 安装；其中 octop-harness `1.0.5`、octop-memory `1.0.2`。
- 网关与控制面从本工作区当前源码构建；工作区原有管理读取优化等未提交改动保留，没有改动业务源码。
- 平台使用独立内存工作区，Octop 使用独立 SQLite / home，服务绑定 `127.0.0.1` 随机端口。未读取用户模型凭据、原 Octop home 或审查数据库。
- 模型使用脚本内 HTTP 替身；Python 入口限制本进程的 socket 连接和 DNS 查询到回环地址，环境变量采用白名单。该约束用于本地 QA，不是生产工具执行沙箱。

报告：[完整脱敏结果](validation/octop-2026-10-28/result.json)。测试脚本：[check-octop.mjs](../scripts/check-octop.mjs)；本地网络约束入口：[octop-local-only.py](../scripts/octop-local-only.py)。

## 已实际验证

| 路径 | 实测结果 |
| --- | --- |
| 平台签发 Key → 模型发现 | 三个测试成员的 `/v1/models` 返回授权模型 |
| Octop → 模型发现 | 实际 `/api/admin/providers/fetch-models` 能获取网关模型 |
| Octop Provider 连接测试 | 两个正常额度成员的非流式请求成功；请求归属对应个人 Key 并按业务计费 |
| WebSocket 对话 → 网关 SSE | 两人均收到预期内容标记、用量和 done 帧 |
| 工具往返 | 实际 Octop 执行 `read_file('/fixture.txt')`，文件标记作为 tool 结果回传网关，第二轮收到预期最终正文 |
| 流式用量 | 所有实际流式模型请求包含 `stream_options.include_usage: true` |
| 额度不足 | 第三个低额度成员收到可见错误；没有请求到达模型，仅保留不计费的拒绝记录，余额不变 |
| 显式取消 | 使用 WebSocket `cancel` 帧停止任务；网关记录 `client_cancelled / pending_review`，未知用量保留预占 |
| Key 停用 | Alice Key 停用后，对话被拒且无模型请求，模型发现返回 401；Bob 继续成功 |
| 账户归属 | 每个正常请求使用对应个人 Key 计入对应成员；三个账户分别核对余额、已确认费用及未知用量预占守恒 |
| 结算恢复状态 | 结束时 outbox 的 queued / blocked / active / authorizing / authorizationPending / authorizationBlocked / writePending 均为 0 |
| Agent 对象权限 | Bob 读取 Alice 的 Agent 返回 403；此项不代表 Provider 已隔离 |

替身共收到 9 次生成请求，其中 1 次为平台独立连接验证、2 次为 Octop Provider 探测，其余为对话、工具和取消。所有用量均为固定测试数据，不证明真实模型识别工具或生成能力，没有模型厂商费用。

模拟价格：输入 1 元、输出 2 元、缓存输入 0.5 元 / 百万 token；固定 13 输入、14 输出、4 缓存输入，每笔确认费用为 39 微元。缓存是输入的子集，不能重复计价。

| 测试成员 | 初始额度 | 确认费用 | 待核对预占 | 可用余额 |
| --- | ---: | ---: | ---: | ---: |
| Alice | 10 | 0.000156 | 0.024530 | 9.975314 |
| Bob | 10 | 0.000117 | 0 | 9.999883 |
| Low | 0.000001 | 0 | 0 | 0.000001 |

三行分别满足初始额度 = 确认费用 + 待核对预占 + 可用余额。Alice 的取消预占不是已确认费用，也未被标为免费。平台连接验证成本独立于以上三个账户；Octop Provider 探测使用个人 Key，属于个人调用。

## 共享实例阻塞证据

本轮使用自己创建的隔离测试账号及随机测试 Key，不涉及现有用户或真实凭据。

1. 普通用户 `POST /api/providers` 返回 **405**。实际写入口是 `/api/admin/providers`，由 `providers` 权限控制。
2. 普通用户 Bob 的 `GET /api/providers` 返回 Alice 的 Provider，且其中 `api_key` 与 Alice 的测试 Key 相等。报告仅保存布尔结果，不保存 Key。
3. 固定源码的 `ProviderRow` 没有 `user_id` / owner 字段；列表接口调用 `provider_repo.list_all()`，序列化直接返回 `api_key`。

可核对的固定源码：

- [Provider 列表及管理写入口](https://github.com/TencentCloud/Octop/blob/890111b7879665840414ca28ab168b05b0db0921/src/octop/api/routers/providers.py#L342)
- [Provider 返回值中的 api_key](https://github.com/TencentCloud/Octop/blob/890111b7879665840414ca28ab168b05b0db0921/src/octop/api/routers/providers.py#L275)
- [Provider 数据结构与查询](https://github.com/TencentCloud/Octop/blob/890111b7879665840414ca28ab168b05b0db0921/src/octop/infra/db/repos/providers.py#L24)

仅遮盖前端 Key 或隐藏 Provider 菜单不足以满足个人 Key 托管目标。共享实例二开需要一起覆盖数据所有权、API 核权、模型解析/工厂缓存、后台与辅助模型调用、凭据存储和撤销，不能只增加一个列表过滤条件。本轮未对所有跨 Provider 路由方式做穷尽测试，也不据此扩大为整个项目的安全审计结论。

另一个交互问题：余额不足时，网关保留结构化策略拒绝信息，但 Octop 最终显示“模型服务鉴权失败”，并出现三笔未转发、不计费的拒绝记录。应在集成层区分额度不足、模型未授权与 Key 无效，并控制无意义的策略拒绝重试。

## 接入配置

当前协议验证使用以下 Provider 设置；共享实例中只允许使用隔离测试 Key，不作为正式托管配置。

```json
{
  "name": "platform-gateway",
  "kind": "openai",
  "base_url": "http://127.0.0.1:<gateway-port>/v1",
  "api_key": "<newly-issued-platform-key>",
  "stream_usage": true,
  "models": [{
    "id": "<public-model-id>",
    "name": "Platform text model",
    "enabled": true,
    "input": ["text"],
    "api_mode": "chat_completions",
    "api_fallback": "none"
  }]
}
```

Agent 的 `default_model` 为 `platform-gateway/<public-model-id>`。首次联调关闭记忆抽取、知识库、MCP、委派和其他辅助功能，逐项补测请求去向与费用主体。脚本使用 `max_iters: 32`；上游的迭代数包含图节点执行，6 次不足以完成本轮最简单对话，不能将它等同于模型请求次数。

当前网关支持文本 Chat Completions 和工具调用；Responses、Anthropic Messages、Embedding、图片音频仍未接入。完整 Key 仅在签发时返回，正式自动交付应在签发时完成并处理失败，不从哈希恢复已有 Key。

## 复现（Windows / PowerShell）

首次准备独立源码缓存，已有同名目录时不要覆盖：

```powershell
git clone --no-checkout https://github.com/TencentCloud/Octop.git .runtime/octop-source-890111b
git -C .runtime/octop-source-890111b checkout --detach 890111b7879665840414ca28ab168b05b0db0921
Push-Location .runtime/octop-source-890111b
uv sync --frozen --no-dev --python 3.12
Pop-Location
pnpm check:octop
# 如需复现本文的共享实例问题：
node scripts/check-octop.mjs --shared
```

脚本校验固定 commit 和上游已跟踪文件未改动，默认读取该缓存中的 `.venv/Scripts/python.exe`。可用 `node scripts/check-octop.mjs <source-directory>` 指定同版本源码目录。每轮报告写入唯一的 `.runtime/octop-results/*.json`，可用 `OCTOP_REPORT_PATH` 指定一个尚不存在的报告路径；不覆盖旧证据。

测试结束关闭本轮进程、清理本轮 home、Key、SQLite 和日记目录；源码与虚拟环境缓存保留用于复跑。本次没有重启现有审查实例，没有修改 Pi / CC Switch，没有发送外部消息或执行部署。

## 下一阶段选择与验收边界

用户后续已选择每用户独立 Octop 实例，本地进程、home、Provider 与 JWT 签名秘钥隔离已完成联调，见 [独立实例验证](OCTOP-PER-USER-2026-10-28.md)。生产执行身份和沙箱、实例资源成本、路由、认证与运维仍待验收；仅开不同端口不等于生产隔离。

若选择共享实例，则先维护 Octop 二开版本并完成上述 Provider / 路由隔离，再做统一身份与 Key 自动交付。OIDC 客户端能力不使当前网关自动成为身份提供方，双方应接入明确的同一身份源。

真实模型实接、SSO、自动 Key 生命周期、云端 TLS、长期容量及恢复验收都仍未完成。部署继续遵守项目原有暂缓边界，Higress 不作为本次协议对接的前置条件。
