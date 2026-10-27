# 核心功能建设与验证（2026-10-27）

基线为 `7a26393`，本记录对应其后的工作区改动。任务清单见 [核心 TODO](CORE-TODO-2026-10-27.md)。本轮不改 UI、不重启人工审查实例、不修改原 Pi / CC Switch 配置。目标部署测试按用户要求暂缓；真实 Pi + DeepSeek 基础实接在独立内存工作空间完成。

## 1. 实现与入口

| 项目 | 本轮结果 | 主要文件 |
| --- | --- | --- |
| 长任务 | 总时限默认 600000ms、首字节 120000ms、空闲 60000ms；收到字节只续空闲窗口；非法配置启动前拒绝。保留原总超时变量。停机排空 35000ms 后中断上游，另留 5000ms 结算，Compose 宽限 45s | `services/gateway-sim/src/upstream-timeout.ts`、`server.ts`、`deploy/compose.yml` |
| 准入诊断 | 输出/上下文超限提供请求值、允许值与来源；额度不足、模型不可用、价格未知分别解释；拒绝同键重放保留原诊断；报价与准入的多来源失败优先级一致 | `packages/contracts/src/index.ts`、控制面 `admission.ts`、两种 Store、`platform.service.ts` |
| 工具协议 | 模型发现、非流式与 SSE 工具调用、工具结果、reasoning 历史、UTF-8/SSE 分片均有自动回归；DeepSeek developer/max_completion_tokens 适配保持在可信路由之后 | `services/gateway-sim/test/protocol.test.mjs`、`upstream-compat.test.mjs` |
| 用量 | 支持 OpenAI 与 DeepSeek 缓存字段；两份缓存计量冲突或最终用量非法时不确认费用；reasoning 不重复叠加 | `packages/contracts/src/usage.ts`、`usage.spec.ts` |
| outbox | queued/blocked 都使健康状态 degraded；补积压年龄和重试计数；服务令牌检查与单条 blocked 重试；原事件与幂等键不变，不允许改金额/用量；原因和次数写结构化日志 | `journal.ts`、`server.ts`、`scripts/outbox.mjs`、`contracts/data-plane-operations-v0.1.yaml` |
| 监控锁 | 统计查询移出工作区写事务，提交采样前重新核对规则版本和分钟，过时采样不覆盖新配置 | `monitoring.service.ts`、`monitoring-lock.spec.ts` |
| 容量与 CI | 独立内存 / PostgreSQL 负载命令，混合真实网关调用与后台维护，并核对资金和账本；GitHub 核心工作流已配置 | `scripts/check-load.mjs`、`.github/workflows/core.yml` |

## 2. 自动验证

| 实际命令 | 结果与范围 |
| --- | --- |
| `pnpm build` | 全项目构建通过；监控调整后控制面另行构建 |
| `pnpm typecheck` | 全项目通过；最终报价优先级调整后控制面类型检查另行通过 |
| `pnpm test` + 最终控制面定向复跑 | Contracts 18 项、网关 27 项、控制面最终 113 项，共 158 项；Web / test-model 的 node test 脚本为 0 项，未将它们计入数量 |
| 网关 31 秒长流 | 实际持续 31.2 秒以上的本地 HTTP/SSE 请求正常完成、最终用量完整；使用默认总时限，验证越过旧 30 秒截断点。首字节、空闲、总时限、取消、停机另有缩短窗口的 HTTP 场景 |
| `node scripts/check-isolated.mjs` | 302 项内存 HTTP 断言通过，含新增 6 项准入诊断断言 |
| `node scripts/check-isolated.mjs --postgres` | 353 项通过，包含重启保持；本次专属 schema 已删除，共享审查资金未动 |
| `node scripts/check-monitoring-pool.mjs` | 10 项隔离 PostgreSQL 连接池 / 查询失败恢复断言通过 |
| YAML / CLI 检查 | 核心工作流、两个 API 契约、Compose 均通过 YAML 解析与重复键检查；Compose 示例配置 `config --quiet` 通过；运维和负载脚本语法通过；真实验收脚本缺显式外呼参数时立即拒绝 |
| `check:containers` | 未执行：本机 Docker API 命名管道不可用，未安装/重启外部环境来替代验收；Compose 语法通过不代表镜像或容器运行已通过 |
| GitHub Actions | 工作流与所用命令已准备，未推送/触发远端运行，不声称 CI 已绿 |

PostgreSQL 首次新增断言因 JSONB 对象键序变化而失败，产品诊断值未发现差异；已改用结构比较，随后完整回归通过。监控锁调整后再次完整通过 353 项，原始输出保留在 `.runtime/core-postgres-validation.log`。最终报价多来源优先级调整由新增控制面单测验证，未因此重跑不受影响的备份或容器场景。

## 3. 并发检查发现与修复

首轮隔离 PostgreSQL 负载出现 1 次 503：48 次请求中 47 次完成，仍有一笔未最终处理的预占。失败报告完整保留于 [首次 PostgreSQL 样本](validation/core-2026-10-27/load-postgres.json)。这暴露了 5 秒控制面 RPC 预算与当前数据库/锁等待之间的风险；不能将“没有费用核对记录”当作没有未处理预占。

