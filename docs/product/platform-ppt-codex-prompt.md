# 给 Codex 的提示词：生成商务版 PPT

**使用方式**：把下面「提示词正文」整段复制给 Codex（在仓库根目录 `D:\Workspace\pri\ai-gateway-platform` 启动会话）。若 Codex 支持读文件，也可以直接说"读 `docs/product/platform-ppt-codex-prompt.md` 并按其执行"。

---

## 提示词正文

### 角色与任务

你是前端工程师 + 演示设计。在仓库根目录 `D:\Workspace\pri\ai-gateway-platform` 里，用**纯 HTML/CSS（少量原生 JS）**制作一套 16:9 的商务介绍幻灯片，交付物是一个双击就能在浏览器里放映、并能一键导出 PDF 的静态网页。不要引入任何构建工具、包管理器依赖、CDN 资源或网络字体。

这套 PPT 的观众是**懂 AI 基本概念的商务、解决方案和客户**，不是工程师。语气平实，不堆术语，不使用营销夸张词。

### 必读输入（按顺序读，以它们为唯一事实来源）

1. `docs/product/platform-ppt-outline-business-v1.md` —— **页面结构、每页内容、每页用哪张图、口播重点，全部以这份为准**。不要自己新增页面或调整顺序。
2. `docs/product/platform-introduction-business-v1.md` —— 文案语料来源。第 2、3、5、16、17、18 页的文字从这份文档里提炼。
3. `apps/web/src/design-v5.css` 开头的 `html[data-ui="beacon"]` 变量块 —— 视觉 token 来源，下方已摘录。

以下截图需要实际查看后再排版（确认图上信息与你要标注的位置一致）：

```text
docs/validation/screenshots-2026-11-02-business-demo/demo-01-onboarding-preview-1440.png
docs/validation/screenshots-2026-11-02-business-demo/model-verification-1440.png
docs/validation/screenshots-2026-11-02-business-demo-live/demo-01-onboarding-preview-1440.png
docs/validation/screenshots-2026-11-02-business-demo-live/demo-02-online-1440.png
docs/validation/screenshots-2026-11-02-business-demo-live/demo-03-usage-1440.png
docs/validation/screenshots-2026-11-02-business-demo-live/demo-04-call-drilldown-1440.png
docs/validation/screenshots-2026-11-02-business-demo-live/demo-05-reconciliation-preview-1440.png
docs/validation/screenshots-2026-11-02-business-demo-live/demo-08-application-owner-1440.png
docs/validation/screenshots-2026-11-04-project-app-lists/projects-list-1440.png
docs/validation/guardrail-2026-10-30/events-1440.png
docs/product/screenshots/beacon-overview-1440.png
docs/product/screenshots/beacon-keys-1440.png
```

### 交付物

```text
deck/
  index.html          # 全部幻灯片 + 放映逻辑 + 自检逻辑，单文件
  theme.css           # 设计 token 与版式（也可内联进 index.html，二选一，不要两者都做）
  notes.md            # 逐页口播稿，按大纲第 X 页的"口播"整理成可直接念的中文
  README.md           # 怎么打开、怎么翻页、怎么导出 PDF、怎么改文案
```

- **不要**修改 `apps/web/**`、`services/**`、`packages/**`、根 `package.json`、`pnpm-workspace.yaml`、任何 `docs/**` 下已有的文件。
- **不要**运行 `pnpm dev`、不要启动任何服务、不要调用真实模型。
- **不要**新增依赖。`deck/` 是纯静态目录，不在 pnpm workspace 范围内，请保持它零依赖。
- 截图**原地引用**（相对路径 `../docs/...`），不要复制进 `deck/`。

### 设计规范（必须照此执行）

画布：**1600 × 900 px**（16:9）。所有尺寸按这个基准写死，不要用响应式缩放做主逻辑。

设计 token 直接抄 `design-v5.css` 的 beacon 主题，不要自己调色：

| 用途 | 变量 | 值 |
| --- | --- | --- |
| 画布底色 | `--bg` | `#f6f5f2` |
| 卡片/内容面 | `--surface` | `#ffffff` |
| 次级面 | `--surface2` | `#f1efe9` |
| 深底色块 | `--surface3` | `#e7e4dc` |
| 分隔线 | `--line` / `--line-strong` | `#e3dfd6` / `#cfcabf` |
| 主文字 | `--text` | `#191c22` |
| 次文字 | `--muted` | `#666a75` |
| 强调色（靛蓝） | `--action` | `#5a55d6` |
| 强调悬停/按下 | — | `#4b46c4` / `#403bb0` |
| 强调浅底 | `--tint` | `#eeedfb` |
| 深墨绿（正面状态） | `--ok` | `#1f6b50` |
| 警示琥珀 | `--warn` / `--warning-bg` | `#8a5a12` / `#fdf3e2` |
| 风险红 | `--danger` | `#a1332a` |
| 深墨块（hero） | `--beacon-ink` / `--beacon-ink-text` | `#14161c` / `#f5f4f0` |
| 圆角 | — | 控件 10px，卡片 20px，hero 26px |
| 等宽字体 | — | `"Cascadia Code", Consolas, ui-monospace, monospace` |

