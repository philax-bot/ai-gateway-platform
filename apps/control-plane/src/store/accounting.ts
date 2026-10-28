import { BadRequestException, ConflictException } from '@nestjs/common';
import type { AdmissionSnapshot, AuthorizeRequest, ReconciliationRequest, RequestIdentity, SettlementRequest } from '@ai-gateway/contracts';
import { isRequestReference } from '@ai-gateway/contracts';
import { costForUsage } from './admission';

export const RESERVATION_AMOUNT = 0.02;

export function sameIdentity(a: RequestIdentity, b: RequestIdentity): boolean {
  return a.subjectType === b.subjectType && a.subjectId === b.subjectId
    && a.credentialId === b.credentialId && a.organizationId === b.organizationId
    && (a.projectId ?? null) === (b.projectId ?? null);
}

export function authorizationFingerprint(input: AuthorizeRequest): string {
  if (!input?.identity || typeof input.identity!=='object' || Array.isArray(input.identity)
    || [input.requestId,input.idempotencyKey,input.modelId,input.policyVersion,input.identity.subjectId,input.identity.credentialId].some(value=>typeof value!=='string'||!value.trim()||value.length>160)
    || !['employee','application'].includes(input.identity.subjectType)
    || (input.identity.organizationId!==undefined&&typeof input.identity.organizationId!=='string')
    || (input.identity.projectId!==undefined&&input.identity.projectId!==null&&typeof input.identity.projectId!=='string')
    || (input.estimatedInputTokens!==undefined&&(!Number.isSafeInteger(input.estimatedInputTokens)||input.estimatedInputTokens<0||input.estimatedInputTokens>2147483647))
    || (input.maxOutputTokens!==undefined&&(!Number.isSafeInteger(input.maxOutputTokens)||input.maxOutputTokens<1||input.maxOutputTokens>2147483647))
    || (input.requestFingerprint!==undefined&&!/^[a-f0-9]{64}$/.test(input.requestFingerprint))
    || (input.expectedPriceVersion!==undefined&&(typeof input.expectedPriceVersion!=='string'||input.expectedPriceVersion.length>128))
    || (input.retryOfRequestId!==undefined&&input.retryOfRequestId!==null&&!isRequestReference(input.retryOfRequestId))
    || (input.admissionAttemptId!==undefined&&!isRequestReference(input.admissionAttemptId))
    || !['personal', 'project', 'application'].includes(input.purpose)
    || !['chat', 'embeddings', 'rerank', 'image', 'audio'].includes(input.mode)) {
    throw new BadRequestException('invalid authorization request');
  }
  const i = input.identity;
  const base = [i.subjectType, i.subjectId, i.credentialId, i.organizationId ?? null,
    i.projectId ?? null, input.purpose, input.modelId, input.mode, input.policyVersion,input.estimatedInputTokens??null,input.maxOutputTokens??null,input.requestFingerprint??null,input.expectedPriceVersion??null];
  // No-retry requests keep the pre-tracing fingerprint so already persisted
  // idempotency keys stay valid. Explicit retries use a versioned extension.
  if (input.retryOfRequestId === undefined || input.retryOfRequestId === null) return JSON.stringify(base);
  if (input.retryOfRequestId === input.requestId) throw new BadRequestException('a request cannot be a retry of itself');
  return JSON.stringify(['retry-v1', ...base, input.retryOfRequestId]);
}

export interface RetryTarget {
  subjectType: AuthorizeRequest['identity']['subjectType'];
  subjectId: string;
  organizationId: string | null;
  projectId: string | null;
  purpose: AuthorizeRequest['purpose'];
}

/** One uniform failure for missing and out-of-scope references so retries cannot probe other calls. */
export function retryLinkAllowed(input: AuthorizeRequest, target: RetryTarget | null): boolean {
  return !!target
    && target.subjectType === input.identity.subjectType
    && target.subjectId === input.identity.subjectId
    && (target.organizationId ?? null) === (input.identity.organizationId ?? null)
    && (target.projectId ?? null) === (input.identity.projectId ?? null)
    && target.purpose === input.purpose;
}

