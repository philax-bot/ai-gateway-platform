# 商务／解决方案演示验收

日期：2026-11-02。演示入口：[信标界面](http://localhost:5176/?ui=beacon)；讲解与账号清单见 [演示脚本](../BUSINESS-DEMO.md)。

## 结论

下钻、演示数据、讲解脚本与完整彩排已完成，可开展本机内部产品能力演示。日常入口仍为 `pnpm dev`，恢复原 PostgreSQL 工作区；本轮没有重建开发数据库、修改原企业自动规则或变更外部模型 opt-in。演示流量使用明确标记的本地模型替身。

## 完成内容

- 运营从人员、项目、应用、组织排名进入既有调用记录，携带实际统计窗口与已应用的组织／模型／用途条件。
- 异常分组与驾驶舱 errors 使用同一定义；待核对金额进入费用核对页。已有调用记录标签可接收新的下钻，分页重置；返回保留窗口、维度和位置。
- 项目经理保留原有汇总范围，本轮未扩大调用明细或费用核对权限。
- 新准入快照新增目录组织归属，组织统计与明细筛选共用该快照。租户授权身份不变；旧记录缺快照时保留原归属，不伪造历史部门。单测覆盖准入后人员转组织，旧调用仍按原组织统计。
- 专用演示资源：6 个账号、2 个部门、2 个项目、2 个应用、2 个本地模型别名。每轮通过正常网关调用生成 24 条记录，包括正常、流式不完整、上游错误；预算、分配、计费与核对均走现有命令及账本。
- 演示应用负责人在现有企业规则下曾自动获得基础个人权益。本轮仅通过正常撤销命令移除该专用演示账号的自动个人权益，原规则、原用户及批次历史保持。这样可实际展示应用额度独立于个人权益。
- 相同日期与轮次重复准备不会重复发放或重复生成调用；需要新的待核对样本时追加新轮次。已核对记录不回滚。

## 验证结果

| 验证 | 结果与范围 |
| --- | --- |
| 全量构建、Web 类型检查／生产构建 | 通过；保留既有的单包超过 500kB 提示 |
| Control Plane 单测 | 36 个文件、200 项通过 |
| 隔离 PostgreSQL | 59 项 SQL／内存一致性、HTTP 权限及下钻筛选断言通过 |
| 隔离浏览器 | 142 项通过，覆盖真实接口／CSV、失败重试、五套壳层、键盘路径及响应式；另完成该次演示主线的 16 项检查 |
| 原开发工作区完整彩排 | 信标界面 19 项通过，增加人员／项目／应用／组织各维度的下钻验证；无未捕获浏览器异常；390px 无页面级横向溢出 |
| 演示准备幂等性 | 同一轮资源数、额度与项目预算余额不变，调用 ID 集合不变 |

隔离回归入口：

```powershell
pnpm build
pnpm --filter @ai-gateway/control-plane test
pnpm --filter @ai-gateway/web typecheck
$env:WEB_CHECK_SCREENSHOT_DIR='docs/validation/screenshots-2026-11-02-business-demo'
node scripts/check-web.mjs --postgres --demo
```

检查脚本使用本次生成并清理的隔离 schema 与专用 Chrome，不关闭用户现有浏览器。原开发工作区另行使用同一彩排函数走查专用演示账号。实际执行了一笔演示记录的预占释放并核对落库，项目补充额度仅预览后取消，没有为了彩排再追加预算。

机器可读证据：[彩排结果](business-demo-rehearsal-2026-11-02.json)、[重复准备检查](business-demo-idempotence-2026-11-02.json)。

## 实际工作区截图

- [开通影响预览](screenshots-2026-11-02-business-demo-live/demo-01-onboarding-preview-1440.png)
- [员工在线使用](screenshots-2026-11-02-business-demo-live/demo-02-online-1440.png)
- [用量驾驶舱](screenshots-2026-11-02-business-demo-live/demo-03-usage-1440.png)
- [调用下钻](screenshots-2026-11-02-business-demo-live/demo-04-call-drilldown-1440.png)
- [费用核对预览](screenshots-2026-11-02-business-demo-live/demo-05-reconciliation-preview-1440.png)
- [项目额度预览](screenshots-2026-11-02-business-demo-live/demo-06-project-funding-preview-1440.png)
- [经理项目汇总](screenshots-2026-11-02-business-demo-live/demo-07-manager-1440.png)
- [应用负责人](screenshots-2026-11-02-business-demo-live/demo-08-application-owner-1440.png)
- [390px 驾驶舱](screenshots-2026-11-02-business-demo-live/demo-09-usage-390.png)

## 范围说明

本轮证明内部演示主线及本地 Higress／PostgreSQL 链路可用，没有新增厂商模型推理。生产部署、客户身份接入、真实模型容量与客户项目验收仍按具体环境另行验证。
