import { beforeEach, describe, expect, it } from 'vitest';
import type { EntitlementMigrationPreview, EntitlementMigrationResult, PlatformCommand } from '@ai-gateway/contracts';
import { DemoStore } from '../store/demo.store';
import { WorkspaceRepository } from './workspace.repository';
import { PlatformService } from './platform.service';

const operator = 'operator-demo-001', employee = 'employee-demo-001';
const modelRange = { poolId: 'pool-local-test', mode: 'follow' as const, definitionIds: [] };
const future = () => new Date(Date.now() + 86400000 * 7).toISOString();

describe('entitlement version migration', () => {
  let ledger: DemoStore, repository: WorkspaceRepository, platform: PlatformService;
  async function command(type: string, payload: Record<string, unknown>, actor = operator, key = crypto.randomUUID()) {
    const c: PlatformCommand = { type, payload, idempotencyKey: key };
    const preview = await platform.preview(actor, c);
    c.previewToken = preview.previewToken;
    return (await platform.execute(actor, c)).result as any;
  }
  beforeEach(async () => {
    ledger = new DemoStore();
    repository = new WorkspaceRepository(ledger);
    await repository.initialize();
    platform = new PlatformService(repository, ledger);
    await repository.transact(async tx => { tx.state.services[0].verification = 'passed'; });
    await command('save.pool', { id: 'pool-local-test', name: '办公池', entries: [{ definitionId: 'definition-test-model', serviceId: 'service-local-test', open: true }] });
  });
  async function plan(cadence: 'once' | 'monthly' = 'monthly', amount = 10) {
    return command('save.plan', { name: '办公方案', range: modelRange, amount, cadence, quotaDays: 30, entitlementDays: 365 });
  }
  async function onboard(cadence: 'once' | 'monthly' = 'monthly') {
    const created = await plan(cadence);
    await command('distribution.execute', { planId: created.id, memberIds: [employee] });
    const entitlement = (await repository.read()).entitlements.find(e => e.memberId === employee && e.planId === created.id)!;
    return { plan: created, entitlement };
  }
  const migration = (planId: string, entitlementIds: string[], reason = '统一到当前方案版本') => ({ planId, entitlementIds, reason });

  it('updates version, snapshot, range and limits without touching money, expiry or periods', async () => {
    const { plan: created, entitlement } = await onboard();
    const beforeBatches = (await repository.view()).batches.filter(b => b.entitlementId === entitlement.id);
    const updated = await command('save.plan', { id: created.id, name: '办公方案', range: modelRange, amount: 20, cadence: 'monthly', quotaDays: 30, entitlementDays: 365, limits: { mode: 'custom', rpm: 11 } });
    expect(updated.version).toBe(2);

    const preview = await platform.preview(operator, { type: 'entitlements.migrate', idempotencyKey: crypto.randomUUID(), payload: migration(created.id, [entitlement.id]) });
    const impact = preview.impact.entitlementMigration as EntitlementMigrationPreview;
    expect(impact.noBackfill).toBe(true);
    expect(impact.changedCount).toBe(1);
    expect(impact.rows[0]).toMatchObject({ status: 'change', fromVersion: 1, toVersion: 2, amountBefore: 10, amountAfter: 20 });

    const result = await command('entitlements.migrate', migration(created.id, [entitlement.id])) as EntitlementMigrationResult;
    expect(result.migratedIds).toEqual([entitlement.id]);
    expect(result.noBackfill).toBe(true);
    const migrated = (await repository.read()).entitlements.find(e => e.id === entitlement.id)!;
    expect(migrated.planVersion).toBe(2);
    expect(migrated.planSnapshot.amount).toBe(20);
    expect(migrated.planSnapshot.limits.rpm).toBe(11);
    expect(migrated.range).toEqual(modelRange);
    expect(migrated.grantedAt).toBe(entitlement.grantedAt);
    expect(migrated.expiresAt).toBe(entitlement.expiresAt);
    expect(migrated.periods).toEqual(entitlement.periods);
    expect(migrated.futureGrants).toBe(entitlement.futureGrants);
    expect(migrated.source).toBe(entitlement.source);

    const afterBatches = (await repository.view()).batches.filter(b => b.entitlementId === entitlement.id);
    expect(afterBatches).toEqual(beforeBatches);
    await command('periodic.run', {});
    expect((await repository.view()).batches.filter(b => b.entitlementId === entitlement.id)).toEqual(beforeBatches);
    expect((await repository.read()).audit.filter(a => a.action === 'entitlement.migrated')).toHaveLength(1);
  });

  it('rejects cross-plan moves, cadence conversion and revoked entitlements at execution', async () => {
    const { plan: first, entitlement } = await onboard('monthly');
    const other = await plan('monthly');
    const crossPlan = await platform.preview(operator, { type: 'entitlements.migrate', idempotencyKey: crypto.randomUUID(), payload: migration(other.id, [entitlement.id]) });
    expect((crossPlan.impact.entitlementMigration as EntitlementMigrationPreview).inapplicableCount).toBe(1);
    await expect(command('entitlements.migrate', migration(other.id, [entitlement.id]))).rejects.toThrow('no longer applicable');

    // Changing the same plan's cadence is the actual once/monthly conversion guard.
    await command('save.plan', { id: first.id, name: '办公方案', range: modelRange, amount: 20, cadence: 'once', quotaDays: 30, entitlementDays: 365 });
    const cadence = await platform.preview(operator, { type: 'entitlements.migrate', idempotencyKey: crypto.randomUUID(), payload: migration(first.id, [entitlement.id]) });
    expect((cadence.impact.entitlementMigration as EntitlementMigrationPreview).rows[0].reason).toContain('一次性与月度');
    await expect(command('entitlements.migrate', migration(first.id, [entitlement.id]))).rejects.toThrow('no longer applicable');

    await command('entitlement.revoke', { id: entitlement.id, reason: '审查案例' });
    await command('save.plan', { id: first.id, name: '办公方案', range: modelRange, amount: 20, cadence: 'monthly', quotaDays: 30, entitlementDays: 365 });
    const revoked = await platform.preview(operator, { type: 'entitlements.migrate', idempotencyKey: crypto.randomUUID(), payload: migration(first.id, [entitlement.id]) });
    expect((revoked.impact.entitlementMigration as EntitlementMigrationPreview).rows[0].status).toBe('inapplicable');
  });

  it('skips entitlements already on the target version and replays idempotently', async () => {
    const { plan: created, entitlement } = await onboard();
    await command('save.plan', { id: created.id, name: '办公方案', range: modelRange, amount: 20, cadence: 'monthly', quotaDays: 30, entitlementDays: 365 });
    const key = 'migration-fixed-key';
    const payload = migration(created.id, [entitlement.id]);
    const c: PlatformCommand = { type: 'entitlements.migrate', payload, idempotencyKey: key };
    const preview = await platform.preview(operator, c);
    const first = await platform.execute(operator, { ...c, previewToken: preview.previewToken });
    const second = await platform.execute(operator, { ...c, previewToken: preview.previewToken });
    expect(second.replayed).toBe(true);
    expect(second.result).toEqual(first.result);

    const again = await platform.preview(operator, { type: 'entitlements.migrate', idempotencyKey: crypto.randomUUID(), payload });
    expect((again.impact.entitlementMigration as EntitlementMigrationPreview).skippedCount).toBe(1);
    const skipped = await command('entitlements.migrate', payload) as EntitlementMigrationResult;
    expect(skipped.migratedIds).toEqual([]);
    expect(skipped.skippedIds).toEqual([entitlement.id]);
    expect((await repository.read()).audit.filter(a => a.action === 'entitlement.migrated')).toHaveLength(1);
  });

  it('requires a fresh preview when the plan or workspace changed', async () => {
    const { plan: created, entitlement } = await onboard();
    await command('save.plan', { id: created.id, name: '办公方案', range: modelRange, amount: 20, cadence: 'monthly', quotaDays: 30, entitlementDays: 365 });
    const c: PlatformCommand = { type: 'entitlements.migrate', payload: migration(created.id, [entitlement.id]), idempotencyKey: 'stale-preview-key' };
    const preview = await platform.preview(operator, c);
    await command('settings.update', { name: '已更新的工作空间' });
    await expect(platform.execute(operator, { ...c, previewToken: preview.previewToken })).rejects.toThrow('stale');
  });

  it('keeps migration operator-only', async () => {
    const { plan: created, entitlement } = await onboard();
    await command('save.plan', { id: created.id, name: '办公方案', range: modelRange, amount: 20, cadence: 'monthly', quotaDays: 30, entitlementDays: 365 });
    await expect(platform.preview(employee, { type: 'entitlements.migrate', idempotencyKey: crypto.randomUUID(), payload: migration(created.id, [entitlement.id]) })).rejects.toThrow();
  });

  it('keeps an unused future budget path intact', async () => {
    // Guard against accidentally routing migration through project funding primitives.
    const { plan: created, entitlement } = await onboard('once');
    const batchesBefore = (await repository.view()).budgets;
    await command('save.plan', { id: created.id, name: '办公方案', range: modelRange, amount: 20, cadence: 'once', quotaDays: 30, entitlementDays: 365 });
    await command('entitlements.migrate', migration(created.id, [entitlement.id]));
    expect((await repository.view()).budgets).toEqual(batchesBefore);
    expect(future()).toBeTruthy();
  });
});
