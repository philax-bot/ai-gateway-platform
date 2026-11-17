# 调用追溯与实时容量验收（2026-11-12）

## 本轮结果

已实现并在原 PostgreSQL 开发工作区启动，入口为 `http://localhost:5176/` → 运营空间 → 运行监控。

- 实时容量：模型服务、服务下模型、模型池、共享容量组，展示当前 RPM / TPM / 并发值、有效上限、占比和配置来源；每 5 秒读取一次。
- 调用追溯：人员/应用、凭据标识、请求 ID、Trace ID、独立访问尝试、模型池、实际服务、上游模型、上游请求号、阶段时间线与原有调用/结算记录关联。
- 参数错误、鉴权失败、准入拒绝、进行中访问、同键重放均有独立访问记录；重放不产生额外上游生成或费用。
- 服务名称、池名称、配置版本和脱敏端点随调用冻结。普通用户返回值不包含私有端点；系统容量和访问追溯查询仅运营角色可读。
- 追溯快照先写本地持久日记，后台同步 PostgreSQL；支持重送去重、进程中断恢复、已 fsync 临时文件恢复。备份格式 v3 包含追溯日记，继续读取 v1/v2。
- 提供服务鉴权保护的 Prometheus 容量指标，以及默认关闭的 OTLP/HTTP JSON 网关 span 导出。

## 指标口径

数据直接来自准入使用的 `admission_windows` 和 `reservation_limit_scopes`；内存模式使用同一套准入窗口/预占数据。继承规则复用 `effectiveUsageLimits`，没有另外维护监控上限。

- RPM：当前固定分钟准入计数 / 有效 RPM 上限。
- TPM：当前固定分钟容量 Token 计数 / 有效 TPM 上限，含估算预占及结算调整；不声称是逐 Token 的实时实耗。
- 并发：未终结且未过期的有效预占槽位 / 有效并发上限；包含已准入、尚未转发的请求。
- 无上限资源仍计数，只是不计算百分比；采集失败和过期数据显示未知。
- 服务、池、共享组分别计数，不相加成为平台总量；同一个共享组仅展示一行。
- 80% / 90% / 100% 为本轮页面压力提示，尚未新增持久化的容量告警通知规则；原有业务故障告警继续运行。没有把无流量或未达容量阈值写成健康。

## 验证

| 检查 | 结果 |
| --- | --- |
| 控制面全部单元测试 | 44 文件、272 项通过 |
| 网关完整回归 | 91 项通过；随后新增的 OTLP/临时快照恢复用例所在文件 3 项通过 |
| Web 类型检查、构建 | 通过；原有大 chunk 提示仍在 |
| PostgreSQL + 真实本地 HTTP + 浏览器 | 45 项断言通过，详见 [browser.json](screenshots-2026-11-12-observability/browser.json) |
| 原生备份恢复 | `PG_BIN=.runtime/pg-client-16.15/bin node scripts/check-delivery.mjs --backup`：12 项迁移检查、57 项隔离交付检查通过，包含 v3 追溯日记原样恢复 |
| 开发工作区启动 | 使用 `pnpm dev`；原 schema、状态文件和外部调用开关保留，5176/4301/4300 健康入口返回 200 |

浏览器验收使用独立 PostgreSQL schema、独立进程和自动化专用 Chrome profile，没有修改原开发业务数据或调用外部模型。验证了：

1. 用户 → Key → 池 → 服务 → 结算的关联，以及有效 W3C Trace Context。
2. 参数错误与无效密钥的匿名记录可查询，记录中没有 API Key、请求正文。
3. 同键重放有两次访问尝试，但仅一条业务调用；服务改名后历史名称和配置版本保留。
4. 服务并发 2/2 显示 100%，第三次准入被拒；同一模型池 2/3 显示约 66.7%，释放后立即归零。
5. RPM、TPM 百分比与实际限流计数一致；无上限不会伪造 100% 或丢失新请求计数。
6. Prometheus 接口鉴权、普通用户无权查询系统追溯/容量，普通调用记录隐藏私有端点。
7. Beacon、Azure、Sidebar、Next、Classic 的 1440/390 截图，无页面级横向溢出；筛选 Tab、时间线 Enter、Escape 关闭与焦点返回；无未捕获浏览器异常。

截图：[信标桌面](screenshots-2026-11-12-observability/observability-beacon-1440.png)、[信标窄屏](screenshots-2026-11-12-observability/observability-beacon-390.png)、[追溯详情桌面](screenshots-2026-11-12-observability/trace-timeline-1440.png)、[追溯详情窄屏](screenshots-2026-11-12-observability/trace-timeline-390.png)。截图中的满载、名称与请求均为隔离验收数据。

上轮已发现的成本汇总测试失败一并修正：该用例按排他的 `to=now` 立即汇总同毫秒生成的记录，现显式设置包含样本的窗口上界；未更改生产计费或统计边界规则。

## 接入与边界

- `GET /api/v1/platform/monitoring/capacity`：运营会话读取容量。
- `POST /api/v1/platform/traces/query`：运营会话按请求、trace、主体、服务、池、时间、状态及游标查询。
- `POST /internal/v1/telemetry/requests`：服务令牌写入有版本的访问快照，终态不能被迟到的活动快照覆盖。
- `GET /internal/v1/telemetry/metrics`：服务令牌读取 Prometheus 文本；指标标签不包含用户、requestId 或 traceId。
- 网关响应包含 `x-request-id` 与 `x-trace-id`，向上游传播 `traceparent`。
- 可设置 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://collector:4318/v1/traces` 导出网关 SERVER span 和阶段事件；未设置时不调用外部采集器。Collector、Prometheus/Grafana、外部链路后端没有在本次部署。
- 系统访问记录通过后台日记同步，正常可见延迟约数秒，页面再按 5 秒刷新；它不替代直接读取的容量硬限制。遥测写入失败不会跳过业务结算；网关健康状态会暴露遥测投递故障。
- 当前追溯到配置的模型服务；供应商内部 Pod/GPU、应用内部自然人身份仍需下游提供可信标识。此处不把应用负责人当作实际操作人。

本次不发布生产版本、不提交或推送 Git；原工作区其他未提交修改保留。
