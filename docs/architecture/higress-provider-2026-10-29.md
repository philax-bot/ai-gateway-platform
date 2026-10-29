# Higress 正式 Provider 与本地默认数据面

后续真实 Pi 编程任务、完整长流及剩余自动验收边界见 [Pi / DeepSeek 实际任务记录](higress-pi-deepseek-2026-10-29.md)。

本轮实现将 Higress 接到现有准入代理之后。控制面继续决定身份、用途、额度、并发和价格；原持久日记及 PostgreSQL 账本继续负责结算。第一阶段的 [隔离 PoC](higress-poc-2026-10-29.md) 保留为历史证据。

## 实现合同

- `HigressProvider` 通过认证后的 Kubernetes REST API 发布 `McpBridge`、`WasmPlugin` 和 `Ingress`，不在控制面执行 Podman 或 Docker 命令。
- `model_route.spec` 仅接受 `serviceId`、`definitionId`。上游地址、物理模型和凭据引用从已保存的业务配置读取。`policy_reference`、`credential_binding`、`rate_limit` 返回 `unsupported_resource_type`；对应业务限制由原控制面执行。
- 迁移 `014_gateway_sync.sql` 新增配置操作表。操作先以 `pending` 落库，再请求管理 API；独立的零生成探针确认版本后才写 `applied`。发布失败保留最后生效版本。进程中断留下的租约过期后变为 `publication_interrupted`，不能直接判为成功。
- 同一资源的发布串行化；重复幂等键返回原操作，改变输入返回冲突。`previousVersion` 用作版本前置条件。配置版本对应不可变的路由及插件名称，回滚通过重新发布历史版本实现。
- 配置指纹包含服务、模型、上游凭据、内部跳转凭据及渲染合同版本。数据库仅保存指纹和版本。真实上游凭据存在受控环境与 Higress 插件配置中；内部跳转凭据和管理凭据分别独立。
- 授权快照中的原上游及价格不被改写。内部 `transport` 指定 Higress 跳转地址；公开调用日志不包含该字段。外呼开关仍检查原始上游地址；缺少有效 Higress 路由会拒绝转发。
- Higress 的自动重试和故障切换关闭。DeepSeek 请求适配继续依据原始受控上游域名执行，保留现有客户端配置。
- 同日恢复专项将 AI Proxy 收敛为共享插件、按路由版本保留规则，内部凭据改用转发前移除的专用头；探针兜底指向本地拒绝端口。后续修复与持续负载证据见 [恢复验收记录](higress-stability-2026-10-29.md)。本文件保留前一阶段的实测数字。
- 配置探针只证明本地路由/插件配置已观察到；厂商可达性和生成协议由独立连接验证及真实模型验收确认。冷启动期间曾记录一次上游 503，未把它伪装为成功；后续完整真实验收通过。

## 日常启动与恢复

仍只使用根目录 `pnpm dev`，入口为 `http://localhost:5176/`。默认开发数据面为 Higress；沿用 `.runtime/review-postgres.json` 的原 schema、账号、资金和外呼开关。启动时准备已有服务的路由，不生成模型请求。前端继续由 Vite 热更新。

Windows 使用已安装的 Podman 和已有固定摘要镜像。管理中继与 Higress 共用网络空间，转发至 all-in-one 的回环管理 API；宿主机通过仅监听 `127.0.0.1` 的 SSH 隧道访问。中继验证独立 Bearer token，限制资源路径和写入方法。该中继属于本地开发运行支持，不作为生产管理面交付。

本地模型仍监听 Windows 回环地址。任务专有 SSH 反向 Unix socket 和私有中继让 Higress 访问它；不修改原服务地址，也不将模型端口绑定到局域网。Higress 配置和内部凭据保存在原运行目录的 `higress/` 下，停止后保留以便恢复。

需要暂时切回直连时，在根 `.env` 设置 `REVIEW_DATA_PLANE=direct`，然后重启同一个 `pnpm dev`；删除该覆盖即可恢复 Higress。此操作不删除数据库、状态文件、历史配置或结算日记。

控制面与持久开发启动器现在处理 PostgreSQL 空闲连接错误，记录不含连接详情的诊断，并允许连接池补建连接。活动查询失败仍向调用方返回失败，不把未提交事务判为成功。

## 验证入口

```powershell
pnpm check:higress:provider
pnpm check:higress:live
```

第一个命令使用独立 PostgreSQL schema、固定 Higress 镜像和确定性模型替身，不读取真实模型凭据。第二个命令复用已有 DeepSeek 配置，会实际外呼；使用前应有对应费用授权。本轮授权上限为累计 20 次、按现有配置价格估算 ¥1，预算落盘在 `.runtime/higress-live-budget-2026-10-29.json`，重跑不重新计数。检查脚本删除自己创建的 schema 和容器，保留脱敏结果；不改原开发库。

## 验收证据

结果见 [汇总](../validation/higress-provider-2026-10-29/summary.json)、[41 项 PostgreSQL/Higress 检查](../validation/higress-provider-2026-10-29/postgres.json)、[13 项真实模型检查](../validation/higress-provider-2026-10-29/live.json) 和 [默认环境切换与重启](../validation/higress-provider-2026-10-29/default-switch.json)。本轮覆盖 PostgreSQL 个人/项目/应用隔离、5 路并发资金争抢、缓存计价、取消、幂等、失败/回滚和进程重启，以及 DeepSeek 非流式、SSE、工具往返与取消。172 项控制面单元测试及 41 项代理测试通过。

原 5176 工作区已完成本地模型和 DeepSeek 实际调用，两个请求 ID 均出现在 Higress 访问日志中，临时 Key 已吊销。重启前后业务配置、资金批次余额及生效路由版本的指纹相同。包含首次 503 验证在内，真实请求累计 10 次，配置价格估算上界 ¥0.078772；真实验收工作区确认费用 ¥0.016115，另有取消产生的预占 ¥0.008408，不能把预占算作确认扣费。

另有 `node scripts/check-isolated.mjs --postgres` 的 428 项原业务链路检查通过，覆盖原 PostgreSQL 准入、用途隔离、价格、并发、恢复及管理流程；它使用本地 HTTP 模型替身，不计入上述 41 项 Higress 专项检查。

真实完成流持续约 10.5 秒；不能据此声称完成真实长流压力、容量、长期稳定性或生产高可用验收。生产目标主机、TLS、管理面 RBAC/网络策略、升级和备份恢复仍需在指定部署环境单独验收。