源码中监控评估在工作区 `FOR UPDATE` 事务内查询多组统计，而授权使用同一工作区的 `FOR SHARE`。已将慢查询移到事务外，只在短事务中提交结果，并补两项回归：统计查询停顿时仍可准入；采样中规则版本改变时丢弃旧采样并在后续评价新版本。

当前负载：单实例、一个人员、一份资金批次，并发 4、48 次调用（16 次 SSE / 32 次非流式），每 8 次夹带工作区读取和维护操作。模型为仓库确定性本地替身；输入 13、输出 14、缓存输入 4，单次费用 0.000039 元。

| 当前样本 | 完成 / 错误 | 总耗时 | 调用 P95 | 管理操作 P95 | 结算与资金 |
| --- | --- | --- | --- | --- | --- |
| [内存](validation/core-2026-10-27/load-memory-after-monitor-lock.json) | 48 / 0 | 401ms | 57.00ms | 24.90ms | 48 笔确认，0 待核对，扣减 0.001872 元，outbox 空 |
| [PostgreSQL](validation/core-2026-10-27/load-postgres-after-monitor-lock.json) | 48 / 0 | 41112ms | 4131.35ms | 7421.16ms | 48 条权威结算账目，扣减 0.001872 元，outbox 空 |

机器与数据库等待采样见 JSON。首次样本同时存在其他隔离回归，前后并非严格控制变量实验，不能把耗时差异全部归因于锁调整。当前开发数据库样本依然慢，调用 P95 接近控制面 5 秒预算；独立目标环境的持续负载、SLO 和容量上限继续待验收。本轮未增加分库、缓存账本或多副本架构。

## 4. Pi + DeepSeek 真实基础验收

证据：[真实模型报告](validation/core-2026-10-27/live-deepseek.json)。使用审查工作区中的模型定义、官方地址、价格和受控凭据引用，读取配置不写入原工作区；另外启动当前控制面/网关构建与独立内存工作空间，签发临时平台密钥。Pi 仅启用 `read`，关闭扩展、MCP、技能、上下文文件发现及启动联网；测试文件只包含固定标记。

| 项 | 实测 |
| --- | --- |
| Pi | `1.4.0`，真实 CLI 经当前网关调用 `read` 后回传结果，最终标记匹配，正常退出 |
| 真实请求范围 | 1 次连接验证 + 6 次业务调用 = 7 次；含 Pi 两轮、两次缓存样本、一次 SSE、一次取消。测试上限为 8 次 / 配置价格保守估算 0.10 元；累计估算上界 0.088724 元 |
| 缓存 | 两个相同 2057 输入 token 的请求，第二次命中 1920 token；费用从 0.004346 降为 0.000559 元；OpenAI / DeepSeek 缓存字段一致 |
| SSE | 正常收到完成标记与 1024 输出 token 用量，持续 7224ms；不记为真实超过 30 秒的任务通过。此样本未证明长篇正文输出，推理与正文预算仍应按实际任务配置 |
| 取消 | 已转发、最终用量未知，`client_cancelled` / `pending_review`；保留 0.008388 元预占，未标为免费 |
| 资金守恒 | 0.10 初始额度 = 0.015019 已确认业务费用 + 0.008388 未确认预占 + 0.076593 可用余额；诊断成本 0.000072 元独立记录，不扣业务额度 |
| 原配置 | 原 Pi 模型文件和 CC Switch 数据库测试前后 SHA-256 一致；未修改、重启用户审查实例 |
| 清理 | 临时平台密钥、Pi 配置、测试文件和内存进程所在运行目录已清理；保留脱敏用量与状态证据，不保留提示词、模型正文、凭据或原始 Pi 事件流 |

费用为平台配置价格核算，取消后的供应商实际用量仍未知，不作为供应商账单确认。真实持续超过 30 秒的代表性任务与生产负载仍待后续场景；本地 31 秒实时时长证据与真实模型 7.2 秒样本分别解释。

可重复入口：先构建控制面与网关，执行 `node scripts/check-live-deepseek.mjs --allow-upstream <Pi CLI 绝对路径>`。脚本从当前审查配置读取指定 DeepSeek 对象，独立开户和限额，默认结果在 `.runtime/live-results/`；设置 `LIVE_REPORT_PATH` 可选择新报告文件，不覆盖旧证据。未显式外呼时不会执行；不加入自动 CI。真实流程本轮运行后增加了命令行显式开关及预算代理鉴权，新增边界已做静态与拒绝路径验证，未为验证这两个保护而重复产生真实费用。

## 5. 交付边界

- 目标主机部署 / 内网 TLS / 安装升级回滚 / 跨主机恢复：用户要求暂缓；准备与结果模板见 [试运行清单](TRIAL-ACCEPTANCE-2026-10-27.md)。
- 容器镜像、停止和恢复：本轮因 Docker 守护进程不可用未验证；旧容器证据不扩展为当前构建已通过。
- Higress：保持暂缓，当前 Provider 的内存 applied 不作为实接证据。
- 企业身份与外部通知：待首批客户协议和对象，未发送通知。
- UI / 浏览器：本轮未改页面源码、未做新主题或浏览器回归，Web 已参与类型检查与构建。
- CI 使用 `pnpm/setup@v1` 的原生 pnpm / Node 运行时入口，按官方 [v1 参数契约](https://github.com/pnpm/setup/blob/v1/action.yml) 配置；构建结果上传仅匹配 `.runtime/load-results/*.json`，不上传其他运行目录。
