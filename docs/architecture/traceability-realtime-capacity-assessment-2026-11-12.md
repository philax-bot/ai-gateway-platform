# 调用可追溯与实时容量监控评估

日期：2026-11-12。范围：检查当前源码及针对性单元测试，对照已拉取的 LiteLLM、New API，提出方案；本次不实现或部署功能。

后续已按用户授权实施核心追溯与容量监控；本文件保留评估时的现状，当前结果、验证及剩余边界见 [实施验收](../validation/observability-2026-11-12.md)。

## 1. 结论

| 需求 | 当前状态 | 判断 |
| --- | --- | --- |
| 从人员/应用追到实际模型服务 | 已有身份、凭据、模型池、服务、上游模型及请求号、费用关联 | 核心业务调用追溯已有，不需要另建一套调用账本 |
| 每次网关访问全链路可追溯 | 入口早期失败、进行中的阶段、分布式 span 和完整历史配置快照不足 | 尚不满足“每次访问、每个阶段、每次上游尝试”的完整要求 |
| 服务运行监控 | 已有服务/模型分组、近 5 分钟汇总、有效预占在途、时延和告警，前端每 15 秒刷新 | 属于运行概览，不能等同于实时容量压力 |
| 模型池实时流量和压力 | 调用查询可按池过滤；实时监控没有池分组及容量占比契约 | 需要新增聚合与展示 |
| 实时指标 / 配置上限百分比 | 限流器已有用量和上限基础，但未对监控暴露 | 可以复用准入数据实现，不能直接拿完成请求统计代替 |

将“实时指标占设置指标的百分比”理解为：**当前使用量 ÷ 当前有效上限 × 100%**，达到 100% 表示该维度的准入容量已用满。它与模型服务在流量总量中的分流占比是两个指标，可以同时显示。

## 2. 两个参考项目均已 clone

| 项目 | 本地目录 | 本次固定提交 |
| --- | --- | --- |
| LiteLLM | `D:\Workspace\pri\_references\litellm` | `801e139c35af5eca132e8761cb11be19621218c4` |
| New API | `D:\Workspace\pri\_references\new-api` | `be5e3153d9734ac0a24220d0694fc3fad2f208d3` |

均为浅克隆、稀疏工作树。上次检出了路由和适配目录，本次又检出了监控、日志、OpenTelemetry 等相关目录；本次未更新提交、安装依赖或启动参考项目。

## 3. 已有的追溯链路与边界

现有可关联的业务链路：

```text
人员 / 应用 → 凭据、用途、组织 / 项目 → requestId
  → 准入预占 → 模型池 → 实际 ModelService → 上游模型
  → upstreamRequestId → 结果、Token、费用、结算
```

### 3.1 证据

- `packages/contracts/src/index.ts:208` 的 `CallLog` 包含 `subjectType/subjectId/credentialId/projectId`、`requestId/upstreamRequestId/retryOfRequestId`、`admission.route`、时序与结算字段。路由包含 `serviceId/poolId/definitionId/upstreamModel`。
- `apps/control-plane/src/store/admission.ts` 在准入时冻结路由与价格；`publicLogAdmission` 将实际服务与池保留到公开日志结构。
- `apps/control-plane/src/store/demo.store.ts:338` 附近从预占身份和路由生成日志；`postgres.store.ts:322` 从数据库映射相同字段。日志来源不是根据当前池成员重新推断。
- `services/gateway-sim/src/server.ts:239` 向实际分发目标传递 `x-request-id`，随后读取上游响应中的请求号并纳入结算。
- `apps/web/src/CallExplorer.tsx:50` 附近已有“主体与路由”“用量与计价”“时序与追踪”；管理员可按主体、服务、池、凭据等筛选，并查看显式重试关系。
- `packages/contracts/src/calls.ts` 及调用查询实现支持 `serviceId/poolId` 等过滤。

因此，“某个员工通过哪个密钥、哪个池，调用了哪个已配置的模型服务”已有数据基础和界面。

### 3.2 尚不能承诺的范围

