export type SubjectType = 'employee' | 'application';
export * from './platform.js';
export * from './calls.js';
export * from './monitoring.js';
export * from './retention.js';
export * from './audit.js';
export { estimateChatInput,chatCompletionsUrl } from './request.js';
export type Purpose = 'personal' | 'project' | 'application';
export type RequestMode = 'chat' | 'embeddings' | 'rerank' | 'image' | 'audio';
export type Decision = 'allow' | 'deny';
export type ReasonCode =
  | 'none'
  | 'credential_invalid'
  | 'model_not_open'
  | 'service_unavailable'
  | 'no_quota'
  | 'quota_insufficient'
  | 'policy_stale'
  | 'subject_disabled'
  | 'dependency_unavailable'
  | 'price_unconfigured'
  | 'rate_limited'
  | 'request_limit_exceeded';

export interface RequestIdentity {
  subjectType: SubjectType;
  subjectId: string;
  credentialId: string;
  organizationId?: string;
  projectId?: string | null;
}

export interface AuthorizeRequest {
  requestId: string;
  idempotencyKey: string;
  identity: RequestIdentity;
  purpose: Purpose;
  modelId: string;
  mode: RequestMode;
  estimatedInputTokens?: number;
  maxOutputTokens?: number;
  requestFingerprint?: string;
  expectedPriceVersion?: string;
  policyVersion: string;
}

export interface Reservation {
  reservationId: string;
  sourceType: 'personal_batch' | 'project_member_batch' | 'application_wallet';
  sourceId: string;
  reservedAmount: number;
  currency: 'CNY';
  expiresAt: string;
}

export interface PriceSnapshot {
  version: string;
  currency: 'CNY';
  unit: 'per_million_tokens';
  inputPrice: number;
  outputPrice: number;
  cachedInputPrice: number;
}
export interface RouteSnapshot {
  serviceId: string;
  poolId: string;
  definitionId: string;
  baseUrl: string;
  upstreamModel: string;
  credentialRef: string | null;
  maxOutputTokens: number;
}
export interface AdmissionScope {
  id: string;
  rpm?: number;
  tpm?: number;
  concurrency?: number;
}
export interface AdmissionSnapshot {
  kind: 'configured' | 'legacy_simulation';
  route: RouteSnapshot | null;
  price: PriceSnapshot | null;
  reservedAmount: number;
  estimatedTokens: number;
  scopes: AdmissionScope[];
}

export interface AuthorizeResponse {
  admission?: AdmissionSnapshot;
  replayed?: boolean;
  requestId: string;
  decision: Decision;
  reasonCode: ReasonCode;
  reasonMessage: string;
  policyVersion: string;
  reservation: Reservation | null;
}

export type SettlementOutcome =
  | 'completed'
  | 'upstream_error'
  | 'timeout'
  | 'client_cancelled'
  | 'partial'
  | 'rejected_before_upstream';

export interface SettlementRequest {
  forwarded?:boolean;
  ttftMs?:number;
  errorCode?:string;
  requestId: string;
  idempotencyKey: string;
  reservationId?: string;
  outcome: SettlementOutcome;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  actualAmount?: number;
  currency?: 'CNY';
  upstreamRequestId?: string | null;
  completedAt: string;
  modelId?: string;
  purpose?: Purpose;
  subjectId?: string;
  /** False when an interrupted response has no final upstream usage. Keep the hold for review. */
  usageFinal?: boolean;
}

export interface SettlementResponse {
  requestId: string;
  status: 'settled' | 'released' | 'pending_review' | 'already_finalized';
  billableState: 'confirmed' | 'pending_review' | 'not_billable';
  ledgerEntryId: string | null;
}
export interface ReconciliationRequest {
  requestId:string;
  idempotencyKey:string;
  actorId:string;
  reason:string;
  mode:'confirm_usage'|'release_hold';
  inputTokens?:number;
  outputTokens?:number;
  cachedInputTokens?:number;
  actualAmount?:number;
}

export interface GatewaySyncRequest {
  provider: 'higress';
  resourceType: 'model_route' | 'policy_reference' | 'credential_binding' | 'rate_limit';
  resourceId: string;
  desiredVersion: string;
  previousVersion?: string | null;
  idempotencyKey: string;
  spec: Record<string, unknown>;
}

export interface GatewaySyncResponse {
  provider: string;
  resourceId: string;
  desiredVersion: string;
  appliedVersion: string | null;
  status: 'accepted' | 'applied' | 'rejected' | 'pending' | 'rolled_back';
  operationId: string;
  errorCode: string | null;
}

export interface CallLog {
  forwarded?:boolean|null;
  ttftMs?:number|null;
  usageFinal?:boolean;
  admission?: {kind:AdmissionSnapshot['kind'];price:PriceSnapshot|null;reservedAmount:number;route:Pick<RouteSnapshot,'serviceId'|'poolId'|'definitionId'|'upstreamModel'>|null} | null;
  organizationId?: string | null;
  errorCode?: string | null;
  latencyMs?: number | null;
  requestId: string;
  startedAt: string;
  completedAt: string;
  subjectType: SubjectType;
  subjectId: string;
  credentialId: string;
  purpose: Purpose;
  projectId?: string | null;
  modelId: string;
  outcome: SettlementOutcome;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  actualAmount: number;
  billableState: 'confirmed' | 'pending_review' | 'not_billable';
  reservationId: string | null;
  reasonCode?: string;
}
export { parseMemberImport } from './member-import.js';
export { runtimeMode,databaseSchema,validateRuntimeConfig } from './runtime-config.js';
