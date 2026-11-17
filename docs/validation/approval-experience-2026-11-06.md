# 审批体验首版验证（2026-11-06）

## 交付范围

七类申请继续使用统一审批中心。界面用流程节点、变更对比和实际结果组织信息，完整规则与长说明折叠；未更改经理自分配、运营直接授权、费用上限或多级审批政策。

- 申请表预览审批职责与结果；审批表随金额和方案变化更新对比，确认页核对完整期限、项目经理与模型范围。
- 待审批、已批准待生效、执行失败均阻止重复申请；当前责任人可预览并关闭未生效申请，保留原审批与失败记录。
- 经理停用、到期或所属组织失效时，成员申请转有效运营。接手已批准事项需留下修正记录，执行仍核对当前职责与批准人。
- 生效事务记录实际对象、预算/资金批次、权益、金额、期限、来源/去向和模型名称；历史无回执标记为未采集，不推断到账。
- 创建项目不要求额度到期日，也不会产生预算。结果直达新项目，个人/成员额度结果恢复正确用途。
- 五套壳层复用共享组件；修复顶栏版窄屏工具条不能收缩的问题，不隐藏工具入口。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `pnpm build` | 全工作区通过，Web 保留已有大 bundle 提醒 |
| Web `typecheck` | 通过 |
| `pnpm --filter @ai-gateway/control-plane test` | 38 个文件、235 项通过；新增生命周期 19 项 |
| `node scripts/check-web.mjs --postgres --approvals-only --application-billing` | 116 项浏览器断言通过；独立 PostgreSQL schema、独立端口与 Chrome profile |
| 同一运行中的 SQL 聚合/权限回归 | 59 项通过 |
| 1440 × 1000 / 390 × 844 | 申请、待批、决定、结果、失败、关闭、接手、项目创建及应用计费截图；无页面级横向溢出 |
| 五套界面 | `azure` / `sidebar` / `next` / `classic` / `beacon` 均通过 1440 / 390 溢出检查 |
| 键盘与权限 | DateField 打开/Escape 回焦，弹窗 Tab 约束，申请人无审批按钮；关闭与接手后端权限检查通过 |
| 浏览器异常 | 0 个未捕获异常 |
| 日常开发入口 | 正常 `pnpm dev` 恢复原 PostgreSQL 工作区，入口为 `http://localhost:5176/?ui=beacon` |

自动化断言全文：[browser.json](screenshots-2026-11-06-approvals/browser.json)。测试仅使用本地模型替身，不代表真实模型、生产环境或客户验收；本轮未对日常开发库制造审批/发放演示单。

## 代表截图

| 场景 | 桌面 | 窄屏 |
| --- | --- | --- |
| 申请前路径 | [1440](screenshots-2026-11-06-approvals/approval-request-1440.png) | [390](screenshots-2026-11-06-approvals/approval-request-390.png) |
| 待审批 | [1440](screenshots-2026-11-06-approvals/approval-pending-1440.png) | [390](screenshots-2026-11-06-approvals/approval-pending-390.png) |
| 调整批准内容 | [1440](screenshots-2026-11-06-approvals/approval-decision-1440.png) | [390](screenshots-2026-11-06-approvals/approval-decision-390.png) |
| 实际结果 | [1440](screenshots-2026-11-06-approvals/approval-effective-1440.png) | [390](screenshots-2026-11-06-approvals/approval-effective-390.png) |
| 执行失败 | [1440](screenshots-2026-11-06-approvals/approval-failed-1440.png) | [390](screenshots-2026-11-06-approvals/approval-failed-390.png) |
| 已关闭 | [1440](screenshots-2026-11-06-approvals/approval-closed-1440.png) | [390](screenshots-2026-11-06-approvals/approval-closed-390.png) |
| 接手后待执行 | [1440](screenshots-2026-11-06-approvals/approval-takeover-1440.png) | [390](screenshots-2026-11-06-approvals/approval-takeover-390.png) |
| 项目创建结果 | [1440](screenshots-2026-11-06-approvals/approval-project-created-1440.png) | [390](screenshots-2026-11-06-approvals/approval-project-created-390.png) |

## 开发启动记录

首次启动发现旧启动锁中的 PID 已被 `GameViewerService.exe` 复用，Node 探活返回 `EPERM`。核对原开发端口无监听、无运行中的本项目启动进程后，仅将失效锁归档到 `.runtime`；保留原状态文件与 schema，没有停止该服务进程。之后按 `pnpm dev` 恢复。后端变更后的重启只停止本次启动器的已核实控制面子进程，由启动器清理自身子进程后重新启动。
