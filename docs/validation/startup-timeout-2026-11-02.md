# pnpm dev 控制面启动超时修复

日期：2026-11-02。用户错误为 `服务启动超时：http://localhost:4301/health`，控制面已注册路由，但没有完成应用启动。

## 根因与恢复

现场 PostgreSQL 锁链显示：旧会话从本地时间 15:52 起执行 `update platform_workspace set payload=$1,revision=$2,updated_at=now() where id=$3`，长时间等待客户端，仍持有当前审查工作区的写锁。其后四个会话等待同一工作区的行锁／事务锁，包括多次重启所留下的连接。

`MaintenanceService.onApplicationBootstrap()` 同步等待首次维护。维护需要更新工作区，因此旧锁阻止初始化钩子返回，Nest 没有开始监听；启动器的 90 秒健康检查最终超时。终端最后显示 `tsc -b` 是因为后续阶段没有进度日志，不能据此判断类型检查卡住。

仅终止了已确认持有／等待当前 schema 锁的五个已过期会话，没有删除状态文件或 schema。清理前后，已提交工作区 revision 均为 360，内容摘要一致；25 个额度批次的金额摘要一致。未提交事务按 PostgreSQL 机制回滚。

## 修复

- 首次维护改为后台运行，不再阻塞 Nest 开始监听；维护失败仍由 `/health` 的 maintenance 状态体现，后续 tick 继续按原规则去重执行。
- 控制面 PostgreSQL 会话默认锁等待上限 5 秒、SQL 上限 30 秒、事务内空闲上限 30 秒，并启用 TCP keepalive。连接携带应用名称，便于定位所属工作区；检查脚本传入的 `PGAPPNAME` 保持有效。
- `pnpm dev` 显示构建完成、数据面准备、各服务就绪检查阶段。单次健康探测由 400ms 调整为 3 秒，仍保留 90 秒总上限，超时时说明最后一次探测状态。

## 验证

- Control Plane 全部 201 项单测通过。新增真实 Nest 初始化测试：初始监控被暂停时，应用初始化仍能完成；释放后维护正常收尾。
- `node scripts/check-postgres-session.mjs` 使用独立生成的 schema，验证真实会话参数、持锁时约 5 秒返回 `55P03`、事务回滚及连接重新使用；结束后仅清理自有 schema。
- 实际 `pnpm dev` 恢复原工作区，Web 5176、控制面 4301、网关 4300、本地模型 4310 均返回 HTTP 200。
- 控制面健康状态为 `ok`、database 为 `up`，后台维护已正常完成，error 为 null。

日常仍使用 `pnpm dev`，保留原开发数据和上游 opt-in。本次没有调用真实模型、重置资金或重建数据库。
