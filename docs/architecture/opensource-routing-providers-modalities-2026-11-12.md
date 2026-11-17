# 路由策略、供应商管理与多类型模型：开源源码评估

评估日期：2026-11-12。以下为实施前的源码评估，结论基于拉取时固定提交的静态检查。

后续已补齐平台路由策略、供应商菜单和六类多模态调用，具体实现、验收与边界见 [实施验收](../validation/routing-providers-multimodal-2026-11-12.md)。下文“未实现”描述评估时基线，不代表当前代码状态。

后续补充：[调用可追溯与实时容量监控评估](traceability-realtime-capacity-assessment-2026-11-12.md)。

## 1. 结论

三项需求都能找到可参考的开源实现，但不能只依赖 9Router：

- **模型池路由**：优先参考 LiteLLM 的加权、最少并发、TPM/RPM 和延迟策略；9Router 适合补充轮询、错误分类、冷却和会话保持的实现思路。
- **供应商菜单**：9Router 有菜单、供应商列表、详情、连接管理、配置注册表和后端接口，源码链路完整，适合作为交互与配置组织参考。
- **视频、图片、Embedding、Rerank、ASR、TTS**：六类均有可找到的网关/适配器源码。9Router 覆盖其中五类，**没有找到专用 Rerank 接口及处理链路**；LiteLLM、New API 可以补齐。

“找到源码”指找到了请求入口、处理或适配逻辑，不代表覆盖任意厂商、任意模型版本，也不代表已经通过真实上游联调。本次没有修改平台业务代码、启动参考项目、安装依赖或调用外部模型。

## 2. 已拉取的仓库

参考仓库放在平台目录外，避免混入现有工作区改动。均为浅克隆；LiteLLM 和 New API 只检出本次相关目录，未检出部分可继续用 Git 获取。

