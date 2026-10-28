# 控制面持续负载与策略一致性验证（2026-10-28）

基线 `359d7f0`，分支 `codex/control-plane-p0`。本轮完成工作区锁竞争治理与准入查询裁剪；六组本地模型混合负载共 **1615 / 1615** 成功，逐用户资金、账目、未结预占、限流占用与 outbox 核对通过。最高组为 4 用户、并发 8、持续 180 秒，712 / 712 成功，调用 P95 2951.40ms，管理操作 P95 2677.82ms。控制面 RPC 仍为 5 秒。

## 使用了什么模型

全部负载均使用仓库内确定性 HTTP 替身 [`postman/mocks/test-model/default.js`](../postman/mocks/test-model/default.js)，逻辑模型标识 `test-model`。替身只返回固定非流式 / SSE 内容与用量，不运行模型推理。**没有调用用户配置的 DeepSeek，没有新增厂商模型费用。**

每组创建独立工作区、端口、日记目录与 PostgreSQL schema；路由显式指向本次本地替身，凭据引用为 null，外部验证与调用开关均为 false。报告 `environment.upstream` 记录这些边界；替身累积请求数扣除一次服务验证后，必须等于本组生成请求数。最高组 712 次生成全部落在替身，计数不受最近 500 条请求明细保留上限影响。

测量对象是 Windows 上的单实例网关、控制面、现有开发 PostgreSQL 端点、管理查询与维护。结果不代表 DeepSeek 性能、真实模型持续负载或生产容量。模拟价格和扣款仅用于核验隔离测试 schema 的记账守恒，不是厂商账单。

## 定位与改动

1. [改动前 4 用户 / 并发 8](validation/capacity-2026-10-28/profile-c8-u4.json) 为 249 / 250 成功。诊断记录到监控提交在工作区 `FOR UPDATE` 上等待约 5577ms，授权的 `FOR SHARE` 等待约 4389ms；连接池与本地计算不足以解释该段耗时。授权等待资金/限流锁时仍持有工作区共享行锁，监控写入与后续授权排队。
2. 策略一致性改用事务级共享 / 独占 advisory 锁：授权持有共享策略锁，普通业务写事务先拿独占策略锁，再锁工作区行。监控与保留清理使用 `runtimeOnly`，仍锁行但跳过策略锁。运行事务若改变业务策略、资金或凭据会拒绝并回滚。
3. [只拆分锁的样本](validation/capacity-2026-10-28/policy-fence-c8-u4.json) 仍有 2 次授权超时，普通工作区 SELECT 往返曾达 28.3 秒。[32 次只读固定载荷测量](validation/capacity-2026-10-28/postgres-payload-echo.json) 表明大响应的往返代价更高，支持减少传输量，但不能证明具体网络丢包或把极端长尾全部归因于网络。
4. 准入只返回 11 个必需策略字段，排除审计、会话、监控和操作历史。样本完整 JSON 为 43583 字节，准入投影为 9560 字节。投影和共享策略锁处于同一 `READ COMMITTED` 事务内；业务撤销、路由/价格与资金配置修改不能穿过该锁。原资金行锁、限流锁、幂等记录与价格快照保留。

