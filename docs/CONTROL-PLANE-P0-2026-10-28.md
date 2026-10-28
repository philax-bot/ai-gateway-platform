# 控制面 P0：性能与预占收敛

基线：`d661d6f`，工作分支 `codex/control-plane-p0`。目标是缩短核心调用热路径、关闭授权响应丢失的预占缺口，并提供可复现的混合负载与故障证据。

- [x] 保存上一轮已验证改动为 Git 检查点。
- [x] 增加有界、脱敏、默认关闭的热路径耗时诊断；分别记录连接池等待、SQL 往返，配合数据库锁等待采样。
- [x] 对比基线，批量化授权/结算的数据库操作，保持原始资金来源、限流与幂等契约。
- [x] 授权请求发出前持久化意图；响应丢失或进程重启后，仅恢复本次未转发预占，避免释放其他网关的请求。
- [x] 验证响应丢失、重复请求、重启、恢复重放和旧记录兼容。
- [x] 单用户/多用户持续混合负载测量：调用、管理查询、维护同时运行，保留成功与失败报告，核对逐用户资金、未结预占和 outbox。
- [x] 更新本轮验收结论与可执行命令。
- [ ] **容量稳定性仍待通过**：持续混合负载仍有 5 秒授权超时及流式结算确认丢失；继续定位工作区读写锁等待链及持锁事务，建立稳定延迟/错误率证据后才能宣称容量达标。

部署、TLS、容器恢复和真实 Higress 接入继续暂缓。本轮使用隔离 PostgreSQL schema 与本地确定性模型，不增加真实模型调用。

## 热路径改动与对比

诊断接口 `GET /internal/v1/diagnostics/hot-path` 只接受服务令牌；`CONTROL_PLANE_DIAGNOSTICS=true` 时最多保留 2048 笔授权、结算、凭据解析、工作区写事务及一致性视图的已完成操作计时，返回保留/丢弃数与分位数。默认关闭。只保留固定阶段标签、耗时和失败标识，不保存 SQL、绑定值、API Key、身份或请求正文。SQL 耗时包含网络及锁等待，不能解释为数据库纯执行时间；另记录 SQL 之外的本地耗时。锁等待使用隔离进程的 `pg_stat_activity` / `pg_blocking_pids` 采样，报告只保存阶段标签、进程号、等待类型和阻塞关系。诊断含启动后的配置/开通操作；压测调用和管理延迟以工作负载单独计时为准。

同一开发数据库端点、并发 4、同用户同批次、48 次调用，含 SSE、管理读取与手动维护，依次运行：

| 指标 | 优化前 | SQL 批量化后 |
| --- | ---: | ---: |
| 成功 / 错误 | 48 / 0 | 48 / 0 |
| 调用 P95 | 2844.66ms | 998.82ms |
| 管理操作 P95 | 3525.80ms | 1291.60ms |
| 吞吐 | 1.48 req/s | 4.04 req/s |
| 授权 SQL 往返数（中位数） | 37 | 15 |
| 结算 SQL 往返数（中位数） | 24 | 14 |
| 授权连接池等待 P95 | 0.08ms | 0.11ms |
| 结算连接池等待 P95 | 0.13ms | 0.08ms |
| 未结预占 / outbox | 0 / 0 | 0 / 0 |

原始报告：[优化前](validation/core-2026-10-28/baseline-postgres-c4-u1.json)、[批量化后](validation/core-2026-10-28/batched-postgres-c4-u1.json)。前者在 `d661d6f` 的业务 SQL 上附加诊断，后者先隔离测量 SQL 改动，尚未包含授权意图写盘；最终完整代码另跑下述持续负载。报告均标记工作区存在未提交修改，不把 Git HEAD 冒充完整测试源码版本。

此样本授权/结算耗时主要落在资金批次相关 SQL，连接池等待很小，数据库采样最多有 3 个锁等待者。结合逐条 SQL 和数据库往返，判断持锁期过长放大了同批次排队。没有提高 5 秒控制面 RPC 超时，也没有把资金或限流转移到缓存。

具体改动：迁移 `012_batch_advisory_locks.sql` 增加按调用方原有排序依次加锁的函数；每组锁只需一次往返。各作用域限流读取、窗口累加、在途作用域插入和结算 token 调整使用集合 SQL；TTFT / 错误码并入调用日志插入。原事务、资金批次行锁、作用域锁、价格快照、唯一约束和六位金额精度保留。授权重放先查不可变记录，避免为返回原授权结果等待工作区读锁。

空闲维护在没有待发周期、没有到期清理、当前分钟监控已经评估时，跳过无变化的工作区写事务；实际发放/清理仍在原事务内重新检查，读取后发生的策略变化由下一轮维护捕获。这减少无效写锁，但尚未证明消除了持续负载长尾。

## 授权响应丢失后的恢复

