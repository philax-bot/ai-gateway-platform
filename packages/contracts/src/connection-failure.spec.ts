import { describe, expect, it } from 'vitest';
import { MAX_CONNECT_ATTEMPTS, definitelyNotSent, shouldRetryConnect } from './connection-failure.js';

describe('upstream connect-phase failure classification', () => {
  it('treats only pre-request failures as provably unsent', () => {
    expect(definitelyNotSent({ cause: { code: 'ECONNREFUSED' } })).toBe(true);
    expect(definitelyNotSent({ cause: { code: 'ENOTFOUND' } })).toBe(true);
    expect(definitelyNotSent({ cause: { code: 'EAI_AGAIN' } })).toBe(true);
    expect(definitelyNotSent({ cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })).toBe(true);
    expect(definitelyNotSent({ cause: { errors: [{ code: 'ECONNREFUSED' }, { code: 'UND_ERR_CONNECT_TIMEOUT' }] } })).toBe(true);
    for (const value of [{ cause: { code: 'ECONNRESET' } }, { cause: { code: 'UND_ERR_SOCKET' } }, { name: 'AbortError' }, new Error('fetch failed'), null, 'failure']) {
      expect(definitelyNotSent(value)).toBe(false);
    }
  });

  it('refuses a mixed aggregate because one attempted address may have been reached', () => {
    expect(definitelyNotSent({ cause: { errors: [{ code: 'ECONNREFUSED' }, { code: 'ECONNRESET' }] } })).toBe(false);
  });

  it('allows exactly one bounded retry, and only for connect-phase failures', () => {
    expect(MAX_CONNECT_ATTEMPTS).toBe(2);
    expect(shouldRetryConnect({ cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }, 0)).toBe(true);
    expect(shouldRetryConnect({ cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }, 1)).toBe(false);
    expect(shouldRetryConnect({ cause: { code: 'ECONNRESET' } }, 0)).toBe(false);
    expect(shouldRetryConnect({ name: 'AbortError' }, 0)).toBe(false);
  });

  it('does not recurse without bound on self-referencing causes', () => {
    const loop: { cause?: unknown } = {};
    loop.cause = loop;
    expect(definitelyNotSent(loop)).toBe(false);
  });
});