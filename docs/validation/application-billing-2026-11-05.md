# 应用记账与额度模式验证（2026-11-05）

## 行为与范围

- 新应用默认 `accounting`（记账模式），可在创建表单选择 `quota`（额度模式）。两者初始均为 0 元；旧应用缺少字段时继续按额度模式处理。
- 记账账户使用零起始金额的独立持久化账户，允许预占和结算成负数；普通额度批次保留非负余额约束。模型范围、价格、安全策略与 RPM / TPM / 并发保护继续生效。
- 记账转额度由负责人提交 `application_billing` 申请，沿用统一审批中心；运营不可自批。仅执行生效时，原子切换模式并发放批准额度。普通编辑、直接发放和普通额度申请不能绕过切换流程。
- 用户确认历史负余额保留，新额度单独使用、不抵扣旧账。原 Key 沿用，已准入请求继续在原来源结算。模式切换写入应用审计。
- 本次没有迁移或修改现有开发应用，也没有访问真实上游；数据库迁移随下一次正常 `pnpm dev` 启动应用。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `pnpm --filter @ai-gateway/control-plane test` | 37 个文件、216 项通过，含新增 7 项应用计费测试 |
| Web `typecheck` / `build`；control-plane 类型检查与构建 | 通过；Web 保留既有大 bundle 提醒 |
| `node scripts/check-web.mjs --postgres --application-billing-only` | 39 项通过，使用独立 PostgreSQL schema、独立服务端口、独立 headless Chrome profile |
| 同一检查中的 SQL 用量与权限回归 | 59 项通过 |
| 真实 HTTP 转发到本地模型 | 0 元可调用，结算余额为负，负余额仍可再次调用 |
| 模式切换 | 页面提交成功；仅批准不生效；执行后新额度独立可用；重复执行无重复批次；原 Key 继续调用 |
| 1440 × 1000 / 390 × 844 | 创建、负余额、申请详情、切换结果共 8 张截图，无页面级横向溢出 |
| 键盘 | 原生 radio 方向键切换、Tab 留在弹窗、Escape 关闭；无未捕获浏览器异常 |

单元测试还覆盖原预占在切换后结算、待核对费用在负余额账户核对、重复结算、额度不足拒绝、负责人变更导致执行失败、驳回与撤回不改变模式。PostgreSQL 检查通过真实网关到本地模型替身的直连路径，不代表生产环境、Higress 路径或真实模型验收。

## 截图

- [创建（1440）](screenshots-2026-11-05-application-billing/application-billing-create-1440.png)
- [创建（390）](screenshots-2026-11-05-application-billing/application-billing-create-390.png)
- [负余额（1440）](screenshots-2026-11-05-application-billing/application-billing-negative-1440.png)
- [负余额（390）](screenshots-2026-11-05-application-billing/application-billing-negative-390.png)
- [申请详情（1440）](screenshots-2026-11-05-application-billing/application-billing-approval-1440.png)
- [申请详情（390）](screenshots-2026-11-05-application-billing/application-billing-approval-390.png)
- [切换后（1440）](screenshots-2026-11-05-application-billing/application-billing-quota-1440.png)
- [切换后（390）](screenshots-2026-11-05-application-billing/application-billing-quota-390.png)
