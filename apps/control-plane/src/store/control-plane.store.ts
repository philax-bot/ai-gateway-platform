import type {
  AuthorizeRequest,
  AuthorizeResponse,
  CallLog,
  RequestIdentity,
  SettlementRequest,
  SettlementResponse,
  VerificationMappingSnapshot,
} from '@ai-gateway/contracts';

export interface DemoCredential {
  credentialId: string;
  identity: RequestIdentity;
  purpose: AuthorizeRequest['purpose'];
  /** Authorized logical model IDs for this credential; used for OpenAI-compatible model discovery only. */
  modelIds: string[];
}

export interface QuotaSnapshot {
  purpose: AuthorizeRequest['purpose'];
  currency: 'CNY';
  projectId: string | null;
  availableAmount: number;
  totalAmount: number;
  sourceId: string | null;
  expiresAt: string | null;
}

export interface StartVerificationInput {
  serviceId: string;
  serviceName: string;
  operatorId: string;
  configVersion: number;
  mappings: VerificationMappingSnapshot[];
  idempotencyKey: string;
}
export interface VerificationPageQuery { limit?: number; before?: string | null }

export interface ControlPlaneStore {
  initialize(): Promise<void>;
  authorize(input: AuthorizeRequest): Promise<AuthorizeResponse>;
  settle(input: SettlementRequest): Promise<SettlementResponse>;
  getDemoCredential(apiKey: string): Promise<DemoCredential | null>;
  listCalls(): Promise<CallLog[]>;
  getQuota(purpose?: 'personal' | 'project'): Promise<QuotaSnapshot>;
  health(): Promise<{ status: 'ok' | 'degraded'; database: string; cache: string }>;
}
