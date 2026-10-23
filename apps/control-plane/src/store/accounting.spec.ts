import { describe, expect, it } from 'vitest';
import { DemoStore } from './demo.store';
import type { AuthorizeRequest, SettlementRequest } from '@ai-gateway/contracts';

async function input(store: DemoStore, key = 'local-employee-key'): Promise<AuthorizeRequest> {
  const credential = (await store.getDemoCredential(key))!;
  return { requestId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), identity: credential.identity,
    purpose: credential.purpose, modelId: 'test-model', mode: 'chat', policyVersion: 'policy-local-1' };
}

describe('quota isolation and settlement invariants', () => {
  it('does not use personal or another project balance when this project is exhausted', async () => {
    const store = new DemoStore();
    const batch = store.quotaBatches.get('project-member-batch-demo-001')!;
    batch.availableAmount = 0;
    store.quotaBatches.set('other-project', { ...batch, id: 'other-project', projectId: 'another-project', availableAmount: 100 });
    expect((await store.authorize(await input(store, 'local-project-key'))).reasonCode).toBe('quota_insufficient');
    expect((await store.getQuota()).availableAmount).toBe(10);
    expect(store.quotaBatches.get('other-project')!.availableAmount).toBe(100);
  });

  it('uses the next funded batch when an earlier batch is exhausted', async () => {
    const store = new DemoStore();
    const first = store.quotaBatches.get('personal-batch-demo-001')!;
    first.availableAmount = 0;
    store.quotaBatches.set('next-batch', { ...first, id: 'next-batch', availableAmount: 1 });
    expect((await store.authorize(await input(store))).reservation?.sourceId).toBe('next-batch');
  });

  it('retains unknown usage for review and preserves its state on retries', async () => {
    const store = new DemoStore(); const request = await input(store); const auth = await store.authorize(request);
    const settlement: SettlementRequest = { requestId: request.requestId, idempotencyKey: crypto.randomUUID(),
      reservationId: auth.reservation!.reservationId, outcome: 'client_cancelled', completedAt: new Date().toISOString(), usageFinal: false };
    expect((await store.settle(settlement)).status).toBe('pending_review');
    expect((await store.settle(settlement)).billableState).toBe('pending_review');
    expect((await store.getQuota()).availableAmount).toBe(9.98);
    expect(await store.listCalls()).toHaveLength(1);
  });

  it('keeps denied authorizations idempotent even after permissions change', async () => {
    const store = new DemoStore(); const request = await input(store); request.modelId = 'not-open';
    expect((await store.authorize(request)).decision).toBe('deny');
    store.credentials.get('local-employee-key')!.modelIds.push('not-open');
    expect(await store.authorize(request)).toMatchObject({ decision: 'deny', replayed: true });
    expect((await store.getQuota()).availableAmount).toBe(10);
  });
});
