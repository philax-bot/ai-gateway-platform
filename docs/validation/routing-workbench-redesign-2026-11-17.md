# 路由、供应商与个人模型工作台界面重做验证

日期：2026-11-17。范围：`apps/web`。方案见 [供应商、模型池与个人模型工作台界面重做方案](../product/routing-modalities-ui-redesign-plan-2026-11-17.md)，组件与配方见 [组件选型与样式契约](../product/ui-component-contract-v1.md) 的 3.21–3.26、4.11–4.13。

状态：P0–P5 已实现，类型检查、生产构建与五组浏览器回归通过。本地验证不代表生产部署或真实上游验收。

## 1. 改动面

| 区域 | 位置 |
| --- | --- |
| 共享构件与新样式 | `apps/web/src/model-surface.tsx`、`model-surface.css`、`media-result.tsx` |
| 供应商列表与对象页 | `apps/web/src/Providers.tsx`（重写）、`WorkspacePages.tsx`（`targetId`） |
| 模型池列表、对象页与页内试算 | `apps/web/src/ModelPools.tsx`（重写）；`RoutingSimulator.tsx` 删除 |
| 可用模型清单 + 详情 | `apps/web/src/AvailableModels.tsx`（重写）、`model-facts.tsx`（原 `ModelCard.tsx`）、`model-discovery.css`（只保留个人壳层） |
| 在线使用 console | `apps/web/src/Online.tsx`（重写） |
| 多模态工作台与任务中心 | `apps/web/src/MultimodalWorkbench.tsx`、`MediaTasks.tsx`（重写） |
| 口径文案 | `apps/web/src/EnterpriseApp.tsx`（`providers` / `pools` 导语） |

未改：后端命令、校验、准入/额度/结算逻辑、权限模型、契约以外的页面。未新增接口；模型池容量读既有 `GET /api/v1/platform/monitoring/capacity`，试算读既有 `POST /pools/:id/simulate`。

## 2. 验证结果

| 检查 | 结果 |
| --- | --- |
| `pnpm --filter @ai-gateway/web typecheck` | 通过（`tsc -b`，无输出即无错误） |
| `pnpm --filter @ai-gateway/web build` | 通过（Vite 生产构建） |
| `node scripts/check-web.mjs`（memory） | **PASS 139** 断言 |
| `node scripts/check-web.mjs --postgres`（隔离 PostgreSQL） | **PASS 139** 断言 |
| `node scripts/check-web.mjs --provider-onboarding-only` | **PASS 93**：供应商列表 → 详情 → 接入服务 → 凭据 → 模型池 → 开通 → **在线使用真实调用** → 密钥停用；五套壳层 × 1440/390 无横向溢出 |
| `node scripts/check-web.mjs --model-discovery-only` | **PASS 158**：清单/详情、筛选组合、空态、来源停用与恢复、刷新失败保留、复制失败/成功、五套壳层 × 1440/1024/920/390 |
| `node scripts/check-web.mjs --operations-v2-only --postgres` | **PASS 74**：模型池详情与**页内试算**（候选表“排序 / 分数”）、六类媒体调用、任务中心、390 无溢出 |
| `node scripts/check-web.mjs --multimodal-only --postgres` | **PASS 72**：供应商能力表单、池路由策略、媒体计价、仅目录连通性文案 |

回归脚本同步改动：`check-model-discovery-web.mjs`（`.split-row` + 详情面板 + 连线选择）、`check-provider-onboarding-web.mjs`（“详情 ›” → “接入服务”、会话气泡、服务编辑入口）、`check-operations-v2-web.mjs`（页内试算、媒体类型分段、技术角色成本保留改为读存储态）、`check-multimodal-web.mjs`（模型池详情入口）。

## 3. 截图

均位于 `docs/validation/screenshots-2026-10-23/`（五套壳层同名文件）与 `screenshots-2026-11-12-operations-v2/`：

- `providers-1440 / 390`、`provider-detail-1440 / 390`（统计条、分组表、能力矩阵、凭据分组）
- `available-models-*`、`available-model-detail-*`（清单 + 详情、单一主按钮）
- `employee-online-1440`（三栏 console：会话设置 / 对话 / 准入小票）
- `routing-simulation-1440`、`routing-decision-1440 / 390`（页内解释与候选表）
- `workbench-result-1440`、`workbench-image-1440`、`workbench-audio-1440`、`tasks-1440 / 390`

## 4. 发现与处理

- **390 供应商详情横向溢出**：能力矩阵固定 `min-width:480px` 溢出页面。已改为宽屏表格 + ≤760px“类型 + 三态文字”行列表（契约 3.22 的降级写法），复跑五套壳层 × 390 通过。
- **在线使用模型下拉曾缺 options**：console 重写时漏传 `options`，回归中表现为“模型只有请选择”。已修复并复跑供应商闭环（真实发送）通过。
- **技术角色成本保留断言**：`billingView` 会对无 `costs.read` 的操作者剥离命令回执里的 `costPrice`，原断言读回执必然失败。改为读 `/state` 的存储态再断言保留语义，未放宽校验。
- **能力矩阵列数**：矩阵按模型类型 7 列展开，供应商模板类型多时只在详情出现；列表仍为 ≤3 标签 + `+N`。

## 5. 仍待处理

- 两处脚本级 ast-grep 提示（webhook 钩子 `JSON.parse`、测试用 PostgreSQL 元数据查询）为既有写法，未在本轮改动；如需清零应单独重构。
- `knip` 可能把 `media-result.tsx` 报为未使用（其索引滞后于本轮新增 import），以 `typecheck`/`build`/浏览器回归为准。
- 未做真实上游联调、生产部署验证与性能压测；`check-web` 的 memory 与隔离 PostgreSQL 均为本地替身。
- 会话内多轮只存在于在线使用页面内存，刷新即清空；未落库，也不合并调用记录。
