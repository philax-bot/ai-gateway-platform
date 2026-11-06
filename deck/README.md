# 企业 AI 资源运营平台 · 商务演示

打开 `index.html` 即可离线放映。共 21 页：19 页正文和 2 页附录。画布固定为 1600 × 900，浏览器窗口只负责等比适配显示。

## 打开与翻页

- 双击 `index.html`，建议使用本机 Chrome。
- `←` / `→`、`Space`、`PageUp` / `PageDown` 翻页，`Home` / `End` 到首尾。
- `F` 或双击画布切换全屏，`G` 打开页码索引，`Esc` 关闭索引。
- 点击左右边缘可翻页，右下角提供同样的控制。
- 地址末尾加 `#7` 直达第 7 页；刷新保留当前页。

## 导出 PDF

点击右下角「导出 PDF」或按 `Ctrl+P`，选择「另存为 PDF」。打印样式会按顺序展开全部 21 页并隐藏控制条。纸张由网页指定为 1600 × 900，建议缩放 100%、无边距、开启背景图形并关闭页眉页脚。也可用 `index.html?print=1` 预览连续页面后打印。

离线命令示例（在仓库根目录执行，Chrome 路径按实际安装位置调整）：

```powershell
& 'C:/Program Files/Google/Chrome/Application/chrome.exe' --headless=new --no-pdf-header-footer --print-to-pdf="deck/export.pdf" "file:///D:/Workspace/pri/ai-gateway-platform/deck/index.html?print=1"
```

浏览器打印需由使用者选择保存位置。「一键导出」指打开已排版的打印对话框。`preview.pdf` 是本次验证用样张，不作为最终对外版本。

## 修改文案与图片

- `index.html`：各页是静态 `<section class="slide">`，按 `slide-1` 至 `slide-21` 排列。修改标题、正文及页脚即可。
- `theme.css`：开头定义 Beacon token，后面为版式、放映和打印样式。
- `notes.md`：逐页口播稿，可独立使用。
- 联系方式故意留空，演示前填写第 19 页 `.contact-slot`，不提供虚构联系人或二维码。
- 截图通过 `../docs/...` 引用原文件，没有副本。移动或分享时保留仓库路径关系，或者直接导出 PDF 分享。

### 截图裁切与标注约定

截图容器 `.shot` 固定宽高，内层 `.shot-source` 用 `transform:scale(S) translate(-Xpx,-Ypx)` 移动：**X / Y 就是可见区域在原图中的起始像素**（原图 1440 × 1000），不再用负 margin，也不再依赖容器定位。例：`scale(.94) translate(-270px,-330px)` 表示从原图 (270, 330) 开始显示。

- 顶部约 34px 是「人工审查模式」横幅，所有截图（包括第 6、12 页）统一裁掉；Y 从 34 及以上开始即可排除。
- 内部地址（第 12、13 页）已落在裁切范围之外，不需要遮挡层；`.mask` 仅作备用。
- 标注一律用序号点 `.dot`（`left` / `top` 为容器百分比），说明文字写在图下 `.legend`，**不把文字块压在截图内容上**。百分比的换算：可见区起点是 X，所以 `left% = (页面元素x - 容器左边缘) / 容器宽度`。居中容器（`margin:0 auto`）要先把居中偏移算进去。
- 改完截图位置后，用下面的截图命令逐页目视检查一次序号点是否落在正确区域。

逐页截图（用于目视校对）：

```powershell
foreach ($n in 1..21) { & 'C:/Program Files/Google/Chrome/Application/chrome.exe' --headless=new --hide-scrollbars --window-size=1600,900 --screenshot="shot-$n.png" "file:///D:/Workspace/pri/ai-gateway-platform/deck/index.html#$n" }
```

## 自检

打开 `index.html?selfcheck=1`。完成后页面显示纯文本报告，检查每页的内容区尺寸、图片加载及 alt、标题页码、画布边界、正文字号、占位词和内容安全边界，另核对总页数。正常为 **21 页、147 项检查、0 failures**。序号点与图注序号属于标注层，不计入正文字号下限。

```powershell
& 'C:/Program Files/Google/Chrome/Application/chrome.exe' --headless=new --allow-file-access-from-files --timeout=15000 --virtual-time-budget=5000 --dump-dom "file:///D:/Workspace/pri/ai-gateway-platform/deck/index.html?selfcheck=1" > selfcheck.html
```

提取 `<pre id="selfcheck">` 的文本检查 `FAIL` 行；HTML 中还包含自检脚本，不能简单搜索整个 HTML 的 `FAIL` 字符串。还须确认 `data-selfcheck="done"` 和报告末尾 `RESULT`，空报告不算通过。运行后可删除 `selfcheck.html`。

## 内容边界与图源差异

事实来源为 `docs/product/platform-ppt-outline-business-v1.md` 与 `docs/product/platform-introduction-business-v1.md`，未新增页面或调整顺序。

- 第 15 页使用三个状态块，页脚说明配图待补拍，不使用旧壳的空态图。
- 第 6 页两张图分别为「纳入本次」与「跳过已有权益」两种结果，大图为主，小图配说明；顶部横幅已裁掉，但页脚仍标明为本地演示样本。
- 第 12 页原图为蓝灰界面，保留真实界面与未通过的诊断结果，未重画成信标；横幅已裁切。
- 第 9 页来源提示条实际为暖灰底与靛蓝边，按真实位置标注。
- 附录 B 两张原图分别为信标与蓝灰界面，未更改图源。附录另引用大纲列明的 7 张图片。
- 本地截图和材料中的「已验证」不代表客户生产验收；第 17 页保留客户环境验证边界。
- 客户对外演示前需重拍真实环境画面并复查脱敏。CSS 遮挡用于放映和打印，源 PNG 仍在仓库，不能把原图当脱敏文件分发。
