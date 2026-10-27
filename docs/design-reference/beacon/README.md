# Beacon 设计参考（只读副本）

来源：`codex/ai-gateway-test/docs/product-design/`（2026-10-26 版本）
用途：给 `apps/web` 增加第五套界面 `beacon` 时的视觉与交互参照。
状态：**静态参考，不参与构建，不代表产品实现。**

## 内容

| 文件 | 说明 |
| --- | --- |
| `theme-gallery.html` | 组件画廊：按钮、表单、标签、表格、弹窗、空状态等 36 组组件与状态 |
| `theme-host.html` | 主题宿主：24 屏 Beacon 界面，可切换员工 / 经理 / 运营视角 |
| `themes/beacon/tokens.css` | 83 个语义 token，唯一色值来源 |
| `themes/beacon/base.css` | 页面骨架与排版 |
| `themes/beacon/components.css` | 组件样式 |
| `themes/beacon/app.js` | 原生渲染逻辑（演示数据，不接后端） |
| `themes/gallery.{css,js}`、`themes/host.{css,js}`、`themes/screen-model.js` | 画廊与宿主的运行时代码 |
| `themes/tokens.contract.json` | token 契约与 12 组对比度规则 |

## 打开方式

直接双击 `theme-gallery.html` 或 `theme-host.html` 即可（`file://` 可用，无 `fetch`、无外部请求）。
若浏览器限制本地脚本，可在本目录起一个静态服务：

```bash
npx serve .
```

演示状态保存在 `localStorage` 的 `beacon.theme-lab.v1`，与产品无关。

## 与来源副本的差异

- 仅保留 Beacon；深色（`atlas-dark`）、浅绿（`atlas-light`）、钢蓝（`atlas-steel`）三个存量主题及其原型未复制。
- `themes/host.js` 的 `THEMES` 只保留 Beacon，`theme-gallery.html` 顶部对应的三个跳转链接已移除。
- 其余文件与来源一致，未改样式或文案。

## 关键取值

| token | 值 | 用途 |
| --- | --- | --- |
| `--bb-canvas` | `#f6f5f2` | 页面画布（暖白） |
| `--bb-surface-1` | `#ffffff` | 卡片、表格、弹窗 |
| `--bb-surface-2` | `#f1efe9` | 次级底、表头 |
| `--bb-surface-3` | `#e7e4dc` | 三级底、禁用底 |
| `--bb-surface-inverse` | `#14161c` | hero 卡、深色块 |
| `--bb-text-primary` | `#191c22` | 正文与标题 |
| `--bb-text-secondary` | `#454a55` | 次要文字 |
| `--bb-text-muted` | `#666a75` | 说明、口径、时间 |
| `--bb-border-default` | `#e3dfd6` | 发丝描边 |
| `--bb-border-control` | `#83868f` | 控件描边 |
| `--bb-accent` | `#5a55d6` | 主按钮、选中态、焦点 |
| `--bb-accent-soft` | `#eeedfb` | 选中底、强调浅底 |
| `--bb-ok-fg` / `--bb-ok-bg` | `#1f6b50` / `#e9f5ee` | 成功 |
| `--bb-warn-fg` / `--bb-warn-bg` | `#8a5a12` / `#fdf3e2` | 提醒 |
| `--bb-danger-fg` / `--bb-danger-bg` | `#a1332a` / `#fbecea` | 危险 |
| `--bb-radius-control` | `10px` | 控件圆角 |
| `--bb-radius-panel` | `20px` | 面板圆角 |
| `--bb-radius-hero` | `26px` | hero 卡圆角 |
| `--bb-font-body` | `15px` | 正文 |
| `--bb-font-title` | `34px` | 页面标题 |
| `--bb-font-numeral` | `60px` | 大数字 |

完整取值以 `themes/beacon/tokens.css` 为准。

## 在产品里怎么用

只在 `apps/web` 的 `design-v5.css` 中映射取值，**不要**直接引用 `.bb-*` 类名，也不要引入这套 `app.js`：

- 产品已有变量名（`--bg`、`--surface`、`--text`、`--action`、`--line`、`--radius-control` 等）保持不变，只替换取值；
- 组件类名沿用产品现有类（`.panel`、`.table`、`.tag`、`.modal`、`.primary` 等），视觉规则限定在 `html[data-ui="beacon"]` 下；
- 参考 `theme-gallery.html` 的组件状态，不参考它的 DOM 结构。

## 维护

来源仓库更新后，重新复制 `themes/beacon/*` 与两个 HTML，并重新执行本文件“与来源副本的差异”中的裁剪。
