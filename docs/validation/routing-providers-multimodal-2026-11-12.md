# 模型池路由、供应商与多模态接口验收

日期：2026-11-12。本轮补齐首轮三项需求。开源源码评估见 [评估报告](../architecture/opensource-routing-providers-modalities-2026-11-12.md)，此前的调用追溯与容量监控见 [验收记录](observability-2026-11-12.md)。

## 交付内容

| 需求 | 当前实现 | 代码入口 |
| --- | --- | --- |
| 模型池路由 | 稳定分流、加权、低并发、低容量占用、低延迟、主备优先；每个来源的权重和优先级；连续故障隔离与到期恢复 | `apps/control-plane/src/store/pool-routing.ts`、`admission.ts`、`postgres.store.ts`、`apps/web/src/ModelPools.tsx` |
| 供应商菜单 | 模型管理 → 供应商；8 个内置模板、自定义供应商、类型与适配器、默认地址、关联服务；停用阻止新调用；适配器/类型变化使关联服务重新验证 | `packages/contracts/src/model-kinds.ts`、`platform/resource-actions.ts`、`apps/web/src/Providers.tsx` |
| 多模态 | 以下六类接口的类型校验、身份与用途授权、模型映射、计量、费用预占、结算、历史记录；视频增加持久化任务、归属校验、轮询、回执恢复 | `services/gateway-sim/src/media.ts`、`media-input.ts`、`platform/media-jobs.controller.ts` |

既有服务没有供应商字段时归入 OpenAI 兼容服务；模型缺少类型时仍按对话处理；未配置新策略时保持原稳定分流。没有自动更改已有池策略、绑定外部供应商或触发外部生成。

## 接口与计量

| 类型 | 平台入口 | 支持的计价方式 |
| --- | --- | --- |
| Embedding | `POST /v1/embeddings` | 上游 Token，或按次 |
| Rerank | `POST /v1/rerank`、`POST /v2/rerank` | 上游 Token，或按次；Cohere `search_units` 不冒充 Token |
| 图片生成 | `POST /v1/images/generations` | 实际图片张数，或按次 |
| ASR | `POST /v1/audio/transcriptions` | 上游返回的实际秒数，或按次；multipart 文件转发 |
| TTS | `POST /v1/audio/speech` | 输入 Unicode 字符数 / 千字符，或按次；音频二进制响应 |
| 视频 | `POST /v1/videos`，兼容 `/v1/videos/generations` | 上游实际秒数，或按次 |

视频提交返回平台任务 ID；`GET /v1/videos/{id}` 查询、`GET /v1/videos/{id}/content` 获取完成内容。读取仍需当前有效密钥，主体、组织、项目与用途必须匹配。查询和下载不另建业务调用或重复扣费。相同幂等键的视频重放返回原任务；其他类型禁止重复转发。

价格、倍率、成本与路由在准入时冻结。数量保留六位小数，整笔费用向上取整到微元。缺少秒数或 Token 时保留待核对状态，不把未知当作零；人工核对必须使用原单位和原批次。更改模型类型会清除不兼容价格并使服务验证失效，历史调用不重算。

视频任务由 PostgreSQL 保存；多网关通过 `FOR UPDATE SKIP LOCKED` 与 30 秒租约领取，单批最多 4 个任务。生成只提交一次；提交结果不明确时转待核对。已收到的上游任务回执先写入并同步本地磁盘，再投递控制面。终态时间与用量固定后，结算重放保持相同事件。备份格式 v4 覆盖 `media-receipts`，继续兼容 v1/v2/v3。

## 路由规则

- 选路发生在转发前，仍受同一组用户、用途、池、服务与共享容量限制；资金不足或容量已满的来源会跳过。不会在上游已接收请求后换服务再生成。
- 加权使用请求 ID 与服务 ID 的确定性采样，目标为长期比例，不保证每一小批请求严格按比例。
- 低并发使用当前有效预占；低容量占用使用当前分钟 RPM/TPM 和并发的最大占比；延迟使用最近成功调用的首字延迟或总耗时，至少 3 个样本。
- 故障隔离基于最近 10 分钟已转发的上游错误、超时、部分失败，业务拒绝不计入；没有自动探活或额外付费探针。PostgreSQL 查询最多读取最近 10,000 条候选服务记录。

## 验证证据

- 控制面全量 282 项测试通过，覆盖原有功能和本轮计量、恢复、配置、权限隔离与选路。
- 网关全量 97 项测试通过，含新增 `test/media.test.mjs` 5 项，覆盖路径与外部开关、multipart、Unicode、可信用量、错误响应与回执重启恢复。
- 隔离 PostgreSQL + 真实网关 + 本地 HTTP 模拟上游共 72 项断言通过：六类真实 HTTP 请求与金额、视频重启、跨工作进程领取、归属隔离、幂等重放、未知用量人工核对、供应商停用。
- 五种界面（beacon / azure / sidebar / next / classic）在 1440 / 390 宽度检查；供应商、模型目录、模型池与编辑表单截图在 [最终截图目录](screenshots-2026-11-12-multimodal/final/)，断言和浏览器异常在该目录 `browser.json`。
- 原生 PostgreSQL 备份/恢复：12 项迁移检查、58 项交付检查通过，包含 v4 视频回执的原样恢复。
- 原本地工作区已载入最终代码：`http://localhost:5176/`；工作区 ID 仍为 `20bea9e2-970a-4e7d-98eb-12ca16e81692`。四个服务健康检查均为 200，网关结算队列、追溯队列和视频待投递回执均为 0。019/020 已迁移，原外部调用开关保持开启，未执行外部生成。
- 原本地运营快照可见 8 个模板，员工快照不包含供应商配置及私有地址。已有 4 个模型定义、3 个池和 3 个服务保留，隔离验收资源未写入该工作区。

复现命令：

```powershell
pnpm --filter @ai-gateway/control-plane test
pnpm --filter @ai-gateway/gateway-sim test
pnpm --filter @ai-gateway/web typecheck
pnpm --filter @ai-gateway/web build
pnpm check:multimodal
$env:PG_BIN=(Resolve-Path '.runtime/pg-client-16.15/bin').Path
node scripts/check-delivery.mjs --backup
```

## 适用边界

验收使用本地模拟上游，没有调用付费供应商，也没有生产部署。适配器包含 OpenAI 兼容、Cohere Rerank、xAI 和火山方舟视频分支；分支和路径不代表所有供应商、模型、参数已完成真实联调。

非聊天连接验证只读取模型目录并确认物理模型存在，不执行生成，不能解释为图片质量、音频效果、视频生成已实测。实际生成需按具体供应商验证。图片编辑、实时语音、流式音频、视频取消/列表/重混、分辨率阶梯价格不在本轮范围；按尺寸等差异可先配置独立模型映射与价格。

聊天保留原 Higress 传输；本轮新增六类由受控网关适配器直接调用冻结的服务地址，尚未实现对应 Higress 原生协议插件。外部调用仍需原有 `ALLOW_UPSTREAM_REQUESTS=true`，实际调用的网关进程也需对应 `UPSTREAM_` 凭据；日常启动器在原外部调用开关开启时同步传入受控引用，不传给 Web。上传上限 20 MiB，缓冲响应/视频内容上限 32 MiB，非聊天入口暂不支持流式返回。

供应商菜单提供模板与服务关联；密钥仍通过现有服务端凭据引用管理，没有新增 OAuth 登录或把密钥明文保存在供应商模板中。
