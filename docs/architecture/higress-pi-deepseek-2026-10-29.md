# Pi 经 Higress 的 DeepSeek 实际任务验收

本轮复用现有 DeepSeek `deepseek-flash` 配置，通过真实 Pi 1.4.0 CLI、当前网关、真实 Higress 和隔离 PostgreSQL schema 执行。编程工具闭环、超过 30 秒的完整生成、取消与关联重试均已确认。用户将累计次数上限明确增至 22 次后，仅新增取消与重试两次生成，最终补验 16 项通过；其中编程和长流复用前序真实证据，不重复生成。

## 已取得的真实证据

| 项目 | 实际结果 |
| --- | --- |
| Pi 编程任务 | 在合成小项目中修复微元结算函数，实际调用 `read`、`write`、`powershell`，4 轮模型交互，无自动生成重试。 |
| 独立验证 | Pi 生成的 10 项 Node 测试通过；另由验收器执行 13 个合同断言，核对去重、冲突、数值边界、余额保护和输入不可变。练习代码不是平台账务实现。 |
| 完整长流 | 真实生成跨度 31.863 秒，往返 33.315 秒；792 输入 / 5567 输出 Token；`finish_reason=stop`、最终 usage、`[DONE]` 和完成标记均已观察，实际 Higress 访问日志匹配。没有插入延迟。 |
| 实际取消 | 已观察到模型输出后取消，控制面记录 `pending_review` / `usageFinal=false`，保留未知费用预占。 |
| 取消后的关联请求 | 最终补验确认带 `x-retry-of-request-id` 的新请求返回 200、完整标记、`stop`、最终 usage 和 `[DONE]`；16 输入 / 8 输出 Token，PostgreSQL 中原调用关联正确，只产生一条结算账目，扣减 ¥0.000096。原取消预占 ¥0.008452 保持待核对。 |
| 资金与队列 | 本次独立验收批次为 ¥1，剩余 ¥0.991452 + 已确认 ¥0.000096 + 未知预占 ¥0.008452 = ¥1；结算队列、blocked 和写入积压均为 0。 |
| 配置保护 | 原 Pi 模型文件、设置文件及 CC Switch 数据库前后哈希一致；默认工作区业务配置与资金指纹前后相同。默认 Web / Higress / PostgreSQL 健康检查通过。 |

详情见 [汇总](../validation/higress-pi-deepseek-2026-10-29/summary.json)、[Pi 编程及首轮截断](../validation/higress-pi-deepseek-2026-10-29/coding-and-truncated-long.json)、[完整长流原始报告](../validation/higress-pi-deepseek-2026-10-29/completed-long-original-check-failure.json)、[取消及关联请求原始报告](../validation/higress-pi-deepseek-2026-10-29/cancel-retry-original-check-failure.json) 和 [生成的练习代码](../validation/higress-pi-deepseek-2026-10-29/coding-fixture/ledger.mjs)。原始失败报告保持 `success=false`。

最终直接查询 PostgreSQL 的证据见 [16 项补验](../validation/higress-pi-deepseek-2026-10-29/final-live.json)；默认数据保留见 [配置与资金核对](../validation/higress-pi-deepseek-2026-10-29/default-preservation.json)。旧报告缺失的快照不作追补，由这轮新的实测提供完整证据。

## 检查器修复与边界

1. 初次连接验证返回 `connection_failed`，未唯一定位传输原因；该次尝试计入预算。随后在生成前增加零生成准备检查，并按本次目标资源判断就绪，避免隔离环境自带但未启动的本地示例路由阻塞 DeepSeek 验收。
2. 现有 Pi 模型把 `thinkingLevelMap.off` 标为不支持，导致 `--thinking off` 被调整为支持的思考级别。首轮长流自然生成约 48 秒，但 8192 输出 Token 中有 5342 个为推理，正文截断，保留为失败。临时验收模型显式映射 `off` 到 `none`，并发送 `thinking.type=disabled`；本地替身已确认真实 Pi 发出的参数。原日常配置保持不变。参数依据 [DeepSeek 思考模式说明](https://api-docs.deepseek.com/guides/thinking_mode/)。
3. 完整评审已经自然结束，但原断言把正文中交叉引用的 `SCENARIO` 也当作标题，得到 59 次提及。修正后的完成条件核对结束原因、完成标记、正文规模和真实生成时间；保留的数据不支持断言标题恰好为 48 项。
4. 取消后的请求已返回完整 SSE，但原脚本在原始事件文本上查找连续标记。标记拆成多个 JSON 事件时该检查会失败。新增解析器先拼接 `delta.content`，再核对标记；单测明确复现这个问题。由于原失败报告未保存拼接正文与关联字段快照，该次真实失败不能仅凭离线复现唯一归因。
5. 失败路径现在会在清理前保存调用、余额、账本和队列快照，避免正文断言失败遮住账务证据。临时运行目录与数据库清理仍限于本次创建的对象。

本地真实 Higress + PostgreSQL、确定性模型替身回归 46 项通过，包含分片标记重组、取消后显式关联重试、原未知预占保持及唯一结算行；6 项预算/正文解析单测通过，三个后端包构建通过。见 [本地回归](../validation/higress-pi-deepseek-2026-10-29/local-regression.json)。最终两次真实请求另有上面的直接账务核对，验证范围分别记录。

## 预算与交付

最初从累计 10 次推进到 20 次，配置价格的保守估算上界为 ¥0.370268。用户随后明确批准增至 22 次、累计费用仍限 ¥1，新增两次的估算不超过 ¥0.02。最终累计 22 次，保守估算上界为 ¥0.379902；新增部分为 ¥0.009634。这里是预算估算，不是厂商账单，也不把未知取消预占当作确认消费。预算文件保留在 `.runtime/higress-live-budget-2026-10-29.json`，保存原授权、追加授权和批准时的计数及金额，不重置历史。

最终补验只重新执行取消与关联请求，共两次生成，复用已有真实 Pi 编程、完整长流与连接验证证据。复用连接状态时，仅把现有已验证服务配置复制到新测试 schema，不对原工作区写入，也不声称进行了新的连接验证。追加前的一次零生成就绪检查失败，没有增加真实请求计数；新旧容器网络的独立 TCP 检查均连通，后续路由就绪并通过补验，未据此宣称唯一确定了该冷启动失败的根因。

22 次额度耗尽后再次执行会在创建验收服务和模型分派前拒绝，见 [最终预算边界](../validation/higress-pi-deepseek-2026-10-29/final-budget-guard.json)。累计 ¥1 上限和新增 ¥0.02 上限分别检查，不能通过重跑重新获得次数或金额。

可重复入口为：

```powershell
$piCli = Join-Path (Split-Path (Get-Command pi).Source) 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'
pnpm check:higress:live --pi $piCli
```

当前授权次数已耗尽，该入口会拒绝外呼。完整流程和续接流程均读取同一累计预算；真实请求不加入自动 CI。生产部署、真实模型持续负载和高可用仍不在本轮验收范围。
