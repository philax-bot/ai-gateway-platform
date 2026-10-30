# T12：三协议探测、原生透传与 Chat 回退

2026-10-30。T10 `978b031` 与 T11 `b73ea19` 已完成。本项按用户最新要求覆盖 **Chat Completions、OpenAI Responses、Anthropic Messages** 三种协议，采用逐模型探测和原生优先，不再只选择一种第二协议。

## 接入和调用行为

“模型配置 → 管理已有配置 → 验证连接”会对服务中的每个映射依次发送三种协议的短请求，逐项保存协议、HTTP 状态、基础支持、用量及内部诊断成本。至少 Chat 基线通过才能开放服务；可选协议失败不会把 Chat-only 服务判成不可用。404/405/501 表示本次模型/入口不支持；鉴权、限流、超时或成功但格式不符均记为未确认。它们都不能冒充基础通过。

调用时使用准入快照选定的来源和当前配置版本的探测证据：对应协议确认支持则原生透传，否则 Responses / Messages 在发送前转换为 Chat，再转换返回格式。旧服务没有三协议记录时保留原 Chat 验证状态，可通过适配器使用新入口；不会凭厂商或模型名称自动声称原生支持。修改连接、受控凭据引用、协议路径或模型映射后，探测状态失效；只修改价格仍沿用已有连接证据，旧调用继续使用原价格。

原生请求不经过 Chat 格式往返转换，保留供应商的原生请求字段、推理/客户端自定义工具内容与事件。网关仍执行平台鉴权、原文围栏、保守输入估算、逻辑/物理模型映射、输出上限、受控凭据替换、取消和结算。原生 Responses 强制 `store=false`。原生 HTTP 错误或流式中断不会自动再调用 Chat，避免二次生成和重复费用。

Higress 增加独立、鉴权的原生路由，使用同一受控服务、路径重写和请求头替换，不让 Chat AI 插件转换原生载荷。默认地址解析支持 DeepSeek 的 `/anthropic/v1/messages`；服务表单可覆盖同一域名下的 Responses / Messages 绝对路径，拒绝外部 URL、查询和路径穿越。没有为本项引入新日常启动器或第二套工作区数据。

## 计量、安全和范围

- 诊断每次 HTTP 请求分别记录内部成本，不扣人员/项目/应用额度；一条基础短请求通过不代表流式、工具、容量、实时健康或供应商全部原生功能通过。
- 三种入口共用原用途、权益、模型池和价格快照。原生与适配用量均归一到原计价模型；Messages 的缓存读/缓存创建计入总输入，其中只有缓存读计入缓存输入子集。缺失用量不补零，取消继续保留待核对预占。
- SSE 文本和工具参数逐步发送，保留跨块 UTF-8；成功终止事件等结算写入持久日记后才发送。账务写入失败返回协议错误，不先发成功。
- 输入围栏检查原生原文和用于准入的投影，覆盖个人、项目、应用；stream 输入拦截仍是 JSON 403，不转发、不预占、不扣费。
- 平台要求完整历史、无状态，拒绝服务端会话/previous_response_id、store=true 和后台任务。原生路径不再枚举允许的输入项及内容块：图片输入、工具结果内的图片及未知内容原样交给上游校验；音视频内容、非文本输出模态和顶层 audio/image/video 配置仍待计量支持。工具保留执行白名单，Responses namespace 内递归检查；顶层 web_search 是已有兼容例外，尚无独立工具费用核算，不因此扩展放行其他服务端/未知工具或 mcp_servers。图片 URL/file_id 的序列化长度不是视觉 Token 预估，现有准入投影不保证覆盖远程图片实际输入量，最终仍依赖上游权威 usage；不把透传等同于完整视觉计量或图片内容围栏验收。Chat 回退只接受已实现的文本/function/tool_use/tool_result 子集，对无法等价表达的签名思考、结构化输出、停止序列等返回明确错误。
- Messages 要求非空 anthropic-version。原生路径原样转发版本与 beta 头，日志只记录请求 ID 和版本；Chat 回退仍只接受 2023-06-01 并拒绝 beta 扩展。模型映射、输出上限、Responses 强制 store=false 及失败不重发策略保留。
- `x-atlas-protocol-mode` 标识 native/adapted，`admission.protocol` 保存请求协议、上游协议及模式；调用详情可追溯。模型目录按来源显示原生基础探测结果和 Chat 适配，不把平台入口等同于每个模型所有能力已验证。

外部接口与边界见 [三协议契约](../../contracts/model-protocols-v0.1.yaml)。

## 验证记录

2026-10-30 原生输入兼容性调整：网关类型检查、`pnpm check:gateway`（76 项）通过；补充省略 store 和请求输出上限高于路由上限的断言后，三协议 HTTP 测试 22 项通过；接口 YAML 解析与改动空白检查通过。新增覆盖图片工具结果、未知内容项、嵌套工具费用边界、原生版本/beta 头透传及回退版本拒绝。仅使用本地 HTTP 替身，未请求真实模型、未操作 Codex 配置，也未重启日常服务；不代表完整客户端或真实视觉计量验收。

本项首版已完成。独立导出的暂存源码全项目构建及 Web 类型检查通过；Contracts **43**、控制面 **149**、网关 **65**、Higress 三协议路由就绪 **6** 项通过，见 [独立基线](../validation/protocols-2026-10-30/staged-baseline.json)及[源码摘要](../validation/protocols-2026-10-30/source-snapshot.json)。不包含工作区已有、未提交的 Agent / Octop 改动。

