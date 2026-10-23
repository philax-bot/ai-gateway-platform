import { describe, expect, it } from 'vitest';
import type { AuthorizeRequest } from '@ai-gateway/contracts';
import { DemoStore } from '../store/demo.store';
import { PolicyService } from './policy.service';

const request = (overrides: Partial<AuthorizeRequest> = {}): AuthorizeRequest => ({
  requestId: 'request-001',
  idempotencyKey: 'idem-001-long',
  identity: {
    subjectType: 'employee',
    subjectId: 'employee-demo-001',
    credentialId: 'credential-demo-001',
    organizationId: 'org-demo',
    projectId: null,
  },
  purpose: 'personal',
  modelId: 'test-model',
  mode: 'chat',
  policyVersion: 'policy-local-1',
  ...overrides,
});

describe('PolicyService', () => {
  it('reserves once and returns the same result for an idempotent retry', async () => {
    const service = new PolicyService(new DemoStore());
    const first = await service.authorize(request());
    const retry = await service.authorize(request());
    expect(first.decision).toBe('allow');
    expect(retry).toEqual({ ...first, replayed: true });
  });

  it('fails closed when the model is not authorized', async () => {
    const service = new PolicyService(new DemoStore());
    const result = await service.authorize(request({ modelId: 'unknown-model' }));
    expect(result.decision).toBe('deny');
    expect(result.reasonCode).toBe('model_not_open');
  });
});