export function settlementAmount(input: SettlementRequest, reserved: number,admission?:AdmissionSnapshot|null): { amount: number; pending: boolean; billable: boolean } {
  if (!input?.requestId || !input.idempotencyKey || !input.reservationId
    || !Number.isFinite(Date.parse(input.completedAt))
    || !['completed', 'partial', 'upstream_error', 'timeout', 'client_cancelled', 'rejected_before_upstream'].includes(input.outcome)
    || (input.currency !== undefined && input.currency !== 'CNY')
    || (input.usageFinal !== undefined && typeof input.usageFinal !== 'boolean')
    || (input.forwarded !== undefined && typeof input.forwarded !== 'boolean')
    || (input.ttftMs!==undefined&&(!Number.isInteger(input.ttftMs)||input.ttftMs<0||input.ttftMs>2147483647))
    || (input.upstreamRequestId!==undefined&&input.upstreamRequestId!==null&&!isRequestReference(input.upstreamRequestId))
    || (input.errorCode!==undefined&&(typeof input.errorCode!=='string'||input.errorCode.length>120))
    || (input.outcome==='rejected_before_upstream'&&input.forwarded===true)) {
    throw new BadRequestException('invalid settlement request');
  }
  for (const value of [input.inputTokens, input.outputTokens, input.cachedInputTokens]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0||value>2147483647)) throw new BadRequestException('invalid token count');
  }
  if((input.cachedInputTokens??0)>(input.inputTokens??0))throw new BadRequestException('cached input tokens cannot exceed input tokens');
  if (input.actualAmount !== undefined && (!Number.isFinite(input.actualAmount) || input.actualAmount < 0)) {
    throw new BadRequestException('invalid settlement amount');
  }
  const configured=admission?.kind==='configured';
  const completeUsage=input.usageFinal!==false&&input.inputTokens!==undefined&&input.outputTokens!==undefined;
  const billable = input.outcome === 'completed' || input.outcome === 'partial'||(configured&&input.outcome!=='rejected_before_upstream'&&completeUsage&&(input.inputTokens!+input.outputTokens!)>0);
  if(configured&&admission.price){
    const amount=billable&&completeUsage?costForUsage(admission.price,input.inputTokens!,input.outputTokens!,input.cachedInputTokens??0):0;
    const uncertain=input.usageFinal===false||(billable&&!completeUsage);
    return {amount,pending:uncertain||amount>reserved,billable};
  }
  const amount = Number((billable ? input.actualAmount ?? reserved : 0).toFixed(6));
  return { amount, pending: input.usageFinal === false || amount > reserved, billable };
}

export function checkSettlementScope(input: SettlementRequest, reservation: { identity: RequestIdentity; purpose: string; modelId: string }): void {
  if ((input.subjectId !== undefined && input.subjectId !== reservation.identity.subjectId)
    || (input.purpose !== undefined && input.purpose !== reservation.purpose)
    || (input.modelId !== undefined && input.modelId !== reservation.modelId)) {
    throw new ConflictException('settlement scope does not match reservation');
  }
}

export function reconciliationCalculation(input:ReconciliationRequest,reserved:number,admission?:AdmissionSnapshot|null){
  if(!input||typeof input.requestId!=='string'||!input.requestId||typeof input.idempotencyKey!=='string'||input.idempotencyKey.length<8||typeof input.actorId!=='string'||!input.actorId||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>2000||!['confirm_usage','release_hold'].includes(input.mode))throw new BadRequestException('invalid reconciliation request');
  if(input.mode==='release_hold')return {amount:0,billable:false};
  if(input.inputTokens===undefined||input.outputTokens===undefined)throw new BadRequestException('confirmed input and output usage is required');
  const result=settlementAmount({requestId:input.requestId,idempotencyKey:input.idempotencyKey,reservationId:'review',outcome:'completed',inputTokens:input.inputTokens,outputTokens:input.outputTokens,cachedInputTokens:input.cachedInputTokens,actualAmount:input.actualAmount,usageFinal:true,completedAt:new Date().toISOString()},reserved,admission);
  return {amount:result.amount,billable:true};
}
