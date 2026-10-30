# 平台管理个人 Octop 实例与专用 Key（2026-10-28）

> 本文记录管理 API 阶段的历史验收。后续已新增 Web 入口、平台会话桥接，并默认关闭过渡登录导出；当前行为与新增证据见 [平台入口与会话桥接](OCTOP-BRIDGE-2026-10-28.md)。下文“尚未新增页面”等描述仅适用于此阶段。

## 交付范围

已实现后台 API 与本地执行器的最小管理闭环：当前平台用户 → 稳定实例映射 → 独立 Octop 进程/home → 专用个人 Key → 启动、停止、轮换及交付失败后重试。

本轮没有新增 Web 页面、统一登录或云端部署。运行器默认关闭，只有明确启用、非 production 且控制面绑定回环地址时才接受操作。普通用户过渡登录不是 SSO；正式托管仍需独立执行身份/容器、文件权限、工具沙箱和完整运维验收。

## 已实现的行为

| 行为 | 实现及影响 |
| --- | --- |
| 创建/启动 | 根据当前会话的稳定 member ID 和 tenant ID 派生实例 ID；服务端决定端口、路径与上游。已健康运行且 Key 有效时复用现有实例，不额外签发 Key |
| Key 交付 | 复用现有个人 Key 签发和准入同步逻辑，在同一事务内保存实例映射与 Key 哈希；完整值只短暂存在于服务端内存，再写入本用户 Octop Provider |
| Key 轮换 | 先吊销旧专用 Key，再安装新 Key。此策略有短暂不可用窗口；不会维持两把都可用的 Key。其他本地客户端的 Key 不受影响 |
| 停止 | 先吊销专用 Key，再停止本执行器持有句柄的进程树；保留 home、SQLite 和实例映射，用于重启 |
| 失败 | 交付失败或确认状态不明确时，新 Key 被吊销，实例标记 failed，并尝试停止本实例；用新的幂等键重试。失败回执重放不再签发 Key |
| 并发 | 同实例操作在进程内互斥，持久化操作 token/租约防止重复执行；启动、HTTP 调用与 Key 交付均在工作区事务之外执行 |
| 访问范围 | 普通用户只能管理自己的实例；运营可读取/停止/轮换已有实例，但不能取得他人的 Octop 登录密码。越权与不存在均返回 404 |
| 过渡登录 | 只有实例所有者可请求重置普通 Octop 用户密码；返回 loginUrl、username、password，设置 Cache-Control no-store。管理员凭据始终由服务端保管 |

过渡登录的密码仅在本次响应展示，平台工作区、审计和幂等回执不保存原值；Octop 自身保存密码哈希。该密码在下一次重置前仍可登录，不是仅能使用一次的 OTP。重置密码不撤销已签发的 Octop JWT；平台退出登录也尚未与 Octop 会话撤销联动。

## API

完整契约见 [platform-api-v0.1.yaml](../contracts/platform-api-v0.1.yaml)，共享类型见 [platform.ts](../packages/contracts/src/platform.ts)。全部入口使用现有 SessionGuard；不新增服务令牌到浏览器。

| 方法与路径 | 权限/输入 |
| --- | --- |
| `GET /api/v1/platform/agent-instances/self` | 当前有效平台用户；未创建时 instance 为 null；返回 enabled |
| `GET /api/v1/platform/agent-instances/:id` | 所有者或运营；仅返回状态、脱敏 Key、入口和 Agent ID |
| `POST /api/v1/platform/agent-instances/self/ensure` | 当前用户，body 仅允许 idempotencyKey |
| `POST /api/v1/platform/agent-instances/:id/rotate-key` | 所有者或运营，body 仅允许 idempotencyKey |
| `POST /api/v1/platform/agent-instances/:id/stop` | 所有者或运营，body 仅允许 idempotencyKey |
| `POST /api/v1/platform/agent-instances/:id/access` | 仅所有者；重置并返回普通用户登录信息，不返回管理员信息 |

操作请求示例：

```json
{"idempotencyKey":"a-new-uuid-for-this-action"}
```

不接受 ownerId、memberId、home、port、baseUrl 或待导入 Key。实例映射按稳定 ID 绑定，改变姓名或登录名不改变归属。

重复操作返回当前实例视图，不重做已完成的操作；相同幂等键不能用于另一操作。首次交付失败后，相同键不再次签发 Key；新的键才发起补偿后的重试。视图反映当前状态，因此若后续另一次操作已恢复成功，再重放早先的请求也会看到当前运行状态，而不是历史失败快照。已过期的持久操作租约在下次操作时作为中断处理，先吊销遗留 Key。金额、额度发放、模型路由、准入和结算仍由原控制面负责。

## 配置与持久化

控制面环境变量均由运维配置，不能来自用户请求：

