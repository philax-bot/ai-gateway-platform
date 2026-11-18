import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DemoStore } from './demo.store';
import { credentialLookupValues } from './credential-key';

const issued = 'sa_unit-test-secret';
const issuedHash = createHash('sha256').update(issued).digest('hex');

describe('credential lookup never replays persisted hashes', () => {
  it('matches issued keys only by their derived hash', () => {
    expect(credentialLookupValues(issued)).toEqual([`sha256:${issuedHash}`]);
    expect(credentialLookupValues(`sha256:${issuedHash}`)).toEqual([`sha256:${createHash('sha256').update(`sha256:${issuedHash}`).digest('hex')}`]);
  });

  it('keeps the two committed development fixtures resolvable by their public literal', () => {
    expect(credentialLookupValues('local-employee-key')).toContain('local-employee-key');
    expect(credentialLookupValues('local-project-key')).toContain('local-project-key');
    expect(credentialLookupValues('local-employee-key')).toHaveLength(2);
  });

  it('authenticates an issued key but rejects the stored hash value as a bearer token', async () => {
    const store = new DemoStore();
    // Exactly what syncResources persists for an issued key.
    store.credentials.set(`sha256:${issuedHash}`, {
      credentialId: 'credential-unit', apiKey: `sha256:${issuedHash}`,
      identity: { credentialId: 'credential-unit', subjectType: 'employee', subjectId: 'member-unit', organizationId: 'org-demo', projectId: null },
      purpose: 'personal', active: true, modelIds: ['test-model'],
    });
    expect(await store.getDemoCredential(issued)).toMatchObject({ credentialId: 'credential-unit' });
    expect(await store.getDemoCredential(`sha256:${issuedHash}`)).toBeNull();
    expect(await store.getDemoCredential(issuedHash)).toBeNull();
  });

  it('rejects a disabled credential and keeps the development fixture working', async () => {
    const store = new DemoStore();
    expect(await store.getDemoCredential('local-employee-key')).toMatchObject({ credentialId: 'credential-demo-001' });
    store.credentials.get('local-employee-key')!.active = false;
    expect(await store.getDemoCredential('local-employee-key')).toBeNull();
  });
});
