# 容器与内网运行

`deploy/compose.yml` 包含控制面、网关和统一 HTTPS Web 入口，使用已有 PostgreSQL；它不创建正式数据库、演示账号或初始资金。Higress 仍是后续评估项。根目录的 `docker-compose.yml` 仅用于原有开发数据库，与此交付配置分开使用。

## 准备目标

安装 Docker Engine 与 Compose 2.30 或更新版本（凭据文件使用 `env_file.format=raw`），准备可从容器网络访问的 PostgreSQL 和专用 schema。控制面账号须具有该 schema 的使用/建对象权限；schema 不存在或安装模式不匹配会拒绝启动。配置含义及首次管理员见 [运行模式与首次安装](RUNTIME-CONFIGURATION.md)。

在项目根目录复制 `deploy/runtime.env.example` 为 `deploy/runtime.env`，填写实际值。该私有文件、TLS 文件、根目录与应用的 `.env` 均不进入镜像上下文或源码提交。当前开发 `.env` 供开发与隔离检查使用；正式运行需要独立的强口令和干净 schema。

| 配置 | 填写方式 |
| --- | --- |
| `PUBLIC_ORIGIN` | 浏览器实际访问的精确 HTTPS 来源，如 `https://atlas.example.com:8443`；不带路径或尾斜线 |
| `HTTPS_PORT` / `BIND_ADDRESS` | 宿主发布端口与地址；默认 `8443` / `127.0.0.1`。内网开放时明确填写对应网卡地址，与域名/入口转发相匹配 |
| `DATABASE_URL` / `DATABASE_SCHEMA` | 容器可达的数据库地址和已建好的专用 schema；容器内的 `127.0.0.1` 不代表宿主或外部数据库 |
| `SERVICE_TOKEN` / `BOOTSTRAP_TOKEN` | 两个不同、随机、至少 32 字符的口令，不接受示例占位符 |
| `ALLOW_UPSTREAM_VALIDATION` / `ALLOW_UPSTREAM_REQUESTS` | 均默认 `false`；获得指定模型服务连接与调用授权后，分别显式启用控制面验证和网关调用 |
| `UPSTREAM_ENV_FILE` | 可选的私有凭据文件绝对路径；默认查找 `deploy/upstreams.env`，参照对应 example 填写 `UPSTREAM_*` 值，模型服务填写相同的凭据引用名 |
| `TLS_DIRECTORY` | 绝对宿主目录，内含 `fullchain.pem` 和 `privkey.pem`，Nginx UID 101 可读；使用域名匹配、受客户端信任的证书 |
| `BACKUP_DIRECTORY` | 已存在的绝对宿主目录，运维容器 UID 1000 可写；备份不会进入镜像 |

凭据文件只提供给控制面和网关，不进入 Web、镜像或公开构建变量。值按原文读取，含 `$` / `#` 时不会被 Compose 插值；不要再给值包上引号。新增或变更凭据后，使用 `up -d --force-recreate --wait control-plane gateway web` 一起重建，使环境生效并让 Nginx 重新解析容器地址。

控制面和网关均以非 root 用户运行，不发布宿主端口；Web 发布一个 HTTPS 端口，`/api/` 到控制面、`/v1/` 到网关，`/internal/` 拒绝访问。容器根文件系统只读，临时文件使用 `/tmp`；网关写入 Compose 专属的 `gateway_journal` 持久卷。每个新增网关实例必须另配日记卷，不能直接让多个实例共享同一个目录。

## 构建与启动

以下命令均在项目根目录执行；显式固定项目名，避免误操作其他 Compose 项目：

```powershell
docker compose --project-name signal-atlas --env-file deploy/runtime.env -f deploy/compose.yml --profile tools build
docker compose --project-name signal-atlas --env-file deploy/runtime.env -f deploy/compose.yml up -d --wait
docker compose --project-name signal-atlas --env-file deploy/runtime.env -f deploy/compose.yml ps
```

镜像使用 Node.js 22、pnpm 11.13.1 和 Nginx。控制面健康后才启动网关，两者健康后才启动 HTTPS 入口。Web 构建固化 `PUBLIC_ORIGIN`；修改公开域名或端口后重建 Web，再重建 Web 容器。健康检查和依赖顺序不能替代访问域名、证书信任、网络防火墙和业务调用的验收。

访问 `PUBLIC_ORIGIN`，使用安装口令创建首位管理员，再按模型准备、人员开通引导操作。TLS 由 Nginx 终止，Web/API/在线调用同源，登录 Cookie 保持 `Secure` / `HttpOnly`。不要在浏览器中忽略证书错误来认定正式入口通过。

查看日志只针对目标服务：

```powershell
docker compose --project-name signal-atlas --env-file deploy/runtime.env -f deploy/compose.yml logs --tail 100 control-plane gateway web
```

`web /health` 只证明 HTTPS 入口在运行；控制面和网关各自健康状态见 `compose ps`。网关 outbox 的 queued/blocked 详情可在网关容器内查询 `http://127.0.0.1:4000/health`。queued 应继续重试，blocked 或用量不完整应保留并核对，不能删除卷来处理失败。

停止应用保留全部持久数据：

