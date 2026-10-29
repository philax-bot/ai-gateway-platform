# Higress 隔离评估记录

当前状态（2026-10-29）：用户已恢复授权，并在 `codex/higress-poc` 完成第一阶段隔离链路，54 项检查通过，见 [最新 PoC 与覆盖边界](higress-poc-2026-10-29.md)。尚未替换正式 Provider 或默认数据面。

下文保留 2026-10-20 的历史状态：当时按阶段决定暂不继续评估，集中人工核验外层产品。仅保留源码和固定镜像准备结果，未启动该轮真实请求链路验证，未作接入或最终选型承诺。

## 已核实的对象

- 官方入口 `alibaba/higress` 当前重定向至 [higress-group/higress](https://github.com/higress-group/higress)。源码克隆在 `.runtime/higress-source-evaluation`。
- 首次读取 main 为 `43ad04ee54139935e9b51fbebec19986fb9f8508`；实际隔离运行统一对齐 v2.2.5，源码现固定为 `4deae1dd3b4cb2707273748985e55bef28e747d1`。
- 官方 Linux amd64 all-in-one:2.2.5 镜像摘要为 `sha256:e650ae5244bb89e95a7cbe5188b9c0c9caf7a165aa5e4c89364e37a1e3efbb24`。镜像准备不等于请求链路已通过。
- 独立运行版 [higress-standalone](https://github.com/higress-group/higress-standalone) 克隆为 `c6d6e5f7083acca37694630d634ed4843d17d7ed`，用于理解文件配置和容器启动方式；不能把其 main 脚本当作已发布镜像的精确构建来源。

## 初步代码发现

1. [ext-auth](https://github.com/higress-group/higress/blob/4deae1dd3b4cb2707273748985e55bef28e747d1/plugins/wasm-go/extensions/ext-auth/main.go) 注册请求头/请求体回调，适合做请求前鉴权；授权服务失联时需保持失败关闭。它自身没有本平台所需的响应后结算与持久重放流程。
2. [ai-statistics](https://github.com/higress-group/higress/blob/4deae1dd3b4cb2707273748985e55bef28e747d1/plugins/wasm-go/extensions/ai-statistics/main.go) 注册响应和流式处理，提取用量并输出日志/指标。这些统计扩展不能直接当作已有确认、去重、落盘和重放的结算提交协议。流式取消/崩溃边界仍要实际验证。
3. `use_default_attributes` 会启用 messages、question、answer、reasoning 等正文日志；本平台不能直接采用该选项。若后续启用统计插件，应明确限制字段，不持久化提示词或回答正文。
4. 当前项目的 `HigressProvider` 是早期内存合同替身，返回 applied 没有调用真实 Higress。它不构成配置同步证据，真实接入必须替换该实现并验证 desired/applied 版本、失败和回滚。

## 正在比较的路径

| 路径 | 必须证明的内容 |
| --- | --- |
| Higress 鉴权/代理 + 独立结算适配 | 每次流式结束、中断和进程故障均能持久记录可重放事件；不能仅依赖成功访问日志 |
| Higress 作为入口代理，现有受控代理执行权威路由与结算 | 验证额外代理跳数、SSE/取消/工具调用、头部和错误透传，并避免双重路由/计费 |
| 继续独立受控数据面 | 继续承担代理、流式、可靠结算及运维验证；现有本地和容器证据不替代真实模型与生产规模验收 |

当前不修改 Higress 核心，不把组织、审批或额度账本塞进其插件。仍按 [P01–P14 清单](gateway-poc-checklist-v0.1.md)记录真实运行结果；源码具备相关回调，只能作为候选依据，不能记为 PASS。
