import {guardrailPolicy,type SafetyEvent,type SafetyQuery} from '@ai-gateway/contracts';
import {admissionGuardrail,memorySafetyPage} from './guardrail';
import { ConflictException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type {
  AuthorizeRequest,
  AuthorizeResponse,
  CallLog,
  RequestIdentity,
  SettlementRequest,
  SettlementResponse,
  AdmissionSnapshot,
  WorkspaceState,
  ReconciliationRequest,
  CallQuery,
  InFlightCount,
  VerificationRun,
  VerificationRunPage,
  VerificationMappingResult,
  UsageAnalyticsQuery,
} from '@ai-gateway/contracts';
import { aggregateUsage } from './call-analytics';
import type { ControlPlaneStore, DemoCredential, QuotaSnapshot, StartVerificationInput, VerificationPageQuery } from './control-plane.store';
import { authorizationFingerprint, checkSettlementScope, reconciliationCalculation, RESERVATION_AMOUNT, retryLinkAllowed, sameIdentity, settlementAmount, type RetryTarget } from './accounting';
import { admissionForBatch, admissionDenialMessage, legacyAdmission, publicLogAdmission } from './admission';
import { businessDenial } from '../platform/domain';
import {runtimeMode} from '@ai-gateway/contracts';
import { queryMemoryCalls, callVisible, type CallScope } from './call-query';

export interface CredentialRecord {
  credentialId: string;
  apiKey: string;
  identity: RequestIdentity;
  purpose: AuthorizeRequest['purpose'];
  active: boolean;
  modelIds: string[];
}

export interface QuotaBatch {
  closedAt?:string|null;closedAmount?:number;
  entitlementId?: string | null;
  sourceBatchId?: string | null;
  id: string;
  sourceType: 'personal_batch' | 'project_member_batch' | 'application_wallet';
  sourceId: string;
  organizationId: string;
  projectId: string | null;
  purpose: AuthorizeRequest['purpose'];
  totalAmount: number;
  availableAmount: number;
  modelIds: string[];
  expiresAt: string;
}

export interface ReservationRecord {
  admission: AdmissionSnapshot;
  windowStart: number;
  reservationId: string;
  requestId: string;
  idempotencyKey: string;
  fingerprint: string;
  amount: number;
  batchId: string;
  identity: RequestIdentity;
  purpose: AuthorizeRequest['purpose'];
  modelId: string;
  createdAt: string;
  expiresAt: string;
  retryOfRequestId: string | null;
  finalized: boolean;
}

@Injectable()
export class DemoStore implements ControlPlaneStore {
  private serial: Promise<unknown> = Promise.resolve();
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serial.then(work);
    this.serial = result.catch(() => undefined);
    return result;
  }
  readonly credentials = new Map<string, CredentialRecord>();
  readonly quotaBatches = new Map<string, QuotaBatch>();
  readonly reservationsByRequest = new Map<string, ReservationRecord>();
  readonly reservationsByIdempotency = new Map<string, ReservationRecord>();
  readonly authorizationResponsesByRequest = new Map<string, AuthorizeResponse>();
  readonly settlementResponsesByRequest = new Map<string, SettlementResponse>();
  readonly safetyEvents:SafetyEvent[]=[];
  async readGuardrailPolicy(){return guardrailPolicy((await this.businessState?.())?.guardrail);}
  async querySafety(input:SafetyQuery={}){return memorySafetyPage(this.safetyEvents,input);}
  readonly callLogs: CallLog[] = [];
  readonly authorizationInputs = new Map<string, { requestId: string; fingerprint: string }>();
  readonly authorizationKeys = new Map<string, string>();
  readonly settlementKeys = new Map<string, string>();
  businessState?: () => Promise<WorkspaceState>;
  private readonly admissionWindows=new Map<string,{start:number;requests:number;tokens:number}>();
  readonly ledgerEntries: {id:string;requestId:string;reservationId:string;batchId:string;kind:'settlement'|'release'|'reconciliation';amount:number;createdAt:string}[]=[];
  readonly reconciliationRecords=new Map<string,{idempotencyKey:string;fingerprint:string;response:SettlementResponse}>();
  readonly verificationRuns: VerificationRun[] = [];
  private static readonly VERIFICATION_LEASE_MS = 120000;
  private static readonly VERIFICATION_INTERRUPTED_NOTE = '验证进程中断，已发出的请求用量待确认；不会自动重发。';

  constructor() {
    if(runtimeMode(process.env)==='production')return;
    const identity: RequestIdentity = {
      subjectType: 'employee',
      subjectId: 'employee-demo-001',
      credentialId: 'credential-demo-001',
      organizationId: 'org-demo',
      projectId: null,
    };
    this.credentials.set('local-employee-key', {
      credentialId: identity.credentialId,
      apiKey: 'local-employee-key',
      identity,
      purpose: 'personal',
      active: true,
      modelIds: ['test-model'],
    });
    this.quotaBatches.set('personal-batch-demo-001', {
      id: 'personal-batch-demo-001',
      sourceType: 'personal_batch',
      sourceId: identity.subjectId,
      organizationId: 'org-demo',
      projectId: null,
      purpose: 'personal',
      totalAmount: 10,
      availableAmount: 10,
      modelIds: ['test-model'],
      expiresAt: '2026-12-31T23:59:59.000Z',
    });
    const projectIdentity: RequestIdentity = { ...identity, credentialId: 'credential-project-demo-001', projectId: 'project-demo-001' };
    this.credentials.set('local-project-key', {
      credentialId: projectIdentity.credentialId, apiKey: 'local-project-key', identity: projectIdentity,
      purpose: 'project', active: true, modelIds: ['test-model'],
    });
    this.quotaBatches.set('project-member-batch-demo-001', {
      id: 'project-member-batch-demo-001', sourceType: 'project_member_batch', sourceId: identity.subjectId,
      organizationId: 'org-demo', projectId: projectIdentity.projectId!, purpose: 'project',
      totalAmount: 20, availableAmount: 20, modelIds: ['test-model'], expiresAt: '2026-12-31T23:59:59.000Z',
    });
  }

  async initialize(): Promise<void> {}

  async authorize(input: AuthorizeRequest): Promise<AuthorizeResponse> {
    return this.exclusive(async()=>{const response=await this.authorizeUnlocked(input);
      if(!response.replayed&&response.guardrail)this.safetyEvents.push(response.guardrail);
      if(response.decision==='deny'&&!response.replayed&&!this.callLogs.some(c=>c.requestId===input.requestId))this.callLogs.push(this.deniedCall(input,response));
      return response;
    });
  }

  protected deniedCall(input:AuthorizeRequest,response:AuthorizeResponse):CallLog{
    const at=new Date().toISOString();return {safety:response.guardrail??null,requestId:input.requestId,upstreamRequestId:null,retryOfRequestId:input.retryOfRequestId??null,startedAt:at,completedAt:at,subjectType:input.identity.subjectType,subjectId:input.identity.subjectId,credentialId:input.identity.credentialId,organizationId:input.identity.organizationId??null,purpose:input.purpose,projectId:input.identity.projectId??null,modelId:input.modelId,outcome:'rejected_before_upstream',forwarded:false,errorCode:response.reasonCode,inputTokens:0,outputTokens:0,cachedInputTokens:0,usageFinal:true,actualAmount:0,billableState:'not_billable',reservationId:null,latencyMs:0,admission:publicLogAdmission(response.admission?{...response.admission,reservedAmount:0}:null)};
  }

  private async authorizeUnlocked(input: AuthorizeRequest): Promise<AuthorizeResponse> {
    const fingerprint = authorizationFingerprint(input);
    const workspace=await this.businessState?.();
    const reason=workspace?businessDenial(workspace,input):null;
    const existing = this.authorizationInputs.get(input.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new ConflictException('idempotency key was reused with different input');
      }
      return { ...this.authorizationResponsesByRequest.get(existing.requestId)!, replayed: true };
    }
    if (this.authorizationKeys.has(input.requestId)) throw new ConflictException('request ID was reused with a different key');
    if (input.retryOfRequestId) {
      // Missing and out-of-scope references share one error so retries cannot probe other calls.
      if (!retryLinkAllowed(input, this.retryTarget(input.retryOfRequestId))) throw new ConflictException('retry reference is not available');
    }
    const validated=[...this.credentials.values()].find(c=>c.credentialId===input.identity.credentialId);
    const safety=!reason&&validated?.active&&sameIdentity(validated.identity,input.identity)&&validated.purpose===input.purpose&&validated.modelIds.includes(input.modelId)?admissionGuardrail(workspace?.guardrail,input):null;
    this.authorizationInputs.set(input.idempotencyKey, { requestId: input.requestId, fingerprint });
    this.authorizationKeys.set(input.requestId, input.idempotencyKey);

    const response: AuthorizeResponse = {
      ...(input.admissionAttemptId?{admissionAttemptId:input.admissionAttemptId}:{}),
      requestId: input.requestId,
      decision: 'deny',
      reasonCode: 'none',
      reasonMessage: '',
      policyVersion: input.policyVersion,
      reservation: null,
    };
    if(reason){response.reasonCode=reason;response.reasonMessage=admissionDenialMessage(reason);this.authorizationResponsesByRequest.set(input.requestId,response);return response;}
    const credential = [...this.credentials.values()].find(
      (item) => item.credentialId === input.identity.credentialId,
    );
    if (!credential || !credential.active || credential.identity.subjectId !== input.identity.subjectId) {
      response.reasonCode = credential ? 'subject_disabled' : 'credential_invalid';
      response.reasonMessage = credential ? 'subject or credential is disabled' : 'credential is not recognized';
      this.authorizationResponsesByRequest.set(input.requestId, response);
      return response;
    }
    if (!sameIdentity(credential.identity, input.identity) || credential.purpose !== input.purpose) {
      response.reasonCode = 'credential_invalid';
      response.reasonMessage = 'credential identity or purpose does not match';
      this.authorizationResponsesByRequest.set(input.requestId, response);
      return response;
    }
    if (!credential.modelIds.includes(input.modelId)) {
      response.reasonCode = 'model_not_open';
      response.reasonMessage = 'model is not open for this credential';
      this.authorizationResponsesByRequest.set(input.requestId, response);
      return response;
    }
    if(safety)response.guardrail=safety;
    if(safety?.action==='block'){response.reasonCode='safety_policy_violation';response.reasonMessage='输入可能包含受限制的信息，已按企业安全策略阻止发送。请修改后重试。';this.authorizationResponsesByRequest.set(input.requestId,response);return response;}
    const batches = [...this.quotaBatches.values()].filter(
      (item) => item.purpose === input.purpose
        && item.sourceId === input.identity.subjectId
        && item.organizationId === input.identity.organizationId
        && item.projectId === (input.identity.projectId ?? null)
        && item.modelIds.includes(input.modelId)
        && !item.closedAt && new Date(item.expiresAt).getTime() > Date.now(),
    ).sort((a, b) => a.expiresAt.localeCompare(b.expiresAt) || a.id.localeCompare(b.id));
    let batch:QuotaBatch|undefined;
    let admission=legacyAdmission();
    let eligible=0;
    let candidateReason:AuthorizeResponse['reasonCode']='no_quota';
    let candidateLimits:AuthorizeResponse['requestLimits'];
    for(const candidate of batches){
      const quote=admissionForBatch(workspace,input,candidate);
      if(quote.reason){candidateReason=quote.reason;candidateLimits=quote.requestLimits;continue;}
      eligible++;
      if(candidate.availableAmount>=quote.admission.reservedAmount){batch=candidate;admission=quote.admission;break;}
    }
    if (!batch) {
      response.reasonCode = eligible?'quota_insufficient':batches.length?candidateReason:'no_quota';
      if(response.reasonCode==='request_limit_exceeded')response.requestLimits=candidateLimits;
      response.reasonMessage = admissionDenialMessage(response.reasonCode,response.requestLimits);
      this.authorizationResponsesByRequest.set(input.requestId, response);
      return response;
    }
    const windowStart=Math.floor(Date.now()/60000)*60000;
    const activeReservations=[...this.reservationsByRequest.values()].filter(r=>!r.finalized&&Date.parse(r.expiresAt)>Date.now());
    if(admission.scopes.some(scope=>{
      const previous=this.admissionWindows.get(scope.id),window=previous?.start===windowStart?previous:{start:windowStart,requests:0,tokens:0};
      return (scope.rpm!==undefined&&window.requests+1>scope.rpm)||(scope.tpm!==undefined&&window.tokens+admission.estimatedTokens>scope.tpm)||(scope.concurrency!==undefined&&activeReservations.filter(r=>r.admission.scopes.some(s=>s.id===scope.id)).length>=scope.concurrency);
    })){
      response.reasonCode = 'rate_limited';
      response.admission=admission;
      response.reasonMessage = 'an applicable subject, pool, service or shared-resource limit is reached';
      this.authorizationResponsesByRequest.set(input.requestId, response);
      return response;
    }

    for(const scope of admission.scopes){const old=this.admissionWindows.get(scope.id),window=old?.start===windowStart?old:{start:windowStart,requests:0,tokens:0};window.requests++;window.tokens+=admission.estimatedTokens;this.admissionWindows.set(scope.id,window);}
    batch.availableAmount = Number((batch.availableAmount - admission.reservedAmount).toFixed(6));
    const reservationId = `reservation-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const reservation = {
      reservationId,
      sourceType: batch.sourceType,
      sourceId: batch.id,
      reservedAmount: admission.reservedAmount,
      currency: 'CNY' as const,
      expiresAt,
    };
    const record: ReservationRecord = {
      admission,
      windowStart,
      reservationId,
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      fingerprint,
      amount: admission.reservedAmount,
      batchId: batch.id,
      identity: input.identity,
      purpose: input.purpose,
      modelId: input.modelId,
      createdAt: new Date().toISOString(),
      expiresAt,
      retryOfRequestId: input.retryOfRequestId ?? null,
      finalized: false,
    };
    response.decision = 'allow';
    response.admission = admission;
    response.reservation = reservation;
    this.reservationsByRequest.set(input.requestId, record);
    this.reservationsByIdempotency.set(input.idempotencyKey, record);
    this.authorizationResponsesByRequest.set(input.requestId, response);
    return response;
  }

  async settle(input: SettlementRequest): Promise<SettlementResponse> {
    return this.exclusive(() => this.settleUnlocked(input));
  }

  private async settleUnlocked(input: SettlementRequest): Promise<SettlementResponse> {
    settlementAmount(input, RESERVATION_AMOUNT);
    const keyRequest = this.settlementKeys.get(input.idempotencyKey);
    if (keyRequest && keyRequest !== input.requestId) throw new ConflictException('settlement key belongs to another request');
    const reservation = this.reservationsByRequest.get(input.requestId);
    if (!reservation || reservation.reservationId !== input.reservationId) {
      throw new ConflictException('reservation does not match request');
    }
    checkSettlementScope(input, reservation);
    const existing = this.settlementResponsesByRequest.get(input.requestId);
    if (existing) {
      const known=settlementAmount(input,reservation.amount,reservation.admission);
      if(existing.status==='pending_review'&&this.settlementKeys.get(`${input.requestId}:lease-expired`)===input.requestId&&input.usageFinal===true&&input.inputTokens!==undefined&&input.outputTokens!==undefined&&!known.pending&&(known.billable||(input.outcome==='rejected_before_upstream'&&input.forwarded===false))){
        const response=await this.reconcileWithinBusinessTransaction({requestId:input.requestId,idempotencyKey:`${input.idempotencyKey}:recovered-final`,actorId:'system:data-plane-recovery',reason:known.billable?'迟到的完整上游用量，按原预占价格自动核对':'数据面持久化记录确认未转发，释放原预占',mode:known.billable?'confirm_usage':'release_hold',inputTokens:input.inputTokens,outputTokens:input.outputTokens,cachedInputTokens:input.cachedInputTokens,actualAmount:input.actualAmount});
        const log=this.callLogs.find(log=>log.requestId===input.requestId)!;log.outcome=input.outcome;log.forwarded=input.forwarded??log.forwarded;log.usageFinal=true;log.errorCode=input.errorCode??log.errorCode;log.completedAt=input.completedAt;log.latencyMs=Math.max(0,Date.parse(input.completedAt)-Date.parse(log.startedAt));
        for(const scope of reservation.admission.scopes){const window=this.admissionWindows.get(scope.id);if(window?.start===reservation.windowStart)window.tokens=Math.max(0,window.tokens-(reservation.admission.estimatedTokens-input.inputTokens-input.outputTokens));}
        return response;
      }
      return { ...existing, status: 'already_finalized' };
    }
    if (reservation.finalized) {
      return { requestId: input.requestId, status: 'already_finalized', billableState: 'confirmed', ledgerEntryId: null };
    }
    const batch = this.quotaBatches.get(reservation.batchId);
    if (!batch) throw new ConflictException('quota batch no longer exists');
    const { amount: actualAmount, pending: pendingReview, billable } = settlementAmount(input, reservation.amount,reservation.admission);
    const release = pendingReview ? 0 : reservation.amount - actualAmount;
    if(batch.closedAt)batch.closedAmount=Number(((batch.closedAmount??0)+release).toFixed(6));
    else batch.availableAmount = Number((batch.availableAmount + release).toFixed(6));
    reservation.finalized = true;
    const response: SettlementResponse = pendingReview
      ? { requestId: input.requestId, status: 'pending_review', billableState: 'pending_review', ledgerEntryId: null }
      : { requestId: input.requestId, status: billable ? 'settled' : 'released', billableState: billable ? 'confirmed' : 'not_billable', ledgerEntryId: `ledger-${randomUUID()}` };
    this.settlementResponsesByRequest.set(input.requestId, response);
    this.settlementKeys.set(input.idempotencyKey, input.requestId);
    if(response.ledgerEntryId)this.ledgerEntries.push({id:response.ledgerEntryId,requestId:input.requestId,reservationId:reservation.reservationId,batchId:reservation.batchId,kind:billable?'settlement':'release',amount:actualAmount,createdAt:input.completedAt});
    if(input.usageFinal!==false&&input.inputTokens!==undefined&&input.outputTokens!==undefined){
      const releasedTokens=reservation.admission.estimatedTokens-input.inputTokens-input.outputTokens;
      for(const scope of reservation.admission.scopes){const window=this.admissionWindows.get(scope.id);if(window?.start===reservation.windowStart)window.tokens=Math.max(0,window.tokens-releasedTokens);}
    }
    this.callLogs.push({
      requestId: input.requestId,
      upstreamRequestId: input.upstreamRequestId ?? null,
      retryOfRequestId: reservation.retryOfRequestId ?? null,
      admission:publicLogAdmission(reservation.admission),
      forwarded:input.forwarded??(input.outcome==='rejected_before_upstream'?false:null),
      safety:this.authorizationResponsesByRequest.get(input.requestId)?.guardrail??null,
      ttftMs:input.ttftMs??null,errorCode:input.errorCode??null,
      organizationId:reservation.identity.organizationId??null,
      latencyMs:Math.max(0,Math.min(2147483647,Date.parse(input.completedAt)-Date.parse(reservation.createdAt))),
      usageFinal:input.usageFinal!==false&&input.inputTokens!==undefined&&input.outputTokens!==undefined,
      startedAt: reservation.createdAt,
      completedAt: input.completedAt,
      subjectType: reservation.identity.subjectType,
      subjectId: reservation.identity.subjectId,
      credentialId: reservation.identity.credentialId,
      purpose: reservation.purpose,
      projectId: reservation.identity.projectId ?? null,
      modelId: reservation.modelId,
      outcome: input.outcome,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      cachedInputTokens: input.cachedInputTokens ?? 0,
      actualAmount,
      billableState: response.billableState,
      reservationId: reservation.reservationId,
    });
    return response;
  }

  async getDemoCredential(apiKey: string): Promise<DemoCredential | null> {
    if(typeof apiKey!=='string'||apiKey.length>4096)return null;
    const credential = this.credentials.get(apiKey) ?? this.credentials.get(`sha256:${createHash('sha256').update(apiKey).digest('hex')}`);
    if (!credential || !credential.active) return null;
    return { credentialId: credential.credentialId, identity: credential.identity, purpose: credential.purpose, modelIds: [...credential.modelIds] };
  }

  async listCalls(): Promise<CallLog[]> {
    return [...this.callLogs].reverse();
  }
  async queryCalls(input:CallQuery,scope:CallScope=null,_client?:import('pg').PoolClient){return queryMemoryCalls(this.callLogs,input,scope);}
  async queryUsage(input:UsageAnalyticsQuery|undefined,scope:CallScope=null,timezone='Asia/Shanghai',_client?:import('pg').PoolClient){return aggregateUsage(this.callLogs,input,scope,timezone);}
  async inFlightCounts(_client?:import('pg').PoolClient):Promise<InFlightCount[]>{
    const groups=new Map<string,InFlightCount>();for(const r of this.reservationsByRequest.values())if(!r.finalized&&Date.parse(r.expiresAt)>Date.now()){
      const serviceId=r.admission?.route?.serviceId??null,key=JSON.stringify([serviceId,r.modelId]),group=groups.get(key)??{serviceId,modelId:r.modelId,count:0};group.count++;groups.set(key,group);
    }return [...groups.values()];
  }
  async getCall(requestId:string):Promise<CallLog|null>{return structuredClone(this.callLogs.find(log=>log.requestId===requestId)??null);}
  protected retryTarget(requestId:string):RetryTarget|null{
    const reservation=this.reservationsByRequest.get(requestId);
    if(reservation)return {subjectType:reservation.identity.subjectType,subjectId:reservation.identity.subjectId,organizationId:reservation.identity.organizationId??null,projectId:reservation.identity.projectId??null,purpose:reservation.purpose};
    const log=this.callLogs.find(value=>value.requestId===requestId);
    return log?{subjectType:log.subjectType,subjectId:log.subjectId,organizationId:log.organizationId??null,projectId:log.projectId??null,purpose:log.purpose}:null;
  }
  async relatedCalls(requestId:string,scope:CallScope):Promise<{original:CallLog|null;retries:CallLog[]}>{
    const original=this.callLogs.find(log=>log.requestId===requestId)??null;
    return {
      original:original&&callVisible(original,scope)?structuredClone(original):null,
      retries:this.callLogs.filter(log=>log.retryOfRequestId===requestId&&callVisible(log,scope)).map(log=>structuredClone(log)),
    };
  }
  private verificationRun(runId:string):VerificationRun{
    const run=this.verificationRuns.find(value=>value.id===runId);
    if(!run)throw new ConflictException('verification run not found');
    return run;
  }
  private expireVerificationRuns():number{
    const at=Date.now();let expired=0;
    for(const run of this.verificationRuns)if(run.state==='running'&&Date.parse(run.leaseExpiresAt)<=at){
      run.state='interrupted';run.completedAt=new Date(at).toISOString();run.note=DemoStore.VERIFICATION_INTERRUPTED_NOTE;expired++;
    }
    return expired;
  }
  async interruptStaleVerifications():Promise<number>{return this.exclusive(async()=>this.expireVerificationRuns());}
  async startVerification(input:StartVerificationInput):Promise<{run:VerificationRun;replayed:boolean}>{
    return this.exclusive(async()=>{
      // Recover a crashed lease before replay lookup so a same-key retry observes `interrupted`.
      this.expireVerificationRuns();
      const prior=this.verificationRuns.find(run=>run.idempotencyKey===input.idempotencyKey);
      if(prior){
        if(prior.serviceId!==input.serviceId)throw new ConflictException('verification key was reused for another service');
        return {run:structuredClone(prior),replayed:true};
      }
      if(this.verificationRuns.some(run=>run.serviceId===input.serviceId&&run.state==='running'))throw new ConflictException('another verification is already running for this service');
      const startedAt=new Date().toISOString();
      const run:VerificationRun={id:`verification-${randomUUID()}`,operatorId:input.operatorId,serviceId:input.serviceId,serviceName:input.serviceName,configVersion:input.configVersion,state:'running',diagnostic:true,idempotencyKey:input.idempotencyKey,mappings:structuredClone(input.mappings),results:[],startedAt,completedAt:null,leaseExpiresAt:new Date(Date.now()+DemoStore.VERIFICATION_LEASE_MS).toISOString(),note:null};
      this.verificationRuns.push(run);return {run:structuredClone(run),replayed:false};
    });
  }
  async markVerificationAttempt(runId:string,definitionId:string):Promise<void>{
    return this.exclusive(async()=>{
      const run=this.verificationRun(runId);if(run.state!=='running')return;
      const mapping=run.mappings.find(value=>value.definitionId===definitionId);
      if(mapping&&!mapping.attemptedAt)mapping.attemptedAt=new Date().toISOString();
      run.leaseExpiresAt=new Date(Date.now()+DemoStore.VERIFICATION_LEASE_MS).toISOString();
    });
  }
  async appendVerificationResult(runId:string,result:VerificationMappingResult):Promise<void>{
    return this.exclusive(async()=>{
      const run=this.verificationRun(runId);if(run.state!=='running')return;
      run.results.push(structuredClone(result));
      run.leaseExpiresAt=new Date(Date.now()+DemoStore.VERIFICATION_LEASE_MS).toISOString();
    });
  }
  async finishVerification(runId:string,state:'completed'|'interrupted'):Promise<VerificationRun>{
    return this.exclusive(async()=>{
      const run=this.verificationRun(runId);
      if(run.state==='running'){
        run.state=state;run.completedAt=new Date().toISOString();
        if(state==='interrupted')run.note=DemoStore.VERIFICATION_INTERRUPTED_NOTE;
      }
      return structuredClone(run);
    });
  }
  async listVerifications(serviceId:string,query:VerificationPageQuery={}):Promise<VerificationRunPage>{
    const limit=query.limit??20;
    return this.exclusive(async()=>{
      const rows=this.verificationRuns
        .filter(run=>run.serviceId===serviceId&&(!query.before||Date.parse(run.startedAt)<Date.parse(query.before)))
        .sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt)||(a.id<b.id?1:-1));
      const items=rows.slice(0,limit);
      return {items:structuredClone(items),nextBefore:rows.length>items.length?items.at(-1)?.startedAt??null:null};
    });
  }
  async getReservationSummary(requestId:string):Promise<{amount:number;batchId:string;admission:AdmissionSnapshot|null}|null>{const r=this.reservationsByRequest.get(requestId);return r?{amount:r.amount,batchId:r.batchId,admission:r.admission??null}:null;}
  async listExpiredReservations(){return this.exclusive(async()=>[...this.reservationsByRequest.values()].filter(r=>!r.finalized&&Date.parse(r.expiresAt)<=Date.now()).slice(0,100).map(r=>({requestId:r.requestId,reservationId:r.reservationId})));}
  async renewReservation(requestId:string,reservationId:string){return this.exclusive(async()=>{const r=this.reservationsByRequest.get(requestId);if(!r||r.reservationId!==reservationId||r.finalized||Date.parse(r.expiresAt)<=Date.now())return {renewed:false};r.expiresAt=new Date(Date.now()+300000).toISOString();return {renewed:true,expiresAt:r.expiresAt};});}

  async getQuota(purpose: 'personal' | 'project' = 'personal'): Promise<QuotaSnapshot> {
    const batch = this.quotaBatches.get(purpose === 'personal' ? 'personal-batch-demo-001' : 'project-member-batch-demo-001');
    return {
      purpose,
      projectId: batch?.projectId ?? null,
      currency: 'CNY',
      availableAmount: batch?.availableAmount ?? 0,
      totalAmount: batch?.totalAmount ?? 0,
      sourceId: batch?.id ?? null,
      expiresAt: batch?.expiresAt ?? null,
    };
  }

  async health(): Promise<{ status: 'ok' | 'degraded'; database: string; cache: string }> {
    return { status: 'ok', database: 'memory', cache: 'disabled' };
  }
  /** Caller must hold the workspace transaction/exclusive lock. */
  async reconcileWithinBusinessTransaction(input:ReconciliationRequest,_client?:import('pg').PoolClient):Promise<SettlementResponse>{
    const fingerprint=JSON.stringify(input),previous=this.reconciliationRecords.get(input.requestId);
    if(previous){if(previous.idempotencyKey!==input.idempotencyKey||previous.fingerprint!==fingerprint)throw new ConflictException('request was already reconciled');return {...previous.response,status:'already_finalized'};}
    if([...this.reconciliationRecords.values()].some(record=>record.idempotencyKey===input.idempotencyKey))throw new ConflictException('reconciliation key belongs to another request');
    const reservation=this.reservationsByRequest.get(input.requestId),settlement=this.settlementResponsesByRequest.get(input.requestId),log=this.callLogs.find(log=>log.requestId===input.requestId);
    if(!reservation||settlement?.status!=='pending_review'||!log)throw new ConflictException('only a pending-review reservation may be reconciled');
    const result=reconciliationCalculation(input,reservation.amount,reservation.admission),batch=this.quotaBatches.get(reservation.batchId)!;
    const release=Number((reservation.amount-result.amount).toFixed(6)),available=Number(((batch.closedAt?batch.closedAmount??0:batch.availableAmount)+release).toFixed(6));
    if(available<0||available>batch.totalAmount)throw new ConflictException('original quota batch has insufficient funds or invalid balance');
    if(batch.closedAt)batch.closedAmount=available;else batch.availableAmount=available;
    const response:SettlementResponse={requestId:input.requestId,status:result.billable?'settled':'released',billableState:result.billable?'confirmed':'not_billable',ledgerEntryId:`ledger-${randomUUID()}`};
    this.settlementResponsesByRequest.set(input.requestId,response);this.reconciliationRecords.set(input.requestId,{idempotencyKey:input.idempotencyKey,fingerprint,response});
    log.actualAmount=result.amount;log.billableState=response.billableState;
    if(input.mode==='confirm_usage'){log.inputTokens=input.inputTokens!;log.outputTokens=input.outputTokens!;log.cachedInputTokens=input.cachedInputTokens??0;log.usageFinal=true;}
    this.ledgerEntries.push({id:response.ledgerEntryId!,requestId:input.requestId,reservationId:reservation.reservationId,batchId:reservation.batchId,kind:'reconciliation',amount:result.amount,createdAt:new Date().toISOString()});return response;
  }
  async confirmedAmountsForBatches(ids:string[],_client?:import('pg').PoolClient):Promise<Record<string,number>>{
    const wanted=new Set(ids),amounts:Record<string,number>={};
    for(const log of this.callLogs){const r=this.reservationsByRequest.get(log.requestId);if(r&&wanted.has(r.batchId)&&log.billableState==='confirmed')amounts[r.batchId]=Number(((amounts[r.batchId]??0)+log.actualAmount).toFixed(6));}
    return amounts;
  }
}
