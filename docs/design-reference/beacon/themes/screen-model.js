/* 24 屏唯一真相：浏览器与 Node 共用（门禁脚本 require 同一份文件）。 */
const SCREEN_MODEL = {
  "version": 1,
  "note": "24 屏的跨主题唯一真相：标题、副标题、角色、空态文案与存量主题的回退导航。主题只负责呈现，不得改写这些字段。",
  "roles": {
    "employee": {
      "label": "员工 · 陈默",
      "nav": [
        [
          "home",
          "工作台"
        ],
        [
          "use",
          "在线使用"
        ],
        [
          "quota",
          "我的额度"
        ],
        [
          "models",
          "可用模型"
        ],
        [
          "requests",
          "我的申请"
        ],
        [
          "logs",
          "调用日志"
        ],
        [
          "myProjects",
          "我的项目"
        ],
        [
          "keys",
          "接入与凭证"
        ]
      ]
    },
    "manager": {
      "label": "经理 · 赵宁",
      "nav": [
        [
          "home",
          "工作台"
        ],
        [
          "projects",
          "项目管理"
        ],
        [
          "allocate",
          "分配额度"
        ],
        [
          "approvals",
          "审批中心"
        ],
        [
          "apply",
          "申请额度"
        ],
        [
          "budgetApply",
          "申请项目总额度"
        ],
        [
          "requests",
          "我的申请"
        ],
        [
          "myProjects",
          "我的项目"
        ],
        [
          "logs",
          "调用日志"
        ]
      ]
    },
    "ops": {
      "label": "运营 · 林晓",
      "nav": [
        [
          "overview",
          "运营总览"
        ],
        [
          "approvals",
          "审批中心"
        ],
        [
          "members",
          "成员与权益"
        ],
        [
          "plans",
          "开通方案"
        ],
        [
          "catalog",
          "模型目录"
        ],
        [
          "services",
          "模型服务"
        ],
        [
          "pools",
          "模型池"
        ],
        [
          "projects",
          "项目与发放"
        ],
        [
          "projectNew",
          "创建项目"
        ],
        [
          "projectGrant",
          "发放总额度"
        ],
        [
          "request",
          "申请详情"
        ]
      ]
    }
  },
  "screens": [
    {
      "id": "home",
      "title": "工作台",
      "sub": "当前用途、余额与下一步。",
      "empty": "还没有可用用途，先申请开通模型与额度。",
      "legacyNav": "home"
    },
    {
      "id": "use",
      "title": "在线使用",
      "sub": "确认扣费用途与模型后发送。",
      "empty": "当前用途没有可用模型。",
      "legacyNav": "use"
    },
    {
      "id": "quota",
      "title": "我的额度",
      "sub": "按用途查看余额与批次。",
      "empty": "当前没有任何有效额度批次。",
      "legacyNav": "quota"
    },
    {
      "id": "models",
      "title": "可用模型",
      "sub": "按用途查看已开放的模型。",
      "empty": "当前用途没有已开放模型。",
      "legacyNav": "models"
    },
    {
      "id": "requests",
      "title": "我的申请",
      "sub": "申请状态与审批人。",
      "empty": "还没有发起过申请。",
      "legacyNav": "requests"
    },
    {
      "id": "request",
      "title": "申请详情",
      "sub": "查看金额、来源与处理结果。",
      "empty": "没有选中的申请。",
      "legacyNav": "requests"
    },
    {
      "id": "logs",
      "title": "调用日志",
      "sub": "按用途追溯每次调用。",
      "empty": "还没有调用记录。",
      "legacyNav": "logs"
    },
    {
      "id": "result",
      "title": "调用结果",
      "sub": "本次扣费与来源。",
      "empty": "没有可查看的调用结果。",
      "legacyNav": "logs"
    },
    {
      "id": "myProjects",
      "title": "我的项目",
      "sub": "已加入的项目与项目内额度。",
      "empty": "还没有加入任何项目。",
      "legacyNav": "myProjects"
    },
    {
      "id": "keys",
      "title": "接入与凭证",
      "sub": "凭证绑定用途，与在线使用共享额度。",
      "empty": "还没有凭证。",
      "legacyNav": "keys"
    },
    {
      "id": "projects",
      "title": "项目管理",
      "sub": "总额度、批次与成员分配。",
      "empty": "还没有可管理的项目。",
      "legacyNav": "projects"
    },
    {
      "id": "allocate",
      "title": "分配额度",
      "sub": "从项目批次分配到成员。",
      "empty": "没有可分配的项目批次。",
      "legacyNav": "projects"
    },
    {
      "id": "apply",
      "title": "申请额度",
      "sub": "说明用途与金额，由对应负责人审批。",
      "empty": "当前没有可申请的用途。",
      "legacyNav": "home"
    },
    {
      "id": "budgetApply",
      "title": "申请项目总额度",
      "sub": "批准后进入项目批次，不直接到成员。",
      "empty": "没有可申请的项目。",
      "legacyNav": "projects"
    },
    {
      "id": "approvals",
      "title": "审批中心",
      "sub": "待处理与已处理申请。",
      "empty": "当前没有待处理申请。",
      "legacyNav": "approvals"
    },
    {
      "id": "overview",
      "title": "运营总览",
      "sub": "待办、资金口径与资源概况。",
      "empty": "今天没有待处理申请。",
      "legacyNav": "overview"
    },
    {
      "id": "members",
      "title": "成员与权益",
      "sub": "成员已开通的方案与模型范围。",
      "empty": "还没有成员开通记录。",
      "legacyNav": "members"
    },
    {
      "id": "plans",
      "title": "开通方案",
      "sub": "把模型范围与额度规则保存为方案。",
      "empty": "还没有开通方案。",
      "legacyNav": "plans"
    },
    {
      "id": "catalog",
      "title": "模型目录",
      "sub": "可用于开通的模型定义。",
      "empty": "还没有模型定义。",
      "legacyNav": "services"
    },
    {
      "id": "services",
      "title": "模型服务",
      "sub": "上游接入、验证状态与启停。",
      "empty": "还没有配置模型服务。",
      "legacyNav": "services"
    },
    {
      "id": "serviceEdit",
      "title": "接入与验证",
      "sub": "修改连接与模型映射前先确认影响。",
      "empty": "没有要编辑的服务。",
      "legacyNav": "services"
    },
    {
      "id": "pools",
      "title": "模型池",
      "sub": "按用途组织模型，变更前确认影响。",
      "empty": "还没有模型池。",
      "legacyNav": "pools"
    },
    {
      "id": "projectNew",
      "title": "创建项目",
      "sub": "指定经理与模型范围。",
      "empty": "没有可创建项目的前提。",
      "legacyNav": "projects"
    },
    {
      "id": "projectGrant",
      "title": "发放项目总额度",
      "sub": "进入项目批次，成员之后按需分配。",
      "empty": "没有可发放的项目。",
      "legacyNav": "projects"
    }
  ]
};

globalThis.SCREEN_MODEL = SCREEN_MODEL;
if (globalThis.process && globalThis.process.versions && globalThis.process.versions.node) {
  module.exports = SCREEN_MODEL;
}
