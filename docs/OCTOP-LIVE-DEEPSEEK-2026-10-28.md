# Octop + DeepSeek 受控实接（2026-10-28）

## 当前结果

每用户独立 Octop 实例的真实工具调用、工具结果回传、流式正文与显式取消已通过，成功轮次 **55 项检查**。本轮没有部署上线；真实长任务、持续负载、统一登录和生产执行隔离仍未验收。

采用官方固定 Octop commit `890111b7879665840414ca28ab168b05b0db0921`、Python 3.12、原 `uv.lock` 依赖。上游已跟踪源码和依赖文件未修改，平台业务源码未修改。新增独立的 Octop 启动适配层及受控真实模型验证入口。

| 证据 | 文件 |
| --- | --- |
| 首次实接未通过及预算 | [initial-failure.json](validation/octop-live-2026-10-28/initial-failure.json) |
| 沿用剩余预算的成功轮次 | [result.json](validation/octop-live-2026-10-28/result.json) |
| 最终本地回归 | [local-regression.json](validation/octop-live-2026-10-28/local-regression.json) |
| 相关运行入口和脚本指纹 | [source-snapshot.json](validation/octop-live-2026-10-28/source-snapshot.json) |

## 实接场景及边界

- Alice / Bob 各有独立的进程、home、SQLite、JWT 签名秘钥及 Provider，各自使用新签发的个人 Key。第三个低额度账户仅作隔离检查，成功的预算续接轮次未向模型发起该账户调用。
- 平台使用独立内存工作区。只读现有审查库中的 DeepSeek 定义、服务映射、价格和受控凭据引用；没有修改该库、原用户 Key 或已有实例。
- 两个真实 Agent 并行调用 `read_file('/fixture.txt')`。文件内容含本轮随机标记，事先没有提供给模型；后续实际网关请求均包含对应 tool 结果，按请求 ID 核对了个人主体和凭据。
- Alice 收到包含随机文件标记的完整流式正文，确认首轮工具选择、文件读取、回传和模型最终回复形成闭环。
- Bob 在工具结果回传后、第二次模型请求已收到上游字节时，通过 Octop WebSocket cancel 停止。该场景证明工具结果已交给模型与取消链路成立，**没有把 Bob 的最终正文记为完整通过**。
- Alice 另行发起长输出并在上游响应开始后取消。两笔取消均记录 `client_cancelled / pending_review / usageFinal: false`，保留各自预占。
- 每笔成功业务请求核对真实输入、输出、缓存子集计价及所属成员。结束时 outbox 的 queued / blocked 等积压为 0，未知用量预占仍待核对。

真实模型为现有受控配置中的 `deepseek-flash`，官方上游 `api.deepseek.com`。Octop Python 进程继续只连接回环地址；Node 预算代理将个人 Key 请求交给网关，网关使用独立供应商凭据访问官方接口。供应商 Key 不交付给 Octop。

