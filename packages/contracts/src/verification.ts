import type { PriceSnapshot } from './index.js';

export type VerificationRunState = 'running' | 'completed' | 'interrupted';
export type VerificationOutcome = 'passed' | 'failed';
export type VerificationCostState = 'priced' | 'price_unknown' | 'usage_unknown';

export interface VerificationMappingSnapshot {
  protocols?:import('./protocol.js').ModelProtocol[];
  definitionId: string;
  upstreamModel: string;
  inputPrice: number | null;
  outputPrice: number | null;
  cachedInputPrice: number | null;
  /** Persisted before the outbound call so an interrupted run still shows what was attempted. */
  attemptedAt: string | null;
}

export interface VerificationUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  complete: boolean;
}

export interface VerificationCost {
  state: VerificationCostState;
  amount: number | null;
  /** Price snapshot used for the internal estimate; null when prices are not configured. */
  price: PriceSnapshot | null;
}

export interface VerificationMappingResult {
  protocol?:import('./protocol.js').ModelProtocol;
  support?:'supported'|'unsupported'|'unknown';
  definitionId: string;
  upstreamModel: string;
  outcome: VerificationOutcome;
  httpStatus: number | null;
  errorCode: string | null;
  message: string;
  upstreamRequestId: string | null;
  usage: VerificationUsage;
  cost: VerificationCost;
  completedAt: string;
}

export interface VerificationSummary {
  probes:number;
  mappings: number;
  attempted: number;
  passed: number;
  failed: number;
  usageKnown: number;
  usageUnknown: number;
  costPriced: number;
  costUnknown: number;
  /** Sum of priced mapping estimates, or null when any attempted mapping is not priced. */
  internalCost: number | null;
}

/**
 * Platform diagnostic runs. They are technical metering evidence, not vendor
 * invoices and not a fourth quota purpose: no employee, project or application
 * balance is charged.
 */
export interface VerificationRun {
  id: string;
  operatorId: string;
  serviceId: string;
  serviceName: string;
  configVersion: number;
  state: VerificationRunState;
  diagnostic: true;
  idempotencyKey: string;
  mappings: VerificationMappingSnapshot[];
  results: VerificationMappingResult[];
  startedAt: string;
  completedAt: string | null;
  leaseExpiresAt: string;
  note: string | null;
}

export interface VerificationRunPage {
  items: VerificationRun[];
  nextBefore: string | null;
}

export function summarizeVerification(run: VerificationRun): VerificationSummary {
  const attempted = new Set(run.mappings.filter(mapping => mapping.attemptedAt).map(mapping => mapping.definitionId));
  for (const result of run.results) attempted.add(result.definitionId);
  const usageKnown = run.results.filter(result => result.usage.complete).length;
  const priced = run.results.filter(result => result.cost.state === 'priced' && result.cost.amount !== null);
  const totalMappings = run.mappings.reduce((n,m)=>n+(m.protocols?.length??1),0);
  const completePricing = run.results.length === totalMappings
    && run.results.every(result => result.cost.state === 'priced' && result.cost.amount !== null);
  return {
    mappings: run.mappings.length,
    probes:totalMappings,
    attempted: attempted.size,
    passed: run.results.filter(result => result.outcome === 'passed').length,
    failed: run.results.filter(result => result.outcome === 'failed').length,
    usageKnown,
    usageUnknown: run.results.length - usageKnown,
    costPriced: priced.length,
    costUnknown: run.results.length - priced.length,
    internalCost: completePricing ? Number(priced.reduce((sum, result) => sum + (result.cost.amount ?? 0), 0).toFixed(6)) : null,
  };
}
