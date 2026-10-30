export type Role = 'operator' | 'employee';
export interface Organization { id: string; name: string; parentId: string | null; active: boolean }
export interface OrganizationChangeImpact {
  name:string; beforeParent:string|null; afterParent:string|null; beforeActive:boolean|null; afterActive:boolean;
  rematches:boolean;
  organizations:{id:string;name:string}[];
  members:{id:string;name:string;organizationName:string;beforeAccess:boolean;afterAccess:boolean}[];
  personalKeyCount:number;
  projects:{id:string;name:string;managerName:string}[];
  applications:{id:string;name:string;ownerName:string}[];
}
export interface Member {
  limits?: UsageLimits;
  id: string; name: string; directoryId: string; organizationId: string; category: 'employee' | 'contractor';
  tags: string[]; roles: Role[]; active: boolean; validUntil: string | null; sponsorId: string | null; passwordHash?: string;
}
export interface ModelDefinition { id: string; name: string; modelId: string; contextTokens: number; description: string; active: boolean }
export interface UsageLimits { mode: 'inherit' | 'none' | 'custom'; rpm?: number; tpm?: number; concurrency?: number; maxOutputTokens?: number }
export interface ServiceModel {
  definitionId: string; upstreamModel: string; inputPrice: number | null; outputPrice: number | null;
  cachedInputPrice: number | null; limits: UsageLimits;
}
export interface ModelService {
  protocolPaths?:import('./protocol.js').ProtocolPaths;
  protocolCapabilities?:import('./protocol.js').ServiceProtocolCapabilities;
  id: string; name: string; baseUrl: string; credentialRef: string | null; active: boolean; mappings: ServiceModel[];
  verification: 'unverified' | 'passed' | 'failed'; verificationMessage: string; verifiedAt: string | null; configVersion: number;
  limits: UsageLimits; sharedCapacityId: string | null;
}
export interface ModelPool { id: string; name: string; entries: { definitionId: string; serviceId: string; open: boolean }[]; limits: UsageLimits }
export interface ModelRange { poolId: string; mode: 'follow' | 'specific'; definitionIds: string[] }
export interface Plan {
  id: string; name: string; version: number; range: ModelRange; amount: number; cadence: 'once' | 'monthly';
  quotaDays: number; entitlementDays: number; active: boolean; limits: UsageLimits;
}
export interface Entitlement {
  id: string; memberId: string; planId: string; planVersion: number; planSnapshot: Plan; range: ModelRange;
  grantedAt: string; expiresAt: string; status: 'active' | 'revoked'; futureGrants: boolean;
  source: 'manual' | 'automatic' | 'approval'; ruleIds: string[]; periods: string[];
}
export interface AutoRule { id: string; name: string; planId: string; organizationId: string | null; includeChildren: boolean; category: Member['category'] | null; tags: string[]; active: boolean }
export interface Project {
  closedAt?:string|null;closedBy?:string|null;closeReason?:string;
  id: string; name: string; description: string; managerId: string; applicantId: string; memberIds: string[];
  status: 'active' | 'paused' | 'ended'; range: ModelRange; limits: UsageLimits;
}
export interface Application { id: string; name: string; ownerId: string; organizationId: string; description: string; active: boolean; range: ModelRange; limits: UsageLimits }
export type ApprovalKind = 'project_create' | 'project_budget' | 'project_member_quota' | 'personal_open' | 'personal_topup' | 'application_quota';
export interface Approval {
  id: string; kind: ApprovalKind; applicantId: string; objectId: string | null; amount: number; requestedExpiresAt: string;
  scenario: string; reason: string; proposedManagerId: string | null; proposedName: string; status: 'pending' | 'approved' | 'effective' | 'rejected' | 'withdrawn' | 'failed';
  approverId: string | null; decisionReason: string; approvedAmount: number | null; approvedExpiresAt: string | null;
  execution: Record<string, unknown> | null; createdAt: string; decidedAt: string | null; effectiveAt: string | null; failure: string | null;
}
export interface ManagedKey {
  internal?: boolean;
  onlineSessionHash?: string;
  id: string; credentialId: string; name: string; ownerId: string; subjectType: 'employee' | 'application'; subjectId: string;
  purpose: 'personal' | 'project' | 'application'; projectId: string | null; masked: string; keyHash: string;
  status: 'active' | 'disabled' | 'revoked'; createdAt: string; expiresAt: string; lastUsedAt: string | null;
}
export interface ApprovalDetail {
  approval:Approval;applicantName:string;responsible:{id:string;name:string}[];history:AuditEntry[];
  permissions:{decide:boolean;repair:boolean;execute:boolean;withdraw:boolean};
}
export interface Notification { id: string; recipientId: string; title: string; body: string; objectType: string; objectId: string; createdAt: string; readAt: string | null }
export interface AuditEntry { id: string; actorId: string; actorName?:string; action: string; objectId: string | null; objectName?:string; reason: string; createdAt: string; detail: Record<string, unknown> }
export interface Distribution {
  planSnapshot?:Plan;scopeDescription?:string;
  id: string; actorId: string; kind: 'plan' | 'topup'; planId: string | null; entitlementId: string | null; amount: number;
  memberIds: string[]; expiresAt: string; createdAt: string; results: { memberId: string; status: 'granted' | 'skipped' | 'failed'; reason: string; batchId: string | null;expiresAt?:string|null;amount?:number;entitlementId?:string|null;planVersion?:number }[];
}
export interface Session { tokenHash: string; memberId: string; createdAt: string; expiresAt: string }
export interface WorkspaceSettings { name: string; timezone: 'Asia/Shanghai'; personalDefaultPoolId: string | null; projectDefaultPoolId: string | null; limits: UsageLimits; retentionDays: number; retentionAutomatic?:boolean }
export interface WorkspaceState {
  guardrail?: import('./guardrail.js').GuardrailPolicy;
  agentInstances?: ManagedAgentInstance[];
  retention?:{lastRun:import('./retention.js').RetentionRun};
  monitoring?:import('./monitoring.js').MonitoringState;
  version: 1; tenantId: string; revision: number; organizations: Organization[]; members: Member[];
  definitions: ModelDefinition[]; services: ModelService[]; pools: ModelPool[]; plans: Plan[]; entitlements: Entitlement[];
  rules: AutoRule[]; projects: Project[]; applications: Application[]; approvals: Approval[]; keys: ManagedKey[];
  distributions: Distribution[]; notifications: Notification[]; audit: AuditEntry[]; sessions: Session[];
  settings: WorkspaceSettings; operations: Record<string, { fingerprint: string; result: unknown }>;
}
export interface ManagedAgentInstance {
  id:string; ownerId:string; status:'provisioning'|'running'|'stopping'|'stopped'|'failed';
  generation:number; keyId:string|null; errorCode:string|null; updatedAt:string;
  operation?:{key:string;actorId:string;action:'ensure'|'rotate'|'stop';token:string;expiresAt:string};
}
export interface ManagedAgentView {
  enabled:boolean; instance:null|{
    id:string;ownerId:string;status:ManagedAgentInstance['status'];generation:number;
    key:Pick<ManagedKey,'id'|'masked'|'status'|'expiresAt'>|null;errorCode:string|null;updatedAt:string;
    entryUrl:string|null;agentId:string|null;
  };
}
export interface BusinessQuotaBatch {
  closedAt?:string|null;closedAmount?:number;
  id: string; sourceType: 'personal_batch' | 'project_member_batch' | 'application_wallet'; sourceId: string;
  organizationId: string; projectId: string | null; totalAmount: number; availableAmount: number;
  modelIds: string[]; expiresAt: string; purpose: 'personal' | 'project' | 'application';
  entitlementId: string | null; sourceBatchId: string | null;
}
export interface ProjectBudgetBatch { closedAt?:string|null;closedAmount?:number;id: string; projectId: string; totalAmount: number; availableAmount: number; expiresAt: string; createdAt: string }
export interface ProjectDetail {
  project:Project;canManage:boolean;managerName:string;poolName:string;models:{modelId:string;name:string}[];budgets:ProjectBudgetBatch[];
  members:{id:string;name:string;active:boolean;isMember:boolean;batches:BusinessQuotaBatch[]}[];
  consumedByBatch:Record<string,number>;history:AuditEntry[];
}
export interface ApplicationDetail {
  application:Application;ownerName:string;organizationName:string;poolName:string;
  status:'disabled'|'model_unavailable'|'price_unconfigured'|'no_quota'|'quota_insufficient'|'ready';
  models:PurposeView['models'];availableAmount:number;batches:BusinessQuotaBatch[];
  keys:Omit<ManagedKey,'keyHash'|'onlineSessionHash'>[];calls:import('./calls.js').CallPage;history:AuditEntry[];
}
export interface PlatformCommand { type: string; idempotencyKey: string; payload: Record<string, unknown>; expectedRevision?: number; previewToken?: string }
export interface EntitlementMigrationRow {
  entitlementId:string; memberId:string; memberName:string;
  status:'change'|'skip'|'inapplicable'; reason:string;
  fromVersion:number; toVersion:number;
  modelsAdded:string[]; modelsRemoved:string[];
  amountBefore:number; amountAfter:number; expiresAt:string; periods:string[];
  limitsBefore:UsageLimits; limitsAfter:UsageLimits;
  affectedKeyIds:string[];
}
export interface EntitlementMigrationPreview {
  planId:string; planName:string; planVersion:number; cadence:'once'|'monthly'; reason:string;
  rows:EntitlementMigrationRow[];
  changedCount:number; skippedCount:number; inapplicableCount:number;
  noBackfill:true;
}
export interface EntitlementMigrationResult {
  planId:string; planName:string; planVersion:number;
  migratedIds:string[]; skippedIds:string[];
  noBackfill:true;
}
export type PublicMember = Omit<Member, 'passwordHash'>;
export interface PurposeView {
  id: string; name: string; purpose: 'personal'|'project'; projectId: string|null;
  status: 'not_open'|'model_unavailable'|'price_unconfigured'|'no_quota'|'quota_insufficient'|'ready'; availableAmount: number;
  models: {modelId:string;name:string;availableAmount:number;largestBatchAmount:number;status:'model_unavailable'|'price_unconfigured'|'no_quota'|'quota_insufficient'|'ready'}[];
}
export interface PlatformSnapshot {
  pendingReviewCount:number|null;callDataQuality:'collected'|'collection_failed';
  revision: number; actor: PublicMember; settings: WorkspaceSettings; organizations: Organization[];
  members: (Pick<PublicMember,'id'|'name'|'organizationId'|'roles'|'active'> & Partial<PublicMember>)[];
  definitions: ModelDefinition[]; services: ModelService[]; pools: ModelPool[]; plans: Plan[]; rules: AutoRule[];
  entitlements: (Entitlement & {futureGrantStatus:'scheduled'|'manually_stopped'|'rule_not_matching'|'inactive'})[]; projects: Project[]; applications: Application[]; approvals: Approval[];
  keys: Omit<ManagedKey,'keyHash'|'onlineSessionHash'>[]; distributions: Distribution[]; audit: AuditEntry[]; notifications: Notification[];
  quotaBatches: BusinessQuotaBatch[]; projectBudgets: ProjectBudgetBatch[];
  purposes: PurposeView[];
  callLogs: import('./index.js').CallLog[];
}
