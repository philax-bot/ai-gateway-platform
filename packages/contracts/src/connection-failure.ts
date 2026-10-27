/**
 * Upstream failure classification shared by the data plane and connection
 * verification. Only failures that provably precede any HTTP request may be
 * treated as "nothing was sent": they are the sole case where a retry cannot
 * double-charge a customer and the sole case that proves zero upstream usage.
 */
export function definitelyNotSent(error: unknown, depth = 0): boolean {
  if (depth > 5 || !error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; cause?: unknown; errors?: unknown[] };
  if (Array.isArray(value.errors) && value.errors.length) return value.errors.every(item => definitelyNotSent(item, depth + 1));
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(String(value.code))) return true;
  return value.cause ? definitelyNotSent(value.cause, depth + 1) : false;
}

/** Bounded connect-phase retry budget. Never raised without a matching billing argument. */
export const MAX_CONNECT_ATTEMPTS = 2;

/**
 * True only for a connect-phase failure on the first attempt. A retried request
 * reuses the same body and headers; DNS/connect stalls are the observed cause of
 * intermittent upstream 502s, while a partially received response is never retried.
 */
export function shouldRetryConnect(error: unknown, attempt: number): boolean {
  return attempt + 1 < MAX_CONNECT_ATTEMPTS && definitelyNotSent(error);
}