迁移 `013_admission_lock_protocol.sql` 记录版本 2 协议。升级同一 schema 前必须停止全部旧控制面实例，再启动新版迁移；不支持新旧协议混跑。旧发布包会因迁移账本拒绝重新启动，已经运行的旧进程仍需先停止。详见 [迁移说明](RUNTIME-CONFIGURATION.md#迁移)。本轮仅升级自动检查创建的隔离 schema，未修改人工审查实例或部署目标。

## 持续混合负载

每三次调用一笔 SSE，每八次混入管理读取与维护；到期停止发新请求并等待在途完成。每用户使用独立密钥与资金批次。固定 13 输入 / 14 输出 / 4 缓存 token，按本地测试价格每次 39 微元；分别核对每人的原批次扣款。

| 用户 / 并发 | 发起时长 | 成功 / 发起 | 调用 P95 | 管理 P95 | 未结预占 / outbox |
| --- | ---: | ---: | ---: | ---: | ---: |
| [1 / 1](validation/capacity-2026-10-28/accepted-c1-u1-60s.json) | 60s | 106 / 106 | 638.28ms | 477.58ms | 0 / 0 |
| [1 / 4](validation/capacity-2026-10-28/accepted-c4-u1-60s.json) | 60s | 236 / 236 | 1359.73ms | 1131.96ms | 0 / 0 |
| [1 / 8](validation/capacity-2026-10-28/accepted-c8-u1-60s.json) | 60s | 226 / 226 | 3683.27ms | 602.68ms | 0 / 0 |
| [4 / 1](validation/capacity-2026-10-28/accepted-c1-u4-60s.json) | 60s | 92 / 92 | 864.61ms | 554.21ms | 0 / 0 |
| [4 / 4](validation/capacity-2026-10-28/accepted-c4-u4-60s.json) | 60s | 243 / 243 | 1517.87ms | 2588.38ms | 0 / 0 |
| [4 / 8](validation/capacity-2026-10-28/accepted-c8-u4-180s.json) | 180s | 712 / 712 | 2951.40ms | 2677.82ms | 0 / 0 |

最高组此前另跑 [60 秒样本](validation/capacity-2026-10-28/projected-policy-c8-u4.json)，300 / 300 成功、调用 P95 2310.05ms。两次均使用相同策略锁与精简查询，没有放宽 RPC 预算。

六组错误率均为 0，账目数与生成次数相等，逐用户资金变化一致，未结预占、在途限流占用及 queued / blocked / active / writePending 均为 0。最高组原批次变化 27768 微元，712 笔结算。

管理接口仍有长尾：4 用户 / 并发 4 样本单次管理操作最大 9083.42ms，最高组最大 5491.75ms。本轮通过标准是本地混合请求全部完成且账目守恒，没有约定或声称管理接口满足某个延迟 SLO。历史增长、更多用户、数小时运行与代表性真实模型场景仍需另测。

## 诊断与一致性回归

诊断默认关闭，仅服务令牌可读；记录固定场景、后端 PID、查询/本地/连接池阶段和 SQL 分类。上限为 2048 个完成操作、128 个活动操作、每操作 24 步、8 个最慢完成操作；不保存 SQL、绑定值、身份或正文。`?after=<completed>` 只筛选完成记录，压测准备结束后设置检查点。事件循环延迟仍是进程全生命周期统计。长样本会淘汰早期诊断，`dropped` 可见；上表请求延迟使用完整工作负载独立计时。

`scripts/check-policy-lock.mjs` 用真实 PostgreSQL 事务验证：运行写者持有行锁时授权可以先完成；策略写者持锁时授权等待并看到已提交撤销；已有授权快照阻塞后来撤销，新授权被拒；旧预占仍从原来源释放；运行事务越权回滚、失败策略事务释放锁；无残留预占和空闲事务。脚本不生成模型请求。

最终代码回归结果：

| 检查 | 结果 |
| --- | --- |
| `pnpm build` / `pnpm typecheck` | 全项目通过 |
| `pnpm test` | Contracts 18、控制面 127、网关 41，共 186 项通过 |
| `node scripts/check-isolated.mjs` | 内存完整 HTTP 371 项通过 |
| `node scripts/check-isolated.mjs --postgres` | 隔离 PostgreSQL 完整 HTTP 427 项通过，重启与 schema 清理通过 |
| `node scripts/check-policy-lock.mjs` | 19 项真实 PostgreSQL 锁协议 / 投影 / 回滚断言通过，无模型请求 |
| `node scripts/check-monitoring-pool.mjs` | 10 项通过 |
| `PG_BIN=<本机绝对目录> node scripts/check-delivery.mjs --backup` | 迁移、空安装、重启、原生备份恢复共 56 项通过，其中前段迁移检查 12 项；包含恢复后版本 2 锁协议与精确一次资金变化 |
| YAML / 脚本 / 文档检查 | 三份 API 契约、Compose 与 CI YAML 解析通过；修改的 JS 脚本语法通过；89 个现有本地文档链接核对通过 |

CI 已增加策略锁并发验证步骤，未触发远端运行。测试源码以 [23 个改动源码/契约/迁移/CI 文件的原始字节 SHA-256](validation/capacity-2026-10-28/source-snapshot.json) 和基线 `359d7f0` 固定；报告产生时工作区尚未提交，不能用当时 HEAD 代替修改后的内容。机器可读汇总见 [验证摘要](validation/capacity-2026-10-28/regression-summary.json)。

## 复现

```powershell
pnpm build
pnpm typecheck
pnpm test
node scripts/check-policy-lock.mjs
node scripts/check-isolated.mjs
node scripts/check-isolated.mjs --postgres
node scripts/check-monitoring-pool.mjs
node scripts/check-load.mjs --postgres --concurrency 8 --users 4 --duration 180
# 设置 PG_BIN 为本机 PostgreSQL 客户端 bin 的绝对目录后：
node scripts/check-delivery.mjs --backup
```

`--out` 必须指定未存在的新文件。脚本只清理自己创建的随机目录与 schema，失败报告和日记证据保留；历史失败样本不被通过样本覆盖。

目标主机部署、TLS、容器恢复按用户要求继续暂缓；Higress、企业身份、外部通知和真实模型持续负载保持原 TODO 边界。
