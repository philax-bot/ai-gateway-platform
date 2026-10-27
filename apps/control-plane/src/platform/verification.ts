import { createHash } from 'node:crypto';
import type { PriceSnapshot, VerificationCost, VerificationMappingSnapshot } from '@ai-gateway/contracts';
import { extractUpstreamUsage, shouldRetryConnect } from '@ai-gateway/contracts';
import { costForUsage } from '../store/admission';

/** Verification waits for a real model answer; the 5s default was below a normal connect+reasoning latency. */
const DEFAULT_VERIFICATION_TIMEOUT_MS = 20000;
export function verificationTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.UPSTREAM_VALIDATION_TIMEOUT_MS ?? DEFAULT_VERIFICATION_TIMEOUT_MS);
  return Number.isSafeInteger(value) && value >= 1000 && value <= 120000 ? value : DEFAULT_VERIFICATION_TIMEOUT_MS;
}

/**
 * One bounded retry, and only when the failure provably happened before any
 * request bytes were sent. Diagnostic traffic is never billed, but the same rule
 * keeps verification results honest about what actually reached the upstream.
 */
export async function fetchVerifiedUpstream(url: string, init: RequestInit): Promise<Response> {
  let attempt = 0;
  for (;;) {
    try {
      // pi-lens-ignore: ts-ssrf — the service URL is validated on save and the loopback/explicit-enable gate is checked by the caller.
      return await fetch(url, init);
    } catch (error) {
      if (!shouldRetryConnect(error, attempt)) throw error;
      attempt++;
    }
  }
}

export interface VerificationMappingInput {
  definitionId: string;
  upstreamModel: string;
  inputPrice: number | null;
  outputPrice: number | null;
  cachedInputPrice: number | null;
}

export function verificationMappingSnapshots(mappings: VerificationMappingInput[]): VerificationMappingSnapshot[] {
  return mappings.map(mapping => ({
    definitionId: mapping.definitionId,
    upstreamModel: mapping.upstreamModel,
    inputPrice: mapping.inputPrice,
    outputPrice: mapping.outputPrice,
    cachedInputPrice: mapping.cachedInputPrice,
    attemptedAt: null,
  }));
}

/** Diagnostic pricing reuses the admission price shape, with its own version marker. */
export function verificationPrice(serviceId: string, configVersion: number, mapping: VerificationMappingInput): PriceSnapshot | null {
  if ([mapping.inputPrice, mapping.outputPrice, mapping.cachedInputPrice].some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) return null;
  return {
    version: createHash('sha256').update(JSON.stringify([serviceId, configVersion, mapping.definitionId, mapping.upstreamModel, mapping.inputPrice, mapping.outputPrice, mapping.cachedInputPrice, 'verification'])).digest('hex').slice(0, 24),
    currency: 'CNY',
    unit: 'per_million_tokens',
    inputPrice: mapping.inputPrice!,
    outputPrice: mapping.outputPrice!,
    cachedInputPrice: mapping.cachedInputPrice!,
  };
}

export function verificationCost(price: PriceSnapshot | null, usage: ReturnType<typeof extractUpstreamUsage>): VerificationCost {
  if (!usage) return { state: 'usage_unknown', amount: null, price };
  if (!price) return { state: 'price_unknown', amount: null, price: null };
  try {
    return { state: 'priced', amount: costForUsage(price, usage.inputTokens, usage.outputTokens, usage.cachedInputTokens), price };
  } catch {
    return { state: 'price_unknown', amount: null, price: null };
  }
}

export function verificationFailure(status: number | null, error: unknown): { errorCode: string; message: string } {
  if (error instanceof Error && error.name === 'TimeoutError') return { errorCode: 'timeout', message: '连接超时' };
  if (status === 401 || status === 403) return { errorCode: 'auth_failed', message: '鉴权失败' };
  if (status === 404) return { errorCode: 'model_not_found', message: '模型或接口不存在' };
  if (status !== null && status >= 500) return { errorCode: 'upstream_error', message: `上游返回 HTTP ${status}` };
  if (status !== null) return { errorCode: 'http_error', message: `上游返回 HTTP ${status}` };
  const message = error instanceof Error ? error.message : '';
  if (/响应不符合/.test(message)) return { errorCode: 'invalid_response', message: '响应不符合文本对话格式' };
  if (/credential reference/.test(message)) return { errorCode: 'credential_missing', message: '受控凭据引用未配置' };
  return { errorCode: 'connection_failed', message: message || '连接失败' };
}