1. **不是所有入口访问都有业务调用日志。** `server.ts:96` 起先进行 JSON/协议/内容校验，部分错误早于 requestId 的创建；无效密钥、凭据解析服务不可用等也会直接返回，不进入完整准入/结算链。
2. **应用身份不自动等于应用内自然人。** 共享应用 Key 能追到应用；若要追到应用内用户，需要调用应用传递可信的终端用户身份，由平台验证来源。应用负责人不能被当成每次请求的实际操作人。
3. **请求日志不等于分布式调用链。** 当前主要记录请求最终结果和显式重试关系，没有完整的入口、鉴权、排队、准入、Higress、上游、首字节及结算 span 链路。
4. **历史配置快照不充分。** 公共调用日志保留路由 ID 和上游模型，但服务/池名称从当前目录解析；名称、地址、绑定版本发生变化后，不能仅凭当前配置完整还原当时状态。
5. **追到配置服务不等于追到物理推理实例。** 如果 ModelService 后面还有负载均衡器或供应商内部调度，当前记录不能证明实际落到哪个 Pod/GPU。需要下游提供请求标识、实例标识或关联遥测。
6. **进行中与历史记录分开。** 最终调用日志在结束/结算时生成，当前在途统计没有提供完整的逐请求阶段列表；日志上游请求号缺失时应明确显示未提供。

## 4. 追溯方案：扩展现有账本，补齐入口与阶段事件

建议优先完成：

- 在网关入口即创建内部唯一 `requestId`，包括早期 400/401/503 等失败都保留访问记录。客户端请求号作为独立关联字段；未鉴权成功时身份为未知，不伪造用户归属。
- 增加 `traceId`，在服务间传播标准 `traceparent`，将控制面、准入、网关、Higress 和上游关联。每个上游实际尝试单独记录 `attemptId`，显式重试仍保持现有独立授权和结算关系。
- 保留服务配置版本、脱敏端点快照、凭据引用版本、实际上游模型以及池/服务名称快照；不记录凭据明文。快照应在准入/分发时写入，不能靠事后查当前目录补齐。
- 补充 accepted/authenticated/admitted/dispatched/first_output/completed/settled 等阶段时间与结果，关联现有预占和结算 journal。明确“已选路”“已开始转发”“上游已响应”分别由什么证据证明。
- 详情页展示阶段时间线；支持按用户、应用、requestId、traceId、服务和池双向定位。未来路由重试按尝试展开，不能只留下最后一条成功来源。
- 业务调用与计费事实保留完整记录；遥测 span 可采用单独的保留/采样策略，但不能靠抽样 span 替代逐次审计。

先补入口覆盖与历史路由快照，再接入 OpenTelemetry；无需等待部署完整追踪系统才能改善调用详情。

## 5. 当前监控到底有哪些

源码证据：

- `packages/contracts/src/monitoring.ts` 的 `MonitorSnapshot.rows` 仅有 `serviceId/modelId/summary/activeReservations`，没有 `poolId`、有效上限或占比。
- `apps/control-plane/src/platform/monitoring.service.ts:12` 按服务模型映射读取调用汇总；`snapshot` 使用近 5 分钟的已结束请求窗口。
- `apps/web/src/Monitoring.tsx:21` 每 15 秒轮询；表格使用 `ended / 5` 展示窗口平均 RPM，另有在途预占、错误、P95 时延、P95 TTFT 和数据质量。超过 90 秒提示过期。
- `postgres.store.ts:323` 从未终结且未过期的 `reservations` 按服务/模型统计在途。它包含准入后尚未转发的请求，不等于上游正在执行的连接数。
- `monitoring.domain.ts` 的告警指标是请求错误率、上游故障率、超时率、部分异常率、限流拒绝率、取消率；没有容量利用率指标，也没有池范围字段。

所以：**现有监控能看到最近运行结果和预占数量，但不能直接回答“某服务/池现在已用到配置能力的百分之多少”。** 长请求尚未结束时，也不会进入已结束请求的吞吐汇总。

## 6. 实时压力方案与指标口径

### 6.1 最小可用版本可复用现有限流器

当前 `admission.ts` 已生成 subject、purpose、pool、service、service-model、shared 等限流 scope。PostgreSQL 使用 `admission_windows` 保存当前固定分钟的请求/Token 计数，使用 `reservation_limit_scopes` 和租约控制并发。应给 store 增加批量只读容量快照接口，复用同一套有效配置解析和权威计数。

