import type { Role } from './platform.js';

export const ROLE_LABELS = {
  operator: '平台管理员',
  model_operator: '模型运维',
  finance_operator: '财务运营',
  auditor: '审计查看',
  employee: '员工',
} as const;

export const PERMISSIONS = {
  'administration.manage': '管理平台、人员与组织',
  'models.read': '查看供应商、模型与模型池',
  'models.write': '管理模型技术配置与路由',
  'pricing.write': '修改计价配置',
  'credentials.read': '查看上游凭据元数据',
  'credentials.write': '管理与轮换上游凭据',
  'verification.read': '查看接入验收结果',
  'verification.run': '执行模型接入验收',
  'routing.simulate': '执行路由试算',
  'monitoring.read': '查看运行监控与追溯',
  'monitoring.write': '配置告警与处理事件',
  'calls.read.all': '查看企业调用记录',
  'usage.read.all': '查看企业用量',
  'finance.read': '查看企业额度与财务明细',
  'finance.write': '管理额度与核对费用',
  'costs.read': '查看上游成本与计费倍率',
  'audit.read': '查看操作审计',
  'security.read': '查看安全策略与事件',
  'security.write': '修改安全策略',
} as const;

export type Permission = keyof typeof PERMISSIONS;
type Actor = { roles: readonly string[] };

const rolePermissions: Record<Exclude<Role, 'operator'>, readonly Permission[]> = {
  employee: [],
  model_operator: [
    'models.read', 'models.write', 'credentials.read', 'credentials.write',
    'verification.read', 'verification.run', 'routing.simulate',
    'monitoring.read', 'monitoring.write', 'calls.read.all', 'usage.read.all',
  ],
  finance_operator: [
    'models.read', 'pricing.write', 'verification.read', 'calls.read.all',
    'usage.read.all', 'finance.read', 'finance.write', 'costs.read',
  ],
  auditor: [
    'models.read', 'credentials.read', 'verification.read', 'monitoring.read',
    'calls.read.all', 'usage.read.all', 'finance.read', 'costs.read',
    'audit.read', 'security.read',
  ],
};

export function hasPermission(actor: Actor, permission: Permission): boolean {
  if (actor.roles.includes('operator')) return true;
  return actor.roles.some(role =>
    Object.hasOwn(rolePermissions, role) && rolePermissions[role as Exclude<Role, 'operator'>].includes(permission),
  );
}

export function actorPermissions(actor: Actor): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter(permission => hasPermission(actor, permission));
}

export function hasOperationsAccess(actor: Actor): boolean {
  return actor.roles.some(role => role !== 'employee' && Object.hasOwn(ROLE_LABELS, role));
}
