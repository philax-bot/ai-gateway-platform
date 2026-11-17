# 开通方案菜单与就地创建验证

日期：2026-11-17。范围：本地实现、隔离 PostgreSQL 和本地模型替身；未执行生产部署或真实上游请求。

- “开通方案”成为运营菜单，位于“为人员开通”旁；原折叠区保留自动规则、已开通权益及执行记录。
- 选择方案步骤常驻“新建方案”和“管理开通方案”；保存后自动选中新方案，取消和失败保留人员、步骤和草稿。
- 嵌套创建模型池后恢复方案草稿、回填模型池，并保留方案保存后的自动选中回调。
- 选择列表显示模型池、范围、可用模型、额度、周期和有效期；不可用方案保留可见并解释原因，禁止发放，提供修正入口。
- 创建与修改方案、取消发放预览均未新增人员权益或额度发放记录。

验证通过：

- `pnpm --filter @ai-gateway/web typecheck`
- `pnpm --filter @ai-gateway/web build`
- `$env:WEB_CHECK_SCREENSHOT_DIR='docs/validation/screenshots-2026-11-17-onboarding-plans'; node scripts/check-web.mjs --onboarding-plans-only --postgres`
- 浏览器 35 项断言通过，覆盖五套界面、1440/390 宽度、键盘打开/取消和焦点恢复、失败修正及嵌套回填，无未捕获异常或页面级横向溢出。

截图与机器结果：[验证目录](screenshots-2026-11-17-onboarding-plans/)。测试工作区与测试浏览器由现有 check-web runner 清理，现有日常开发数据保留。
