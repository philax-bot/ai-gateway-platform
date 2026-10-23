# Signal Atlas UI 组件样板 v0.1

日期：2026-10-16。承接用户对 v0.10 原型体验的认可；[查看样板](prototypes/signal-atlas-ui-kit.html)。

## 交付

- 从 07 主原型提取共享 tokens 与样式，保留原有规则顺序；将主要尺寸替换为等值变量，不改业务脚本和会话数据。
- 样板覆盖基础变量、按钮/表单、12 种反馈状态、跟随/指定模型、个人/项目额度来源和服务停用影响预览。
- 可实际操作金额校验、保存中状态、范围变化、用途和模型切换、预览取消/确认/恢复。状态刷新恢复，不读写主原型 sessionStorage。
- [UI 规范第 13 节](token-operations-ui-coding-guidelines-v0.1.md#13-组件样板与-ai-coding-契约ui-kit-v01)定义复用入口、组件契约与验收条件；统一早期建议值与已确认原型实际样式。

## 本地验证

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 组件交互与共享样式 | 6 组通过，15 次宽度检查 | [组件检查](prototypes/checks-ui-kit-v0.1/browser-checks.json) |
| 运营资源 / 项目回归 | 8 组通过，60 次宽度检查 | [资源回归](prototypes/checks-ui-kit-v0.1/operator-regression/browser-checks.json) |
| 员工工作台 / 额度回归 | 12 组通过，75 次宽度检查 | [工作台回归](prototypes/checks-ui-kit-v0.1/workbench-regression/browser-checks.json) |

合计 26 组本地检查、150 次宽度检查。宽度为 320、360、736、1024、1440px；次数包含不同状态，不能解释为 150 个独立页面。未捕获脚本异常或外部请求。额外验证了金额边界、键盘复选框焦点、Escape/取消后的焦点恢复，以及主原型/样板主按钮的计算样式一致。

已查看截图：[桌面样板](prototypes/checks-ui-kit-v0.1/overview-desktop.png)、[模型范围](prototypes/checks-ui-kit-v0.1/model-range-desktop.png)、[影响预览](prototypes/checks-ui-kit-v0.1/impact-dialog-desktop.png)、[360px 额度来源](prototypes/checks-ui-kit-v0.1/quota-mobile.png)。

复核命令（项目根目录，已有 Node / Playwright / Chrome）：

```powershell
node --check docs/product-design/prototypes/signal-atlas-ui-kit.js
node --check docs/product-design/prototypes/check-signal-atlas-ui-kit.cjs
node docs/product-design/prototypes/check-signal-atlas-ui-kit.cjs
node docs/product-design/prototypes/check-operator-onboarding-v0.10.cjs checks-ui-kit-v0.1/operator-regression
node docs/product-design/prototypes/check-workbench-v0.9.cjs checks-ui-kit-v0.1/workbench-regression
```

## 使用边界与下一步

这是固定深色的 HTML / CSS UI Kit，不是已经完成的 React / Vue 组件库；本轮没有设计浅色主题。主原型的模拟计费和固定数据仍只用于评审。真实接口、身份、审批、模型调用与资金操作均未执行。

下一步在正式前端仓库与技术栈明确后，将这些基础和业务组件实现为可复用工程组件，再完成已确认的同一条纵向流程。完整产品功能仍按 v1.3 定义，不从局部样板推断删减范围。
