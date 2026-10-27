/** Shared, deliberately narrow request-reference rules for call tracing. */

export const MAX_REQUEST_REFERENCE_LENGTH = 160;

/** A request reference is opaque text: no control characters, no unbounded input. */
export function isRequestReference(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_REQUEST_REFERENCE_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * Upstream request identifiers are only collected from explicitly supported
 * headers, in a fixed order. Completion IDs in response bodies are not request
 * identifiers. Unknown or malformed values are recorded as "not provided".
 */
export const UPSTREAM_REQUEST_ID_HEADERS = ['x-request-id', 'request-id'] as const;

export function readUpstreamRequestId(headers: { get(name: string): string | null | undefined }): string | null {
  for (const name of UPSTREAM_REQUEST_ID_HEADERS) {
    let value: string | null | undefined;
    try { value = headers.get(name); } catch { continue; }
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    // A malformed value is never recorded; move on to the next supported header.
    if (isRequestReference(trimmed)) return trimmed;
  }
  return null;
}
