# 监控事务的连接池等待修复

此前数据库回归出现过单笔授权 HTTP 500 和一次缺少预期调用记录。本轮确认并修复了一处会造成连接池等待的实际缺陷；因原两次失败没有完整服务错误记录，不宣称它已被证明是所有历史异常的唯一原因。

## 复现与修复

`MonitoringService.evaluate()` 在 `WorkspaceRepository.transact()` 中持有工作区行锁和一个 PostgreSQL 连接，却通过 `store.inFlightCounts()` / `store.queryCalls()` 再向同一个池申请连接。并发授权会占用剩余连接、等待工作区锁；持锁任务也等待连接，直到取连接超时。即使统计数据正常，也会记录为采集故障。

独立数据库测试将本次专属池限制为两个连接，并占用其中一个。在修复前，强制监控采集稳定失败于：`monitoring must collect with one available connection, without marking healthy storage unavailable`。测试没有改共享连接配置、审查数据或生产超时。

修复后，事务内统计查询复用当前事务连接，不再嵌套取连接。统计查询使用 savepoint；查询出错时回退该次读取，使外层事务仍能记录采集故障，不因 PostgreSQL 事务被标记失败而丢失告警。普通独立调用查询仍使用原有只读一致性事务。

## 验证

```powershell
pnpm check:monitoring
```

10 项隔离 PostgreSQL 检查通过：仅剩一个可用连接时采集成功；真实缺失统计表时故障可记录；恢复表后同一流程继续成功；业务 revision 和资金不变；并发授权实际填满测试池，最终正常返回业务拒绝，没有取连接失败；不存在遗留的 idle-in-transaction。专属 schema 已清理。

控制面 86 项测试、完整内存 HTTP 277 项、完整 PostgreSQL HTTP 328 项通过；`pnpm check:monitoring` 实际执行通过。并发请求使用生产代码既有的 5 秒取连接超时，未提高生产超时或降低并发；300 ms 仅用于前半段快速发现嵌套取连接的固定复现，不作为业务延迟指标。

后端修复已更新到 http://localhost:5176/，未修改页面交互。升级恢复沿用同一审查工作区，未重新播种；升级前后企业设置、组织、成员、项目、应用、密钥、资金批次、预算、审批和调用汇总一致，差异字段为空。工作区目录中的 `monitor-upgrade-verified.json` 保存无凭据的核对收据。