建议容量快照包含：资源类型/ID、模型、scope、有效上限及来源、当前值、窗口起止、剩余量、占比、采集时间与质量、配置版本。查询应批量执行，避免每次刷新按每个服务/模型逐项扫调用日志；不持有业务工作区写锁进行采集。

| 指标 | 计算与示例 | 说明 |
| --- | --- | --- |
| RPM 限额使用率 | 当前限流分钟已准入请求 `240 / 600 = 40%` | 与现有固定分钟限流口径一致；不是近 5 分钟完成数的平均值 |
| TPM 限额使用率 | 当前限流分钟 Token 占用 `60,000 / 100,000 = 60%` | 使用限流器中的实际计数，可能包含预估预占及结算调整，明确标为容量占用 |
| 并发容量占用率 | 有效预占槽位 `18 / 20 = 90%` | 与准入硬限制一致，另列真正已分发/执行中的请求 |
| 实际吞吐 | 最近 10 秒/60 秒到达、准入、分发、完成速率 | 分开统计，防止长请求、拒绝和重试使数字混淆 |
| 实际 Token 吞吐 | 已确认用量，或明确标注的进行中估计 | 上游没有实时 usage 时，不将预估 Token 冒充实时实耗 |
| 分流占比 | 某服务实际分发数 / 同池同模型分发总数 | 用于检查路由分配；与容量使用率分开展示 |
| 质量与体验 | 错误率、限流率、P95、TTFT | 辅助解释压力，不混成一个无定义的“健康百分比” |

无上限显示“未设上限”，采集失败显示“未知”，都不能显示 0%。配置下调导致暂时超出上限时，应显示实际百分比，不能为了进度条而隐藏超过 100% 的事实。

### 6.2 服务与模型池要同时看，瓶颈来源要可解释

- 服务总览 → 服务下模型 → 模型池 → 池内同模型各来源，均展示 RPM、TPM、并发的当前值/有效上限/百分比，并可下钻当前请求与调用记录。
- 服务和模型池的限流计数直接使用各自 scope；同一请求在池和服务两个视图中出现是不同维度，计算平台总量时不能相加重复计数。
- 池本身有上限时直接展示池 scope 的占用；池未设上限时，不能把不同模型、不同共享组的上限简单相加作为池总容量。
- 若需要“池内某模型可用容量”，结合开放/健康来源、各服务与服务模型上限、池上限、共享容量去重计算；显示瓶颈是池、某服务、某服务模型还是共享组。
- 人员、项目、应用限额引起的拒绝另外归因，不应让服务看起来已满。
- 这些百分比代表**本网关配置容量的占用**。供应商其他客户流量、其他网关流量、实际 GPU/显存饱和度，需要接供应商配额响应或推理服务遥测才能判断。

### 6.3 更新、告警与持续运行

最小版本可每 5 秒刷新容量快照，保留现有 15 秒的质量概览；流量增长后由后台批量采集并缓存快照，前端读取或通过 SSE 接收，避免每个浏览器触发全量数据库聚合。

在现有告警状态机中增加 RPM/TPM/并发使用率和 pool 范围，阈值可配置。可默认 80% 提醒、90% 预警、100% 满载，但触发和恢复应有持续时间与回落阈值。对秒级尖峰应按短周期判定，不能直接沿用当前每分钟一次的规则评估频率。

入口与分发事件补齐后再输出 Counter/Gauge/Histogram，接 Prometheus/Grafana 保存趋势；通过 OpenTelemetry 接链路查看器。准入是否放行仍以现有事务/限流器为准，不能以延迟采样的监控数据决定。

Prometheus 标签优先采用有限集合的租户、池、服务、模型、结果等维度；逐请求 requestId、traceId、用户标识放日志/trace，避免时序数量随请求无限增长。

## 7. 哪些开源源码适合参考

