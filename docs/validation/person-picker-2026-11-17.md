# 统一人员选择器验证（2026-11-17）

已实现共享 `PersonPicker` 和 `Field type="person"`，单选 / 多选复用同一套组织、候选、已选面板。桌面三栏，390px 全屏分区。候选展示姓名、登录账号、完整组织路径、人员类别、有效期与不可用原因；预览和回执保留身份信息。

首批接入：为人员开通、批量方案开通 / 追加、项目成员添加、项目额度分配、项目经理、应用负责人、外部协作的内部责任人，以及审批中的建议 / 确认负责人字段。通用模型、套餐和职责多选仍使用 `MultiSelect`。

## 查询与权限

- `/api/v1/platform/people/query`：姓名 / 账号 / 组织路径搜索，组织与下级、类别筛选，人员分页，按 ID 解析原有选择；默认每页 40，最多 100，最多选择 / 解析 1000 人。
- `/api/v1/platform/people/organizations`：逐级加载组织、组织路径搜索，分页返回。
- 开通与内部责任人要求对应运营权限；项目成员与分配要求项目经理 / 运营权限，项目分配仅返回当前项目成员；普通查询沿用现有同项目人员可见范围。身份投影不含密码、职责或凭据。
- 搜索、翻页、组织切换保留选择；取消不回填。确认前重新读取所选 ID 并核验可选性，失效人员必须移除。选择本身不写成员关系、不发额度。
- 后端沿用当前 workspace JSON 存储，仅读取成员、组织、项目三个相关字段后筛选分页；没有引入组织目录服务或数据库索引查询。原有管理员全量业务快照尚未改造，本次不宣称已完成海量目录存储优化。

## 本地验证

- Contracts / Control Plane 构建通过，Web typecheck / build 通过。Vite 保留已有 bundle 大小提示。
- Control Plane：52 个测试文件、338 项通过，其中新增 6 项人员分页、同名区分、完整路径、可见范围、项目权限、失效 / 循环组织与输入边界测试。
- `node scripts/check-web.mjs --person-picker-only --postgres`：36 项浏览器断言通过。覆盖同名不同账号、服务端分页、组织逐级展开、跨页保留、键盘选择、取消回填、确认前停用、查询失败重试、必填校验、嵌套 Escape / Tab、项目成员实际添加、额度分配候选与预览、五种界面和 1440 / 390 尺寸。
- `node scripts/check-web.mjs --onboarding-plans-only --postgres`：35 项通过，包含选择人员后创建 / 修正方案、草稿与预览保留。
- `node scripts/check-web.mjs --quota-p0-only --postgres`：70 项浏览器断言通过，包含项目经理选择、应用负责人交接与额度流程；同时通过现有 62 项 SQL 用量分析与 HTTP 权限核对。
- 浏览器使用自动化专属 Chrome profile、回环模型替身、临时端口和独立 PostgreSQL schema；运行后清理专属进程、目录与 schema，没有操作日常业务数据或外部模型。

截图与机器断言：

- [人员选择](screenshots-2026-11-17-person-picker/browser.json)
- [1440px](screenshots-2026-11-17-person-picker/person-picker-1440.png)、[390px](screenshots-2026-11-17-person-picker/person-picker-390.png)
- [开通回归](screenshots-2026-11-17-person-picker-onboarding/browser.json)
- [额度与交接回归](screenshots-2026-11-17-person-picker-quota/browser.json)

日常环境已通过同一 `pnpm dev` 入口重启，入口 `http://localhost:5176/`，四项 HTTP 健康检查为 200。继续使用原 `.runtime/review-postgres.json` 的工作区与 PostgreSQL schema，保留原外部调用 opt-in。未发布生产环境。