1. 网关生成物理尝试 `admissionAttemptId`，在授权 RPC 前将意图 fsync 到日记的 `authorizations/` 子目录。只保存可信身份、估算值、正文哈希与幂等信息，不保存 API Key 或正文。
2. 控制面在第一次提交的响应 JSON 中保存该尝试标识。它不进入逻辑指纹，旧幂等键仍可重放；后来的尝试不能夺取原预占。
3. 正常授权后先持久化准入，再移除意图，之后才允许记录分派和调用模型。任何一步写盘失败都拒绝转发。
4. 响应丢失、RPC 超时或进程重启后，恢复器只用原输入重查授权。归属吻合且没有分派证据，才通过原结算键释放原预占；若原请求没有到达控制面，最多创建一次自己的预占并立即释放。不会自动重发模型生成。
5. 其他尝试拥有的预占不触发资金操作。缺少归属的旧记录或永久合同错误保留为可见 blocked；不能通过重试补造归属。已有分派/最终结算记录优先，不得用零用量覆盖。恢复结算失败则由普通 outbox 保存原事件。
6. 若维护任务已把过期租约变为 `pending_review`，明确未转发的持久化证据可以按原资金来源自动释放；已转发而用量未知的记录继续待核对。迟到完整用量与未转发恢复同时校正原限流窗口，重复补发不会再次变更资金。

`/health` 与服务令牌 outbox 接口把授权意图计入 queued / blocked / active，并额外提供 authorizing / authorizationPending / authorizationBlocked。检查只返回元数据；人工重试须指定单个请求、尝试标识和原因，原输入不能改写，原因与次数记录在日记及结构化日志中。真正缺少归属的旧记录仍需人工查明资金状态和处理依据，自动重试不能替代核对。

持续负载还复现了 Windows `EPERM`：最终结算 JSON 已写入临时文件，但替换分派记录失败，旧逻辑留下 active / dispatched。现在只对 EPERM / EACCES / EBUSY 做有界替换重试；重试仍失败时保留原最终用量并由后台补写，`writePending` 与 `write_pending` 元数据使其可见。重启先恢复完整 queued 临时文件，身份/分派证据冲突则停止供核查；不把完整用量降成未知或重发生成。原生备份也把这种完整临时结算归并为规范日记，不修改源目录、不丢失唯一用量证据。授权子目录使用备份清单 version 2，恢复器兼容 version 1。

```powershell
# SERVICE_TOKEN 和 GATEWAY_OPERATIONS_URL 通过当前运维环境提供。
node scripts/outbox.mjs status
node scripts/outbox.mjs inspect --request <request-id>
node scripts/outbox.mjs retry --request <request-id> --attempt <admission-attempt-id> --reason "已修复归属契约，按原意图重试"
```

## 回归记录

| 检查 | 本轮结果 |
| --- | --- |
| `pnpm build` / `pnpm typecheck` | 全项目通过 |
| `pnpm test` | Contracts 18、控制面 122、网关 41，共 181 项通过；含实际 31 秒本地流和最终写盘失败/重启恢复 |
| `node scripts/check-isolated.mjs` | 最终内存完整 HTTP 回归 369 项通过 |
| `node scripts/check-isolated.mjs --postgres` | 最终隔离 PostgreSQL 完整 HTTP 回归 425 项通过，重启保持与 schema 清理通过 |
| `node scripts/check-isolated.mjs --recovery-only` | 最终代码补充定向故障验证 65 项通过 |
| `node scripts/check-isolated.mjs --postgres --recovery-only` | 最终代码补充定向故障验证 72 项通过，包含拒绝响应丢失时不产生账目；与完整回归重叠，不相加 |
| `node scripts/check-delivery.mjs` | 迁移完整性 12 项、正式空安装/受控调用/重启/模式隔离 30 项通过 |
| `PG_BIN=<本机绝对目录> node scripts/check-delivery.mjs --backup` | 最终迁移完整性 12 项、交付/原生备份恢复 55 项通过；含授权归属、完整结算临时文件、篡改拒绝、恢复后精确一次资金变化 |
| `node scripts/check-monitoring-pool.mjs` | 最终 10 项通过，独立 schema 清理通过 |
| 内存 4 用户 / 并发 4 / 24 次 | 全部确认；逐用户扣款一致，outbox 空；[报告](validation/core-2026-10-28/load-memory-u4.json) |

故障验证使用实际网关和实际控制面，在本地代理处注入：提交后丢响应、首个提交晚于 5 秒预算、拒绝响应丢失、授权提交后强制退出/重启、双网关相同逻辑请求（第二个网关丢重放响应）、缺少归属标识、租约维护先执行、结算成功后丢确认。分别核对模型调用次数、原批次余额、单条调用日志、重复结算原文和 PostgreSQL 账目数。测试只停止本轮创建的进程，未重启人工审查实例。

最终本地回归所用 38 个源码/配置文件的原始字节 SHA-256 见 [源码快照](validation/core-2026-10-28/source-snapshot.json)；与早期压测实验的版本区分以上文记录为准。