```text
OCTOP_MANAGED_ENABLED=true
HOST=127.0.0.1
PLATFORM_MODE=development
OCTOP_PROJECT_ROOT=D:\Workspace\pri\ai-gateway-platform
OCTOP_SOURCE_DIR=D:\Workspace\pri\ai-gateway-platform\.runtime\octop-source-890111b
OCTOP_MANAGED_ROOT=<本项目 .runtime 下的专用子目录>
OCTOP_GATEWAY_URL=http://127.0.0.1:<该环境的网关端口>
```

上游要求固定 commit `890111b7879665840414ca28ab168b05b0db0921`、干净的已跟踪源码和已安装的 `.venv`。准备方式沿用 [初次 Octop 接入](OCTOP-INTEGRATION-2026-10-28.md)。配置了 production 或非回环 HOST 时，即使开关为 true 仍不启用。

业务实例元数据作为可选的 `WorkspaceState.agentInstances` 持久化；旧工作区无此字段时按空集合读取，不需要修改已执行迁移。它只保存归属、状态、代次、Key ID、操作租约和固定错误码，完整 Key、管理员密码和外部异常原文不进入工作区。

本地运行目录由实例 ID 派生，校验 realpath 位于专用根目录。目录内 `manager.json` 保存本地执行器所需的管理员凭据与端口，Octop home 则保存 SQLite、用户 workspace 和 Provider 凭据；管理文件位于 Agent workspace 之外。文件创建使用 0600，但 Windows 同账户下的隔离不能靠该模式保证，因此运行器明确限制为本地开发用途。

一个运行根目录由一个控制面进程管理，根锁记录进程身份。新进程只会清除已确认死亡进程留下的根锁；存活或不明身份的锁会拒绝接管。对某个端口已有响应但不持有进程句柄的实例，不会按名称查杀或自动收编；需先按实际进程归属处置。此实现不宣称支持多副本调度、跨主机迁移或强杀后的全部自动恢复。

正常停止保留数据；测试脚本结束后才删除本轮专属目录。平台数据库备份与用户 Octop home/管理文件必须配套规划，现有数据库恢复不自动恢复 Octop 文件卷，本轮未验收组合备份。

## 验证

复跑命令（均只调用本地确定性模型，无厂商费用）：

```powershell
pnpm check:octop:managed
# 构建后验证独立 PostgreSQL schema 及控制面重启：
node scripts/check-octop-managed.mjs --postgres
```

| 检查 | 结果 |
| --- | --- |
| 管理域及运行开关定向单测 | 12 项通过，包含隔离、幂等、轮换、失败补偿、并发、交付中降权、过期操作恢复与运行进程失联观测 |
| 实际 Octop + 内存平台 | 41 项通过 |
| 实际 Octop + 隔离 PostgreSQL | 46 项通过，包含并行创建、控制面重启后映射/会话/状态保持，且重启不额外创建 Key |
| 全项目类型检查、构建 | 通过 |
| 单元测试 | Contracts 18、控制面最终 141、网关 41，共 200 项通过；最终控制面含运行开关与失联状态测试 |
| 现有完整 HTTP 回归 | 内存 372 项、隔离 PostgreSQL 428 项通过；新功能默认关闭，已有业务链路继续通过 |

两种实际实例验证都包含普通用户越权拒绝、客户端目录/所有者注入拒绝、幂等创建、并行对话、轮换期间另一用户继续调用、停止吊销、原映射重新启动，以及网关故障导致交付失败后安全重试。账户各自按 39 微元/次核对，并未把停止/轮换当作 Token 消费。

PostgreSQL 重启用例先正常停止两个用户实例，再重启控制面；随后验证映射、会话、停止状态和再次启动，不能据此宣称运行中实例在强杀后可自动接管。若持久记录为 running，但执行器无法观测其进程，视图返回 failed / runtime_not_observed 与空入口，不能误报为已停止或健康运行；这条分支另有定向单测。

内存及 PostgreSQL 脱敏结果、输入摘要见 [验证目录](validation/octop-management-2026-10-28/summary.json)。执行器只停止自己创建的 PID 树，不影响现有审查环境或用户浏览器；脚本清理专属 schema、home 和日记目录。此前已经用完的真实模型预算没有重置，本轮没有新增 DeepSeek 请求。

## 当前边界与后续

后台管理闭环已可通过 API 验收。下一阶段是统一身份和受鉴权的平台入口：服务端选择用户实例、管理 WebSocket 路由、实现平台退出/停用与 Octop 会话和执行能力的联动，再建设对应页面。当前没有新增菜单或一键跳转 UI。

成员停用会通过现有实时授权逻辑阻止其模型调用，但不会自动终止已经登录 Octop 的工具会话。生产容器/执行身份、资源与网络限制、入口 TLS、组合备份恢复及长时负载仍未交付，云端部署保持暂缓。
