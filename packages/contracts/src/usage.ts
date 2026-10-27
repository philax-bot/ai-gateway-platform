/**
 * Upstream usage parsing shared by the data plane and connection verification so
 * both interpret non-stream and SSE responses identically.
 */
export interface UpstreamUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export function extractUpstreamUsage(raw: string): UpstreamUsage | null {
  const objects: Record<string, unknown>[] = [];
  try { objects.push(JSON.parse(raw)); } catch {
    for (const line of raw.split(/\r?\n/).reverse()) {
      if (!line.startsWith('data:')) continue;
      try { objects.push(JSON.parse(line.slice(5).trim())); } catch { /* SSE marker or partial line */ }
    }
  }
  for (const object of objects) {
    const usage = object.usage as Record<string, unknown> | undefined;
    if (!usage) continue;
    const inputTokens = usage.prompt_tokens ?? usage.input_tokens;
    const outputTokens = usage.completion_tokens ?? usage.output_tokens;
    const cachedInputTokens = (usage.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens ?? 0;
    if ([inputTokens, outputTokens, cachedInputTokens].every(v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 2147483647)
      && Number(cachedInputTokens) <= Number(inputTokens)) {
      return { inputTokens: inputTokens as number, outputTokens: outputTokens as number, cachedInputTokens: cachedInputTokens as number };
    }
  }
  return null;
}