## 持续混合负载

使用 `--duration 60 --concurrency 1|4|8 --users 1|4` 六组串行运行；到期停止发起新请求并等待在途完成。每组独立 schema、独立用户/签发密钥、每人一个批次，按调用 13 输入 / 14 输出 / 4 缓存 token 计算每次 39 微元；每三次一笔 SSE，每八次混入管理读取与维护。默认 2000 次封顶，报告保留实际停止原因。

首轮结果（SQL 批量化、授权意图已接入，尚未加入后续落盘/空闲维护修复）：

| 用户 / 并发 | 调用成功 / 发起 | 调用 P95 | 管理 P95 | 未结预占 / active 日记 |
| --- | ---: | ---: | ---: | ---: |
| [1 / 1](validation/core-2026-10-28/sustained-postgres-c1-u1.json) | 118 / 118 | 523.73ms | 540.87ms | 0 / 0 |
| [1 / 4](validation/core-2026-10-28/sustained-postgres-c4-u1.json) | 223 / 223 | 1694.79ms | 3564.09ms | 0 / 0 |
| [1 / 8](validation/core-2026-10-28/sustained-postgres-c8-u1.json) | 254 / 254 | 2465.58ms | 7242.37ms | 0 / 0 |
| [4 / 1](validation/core-2026-10-28/sustained-postgres-c1-u4.json) | 114 / 114 | 534.48ms | 707.71ms | 0 / 0 |
| [4 / 4](validation/core-2026-10-28/sustained-postgres-c4-u4.json) | 214 / 214 | 2232.72ms | 4287.53ms | 0 / 0 |
| [4 / 8](validation/core-2026-10-28/sustained-postgres-c8-u4.json) | 247 / 249 | 3011.30ms | 10087.70ms | 1 / 1 |

最高组失败后增加诊断并保留原目录，确认了 [231 / 232 的复现](validation/core-2026-10-28/diagnostic-postgres-c8-u4.json) 中最终替换报 `EPERM`，临时文件保留了 13 / 14 / 4 的完整用量。失败运行目录在报告 `evidenceDirectory` 字段中，本机保留，未作为源码提交。

落盘与空闲维护修复后，[4 用户 / 并发 8 / 60 秒](validation/core-2026-10-28/final-postgres-c8-u4.json) 为 248 / 250，全部资金收敛，未结预占、限流占用和 outbox 均为 0，但仍有授权超时和请求失败；[4 / 4 / 60 秒](validation/core-2026-10-28/verified-postgres-c4-u4.json) 为 169 / 172 个客户端成功，170 笔已确认用量，逐用户扣款与确认用量完全一致，0 残留预占。流式确认丢失可以导致客户端未见 DONE，但不能据此抹去已经确认的上游费用。文件名中的 final / verified 是探针名称，判定以 `success` 和错误明细为准，两份报告均为 false。

[30 秒阻塞链样本](validation/core-2026-10-28/lock-graph-postgres-c4-u4.json) 103 / 104，记录约 7.8 秒事务年龄、工作区行锁及 advisory 等待，外部阻塞采样为 0；这一瞬时关系不足以断言具体持锁业务已经定位。[最终工作区分段诊断样本](validation/core-2026-10-28/workspace-profile-postgres-c4-u4.json) 68 / 68、逐用户资金一致、0 残留，但时长仅 30 秒，不能推翻其他失败样本。另试验同资金源前置串行门闩后发生更多超时/拒绝，改动已撤销，[试验报告](validation/core-2026-10-28/source-gate-postgres-c8-u4.json) 仅保留排查证据。

**结论：资金与恢复缺口已补，持续容量稳定性未通过。** 不能据首轮通过样本推荐固定并发上限，也不能把失败后资金收敛当成所有请求成功。下一项继续追踪工作区写事务和授权共享锁的实际持有/等待时间，并区分客户端本地工作、数据库执行和网络等待；5 秒 RPC 预算保持原值。测量只反映此开发端点和本地模型替身的单实例闭环，不是生产容量、长周期稳定性或真实模型持续负载验收。

复现时先构建，再分别运行以下命令（`--out` 仅可指定新的文件）：

```powershell
pnpm --filter @ai-gateway/control-plane... --filter @ai-gateway/gateway-sim... build
node scripts/check-load.mjs --postgres --concurrency 4 --users 1 --requests 48
node scripts/check-load.mjs --postgres --concurrency 8 --users 4 --duration 60
```

## 后续边界

继续保留先前 T7 的待验部分：超过 30 秒的代表性真实模型任务、真实模型持续负载，以及用户暂缓的目标部署/TLS/容器恢复；Higress 与企业身份/外部通知按原清单后置。CI 已增加多用户 PostgreSQL 负载配置，未触发远端运行。整机断电、存储损坏和跨主机日记接管没有本轮证据。