正文字体栈（与平台一致）：
`"Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif`

字号基准（1600×900 下）：
- 封面主标题 64px / 字重 650 / `letter-spacing: -.02em`
- 页面标题 40px / 650
- 区块小标题 22px / 600
- 正文 19px / 行高 1.7
- 表格与次要说明 15–16px，颜色用 `--muted`
- 页脚注释 13px

版式骨架（每页统一）：
- 页眉：左侧 10px 等宽大字距眉标（如 `SIGNAL ATLAS · 商务介绍`），右侧页码 `03 / 19`；
- 内容区：四周安全边距 72px（上 56px）；
- 页脚：一行 13px 灰色注解，写清该页数字口径或注意事项（大纲中已有这类口径，用它，不要编）。
- 每页最多一个视觉重点。不要出现第二个同权重的强调色块。

图像处理（**这是本任务最容易出错的地方，务必照做**）：
- 所有截图顶部约 34px 有一条"人工审查模式 / 本地模型替身"横幅，**全部裁掉**（包括第 6、12 页）：报价场景不应出现审查模式字样。内部地址也要落在裁切范围之外。
- 裁切统一用一套约定：`<div class="shot" style="width:Wpx;height:Hpx"><div class="shot-source" style="transform:scale(S) translate(-Xpx,-Ypx)">`，`transform-origin:0 0`。**X / Y 就是原图中可见区域的起始像素**，S = W / 可见宽度。不要用负 margin，不要逐页手算负 left/top——算错就会切在标题中间。
- 居中容器要算上偏移：`容器左边缘 = (1456 − W)/2 + 72`。序号点坐标 `left% = (目标页面x − 容器左边缘)/W`，`top% = (目标页面y − 204)/H`。
- **每页改完必须用 Chrome 实际截图目视校对**，不得凭计算宣布完成。
- 截图必须带 `alt`，写清这张图展示的是哪个界面。
- 页面上若要"指位置"，**只能用序号点 + 图注**：截图内只放 26px 圆形的 ①②③ 标记（`position:absolute` + 百分比坐标），解释文字全部写在图下的 `.legend` 里，处于页面底色上。**禁止**把带文字的色块、标签、描边框压在截图上——那会盖住截图自己的文字，并造成颜色冲突。序号点也不要落在表格文字或日期值上。
- 图片路径相对于 `deck/index.html`，即 `../docs/validation/...`。

### 页面内容要求

按大纲做 **19 页正文 + 2 页附录**。以下只写每页的额外制作要求，文案与口播以大纲为准：

- **P1 封面**：深墨块做底，左侧标题区，右侧 `beacon-overview-1440.png` 斜切或圆角裁切出血。副标题一行。
- **P2 痛点**：四宫格卡片，无图。每格「一句现状 + 一句后果」，后果用 `--danger` 或 `--muted`。
- **P3 三个角色**：中间一句话大字，下方三个横排卡片（交换机 / 财务 / 审计）。
- **P4 请求流转**：**必须用 HTML/CSS 自绘**横向 5 节点流程条（含节点序号、标题、一行说明、节点间箭头）。不要贴 README 的 ASCII 图，不要用图片。
- **P5 四个钱包**：**自绘**四个并列卡片，底部一条 `--danger` 系强调带写"个人额度用完不会偷偷从项目预算扣"。
- **P6 开通**：主图 + 右下角 1/4 小图（跳过保护版），两个小标题分别指向两张图。
- **P7 在线使用**：主图居中，用 2–3 个标注指出"该模型适用余额""单次调用上限""回复长度与费用明细"。
- **P8 驾驶舱**：主图占 60%，右侧竖排三条"读图提示"，第一条必须是"待核对写的是**金额待定**，不是 0 元"。
- **P9 调用下钻**：主图 + 标注顶部青色提示条，说明筛选条件自动带入。
- **P10 待核对**：主图居中略小，下方三格流程：原预占 → 核对后 → 余额变化。
- **P11 项目与应用**：左宽右窄双图，各自配一个小标题和一行说明。
- **P12 模型配置**：主图 + 标注三段式步骤条与逐协议诊断（Chat / Responses / Messages）。
- **P13 密钥**：主图 + 标注脱敏标识与"完整值只在签发时显示一次"；**图中内部地址需用模糊块或遮挡条盖住**（在图上叠一个 `backdrop-filter: blur()` 的小矩形）。
- **P14 安全围栏**：主图 + 标注策略状态（拦截 · 版本 21）、预置规则、"默认不保存正文"。
- **P15 观测**：**此页无合格截图**。用文字 + 三个并列状态块（无流量 / 样本不足 / 采集失败）讲"没有数据 ≠ 健康"，并在页脚注明"配图待补拍，当前版本用示意图"。不要使用旧的空态截图凑数。
- **P16 四条承诺**：无图，四行大字，每行「一句话 + 一行 15px 解释」。用序号 01–04，不要用图标字体或 emoji。
- **P17 状态矩阵**：两列对照表，左"已验证"（12 项以内，可用两栏排列）、右"待客户环境验证"（4 项）。右侧列头用 `--warn`。
- **P18 五问**：五行 Q/A，Q 用 20px 650，A 用 16px `--muted`。行间用 1px `--line`。
- **P19 结束页**：深墨块，一行动作请求 + 联系方式占位。
- **附录 A / B**：五宫格拼图 / 移动端双图，版式从简，标题注明"附录"。

