import type { CallLog, Purpose, SettlementOutcome } from './index.js';

export interface CallFilters {
  from?:string; to?:string; requestId?:string; subjectId?:string; credentialId?:string;
  projectId?:string; organizationId?:string; subjectType?:CallLog['subjectType']; resultGroup?:'errors'; modelId?:string; serviceId?:string; poolId?:string;
  purpose?:Purpose; outcome?:SettlementOutcome; billableState?:CallLog['billableState'];
  /* Error drill-down. `errorCode` is an exact match; the two `*Missing` flags cover
     rows the breakdown reports as 未知 (no code recorded) and 未记录服务 (no route),
     so a distribution row and its list can never disagree about what they count. */
  errorCode?:string; errorCodeMissing?:'true'; serviceMissing?:'true';
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

/** One grouped reason. Grouping is deliberately narrow so every row is drillable. */
export interface CallErrorBucket {
  /** Route service at admission, or null when the call never reached routing. */
  serviceId:string|null;
  modelId:string;
  outcome:SettlementOutcome;
  /** null means the code was not recorded; the UI must not invent one. */
  errorCode:string|null;
  /** `cancelled` is reported separately and is never part of the error rate. */
  group:'error'|'cancelled';
  calls:number;
}
/**
 * Read-only reason distribution over a call window. `ended`, `errors` and `cancelled`
 * use exactly the same predicates as `CallSummary`, so the sums of `buckets` match
 * the same-window list totals; `bucketCount` is the number of groups before `limit`.
 */
export interface CallErrorBreakdown {
  from:string|null; to:string|null; collectedAt:string;
  ended:number; errors:number; cancelled:number;
  /** Calls counted in `errors` whose `errorCode` is missing (shown as 未知). */
  unknownCode:number;
  bucketCount:number;
  buckets:CallErrorBucket[];
}
export interface CallErrorQuery extends CallFilters { limit?:number }