- [隔离集成](../validation/protocols-2026-10-30/integration.json)：真实 Higress + PostgreSQL、本地确定性来源，163 项断言；官方 OpenAI 7.19.0 / Anthropic 0.129.0 SDK 的原生及回退流式工具往返分别 8 项通过。
- [页面检查](../validation/protocols-2026-10-30/browser.json)：26 项通过，含点击验证实际展示每模型三协议、路径表单、目录状态、五种界面键盘及 1440/390 无页面横向溢出。[桌面诊断明细](../validation/protocols-2026-10-30/probe-detail-1440.png)、[手机目录详情](../validation/protocols-2026-10-30/catalog-detail-390.png)已目检。
- 首轮工具检查在清理时保留临时目录，原因是目录前缀断言仍写旧名称，已修正；数据库/容器已释放。SDK 检查随后修复了输出文本项携带 `logprobs` 重入历史被误拒的问题。首次页面脚本未展开既有配置折叠区，修正为走实际展开路径，见 [页面初始记录](../validation/protocols-2026-10-30/browser-initial-hidden-config.json)。
- 后续发生现有 5 秒控制面 RPC 超时和一次初始 PostgreSQL 连接超时；失败记录保留。六次独立新连接实测约 333–375 ms 建连、54–71 ms 查询，见 [连接样本](../validation/protocols-2026-10-30/postgres-connectivity.json)，不能由此定因或声称长尾消失。隔离验收显式采用 15 秒 RPC 等待；日常默认仍 5 秒，没有重发模型生成来掩盖失败。

真实结果见[汇总](../validation/protocols-2026-10-30/live-summary.json)：DeepSeek 官方三种原生基础探测、两种官方 SDK 的原生流式工具往返、原生取消保留待核对预占、经 Chat 的两种返回格式及关联重试均通过。回退测试在专属代理中有意屏蔽可选原生入口以选中适配器，最终生成仍调用真实 DeepSeek Chat；不表示 DeepSeek 官方缺少原生入口。

初次工具请求带 thinking low 与强制 tool_choice，供应商返回 HTTP 400，网关未改走 Chat。后续按官方 `reasoning.effort=none` / `thinking.type=disabled` 验证工具场景。该失败保留在[原始记录](../validation/protocols-2026-10-30/live-failed-bf5219cb-692a-4a52-92fd-5dc182fd7daa.json)，不归因为协议整体不支持。

费用核对脚本曾把原有单请求向上舍入误写为四舍五入，导致[原核对中止](../validation/protocols-2026-10-30/live-failed-1449372c-e7b1-4fd8-ae7b-fedcbc339bb0.json)。原生 Responses 的两笔费用检查已在该记录中通过；原生 Messages 的两笔完整快照未保留，因此按用户追加的最多 2 次授权重新验收，见 [Messages 账务补验](../validation/protocols-2026-10-30/live.json)。新两笔实际金额为 **¥0.000592 / ¥0.000148**，其中前者包含 128 个缓存输入 Token，按原价和向上舍入核对通过。没有补造此前丢失的快照，也没有改写原失败为成功。

本轮真实供应商请求 **14 次**，累计 **36 / 36 次**；新增配置价保守估算上界 **¥0.051122**，累计上界 **¥0.431024**，仍低于本轮 ¥0.15 / 累计 ¥1。取消的最终用量仍未知，保留原 **¥0.004648** 预占，不计作免费；该预占在独立验收工作区，不改变日常用户余额。真实结果验证了上述场景，不等于所有供应商功能、生产容量或完整 Claude Code / Codex 客户端已验收。

默认 `pnpm dev` 已重启并确认 Higress 2/2 模型路由就绪（三条协议路由均须安装后才判就绪）。[原环境保留核对](../validation/protocols-2026-10-30/default-preservation.json)包含业务配置、资金、状态文件和最终预算哈希不变；[默认环境页面](../validation/protocols-2026-10-30/default-browser.json)另作只读验证。原服务未被自动补写原生能力，仍明确显示未探测；运营后续点击“验证连接”才能更新该服务当前版本的三协议证据。

## 日常使用和复测

日常仍为根目录 `pnpm dev`，访问 `http://localhost:5176/`。已有服务在“模型配置”点击“验证连接”后可更新三协议基础探测结果；每个映射最多三次短请求，属于诊断流量并可能产生供应商费用。保存配置和发起验证仍分开。

`pnpm check:protocols` 使用隔离 PostgreSQL、Higress 与本地替身。加 `--browser` 可在脚本输出的专属目录上执行 `node scripts/check-protocols-web.mjs <directory>`；可选 `--sdk-root <existing node_modules directory>` 使用现有官方 SDK，不修改用户 Pi / CC Switch 配置。检查结束只清理自身资源。

真实验收入口为 `pnpm check:protocols:live --allow-upstream --sdk-root <existing node_modules directory>`，必须有既有 DeepSeek 配置和本地预算账本；最终供应商转发前使用文件锁强制全局次数和费用估算上限，已用额度不会因重跑重置。本轮先获 12 次、后获 Messages 账务补验 2 次授权，累计最多 36 次 / ¥1，本轮新增配置价估算上限仍 ¥0.15。额度已用完，继续真实执行需新增授权；离线检查不受影响。供应商账单仍以供应商为准；配置价估算不是发票。

## 官方契约核对

依据 [OpenAI Responses 流式事件](https://developers.openai.com/api/reference/resources/responses/streaming-events)、[OpenAI 函数工具指南](https://developers.openai.com/api/docs/guides/function-calling)、[Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create)与[流式事件](https://platform.claude.com/docs/en/build-with-claude/streaming)设计接口和工具回传；供应商入口差异核对了 [DeepSeek Responses](https://api-docs.deepseek.com/guides/responses_api/)和 [Anthropic 格式](https://api-docs.deepseek.com/guides/anthropic_api/)。Higress 原生路由采用[官方路径与请求头注解](https://higress.io/docs/latest/user/annotation-use-case/)。文档声明与本轮实际验证分开记录。
