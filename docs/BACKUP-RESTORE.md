# 备份与恢复

备份包含指定 PostgreSQL schema 的原生归档，以及每个网关实例的结算日记；恢复后继续使用原账本、会话和密钥。命令不会覆盖已有备份、schema 或日记目标。先在隔离环境完成演练，再安排正式停机窗口。

## 准备与停机

1. 使用同一发布版本，确认 `DATABASE_URL` 指向本次操作的数据库。脚本优先读取进程环境，其次私下读取 `apps/control-plane/.env`，不会打印连接串。备份还必须显式提供 `DATABASE_SCHEMA`；开发默认 schema 也需要明确填写。
2. 安装与服务器兼容的 PostgreSQL `pg_dump` / `pg_restore` 客户端，加入 `PATH` 或把 `PG_BIN` 设为其绝对目录。Windows 官方下载页提供 EDB 的便携二进制包。本机隔离检查使用 `.runtime/pg-client-16.15/bin`，它属于本机工具，不是发布包依赖或数据库服务安装。
3. 暂停入口流量，停止所有网关，再停止控制面。核对每个实例实际使用的 `GATEWAY_JOURNAL_DIR`，包括空日记目录。不要使用另一个实例的空目录替代，也不要手工删除尚在运行实例的 `writer.lock`。
4. 准备新备份目录和足够磁盘空间。目标必须位于全部日记目录之外。

脚本会拒绝存活的本机日记写进程，并在备份期间持有各日记写锁和数据库表的共享锁；迁移锁与一致性快照确保归档不跨越一次迁移。它不能发现未提供的实例或另一台主机的写进程；停机与完整列举日记目录由执行人负责。五秒内无法取得数据库锁会失败。

## 创建备份

在项目根目录运行，例如一个网关实例：

```powershell
$env:PG_BIN = 'C:\PostgreSQL\16\bin'
$env:DATABASE_SCHEMA = 'signal_atlas'
pnpm backup -- --out 'D:\Backups\atlas-20261019-001' --journal 'D:\AtlasData\gateway-001'
```

多个实例追加 `--journal <目录>`；目录顺序对应恢复后的 `gateway-001`、`gateway-002` 等。命令成功后，备份目录中包含：

- `platform.dump`：`pg_dump --format=custom` 原生 schema 归档。
- `journals/gateway-*/`：包括已准入、已分派、待补发和 blocked 事件；空实例仍有目录记录。
- `manifest.json`：安装模式、schema、迁移版本/摘要、日记数量/阶段，以及各文件大小与 SHA-256。

出现“Backup completed”才算成功；失败留下的目录不能当作完成的备份，检查后使用新的目标重试。命令结束会释放自己的锁，不会删除源 schema 或日记。

备份中含密码散列、会话、业务配置、额度和调用元数据，按业务数据保护。它不包含 `.env`、TLS 证书、模型服务凭据的外部配置、数据库全局角色/权限或操作系统服务配置。为外部依赖另存受控配置，不把它们打印到操作日志。schema 外的扩展/依赖须由目标数据库预先提供。

## 恢复到干净目标

使用可信、同一发布版本生成的备份。清单校验检查损坏和路径，不能代替来源认证；不要恢复未知来源的 PostgreSQL 归档。

1. 目标数据库必须可连接，且备份中同名 schema **尚不存在**。脚本不改名、不删除现有 schema；已有数据时选择独立目标数据库。恢复账号须有建 schema/对象权限，目标账号承担恢复后的对象所有权。
2. 将进程 `DATABASE_URL` 或受控 `.env` 指向目标数据库，准备一个不存在的日记根目录。不要启动网关或控制面。
3. 执行：

```powershell
pnpm restore -- --from 'D:\Backups\atlas-20261019-001' --journal-root 'D:\AtlasData\restored-journals'
```

脚本先核验清单、文件摘要和日记身份，再在目标旁暂存日记，随后使用 `pg_restore --single-transaction --exit-on-error --no-owner --no-acl` 恢复，最后把暂存日记目录移到指定位置。连接口令不会放进进程命令参数。

4. 根据输出，将每个实例的 `GATEWAY_JOURNAL_DIR` 分别指向 `restored-journals/gateway-001` 等对应目录；设置备份中相同的 `DATABASE_SCHEMA` 和 `PLATFORM_MODE`，重新提供服务/安装口令和外部配置。先启动控制面，再启动网关，最后开放入口。
5. 确认登录、组织/模型配置、余额、历史调用以及网关 `/health` 的 outbox 状态。待补发事件可在网关启动时继续结算，blocked / pending_review 仍需按原业务处理，不能靠删除日记“清零”。正式模型调用另按运行授权执行。

PostgreSQL 与文件系统没有跨系统原子提交。数据库恢复失败时，单事务回滚数据库更改，错误显示保留的 `.pending-<uuid>` 日记位置；保留备份，排除原因后使用新的日记目标重试。若数据库已恢复但最终目录移动失败，错误会明确提示 “Database restored”；保持服务停止，将提示的暂存目录移到计划的目标，核对后再启动。此时不要再次恢复覆盖数据库，也不要先启动空日记实例。

## 可重复验证

```powershell
$env:PG_BIN = (Resolve-Path '.runtime/pg-client-16.15/bin').Path
pnpm check:backup
```

该检查构建后只使用自动生成的 `agp_check_<uuid>` schema、本地模型替身和专属运行目录；备份后把原 schema 改名保留，再恢复到原名。检查恢复后的登录会话、配置、迁移历史、原余额、待结算事件恰好记账一次和原密钥新调用，结束后停止自己的进程并清理自己的 schema/目录。不会覆盖共享开发数据或人工审查实例。证据见 [备份恢复验证](VALIDATION-BACKUP-2026-10-19.md)。

原生命令语义与 schema 依赖边界见 PostgreSQL 官方 [pg_dump](https://www.postgresql.org/docs/16/app-pgdump.html)、[pg_restore](https://www.postgresql.org/docs/16/app-pgrestore.html)；Windows 客户端来源见 [官方下载入口](https://www.postgresql.org/download/windows/)。本地原生恢复不代表异地灾备、整机断电、存储损坏或正式部署已经验收。
