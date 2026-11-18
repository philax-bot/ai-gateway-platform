export * from './upstream-credentials.js';
export * from './notifications.js';
export * from './routing.js';
export * from './catalog.js';
export * from './protocol.js';
export * from './guardrail.js';
export type SubjectType = 'employee' | 'application';
export * from './platform.js';
export * from './calls.js';
export * from './call-errors.js';
export * from './monitoring.js';
export * from './capacity.js';
export * from './gateway-trace.js';
export * from './model-kinds.js';
export * from './permissions.js';
export * from './media.js';
export * from './retention.js';
export * from './audit.js';
export * from './tracing.js';
export * from './verification.js';
export * from './usage.js';
export * from './analytics.js';
export * from './report-period.js';
export * from './connection-failure.js';
export { estimateChatInput,estimateProtocolInput,chatCompletionsUrl } from './request.js';
export type Purpose = 'personal' | 'project' | 'application';
export type RequestMode = import('./model-kinds.js').ModelKind | 'audio';
export type Decision = 'allow' | 'deny';
export type ReasonCode =
  | 'safety_policy_violation'
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
  estimatedUnits?:number;
  modelProtocol?:import('./protocol.js').ModelProtocol;
  guardrail?: import('./guardrail.js').GuardrailAssessment;
  requestId: string;
  idempotencyKey: string;
  /** Physical gateway attempt, excluded from the logical idempotency fingerprint. */
  admissionAttemptId?: string;
  identity: RequestIdentity;
  purpose: Purpose;
  modelId: string;
  mode: RequestMode;
  estimatedInputTokens?: number;
  /** Largest individual Embedding input; total tokens still govern reservation and TPM. */
  maxInputTokens?:number;
  maxOutputTokens?: number;
  requestFingerprint?: string;
  expectedPriceVersion?: string;
  policyVersion: string;
  /** Explicit client retry of an earlier call; scope is re-checked by the control plane. */
  retryOfRequestId?: string | null;
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
  meter?:{unit:import('./model-kinds.js').MeterUnit;price:number;multiplier:number};
  /** Exact operator-only calculation basis; unit prices are effective display values. */
  billing?: { base: { inputPrice:number; outputPrice:number; cachedInputPrice:number }; multiplier:number };
  version: string;
  currency: 'CNY';
  unit: 'per_million_tokens'|import('./model-kinds.js').MeterUnit;
  inputPrice: number;
  outputPrice: number;
  cachedInputPrice: number;
}
export interface RouteSnapshot {
  videoCancellation?:{path:string;method:'POST'|'DELETE'};
  credential?:import('./upstream-credentials.js').FrozenCredential;
  kind?:import('./model-kinds.js').ModelKind;
  adapter?:import('./model-kinds.js').ModelProvider['adapter'];
  modalityPaths?:Partial<Record<import('./model-kinds.js').ModelKind,string>>;
  audit?:import('./gateway-trace.js').RouteAudit;
  protocolPaths?:import('./protocol.js').ProtocolPaths;
  protocols?:Partial<Record<import('./protocol.js').ModelProtocol,import('./protocol.js').ProtocolCapability>>;
  serviceId: string;
  poolId: string;
  definitionId: string;
  baseUrl: string;
  upstreamModel: string;
  credentialRef: string | null;
  /** Explicit request/policy cap only. Absence preserves the provider default. */
  maxOutputTokens?: number;
  /** Private dispatch metadata; the original route and price remain authoritative. */
  transport?:{kind:'higress';baseUrl:string;model:string;version:string}|{kind:'unavailable'};
}
export interface AdmissionScope {
  id: string;
  rpm?: number;
  tpm?: number;
  concurrency?: number;
}
export interface AdmissionSnapshot {
  callbackChannelId?:string|null;
  meterEstimate?:import('./model-kinds.js').MeteredUsage;
  routing?:import('./routing.js').RoutingDecision;
  costPrice?: PriceSnapshot | null;
  /** Frozen reservation estimate, independent of the generation cap and final usage. */
  estimate?: { inputTokens:number; outputTokens:number; outputSource:'model'|'default' };
  /** Directory organization at admission time, independent of the tenant authorization identity. */
  attributionOrganizationId?:string|null;
  protocol?:{requested:import('./protocol.js').ModelProtocol;upstream:import('./protocol.js').ModelProtocol;mode:'native'|'adapted'};
  kind: 'configured' | 'legacy_simulation';
  route: RouteSnapshot | null;
  price: PriceSnapshot | null;
  reservedAmount: number;
  estimatedTokens: number;
  scopes: AdmissionScope[];
}

export interface RequestLimitDiagnostic {
  estimatedInputTokens: number;
  requestedOutputTokens: number | null;
  allowedOutputTokens: number;
  modelContextTokens: number;
  limitSources: { source: 'enterprise' | 'subject' | 'entitlement' | 'project' | 'application' | 'pool' | 'service' | 'service_model' | 'shared_capacity' | 'model_context'; maxOutputTokens: number }[];
}

export interface AuthorizeResponse {
  guardrail?: import('./guardrail.js').SafetyEvent;
  /** Owner of the first committed authorization; replays preserve it. */
  admissionAttemptId?: string;
  admission?: AdmissionSnapshot;
  requestLimits?: RequestLimitDiagnostic;
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
  meteredUsage?:import('./model-kinds.js').MeteredUsage;
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
  meteredUsage?:import('./model-kinds.js').MeteredUsage;
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
  meteredUsage?:import('./model-kinds.js').MeteredUsage|null;
  safety?: import('./guardrail.js').SafetyEvent | null;
  forwarded?:boolean|null;
  ttftMs?:number|null;
  usageFinal?:boolean;
  admission?: {routing?:AdmissionSnapshot['routing'];meterEstimate?:AdmissionSnapshot['meterEstimate'];costPrice?:PriceSnapshot|null;attributionOrganizationId?:string|null;protocol?:AdmissionSnapshot['protocol'];kind:AdmissionSnapshot['kind'];price:PriceSnapshot|null;reservedAmount:number;route:Pick<RouteSnapshot,'serviceId'|'poolId'|'definitionId'|'upstreamModel'|'audit'|'kind'|'credential'>|null} | null;
  organizationId?: string | null;
  errorCode?: string | null;
  latencyMs?: number | null;
  requestId: string;
  upstreamRequestId?: string | null;
  retryOfRequestId?: string | null;
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
export * from './people.js';