```powershell
docker compose --project-name signal-atlas --env-file deploy/runtime.env -f deploy/compose.yml stop web gateway control-plane
```

网关收到 SIGTERM 后停止接受新请求，等待在途请求与结算、关闭日记写锁后退出；上限 40 秒，Compose 给 45 秒宽限。超过上限按中断退出，保留 fsync 日记供重启核对，不宣称完成结算。默认上游超时 30 秒；若另改超时，应同步评估停止窗口。

## 容器内备份

先按上面命令停止流量入口、网关与控制面，保留数据库可达。在已构建的运维镜像内运行：

```powershell
docker compose --project-name signal-atlas --env-file deploy/runtime.env -f deploy/compose.yml run --rm --no-deps operations scripts/backup.mjs backup --out /backups/atlas-20261019-001 --journal /journals/gateway-001
```

`/backups` 对应 `BACKUP_DIRECTORY`；`/journals/gateway-001` 对应本项目的原始网关卷。自定义日记子目录或多实例时，传入每个实例实际的目录并为运维容器挂载对应卷。目录锁只能识别本进程命名空间，所有实例停机是备份前提。

成功后再启动应用。原生归档、清单、来源信任、配置保管和失败处理的完整语义见 [备份与恢复](BACKUP-RESTORE.md)。运维镜像带 PostgreSQL 16 客户端，用于当前主版本 16 的交付检查；更换数据库主版本前验证客户端兼容性并更新工具镜像。

## 容器内恢复

使用独立干净目标数据库或尚无原 schema 的目标；保持应用停止。选择新的 Compose 项目名和新日记卷，配置目标连接与可信备份目录，先构建/加载运维镜像，再运行：

```powershell
docker compose --project-name signal-atlas-restored --env-file deploy/runtime.env -f deploy/compose.yml run --rm --no-deps operations scripts/backup.mjs restore --from /backups/atlas-20261019-001 --journal-root /journals/gateway-001/restored
```

将私有配置补上 `GATEWAY_JOURNAL_PATH=/var/lib/signal-atlas/journal/restored/gateway-001`，设置备份中的 `DATABASE_SCHEMA` 和同一安装模式，再按正常顺序启动。该路径是同一卷在网关容器内的映射；不要把运维容器的 `/journals/...` 直接填给网关。多个实例按输出一一映射。原有 schema、备份目标或恢复日记目标存在时会拒绝覆盖。

恢复后确认原账号登录、配置、余额、历史调用、outbox 补发，以及获授权的新请求。数据库恢复与日记目录移动不能跨系统原子提交；若提示数据库已恢复但日记仍在暂存目录，按 [失败处理](BACKUP-RESTORE.md) 保持停机并先修复目录位置。

## 离线内网交付

在可构建的机器构建三个镜像，按本次发布记录它们的镜像 ID；需要版本标签时在私有配置设置 `ATLAS_SERVER_IMAGE`、`ATLAS_WEB_IMAGE`、`ATLAS_OPERATIONS_IMAGE` 后构建。保存镜像：

```powershell
docker image save -o signal-atlas-images.tar signal-atlas-server:local signal-atlas-web:local signal-atlas-operations:local
```

把镜像归档、`deploy/compose.yml`、本操作说明和匹配版本的备份工具说明交付到目标；真实口令、证书与数据库配置通过受控方式单独提供。目标载入归档后运行同一 Compose 配置，使用 `up -d --wait --no-build --pull never`。初次安装直接使用空 schema；升级前执行备份与独立恢复演练。应用启动执行迁移，迁移失败拒绝运行；不使用旧版本覆盖已升级 schema 的迁移账本。

## 本机隔离检查

```powershell
pnpm check:containers
```

该命令为本次检查生成独立 Compose 项目、PostgreSQL 容器/卷、网关日记卷、随机端口和两天有效的 localhost 测试证书；Windows 需 PowerShell 7，其他系统需 OpenSSL。不会连接开发 `.env` 中的数据库、替换现有审查实例或改动证书信任库。HTTPS 请求使用生成证书作为显式 CA 校验，不全局关闭 TLS 校验。

检查包含空正式安装、安装口令、登录、原额度、非流式/SSE、容器重建，以及容器内原生备份恢复。默认清理本次专属容器、测试卷和运行目录；`pnpm check:containers -- --keep` 可保留成功的本地实验，输出账号和 `.runtime/container-check-<uuid>` 参数目录。此测试证书没有加入浏览器信任库，浏览器证书信任与企业证书安装仍须单独验收。

保留实验只用其输出的项目名、私有 env 文件和附加 Compose 文件停止；`down --volumes` 只用于确认可丢弃的这一测试项目，不能照搬到正式项目。构建过程与证据见 [19 项容器停止与恢复复核](VALIDATION-CONTAINERS-2026-10-20.md)，前一轮结果见 [18 项基础交付验证](VALIDATION-CONTAINERS-2026-10-19.md)。

依赖启动与流式代理行为依据 [Compose 健康依赖](https://docs.docker.com/compose/how-tos/startup-order/) 和 [Nginx proxy_buffering](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering)。这些配置不代表正式网络、厂商模型或高可用部署已经验收。
