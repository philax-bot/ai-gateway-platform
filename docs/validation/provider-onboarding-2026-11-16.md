# 供应商接入到实际使用的流程验证

日期：2026-11-16。结论：已修复凭据接入入口与顶层服务保存收尾，并在隔离 PostgreSQL 中通过浏览器完成从新建供应商到员工调用、结算及密钥停用的闭环。日常开发入口仍为 `pnpm dev` / `http://localhost:5176/`，原工作区数据与外呼设置保留。

## 问题与修复

| 问题 | 原因 | 当前行为 |
| --- | --- | --- |
| 接入表单先出现“受控凭据引用（可选）”文本框 | 该字段实际要求服务端 `UPSTREAM_` 环境变量名称，却被放进普通接入路径；托管凭据选择排在后面 | 默认选择托管上游凭据，可就地创建并回填。只有明确选择“服务端环境变量（高级）”才显示变量名称；无需鉴权须明确选择“无需凭据” |
| 凭据与供应商不匹配，或同时填写两种凭据 | 原托管下拉展示所有供应商的凭据，两个凭据字段互相独立 | 下拉按当前供应商筛选；切换供应商清除失效关联；请求只提交当前鉴权方式对应的字段 |
| 保存模型服务后弹窗不结束 | `EditorFlow.finish` 对所有未验证服务强制进入另一个验证弹窗 | 顶层保存成功关闭编辑与确认窗，页面提示对象名称、保存成功及验证下一步，提供“前往验证连接”。模型池中补充创建服务仍保留验证并返回父草稿 |
| 看不到保存成功 | 成功 notice 位于页首，从长列表下方打开表单后，关闭时仍停在原滚动位置 | 本次写入完成且弹窗关闭后，把结果提示带回可见区域；取消编辑不会重复滚动到旧提示 |
| 空模型 / 错误变量名称只在后端失败 | 表单缺少相应说明 | 提交前给出中文错误并保留输入；未选托管凭据使用标准必填校验 |

复用 `Field`、`PasswordInput`、`MultiSelect`、`Modal`、`EditorDialog` 和共享 notice/link-button；新增 `FieldSpec.optionsWhen` 与关联字段更新回调，无页面专属 CSS。凭据子任务按 `credentials.write` 授权。模型价格、业务授权、服务端校验、在途调用和历史结算规则不变。

原问题已在修改前复现：确认执行后服务已写入，仍存在“模型服务已保存，下一步验证连接”弹窗，等待全部弹窗关闭超时。[修改前截图](screenshots-2026-11-16-provider-onboarding/before/failure.png)。

## 完整流程与失败恢复

新增 `scripts/check-provider-onboarding-web.mjs`，由既有隔离浏览器检查入口执行。账号和初始工作区由测试夹具准备；以下新建业务对象均通过页面表单及确认流程写入，API 读取只用于核对实际持久化结果。

1. 创建供应商及默认地址，从对应供应商行进入服务接入。
2. 检查默认托管方式、供应商及地址预填、空候选和跨供应商过滤。
3. 在服务中创建凭据：取消能恢复草稿；保存后自动回填，凭据值默认遮蔽，工作区快照不返回原值。
4. 切换供应商清除错误关联；未选模型时显示可恢复错误。
5. 就地登记新模型并回填，配置上游模型及输入、输出、缓存输入价格；错误环境变量名称在本地拦截。
6. 保存服务：编辑及确认窗全部关闭，保存结果与下一步位于当前视口。
7. 故意移除鉴权后验证失败；修改为托管凭据再验证通过，历史保留失败与成功两次运行。
8. 创建新模型池，纳入服务并显式开放；创建个人方案，选择员工、预览名单金额、确认开通，核对权益回执。
9. 模型池内补充创建服务并验证，返回时父草稿及新服务选择保留。
10. 五套界面各检查 1440 / 390：供应商页、编辑窗无页面级横向溢出，原鉴权方式恢复正确，Tab 不离开弹窗，Escape 回到触发按钮。
11. 员工从在线使用发送实际请求，读取回复；调用记录显示新模型、实际路由和大于零的已结算费用。
12. 页面签发用途密钥，默认遮蔽一次性完整值，读取接入指引；使用该密钥实际调用网关成功；页面停用后同一密钥的新调用被拒绝。

上游是测试进程创建的本地鉴权服务，要求正确的 Bearer 凭据，再转发到仓库的本地模型替身；由实际 HTTP 鉴权、回复、路由快照与结算记录确认链路。没有调用真实收费供应商，不将本地替身视为生产验证。

## 验证结果

| 检查 | 结果与证据 |
| --- | --- |
| Web 类型检查 | `pnpm --filter @ai-gateway/web typecheck` 通过 |
| Web 生产构建 | `pnpm --filter @ai-gateway/web build` 通过；仍有现有大 bundle 提示 |
| 新增闭环，隔离 PostgreSQL | **82 项浏览器断言通过**，[记录](screenshots-2026-11-16-provider-onboarding/browser.json) |
| 通用回归，隔离 PostgreSQL | **139 项浏览器断言通过**，并通过 **62 项用量 SQL / HTTP 权限断言**，[浏览器记录](screenshots-2026-11-16-general-regression/browser.json) |
| 相关运营能力回归，隔离 PostgreSQL | **74 项断言通过**，覆盖技术/财务/审计职责、凭据轮换与在途任务、路由、实际接入验收及多模态工作台。[记录](screenshots-2026-11-16-operations-regression/browser.json) |
| 日常开发工作区 | 现有 `localhost:5176` 登录、供应商入口、新表单、1440/390、Escape、无未捕获异常通过；只读取业务数据并取消编辑，没有保存或发起模型调用。[记录](screenshots-2026-11-16-provider-onboarding/development-smoke.json) |

复现新增检查：

```powershell
pnpm --filter @ai-gateway/control-plane... --filter @ai-gateway/gateway-sim... build
$env:WEB_CHECK_SCREENSHOT_DIR='docs/validation/screenshots-2026-11-16-provider-onboarding'
node scripts/check-web.mjs --provider-onboarding-only --postgres
```

截图：[服务编辑 1440](screenshots-2026-11-16-provider-onboarding/service-editor-1440.png)、[服务编辑 390](screenshots-2026-11-16-provider-onboarding/service-editor-390.png)、[保存成功及验证入口](screenshots-2026-11-16-provider-onboarding/service-saved-1440.png)、[开通回执](screenshots-2026-11-16-provider-onboarding/employee-onboarding-receipt-1440.png)、[员工在线使用](screenshots-2026-11-16-provider-onboarding/employee-online-1440.png)、[实际调用结算](screenshots-2026-11-16-provider-onboarding/employee-calls-1440.png)。

本轮未部署，未用真实供应商验收；用户原有未提交改动保留。
