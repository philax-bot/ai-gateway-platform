# 用量驾驶舱 · 设计稿（演示）

产品实现的接口、权限、真实页面 / CSV 与故障恢复验收见 [2026-11-02 验证记录](../../validation/usage-analytics-2026-11-02.md)；本目录的静态演示数字不作为运行态证据。

同一个数据故事的三版视觉方案，用于评审对比。三者都**不是产品页面**：不进入 `apps/web` 构建，不复用任何页面级 CSS，页面实现仍以 [组件选型与样式契约](../ui-component-contract-v1.md) 为准。

> **演示已进产品壳层（2026-10-30）**：三版视觉作为三个并列菜单页放在运营空间里，可直接在真实壳层中切换对照：
> 「浅色驾驶舱」（`cockpit-light`，列表版）、「深蓝驾驶舱」（`cockpit-tech`，深蓝科技版）、「大屏驾驶舱」（`cockpit-beacon`，信标大屏版）。
> 三页共用 `POST /api/v1/platform/analytics/usage` 的同一份聚合数据与同一套图表组件，只换皮肤与信息密度；页面内提供三版互跳、本月至今 / 近 7 天 / 近 30 天与费用 / Token / 请求切换。
> 实现：`apps/web/src/cockpit-demo.tsx` + `apps/web/src/cockpit-demo.css`（全部规则限定在 `.demo-cockpit` 下，不改五套产品壳层）。这三个页面是演示页，不属于组件契约的产品页面。
>
> **已落地（2026-10-30）**：信标浅色版的信息结构与交互已实现为产品页面 `apps/web/src/UsageCockpit.tsx`（导航「用量驾驶舱」，契约 4.5），数据来自 `POST /api/v1/platform/analytics/usage`；两版驾驶舱的图表成为契约 3.18 / 3.19 的共享组件（`apps/web/src/components-charts.tsx`）。本目录只保留为设计对照与回归参考，不再作为实现来源。

| 文件 | 版本 | 说明 |
| --- | --- | --- |
| `usage-cockpit-v1.html` | 信标浅色版 | 产品既有语言（`data-ui="beacon"`、v4 壳层），列表页形态，组件全部来自契约：FilterBar / TaskHero / StatStrip / Table / DetailGroup / Modal。**可直接作为 `apps/web` 落地参考。** |
| `usage-cockpit-beacon-v1.html` | 信标驾驶舱版 | 同一套 tokens（暖白画布 / 深墨主数值带 / 紫色强调 / 20–26px 圆角）套到大屏驾驶舱布局：环形分布、排名条、活跃度仪表、双轴趋势。视觉与产品一致，但多面板布局与图表属于待入契约的新增项。 |
| `usage-cockpit-tech-v1.html` | 深蓝科技版 | 深蓝底 + 霓虹描边的另一种大屏皮肤，只用于演示与视觉对比，不建议作为产品主题。 |

三版使用**同一套演示数据**（近 7 天：42 名活跃人员 / 18,364 次请求 / 8.42M 输入 Token / ¥1,248.04 已确认费用 / ¥33.62 待核对），便于同一窗口左右对比：数字、排名、口径与未知状态处理完全一致，差异只在视觉与信息密度。

## 三版差异

| 维度 | 信标浅色版 | 信标驾驶舱版 | 深蓝科技版 |
| --- | --- | --- | --- |
| 定位 | 产品页面（可落地） | 大屏布局 + 产品语言 | 大屏皮肤（纯演示） |
| 布局 | 页头 → 筛选 → hero → 统计条 → 排名 → 分布 | 页头 → 深墨主数值带 → 统计条 → 2×3 面板 | 同左，霓虹切角卡 |
| 筛选 | FilterBar 可交互 | 时间窗口固定展示 | 时间窗口固定展示 |
| 图表 | 行内占比条（提案 3.18） | 环形图 / 条形排名 / 仪表 / 双轴折线 | 同左，发光版 |
| 契约状态 | 全部符合（已落地） | 图表已入契约 3.18 / 3.19 | 仅演示，不做主题 |

## 已入契约的新增项（三版共用结论）

1. **3.18 ShareBar**：表格内占比条（轨道 6–9px、圆角、`aria-hidden`、百分比单独成列）。已实现，并补了「<0.1% / >99.9%」的写法，避免把有金额的行显示成 0%。
2. **3.19 图表**：环形图 / 仪表 / 折线的维度、空值与未知、口径说明、可访问表格替代（驾驶舱两版都提供了折叠数值表）。已实现为 `DonutChart` / `GaugeChart` / `TrendChart`，趋势按自然日补 0。
3. **4.5 驾驶舱页面配方**：筛选在统计条之前并作用于全页；主数值只出现一次。已落地为 `usage` 页面。

## 已知边界

- 驾驶舱两版的趋势图针对 1920 与 1440 优化；≤900px 时图表在容器内横向滚动，保持刻度可读。
- 演示数据里"今日"为进行中数据（09:41 截止），不与完整日同比；采集失败、用量未知、待核对的口径三版一致。
- 深蓝版的深色主题若真要落地，需要独立 `design-vN.css` 主题层与对比度复核，不能与信标 tokens 混用。

## 截图

`docs/product/screenshots/`：

- 浅色版：`cockpit-usage-1440.png`、`cockpit-usage-1440-full.png`、`cockpit-usage-390.png`、`cockpit-detail-1440.png`、`cockpit-notes-1440.png`
- 信标驾驶舱版：`cockpit-beacon-1920.png`、`cockpit-beacon-1440.png`、`cockpit-beacon-390.png`
- 深蓝科技版：`cockpit-tech-1920.png`、`cockpit-tech-1440.png`、`cockpit-tech-390.png`
- 三版并列演示页：`cockpit-demo-light-1440.png`、`cockpit-demo-tech-1440.png`、`cockpit-demo-beacon-1440.png`、`cockpit-demo-390.png`
- 真实产品页面（`usage`）：`cockpit-real-1440.png`、`cockpit-real-panels-1440.png`、`cockpit-real-detail-1440.png`、`cockpit-real-empty-1440.png`、`cockpit-real-390.png`（截图由本地一次性 CDP 走查生成，64 项断言；脚本留在 `.runtime/`，不随仓库提交）
