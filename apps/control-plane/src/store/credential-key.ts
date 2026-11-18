import { createHash } from 'node:crypto';

/** Development fixture keys are the only credentials ever stored verbatim. */
const LEGACY_DEMO_API_KEYS = ['local-employee-key','local-project-key'] as const;

/**
 * Keys issued by the platform are persisted only under their derived hash
 * (`sha256:<sha256(secret)>`), and the data plane re-derives that value from the
 * presented secret. Looking the stored value up verbatim would turn the hash
 * itself into a bearer token: anyone able to read the credentials row (backup,
 * replica, log) could replay it. Only the two committed development fixtures are
 * matched by their public literal.
 */
export function credentialLookupValues(apiKey: string): string[] {
  const derived = `sha256:${createHash('sha256').update(apiKey).digest('hex')}`;
  return (LEGACY_DEMO_API_KEYS as readonly string[]).includes(apiKey) ? [derived,apiKey] : [derived];
}
