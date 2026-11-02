# 用量聚合与驾驶舱验收记录

日期：2026-11-02。范围：用量聚合接口、驾驶舱、排行榜、三版演示页及 CSV 导出；本地测试模型，无外部模型调用。

## 验证入口与结果

从仓库根目录运行：

```powershell
pnpm build
pnpm --filter @ai-gateway/web typecheck
pnpm --filter @ai-gateway/control-plane test
$env:WEB_CHECK_SCREENSHOT_DIR='docs/validation/screenshots-2026-11-02-usage-acceptance'
node scripts/check-web.mjs --postgres
```

- 全量构建、Web 类型检查通过。
- Control Plane：36 个测试文件、198 项测试通过，包含 7 项内存聚合测试。
- PostgreSQL：42 项 SQL/内存一致性及真实 HTTP 权限断言通过。
- 浏览器：129 项断言通过，涵盖真实接口与 CSV、故障响应、标签页保留、日期键盘路径、五套壳层及 320–1440px 横向溢出检查。
- 省略 `--postgres` 的内存模式另行通过同一套 129 项浏览器断言。

`--postgres` 读取已有数据库连接配置，创建本次随机生成的 `agp_web_<uuid>` schema，使用真实迁移初始化并在结束时删除。检查不接管日常开发工作区，不使用 `.runtime/review-postgres.json` 指向的 schema；临时服务和 Chrome 均按本次持有的子进程清理。

## 数据与权限

`scripts/check-usage-analytics.mjs` 插入隔离测试记录，逐字段对比 SQL 与内存聚合：

- `[from,to)` 边界、跨月、工作区午夜、UTC 和 `America/New_York` 夏令时切换；固定历史窗口避免与启动时的演示记录混淆。
- 模型、组织、用途筛选；无数据窗口；默认月份边界。
- 六位小数费用、未知用量 Token 排除、已确认费用、待核对费用、未转发与上游失败。
- 人员、应用、项目、模型、组织、自然日和汇总结果一致。

同一批记录经真实账号登录再次校验接口作用域：运营全部可见；项目经理仅有本人、本人负责的应用和 active 受管项目的项目调用；同事个人支出、其他项目和无关应用不进入经理汇总。暂停项目会移除该项目增加的可见范围。普通成员只见自己的调用及负责应用；匿名请求为 401，伪造作用域和非法窗口为 400。

## 真实页面与 CSV

浏览器检查首先通过真实本地网关产生已结束调用，使用未经替换的聚合响应显示驾驶舱与排行榜。直接读取导出按钮生成的 Blob，验证 UTF-8 BOM、15 列、请求与费用合计，以及各维度与接口汇总的一致性。

之后才注入浏览器测试响应，覆盖当前已开通但无调用的人员、已到期调用者、历史未知身份、请求延迟、503 和重试：旧数字与导出失效，重试后恢复；历史主体退出排名但留在合计与数据质量；活跃率分子与分母为同一人员集合；切换标签保留筛选与排名口径，完整排行榜可定位到新维度。此部分响应属于交互测试数据，不作为真实采集证据。

截图：

- [真实驾驶舱 1440px](screenshots-2026-11-02-usage-acceptance/usage-live-1440.png)
- [真实驾驶舱 390px](screenshots-2026-11-02-usage-acceptance/usage-live-390.png)
- [真实排行榜](screenshots-2026-11-02-usage-acceptance/usage-leaderboard-live-1440.png)
- [接口失败与导出禁用](screenshots-2026-11-02-usage-acceptance/usage-fixed-error-1440.png)

## 验收边界

这些结果证明隔离 PostgreSQL、内存实现和本地浏览器流程的一致性；没有进行生产部署、真实模型或持续负载容量验收。构建仍有既存的单包超过 500kB 提示，未影响构建通过。