| 项目 | 本地目录 | 固定提交 | 检出范围与用途 |
| --- | --- | --- | --- |
| [9Router](https://github.com/decolua/9router) | `D:\Workspace\pri\_references\9router` | `54a88d0498ffea4e52576950235562ea420dc761` | 完整工作树；路由、供应商前后端、多类型适配 |
| [LiteLLM](https://github.com/BerriAI/litellm) | `D:\Workspace\pri\_references\litellm` | `801e139c35af5eca132e8761cb11be19621218c4` | 稀疏工作树；`litellm/router_strategy`、`litellm/llms`、相关 proxy 目录 |
| [New API](https://github.com/QuantumNous/new-api) | `D:\Workspace\pri\_references\new-api` | `be5e3153d9734ac0a24220d0694fc3fad2f208d3` | 稀疏工作树；`relay`、`router`、`model`、`service` 等目录 |

9Router 提交标题为 v0.5.119，但根 `package.json` 为 0.5.116，因此本评估以提交 SHA 为准。

## 3. 模型池路由：有源码，需区分服务分流与跨模型选择

### 3.1 当前平台的实际基础

当前实现已经具备同模型多个服务的候选选择，并非从零开始：

- `apps/control-plane/src/store/admission.ts:125` 的 `admissionOptionsForBatch` 对池内同模型服务按 `requestId + serviceId` 稳定哈希排序。
- 同文件 `admissionForServiceBatch` 校验开放状态、服务验证、价格、协议和主体范围，并生成实际来源与价格快照。
- `apps/control-plane/src/store/postgres.store.ts:163` 附近枚举候选，统一锁定候选限流范围，再检查 RPM、TPM、并发容量，只对选中的候选预占和计数。
- `apps/control-plane/src/store/demo.store.ts:230` 附近也枚举候选并检查容量。

因此优化重点是候选排序与健康反馈；现有权限、容量硬限制、报价约束、幂等重放和原子预占需要保留。不能在转发层另选一条与准入快照不同的来源。

### 3.2 可参考源码

以下 LiteLLM 文件位于本地 `litellm` 参考仓库的 `litellm/router_strategy/` 下：

| 策略 | 已找到的实现 | 对当前平台的价值与边界 |
| --- | --- | --- |
| 加权分流 | [`simple_shuffle.py`](https://github.com/BerriAI/litellm/blob/801e139c35af5eca132e8761cb11be19621218c4/litellm/router_strategy/simple_shuffle.py) | 按显式权重或 RPM/TPM 配置选择；适合不同容量服务的流量分配。借鉴权重逻辑时，平台仍需固定已准入请求的来源 |
| 最少并发 | [`least_busy.py`](https://github.com/BerriAI/litellm/blob/801e139c35af5eca132e8761cb11be19621218c4/litellm/router_strategy/least_busy.py) | 有请求计数、选择预占、释放和 Redis 共享计数；适合长短请求混合。应接入平台已有租约与事务，不能用单进程计数替代跨实例容量限制 |
| 使用量路由 | [`lowest_tpm_rpm_v2.py`](https://github.com/BerriAI/litellm/blob/801e139c35af5eca132e8761cb11be19621218c4/litellm/router_strategy/lowest_tpm_rpm_v2.py) | 读取各部署 TPM/RPM、检查容量并选择候选；适合参考容量数据的组织与筛选方式 |
| 延迟优先 | [`lowest_latency.py`](https://github.com/BerriAI/litellm/blob/801e139c35af5eca132e8761cb11be19621218c4/litellm/router_strategy/lowest_latency.py) | 有样本窗口、平均/分位延迟和候选选择逻辑；需要先积累真实、可归属到服务的指标，并明确冷启动行为 |
| 成本优先 | [`lowest_cost.py`](https://github.com/BerriAI/litellm/blob/801e139c35af5eca132e8761cb11be19621218c4/litellm/router_strategy/lowest_cost.py) | 有价格与容量筛选实现；不能直接照搬。其一条选择路径使用输入/输出单价之和作为比较值，平台应结合预计用量、成本价和已确认用户报价决定 |
| 优先级加权与降级 | New API [`model/channel_cache.go`](https://github.com/QuantumNous/new-api/blob/be5e3153d9734ac0a24220d0694fc3fad2f208d3/model/channel_cache.go)、`model/ability.go` | 按优先级分层、同层加权，重试时选择后续层级；适合主备服务的策略参考 |

9Router 的对应实现：

- [`open-sse/services/combo.js`](https://github.com/decolua/9router/blob/54a88d0498ffea4e52576950235562ea420dc761/open-sse/services/combo.js)：`getRotatedModels` 轮询和连续使用次数；`handleComboChat` 顺序回退、能力排序和 smart 模式。
- `src/sse/services/auth.js`：供应商内多连接选择、fill-first/round-robin、按模型冷却、连接状态更新。
- `open-sse/services/accountFallback.js`：区分账号错误与请求自身错误，避免普通参数错误使健康账号进入冷却。
- `open-sse/services/systemoneRouter.js` 与 `src/sse/services/systemoneRouter.js`：会话保持、路由响应解析及实际分类模型调用。

**关键判断**：9Router 的 smart 模式会调用一个路由模型，根据请求内容在不同模型间选择；它不是纯本地的容量调度算法。轮询状态和 smart 会话保持也使用进程内 Map，不能直接当作平台跨实例一致性的实现。当前池用于同模型多服务容量聚合，第一阶段不需要引入跨模型语义选择及额外模型调用。

### 3.3 建议采用的方向

先在已符合权限、价格、协议和健康条件的同模型服务内，增加可配置权重与基于实际占用的排序；最终准入仍在现有事务中检查硬容量并冻结来源。随后增加错误分类、冷却及恢复探测，再根据真实指标增加延迟策略。

上游转发后的重试应单独设计：客户端已经收到内容后不换来源；网络结果不确定的计费请求不能简单重发。每次上游尝试与预占、结算之间的关系必须明确。

## 4. 供应商菜单：9Router 有完整参考链路

| 层次 | 9Router 源码位置 | 已确认的内容 |
| --- | --- | --- |
| 导航 | `src/shared/components/Sidebar.js` | Providers、Combo，以及 Embedding/Image/Video/TTS/STT 等能力入口 |
| 供应商总览 | `src/app/(dashboard)/dashboard/providers/page.js` | 搜索、状态筛选、连接汇总、优先级排序、兼容节点入口 |
| 供应商详情 | `src/app/(dashboard)/dashboard/providers/[id]/page.js` 及同目录组件 | 连接列表、API Key 表单、兼容节点配置、模型管理等页面源码 |
| 多类型供应商 | `src/app/(dashboard)/dashboard/media-providers/[kind]/page.js` 与 `[kind]/[id]/page.js` | 按能力展示供应商和详情；同目录有 TTS、STT、Embedding 示例组件 |
| 配置注册 | `open-sse/providers/REGISTRY_TEMPLATE.js`、`schema.js`、`index.js`、`registry/*.js` | 身份、显示、认证、传输、模型、`serviceKinds` 与各类媒体配置 |
| 后端接口 | `src/app/api/providers/route.js`、`[id]/route.js`、`provider-nodes/route.js` | 连接查询/创建/更新、兼容节点配置 |
| 返回值处理 | `src/lib/providerConnectionResponse.js` | 普通凭据字段剔除，以及 AWS session token 的专门处理；不等同于已完成整体凭据安全审计 |

源码入口：[供应商页面目录](https://github.com/decolua/9router/tree/54a88d0498ffea4e52576950235562ea420dc761/src/app/%28dashboard%29/dashboard/providers)、[注册模板](https://github.com/decolua/9router/blob/54a88d0498ffea4e52576950235562ea420dc761/open-sse/providers/REGISTRY_TEMPLATE.js)、[连接 API](https://github.com/decolua/9router/blob/54a88d0498ffea4e52576950235562ea420dc761/src/app/api/providers/route.js)。

适配本平台时，建议区分：供应商/协议模板负责连接方式和能力；现有 `ModelService` 负责实际实例、地址、凭据引用、验证和容量；`ModelDefinition` 负责模型定义。当前 `vendor` 是模型展示资料，不能直接充当供应商连接实体。供应商菜单应组织已有模型服务，避免再建一套互不关联的服务台账。

9Router 使用 Next.js/React、自己的组件和数据库层。本平台可以参考信息架构、状态和字段组织，页面实现继续遵循现有组件契约与 Beacon 主题。OAuth、Cookie、网页自动化等连接方式不必随菜单整体移植。

## 5. 各种模型类型：逐类源码证据

下表中的 9Router 路径均相对于本地 `9router` 参考仓库。已核对路由文件与 handler/core 的连接关系，并检查对应 adapter 或实际上游调用逻辑。

| 类型 | 9Router 入口 | 9Router 处理/适配源码 | 评估 |
| --- | --- | --- | --- |
| 图片生成 | `src/app/api/v1/images/generations/route.js` | `src/sse/handlers/imageGeneration.js` → `open-sse/handlers/imageGenerationCore.js`、`imageProviders/` | 有实际实现；注册了 OpenAI、Gemini、ComfyUI、SD WebUI、fal.ai、Stability 等适配器。不能据此推断所有图片编辑/变体接口也完整支持 |
| 视频生成 | `src/app/api/v1/videos/generations/route.js`、`edits/route.js`、`extensions/route.js`、`[id]/route.js` | `src/sse/handlers/videoGeneration.js` → `open-sse/handlers/videoCore.js`、`videoProviders/` | 有提交和状态轮询。默认 xAI 请求形态，另有 OpenRouter/Vertex 适配；不是统一实现了所有厂商视频 API |
| Embedding | `src/app/api/v1/embeddings/route.js` | `src/sse/handlers/embeddings.js` → `open-sse/handlers/embeddingsCore.js`、`embeddingProviders/` | 有实际实现；含 OpenAI 兼容、Gemini、Ollama、本地自建服务等适配 |
| Rerank | 未找到专用入口 | 没有找到 rerank handler/core/adapter；命中仅为能力排除和测试过滤等文字 | **9Router 不足以提供这一项实现；使用 LiteLLM 或 New API 补齐** |
| ASR/STT | `src/app/api/v1/audio/transcriptions/route.js` | `src/sse/handlers/stt.js` → `open-sse/handlers/sttCore.js` | 有 multipart 文件处理及上游调用；含 OpenAI 兼容、Deepgram、AssemblyAI、Gemini 等分支。实时语音能力需单独选定协议和上游验证 |
| TTS | `src/app/api/v1/audio/speech/route.js` | `src/sse/handlers/tts.js` → `open-sse/handlers/ttsCore.js`、`ttsProviders/` | 有音频二进制/base64 输出及多供应商合成实现；音色、格式和流式支持仍有厂商差异 |

直接源码：[9Router handlers](https://github.com/decolua/9router/tree/54a88d0498ffea4e52576950235562ea420dc761/open-sse/handlers)、[9Router API v1](https://github.com/decolua/9router/tree/54a88d0498ffea4e52576950235562ea420dc761/src/app/api/v1)。

### 5.1 LiteLLM 的补充实现

- Rerank：[`litellm/proxy/rerank_endpoints/endpoints.py`](https://github.com/BerriAI/litellm/blob/801e139c35af5eca132e8761cb11be19621218c4/litellm/proxy/rerank_endpoints/endpoints.py) 注册 `/rerank`、`/v1/rerank`、`/v2/rerank`，进入 `arerank` 调用链；`litellm/llms/cohere/rerank/transformation.py`、`jina_ai/rerank/transformation.py`、`voyage/rerank/`、`infinity/rerank/` 有对应适配源码。
- 视频：`litellm/proxy/video_endpoints/endpoints.py` 有创建、状态、内容、列表等入口；`litellm/llms/openai/videos/transformation.py`、`gemini/videos/transformation.py`、`volcengine/videos/transformation.py` 有协议转换实现。各适配器的具体操作支持范围仍需分别确认。
- 图片：`litellm/proxy/image_endpoints/endpoints.py` 和 `litellm/llms/*/image_generation/`。
- Embedding、TTS、ASR：`litellm/proxy/proxy_server.py` 中有 `/v1/embeddings`、`/v1/audio/speech`、`/v1/audio/transcriptions` 实际入口；`litellm/llms` 中有对应供应商的 embedding、speech、transcription 实现。

LiteLLM 的 Python 源码适合作为协议映射参考，或作为独立适配服务的候选。若引入独立服务，需要明确平台与 LiteLLM 中哪一层负责路由和重试，不能让准入记录与实际调用来源脱节。

### 5.2 New API 的补充实现

- `router/relay-router.go` 注册 Embedding、Rerank、ASR、TTS 等入口，图片生成和编辑也接入中继链路。
- [`relay/rerank_handler.go`](https://github.com/QuantumNous/new-api/blob/be5e3153d9734ac0a24220d0694fc3fad2f208d3/relay/rerank_handler.go) 有请求读取、模型映射、适配器转换、上游调用和响应处理；`relay/channel/ali/rerank.go` 有具体请求/响应转换。
- `relay/embedding_handler.go`、`relay/image_handler.go`、`relay/audio_handler.go` 有各类中继处理。
- `router/video-router.go`、`relay/relay_task.go`、`model/task.go`、`service/task_polling.go`、`service/task_billing.go` 提供视频/异步任务提交、持久化、轮询和结算/退款参考。

New API 的异步任务生命周期比只参考视频 HTTP 转发更有价值；部分视频能力经过任务插件机制，不能仅凭存在 `/videos` 路径就认定所有上游适配已内置。

## 6. 接入当前平台需要补齐什么

源码检查确认，平台当前不能仅增加菜单或模型标签就获得这些调用能力：

1. **类型契约**：`packages/contracts/src/index.ts` 虽已有 `embeddings/rerank/image/audio` 等 `RequestMode`，但 `admission.ts` 仍对 `input.mode !== 'chat'` 拒绝服务；枚举不等于实际支持。需要将模型用途、输入输出能力、协议和计费维度分别定义，ASR 与 TTS 也应区分。
2. **公开调用入口**：`services/gateway-sim/src/server.ts:358` 附近实际只开放 Models、Chat Completions、Responses、Messages。需要为新类型补充校验、鉴权、转发、错误和结果处理。
3. **能力验证**：`packages/contracts/src/protocol.ts` 的探测/协议契约目前只包含 chat/responses/messages；新类型应按实际端点验证，不用模型名称猜能力。
4. **计量与价格**：当前价格及 `costForUsage` 以输入、输出和缓存 Token 为核心。需要支持各上游实际计费维度，例如图片张数/尺寸、音频时长/字符、视频时长/分辨率及请求次数，并保持可追溯的预占与结算快照。
5. **异步任务**：视频应由平台保存内部任务 ID、上游任务 ID、实际服务/凭据引用、调用主体、状态和结算记录。轮询、下载、取消等操作都应验证任务归属。重复查询不重复收费，提交结果不确定时应可对账。
6. **输出语义**：Embedding 的维度与批量输入、Rerank 的文档索引和分数、ASR 的文件格式/字幕、TTS 的音频格式/音色、图片和视频的资源有效期都需要保留，不能统一塞入聊天消息结构。

特别是 9Router 的视频实现：它通过响应 `x-9router-connection-id` 让客户端在后续 GET 中回传 `x-connection-id`，保持上游账号一致；本次检查的 handler 中没有平台级任务归属映射。这一机制可以解释其轮询方式，但不能替代本平台的任务鉴权与持久化。

`videoCore.js` 也明确限制视频提交自动重发：网络错误可能发生在上游已创建付费任务之后。该原则值得保留，不能直接套用聊天类故障切换。

## 7. 许可与复用边界

许可文件为本次拉取版本的事实记录；本次只做源码评估，没有复制第三方实现进入平台。

| 项目 | 本次核对的许可 | 采用建议 |
| --- | --- | --- |
| 9Router | [MIT](https://github.com/decolua/9router/blob/54a88d0498ffea4e52576950235562ea420dc761/LICENSE) | 可作为主要参考来源；实际复用时按许可证保留版权及许可声明 |
| LiteLLM | [根许可证](https://github.com/BerriAI/litellm/blob/801e139c35af5eca132e8761cb11be19621218c4/LICENSE) 声明 `enterprise/` 以外为 MIT，`enterprise/` 单独许可 | 本报告优先选择公开核心目录中的路由和适配文件，避免把企业目录能力误认为同等许可 |
| New API | [AGPLv3](https://github.com/QuantumNous/new-api/blob/be5e3153d9734ac0a24220d0694fc3fad2f208d3/LICENSE)，另有 [NOTICE](https://github.com/QuantumNous/new-api/blob/be5e3153d9734ac0a24220d0694fc3fad2f208d3/NOTICE) 署名与链接条款 | 适合补充研究；若采用其代码或作为产品组成部分，应按实际使用方式确认许可义务，不能按 MIT 的方式直接处理 |

## 8. 建议实施顺序与本次验证边界

建议顺序：

1. 供应商配置模板与现有模型服务建立关联；模型池先增加权重、容量排序与健康冷却。
2. 先落地 Embedding、Rerank，完成类型、端点、权限、用量和结算闭环。
3. 落地图片生成、ASR、TTS，补充二进制、multipart 和对应计量。
4. 建立异步任务与对账机制后接入视频生成。

本次已完成：三个仓库拉取、固定提交记录、源码路径与主要调用链核查、许可文件检查、与当前平台实现对照。参考仓库无本次代码修改；平台只新增本评估文档，原有未提交改动保留。

本次未执行：参考项目构建/测试、页面运行验证、真实供应商 API 调用、性能测试、平台功能实现或部署。因此这里的“有实现”属于源码证据，不是运行兼容性验收。
