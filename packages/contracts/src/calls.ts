import type { CallLog, Purpose, SettlementOutcome } from './index.js';

export interface CallFilters {
  from?:string; to?:string; requestId?:string; subjectId?:string; credentialId?:string;
  projectId?:string; modelId?:string; serviceId?:string; poolId?:string;
  purpose?:Purpose; outcome?:SettlementOutcome; billableState?:CallLog['billableState'];
}
export interface CallQuery extends CallFilters { limit?:number; cursor?:string }
export interface CallSummary {
  ended:number; forwarded:number; unknownForwarding:number; errors:number; upstreamFailures:number; cancelled:number; timeouts:number;
  partial:number; rejected:number; pendingReview:number; knownUsage:number; unknownUsage:number;
  inputTokens:number; outputTokens:number; cachedInputTokens:number; confirmedAmount:number;
  activeUsers:number; activeProjects:number; activeApplications:number;
  rateLimited:number;latencySamples:number;averageLatencyMs:number|null;p95LatencyMs:number|null;
  ttftSamples:number;p95TtftMs:number|null;
}
export interface CallPage {
  items:CallLog[]; nextCursor:string|null; summary:CallSummary; collectedAt:string;
}
export interface CallRelations { original:CallLog|null; retries:CallLog[] }