| 项目与源码 | 可参考的能力 | 本次判断 |
| --- | --- | --- |
| LiteLLM [`litellm/models/spend_logs.py`](https://github.com/BerriAI/litellm/blob/801e139c35af5eca132e8761cb11be19621218c4/litellm/models/spend_logs.py)、`proxy/spend_tracking/spend_tracking_utils.py` | 请求、用户、模型、api_base、metadata 及成本日志 | 参考请求与实际部署元数据关联；平台已有账本应继续作为事实来源 |
| LiteLLM [`litellm/integrations/opentelemetry.py`](https://github.com/BerriAI/litellm/blob/801e139c35af5eca132e8761cb11be19621218c4/litellm/integrations/opentelemetry.py) | span、父子关系、模型/用户属性、服务阶段与错误记录 | 适合补齐分布式链路；Python 实现作为设计参考，不直接替换现有 TS 服务 |
| LiteLLM [`litellm/integrations/prometheus.py`](https://github.com/BerriAI/litellm/blob/801e139c35af5eca132e8761cb11be19621218c4/litellm/integrations/prometheus.py) 及 `prometheus_helpers/` | 请求/Token/延迟、部署 RPM/TPM 上限、used/allowed 指标、Grafana 面板及标签控制 | 最适合参考“实时使用量 / 上限”的指标拆分与导出；各指标启用条件仍需按采用方式确认 |
| LiteLLM [`proxy/middleware/in_flight_requests_middleware.py`](https://github.com/BerriAI/litellm/blob/801e139c35af5eca132e8761cb11be19621218c4/litellm/proxy/middleware/in_flight_requests_middleware.py) | HTTP 在途请求增减、Prometheus gauge 与多进程处理 | 适合区分 HTTP 在途与业务预占；不能直接当作每个模型服务的执行并发 |
| New API [`model/log.go`](https://github.com/QuantumNous/new-api/blob/be5e3153d9734ac0a24220d0694fc3fad2f208d3/model/log.go)、`controller/relay.go` | UserId/TokenId/ChannelId/模型/请求号/上游请求号，渠道尝试记录 | 与“用户追到实际渠道”直接对应，可参考查询与路由诊断组织 |
| New API [`pkg/perf_metrics/metrics.go`](https://github.com/QuantumNous/new-api/blob/be5e3153d9734ac0a24220d0694fc3fad2f208d3/pkg/perf_metrics/metrics.go)、`types.go`、`model/perf_metric.go` | 已结束请求与异步任务性能采样、模型/分组聚合和趋势 | 当前采样主要按 model/group，默认小时桶；不是现成的服务/池秒级容量占比方案 |

New API 的 `middleware/performance.go` 主要处理网关宿主 CPU/内存过载，与模型服务/池的 RPM、TPM、并发压力不同，不应混用。

许可沿用前次核查：LiteLLM 核心目录 MIT，企业目录单独许可；New API 为 AGPLv3 且有 NOTICE 附加条款。本次仅研究源码，没有复制实现。

## 8. 建议交付顺序与验收

1. **先补服务/池容量占比**：复用权威限流计数，提供当前值/上限/百分比/瓶颈/采集时间；验证继承配置、无上限、共享组、多实例与池聚合不重复。
2. **同时补追溯缺口**：入口即分配 ID、早期失败日志、历史服务配置快照、进行中阶段、可信终端用户扩展；每条记录可追到原业务调用和结算。
3. **再接持续遥测**：OpenTelemetry + Prometheus/Grafana，按 requestId/traceId 串联，形成趋势、阶段耗时和容量告警；后续路由策略消费明确口径的服务指标。

验收至少包括：成功、鉴权失败、参数失败、准入拒绝、上游错误、超时、取消、显式重试和同键重放；修改服务配置后历史调用仍可还原；两个网关实例下并发不重复计算；服务与池达到 100% 的展示能与真实准入拒绝对应。

## 9. 本次验证及限制

本次运行 6 个控制面测试文件：`tracing`、`call-query`、`admission`、`monitoring`、`collection-monitoring`、`monitoring-lock`，**52 项中 51 项通过**。

追踪、调用查询和监控相关 5 个文件全部通过；`admission.spec.ts` 的路由/容量用例通过，但 `freezes a model multiplier and independent cost across repricing, replay and settlement` 在成本汇总断言失败（期望有成本样本，实际为 0），单例复跑仍失败。源码显示该用例立即按默认当前时间汇总，而统计 `to` 是排他边界，存在同毫秒记录被排除的时间边界嫌疑；本次未将其认定为已证实根因，也未修改已有业务或测试代码。

本次没有执行生产环境、真实上游、多实例运行压测或页面截图验证。结论是当前源码与本地测试层面的能力评估，不是完整运行验收。