验证 profile 只向模型暴露 `read_file` 工具，并明确限制输出最多 1024 token；预算代理将 `thinking.type` 设置为 `disabled`、`reasoning_effort` 设置为 `none`。这验证的是非思考模式下的文本工具链，不扩展为思考模式、多模态或任意工具已验收。参数口径见 [DeepSeek 官方 Chat Completions 文档](https://api-docs.deepseek.com/api/create-chat-completion/)。没有替换模型回答、伪造工具选择或用本地替身冒充真实生成。

## 首轮失败与预算续接

首轮新建 Agent 尚处于首次引导状态。实际模型先按 `BOOTSTRAP.md` 进入引导对话，并出现了额外工具调用，未返回验收要求的正文标记；检查失败后关闭本轮实例。首次已占用 6 个请求预算，保守费用上界 0.237566 元，证据保留，不能将它当作成功。

随后在新测试 workspace 的 `.octop/.bootstrapped` 显式记录已配置的 QA 身份，并重载 Agent，读取 `bootstrap_pending: false` 后才开始付费场景。该步骤处理测试前置状态，没有修改上游默认引导语义；正式自动创建实例时也需要明确选择完成引导或向用户展示引导。

第二轮从首次报告继承剩余预算，不重新获得 12 次 / 1 元：

| 轮次 | 请求预算占用 | 配置价格保守上界 |
| --- | ---: | ---: |
| 首次，未通过 | 6 | 0.237566 元 |
| 预算续接，55 项通过 | 6 | 0.238990 元 |
| 合计 | **12 / 12** | **0.476556 / 1 元** |

成功轮次的 6 次为 1 次平台连接验证、Alice 2 次工具链请求、Bob 2 次工具链请求（第二次被取消）、Alice 1 次单独取消。为保留预算，没有重跑普通短对话、Provider 探测、辅助生成、重启或 Octop 内停用后对话；这些路径沿用已有本地替身证据。本轮停用 Alice Key 后直接验证模型发现返回 401，没有将它记为一次新的模型生成。

上界按传输体积估算输入、输出上限和当前配置价格计算，预留后才允许转发，不能视为供应商实际账单。已明确未发送请求字节的连接建立重试沿用网关策略。初次失败报告未保存完整逐笔结算，不能据成功轮次的确认费用推断两轮总实际成本；本轮已补失败时的脱敏账目快照，以保留后续异常的可核查信息。

## 成功轮次的记账

价格来自当前平台映射快照：输入 2 元、输出 8 元、缓存输入 0.04 元 / 百万 token。缓存输入是输入的子集；使用每笔真实用量核算并按现有金额精度取整。

| 成员 | 初始额度 | 确认业务费用 | 未知用量预占 | 可用余额 |
| --- | ---: | ---: | ---: | ---: |
| Alice | 0.5 | 0.011304 | 0.048462 | 0.440234 |
| Bob | 0.5 | 0.010462 | 0.047980 | 0.441558 |
| Low | 0.000001 | 0 | 0 | 0.000001 |

三行分别守恒。确认业务费用共 **0.021766 元**，取消后未知用量的预占共 **0.096442 元**。成功轮次的平台连接验证成本 0.000072 元独立记录，不扣三个成员的额度。取消预占不是已确认费用，也不是供应商已确认用量。

这些为隔离验收工作区的测试额度；报告保存后工作区与临时 Key 已清理，不能将其解释为原审查库中仍有待处理的预占。

## 额度不足提示与重试适配

原 Octop 对 HTTP 403 优先显示“鉴权失败”，并对未分类的策略拒绝重试。新增 [octop_gateway_compat.py](../scripts/octop_gateway_compat.py)，在上游导入聊天模块前安装：

1. 沿异常 cause/context 查找结构化响应；仅将 HTTP 403 且 `type: policy_denied` 的 `no_quota / quota_insufficient` 映射为平台额度不足提示。
2. HTTP 403 的明确策略拒绝不自动重试。其他错误继续沿用原重试判定；没有把所有 403 改成额度不足。
3. 不改变网关状态码、鉴权或记账契约，也不回显服务地址或凭据。

适配需在启动时设置 `OCTOP_GATEWAY_COMPAT=1` 并使用本地启动入口；已经运行的上游 Octop 或未来部署包不会自动获得此修复。4 项 Python 测试覆盖额度不足、嵌套异常、非额度策略拒绝、其他错误以及循环 cause。最终本地 HTTP/WS 回归也检查可读的额度提示，以及仅一笔未转发、不计费的拒绝记录。

## 命令

默认的本地验证仍不读取真实模型凭据、不发送外部模型请求：

```powershell
pnpm check:octop
node --test scripts/octop-live-budget.test.mjs
$env:PYTHONDONTWRITEBYTECODE = '1'
& .runtime/octop-source-890111b/.venv/Scripts/python.exe scripts/test_octop_gateway_compat.py
```

新一轮明确授权的真实验证使用：

```powershell
pnpm check:octop:live --allow-upstream
```

缺少 `--allow-upstream` 会在读取私有配置和启动服务前拒绝。真实模式禁止 `--shared`；默认全场景真实验证入口已经准备，本轮成功报告采用预算续接的精简场景，没有另行消耗预算跑完整分支。

需要在同一总上限内继续一次未完成的验收时，传入真实报告中的已占用预算：

```powershell
node scripts/check-octop.mjs --live-deepseek --allow-upstream --budget-from=<prior-report-path>
```

继承累计占用，最多仍为 12 次 / 1 元；本次已用满，不能再用本次报告发送新请求。续接采用双用户工具回传与取消的精简场景，不能通过该参数获得额外预算。

本轮所有测试进程、home、SQLite、日记和临时凭据均清理。固定源码和依赖环境留作复跑；现有审查实例、Pi / CC Switch 配置、云端部署和外部通知未改动。