### 交互与导出

- 翻页：`←` `→` `Space` `PageUp` `PageDown` `Home` `End`；`F` 或双击进入全屏；`G` 打开页码索引（缩略列表）。
- URL 支持 `#7` 直接跳到第 7 页；刷新后保持当前页。
- 右下角显示 `当前页 / 总页数`，底部 2px 进度条用 `--action`。
- 点击画布右半 / 左半边缘也能翻页（但不要遮挡图片区域的可点击性——用 `pointer-events` 控制）。
- 尊重 `prefers-reduced-motion: reduce`：关闭所有过渡。
- 打印导出：`@page { size: 1600px 900px; margin: 0 }`，`@media print` 下**顺序展开全部 21 页**，每页 `break-after: page`，隐藏导航控件。用 `?print=1` 或直接 Ctrl+P 都要能得到干净的 PDF。

### 自检（必须做完再交付）

在 `index.html` 里内置 `?selfcheck=1` 模式：依次渲染每一页，测量并输出一份纯文本报告到 `<pre id="selfcheck">`，每行一条 `PASS|FAIL  页码  检查项  详情`，至少覆盖：

1. 每页内容区 `scrollWidth/scrollHeight` 不超过容器（无内容溢出、无横向滚动）；
2. 每张 `<img>` 的 `naturalWidth > 0`（图片路径有效、全部加载成功）；
3. 每页标题与页码存在且非空；
4. 没有元素横向超出 1600px 画布；
5. 正文字号不小于 15px（读取计算样式）；
6. 全文未出现占位符残留（`lorem`、`TODO`、`XXX`、`待填`）。

然后实际运行并用输出验证：

```powershell
# 用仓库运行 check:web 时用的本机 Chrome
chrome --headless=new --dump-dom "file:///<仓库绝对路径>/deck/index.html?selfcheck=1" > selfcheck.html
```

确认 `selfcheck.html` 里**没有 FAIL 行**后，再执行一次 PDF 导出，确认页数正确（21 页）：

```powershell
chrome --headless=new --print-to-pdf="deck/preview.pdf" --no-pdf-header-footer "file:///<仓库绝对路径>/deck/index.html?print=1"
```

`deck/preview.pdf` 只用于你自己验证页数与排版，**不要**承诺它是最终交付件（用户会自己导出）。如果本机找不到 Chrome，说明原因并给出替代验证方式，不要跳过自检直接宣布完成。

### 硬性禁止

- 不要编造任何数字、金额、性能指标、客户名、时间。所有数字必须来自截图或在输入文档中出现过。
- 不要写"生产已验收""支持高并发""毫秒级响应"这类结论。第 17 页的边界表述必须保留。
- 不要使用 emoji、图标字体、外链图片、外链字体、CDN 上的任何资源。
- 不要用 `!important` 堆叠去硬压版式；如果某页排不下，裁文字而不是缩字号到 14px 以下。
- 不要动仓库里已有的任何文件。这是纯新增任务。
- 不要使用 `docs/design-reference/**` 里的任何资源（只读参考，禁止进入交付物）。

### 完成后请汇报

1. 交付文件清单与行数；
2. 自检报告结论（多少页、多少项检查、是否有 FAIL）；
3. PDF 导出的实际页数；
4. 你在制作过程中发现的**输入问题**（例如某张截图与大纲描述不符、某页文案放不下、某张图缺失），列出来并说明你是怎么处理的；
5. 仍需用户决策的点（例如第 15 页配图什么时候补拍）。
