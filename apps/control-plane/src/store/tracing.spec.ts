import { describe, expect, it } from 'vitest';
import type { AuthorizeRequest, SettlementRequest } from '@ai-gateway/contracts';
import { isRequestReference, readUpstreamRequestId } from '@ai-gateway/contracts';
import { DemoStore } from './demo.store';
import { authorizationFingerprint, retryLinkAllowed } from './accounting';

const storeSetup = () => {
  const store = new DemoStore();
  const identity = store.credentials.get('local-employee-key')!.identity;
  const request = (overrides: Partial<AuthorizeRequest> = {}): AuthorizeRequest => ({
    requestId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), identity,
    purpose: 'personal', modelId: 'test-model', mode: 'chat', policyVersion: 'tracing-1', ...overrides,
  });
  const settlement = (requestId: string, reservationId: string, overrides: Partial<SettlementRequest> = {}): SettlementRequest => ({
    requestId, idempotencyKey: `${requestId}:settlement`, reservationId, outcome: 'completed', forwarded: true,
    usageFinal: true, inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, completedAt: new Date().toISOString(), ...overrides,
  });
  return { store, identity, request, settlement };
};

describe('explicit retry tracing', () => {
  it('keeps the pre-tracing fingerprint for requests without a retry link', () => {
    const { request } = storeSetup();
    const input = request({ requestId: 'req-a', idempotencyKey: 'key-a', estimatedInputTokens: 3, maxOutputTokens: 7 });
    const legacy = JSON.stringify([input.identity.subjectType, input.identity.subjectId, input.identity.credentialId,
      input.identity.organizationId ?? null, input.identity.projectId ?? null, input.purpose, input.modelId, input.mode,
      input.policyVersion, 3, 7, null, null]);
    expect(authorizationFingerprint(input)).toBe(legacy);
    const linked = authorizationFingerprint({ ...input, retryOfRequestId: 'req-original' });
    expect(linked).not.toBe(legacy);
    expect(JSON.parse(linked)[0]).toBe('retry-v1');
    expect(JSON.parse(linked).at(-1)).toBe('req-original');
  });

  it('rejects self references and malformed references', () => {
    const { request } = storeSetup();
    expect(() => authorizationFingerprint(request({ requestId: 'req-self', retryOfRequestId: 'req-self' }))).toThrow();
    expect(() => authorizationFingerprint(request({ retryOfRequestId: 'bad\nvalue' }))).toThrow();
    expect(() => authorizationFingerprint(request({ retryOfRequestId: 'x'.repeat(161) }))).toThrow();
  });

  it('reads only supported upstream request headers, in order, with validation', () => {
    expect(readUpstreamRequestId(new Headers({ 'request-id': 'secondary', 'x-request-id': 'primary' }))).toBe('primary');
    expect(readUpstreamRequestId(new Headers({ 'request-id': 'secondary' }))).toBe('secondary');
    expect(readUpstreamRequestId(new Headers({}))).toBeNull();
    expect(readUpstreamRequestId(new Headers({ 'x-request-id': 'bad\u0001value' }))).toBeNull();
    expect(readUpstreamRequestId(new Headers({ 'x-request-id': 'x'.repeat(161), 'request-id': 'fallback' }))).toBe('fallback');
    expect(isRequestReference('opaque-reference')).toBe(true);
    expect(isRequestReference('')).toBe(false);
  });

  it('links a retry to the earlier call and persists ids in logs and reservations', async () => {
    const { store, request, settlement } = storeSetup();
    const first = await store.authorize(request({ requestId: 'req-original', idempotencyKey: 'key-original' }));
    expect(first.decision).toBe('allow');
    const retry = await store.authorize(request({ requestId: 'req-retry', idempotencyKey: 'key-retry', retryOfRequestId: 'req-original' }));
    expect(retry.decision).toBe('allow');
    await store.settle(settlement('req-retry', retry.reservation!.reservationId, { upstreamRequestId: 'upstream-42' }));
    await store.settle(settlement('req-original', first.reservation!.reservationId, { upstreamRequestId: 'upstream-41' }));

    const retryLog = await store.getCall('req-retry');
    expect(retryLog?.retryOfRequestId).toBe('req-original');
    expect(retryLog?.upstreamRequestId).toBe('upstream-42');
    const relations = await store.relatedCalls('req-original', null);
    expect(relations.original?.requestId).toBe('req-original');
    expect(relations.retries.map(log => log.requestId)).toEqual(['req-retry']);
  });

  it('refuses missing, cross-subject, cross-project and cross-purpose links with one error', async () => {
    const { store, request } = storeSetup();
    await store.authorize(request({ requestId: 'req-personal', idempotencyKey: 'key-personal' }));
    await expect(store.authorize(request({ requestId: 'req-retry', idempotencyKey: 'key-retry', retryOfRequestId: 'req-nope' })))
      .rejects.toThrow('retry reference is not available');
    await expect(store.authorize(request({ requestId: 'req-retry-2', idempotencyKey: 'key-retry-2', retryOfRequestId: 'req-personal', identity: { ...store.credentials.get('local-employee-key')!.identity, subjectId: 'someone-else' } })))
      .rejects.toThrow('retry reference is not available');
    await expect(store.authorize(request({ requestId: 'req-retry-3', idempotencyKey: 'key-retry-3', retryOfRequestId: 'req-personal', purpose: 'project' })))
      .rejects.toThrow('retry reference is not available');
    const projectCredential = store.credentials.get('local-project-key')!;
    await expect(store.authorize(request({ requestId: 'req-retry-4', idempotencyKey: 'key-retry-4', retryOfRequestId: 'req-personal', identity: projectCredential.identity, purpose: 'project' })))
      .rejects.toThrow('retry reference is not available');
  });

  it('does not authorize an unlinked retry as a replay of the original key', async () => {
    const { store, request } = storeSetup();
    await store.authorize(request({ requestId: 'req-1', idempotencyKey: 'shared-key' }));
    const different = await store.authorize(request({ requestId: 'req-2', idempotencyKey: 'shared-key' }));
    expect(different.replayed).toBe(true);
    const retry = await store.authorize(request({ requestId: 'req-3', idempotencyKey: 'other-key', retryOfRequestId: 'req-1' }));
    expect(retry.replayed).toBeUndefined();
    expect(retry.reservation?.reservationId).toBeTruthy();
  });

  it('enforces related-call read scope instead of returning other subjects', async () => {
    const { store, identity, request, settlement } = storeSetup();
    const original = await store.authorize(request({ requestId: 'scoped-original', idempotencyKey: 'scoped-1' }));
    const retry = await store.authorize(request({ requestId: 'scoped-retry', idempotencyKey: 'scoped-2', retryOfRequestId: 'scoped-original' }));
    await store.settle(settlement('scoped-retry', retry.reservation!.reservationId));
    await store.settle(settlement('scoped-original', original.reservation!.reservationId));
    const other = await store.relatedCalls('scoped-original', { employeeId: 'another-member', applicationIds: [] });
    expect(other).toEqual({ original: null, retries: [] });
    const own = await store.relatedCalls('scoped-original', { employeeId: identity.subjectId, applicationIds: [] });
    expect(own.retries).toHaveLength(1);
  });

  it('rejects malformed upstream request identifiers at settlement', async () => {
    const { store, request, settlement } = storeSetup();
    const allowed = await store.authorize(request({ requestId: 'req-bad-upstream', idempotencyKey: 'key-bad-upstream' }));
    await expect(store.settle(settlement('req-bad-upstream', allowed.reservation!.reservationId, { upstreamRequestId: 'bad\nid' }))).rejects.toThrow();
  });

  it('keeps retry links valid only when the caller can still act as the original subject', () => {
    const { request } = storeSetup();
    const input = request({ purpose: 'project', identity: { subjectType: 'employee', subjectId: 'employee-1', credentialId: 'cred', organizationId: 'org', projectId: 'project-1' } });
    expect(retryLinkAllowed(input, { subjectType: 'employee', subjectId: 'employee-1', organizationId: 'org', projectId: 'project-1', purpose: 'project' })).toBe(true);
    expect(retryLinkAllowed(input, { subjectType: 'employee', subjectId: 'employee-1', organizationId: 'org', projectId: 'project-2', purpose: 'project' })).toBe(false);
    expect(retryLinkAllowed(input, { subjectType: 'application', subjectId: 'employee-1', organizationId: 'org', projectId: 'project-1', purpose: 'project' })).toBe(false);
    expect(retryLinkAllowed(input, { subjectType: 'employee', subjectId: 'employee-1', organizationId: 'org', projectId: 'project-1', purpose: 'personal' })).toBe(false);
  });
});
