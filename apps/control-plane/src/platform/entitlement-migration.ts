import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Entitlement, EntitlementMigrationPreview, EntitlementMigrationRow, Plan, WorkspaceState } from '@ai-gateway/contracts';
import { availableModels, pick, strings, text } from './validation';

export const MAX_ENTITLEMENT_MIGRATION_ITEMS = 200;

export interface PreparedEntitlementMigration {
  plan: Plan;
  rows: EntitlementMigrationRow[];
  preview: EntitlementMigrationPreview;
}

/**
 * First release scope: move an existing entitlement of the same plan to the
 * plan's current version, without changing cadence. Cross-plan moves and
 * once/monthly conversion are intentionally unsupported, never silently
 * approximated.
 */
export function prepareEntitlementMigration(s: WorkspaceState, p: Record<string, unknown>): PreparedEntitlementMigration {
  const plan = pick(s.plans, p.planId, 'plan');
  if (!plan.active) throw new ConflictException('target plan is disabled');
  const ids = strings(p.entitlementIds, 'entitlementIds');
  if (!ids.length || ids.length > MAX_ENTITLEMENT_MIGRATION_ITEMS) throw new BadRequestException(`select between 1 and ${MAX_ENTITLEMENT_MIGRATION_ITEMS} entitlements`);
  const reason = text(p.reason, 'reason', 2000);
  const modelsAfter = availableModels(s, plan.range);
  const rows = ids.map(entitlementId => {
    const entitlement: Entitlement = pick(s.entitlements, entitlementId, 'entitlement');
    const member = s.members.find(value => value.id === entitlement.memberId);
    const modelsBefore = availableModels(s, entitlement.range);
    const base = {
      entitlementId: entitlement.id,
      memberId: entitlement.memberId,
      memberName: member?.name ?? entitlement.memberId,
      fromVersion: entitlement.planVersion,
      toVersion: plan.version,
      modelsAdded: modelsAfter.filter(modelId => !modelsBefore.includes(modelId)),
      modelsRemoved: modelsBefore.filter(modelId => !modelsAfter.includes(modelId)),
      amountBefore: entitlement.planSnapshot.amount,
      amountAfter: plan.amount,
      expiresAt: entitlement.expiresAt,
      periods: [...entitlement.periods],
      limitsBefore: entitlement.planSnapshot.limits,
      limitsAfter: plan.limits,
      affectedKeyIds: s.keys.filter(key => !key.internal && key.subjectType === 'employee' && key.subjectId === entitlement.memberId && key.purpose === 'personal').map(key => key.id),
    };
    if (entitlement.planId !== plan.id) return { ...base, status: 'inapplicable' as const, reason: '跨方案迁移不在首版范围；请在原方案内迁移到当前版本' };
    if (entitlement.status !== 'active' || Date.parse(entitlement.expiresAt) <= Date.now()) return { ...base, status: 'inapplicable' as const, reason: '权益已吊销或到期，不能迁移' };
    if (entitlement.planSnapshot.cadence !== plan.cadence) return { ...base, status: 'inapplicable' as const, reason: '一次性与月度发放不能互转' };
    if (entitlement.planVersion === plan.version) return { ...base, status: 'skip' as const, reason: '已是目标版本' };
    return { ...base, status: 'change' as const, reason: '更新版本、快照与模型范围；不补发额度' };
  });
  const preview: EntitlementMigrationPreview = {
    planId: plan.id,
    planName: plan.name,
    planVersion: plan.version,
    cadence: plan.cadence,
    reason,
    rows,
    changedCount: rows.filter(row => row.status === 'change').length,
    skippedCount: rows.filter(row => row.status === 'skip').length,
    inapplicableCount: rows.filter(row => row.status === 'inapplicable').length,
    noBackfill: true,
  };
  return { plan, rows, preview };
}
