import {jobReceipt,jobUpdate,applyJobReceipt,applyJobUpdate,claimJobCancellation} from './media-jobs';
import {rankRoutes,memoryRouteObservations,recordRoutingOutcome} from './pool-routing';
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
import { scopedAuthorizationKey,scopedSettlementKey,sameAuthorizationScope,authorizationFingerprint, checkSettlementScope, reconciliationCalculation, RESERVATION_AMOUNT, retryLinkAllowed, sameIdentity, settlementAmount, type RetryTarget } from './accounting';
import { admissionOptionsForBatch, admissionDenialMessage, legacyAdmission, publicLogAdmission } from './admission';
import { businessDenial } from '../platform/domain';
import {runtimeMode} from '@ai-gateway/contracts';
import { queryMemoryCalls, callVisible,decodeCursor, type CallScope } from './call-query';
import {validateGatewayTrace,traceQuery,traceMatches} from './gateway-traces';

export interface CredentialRecord {
  credentialId: string;
  apiKey: string;
  identity: RequestIdentity;
  purpose: AuthorizeRequest['purpose'];
  active: boolean;
  modelIds: string[];
}

export interface QuotaBatch {
  accounting?:boolean;
  closedAt?:string|null;closedAmount?:number;returnedAmount?:number;
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
    const fingerprint = authorizationFingerprint(input),originalKey=input.idempotencyKey;input={...input,idempotencyKey:scopedAuthorizationKey(input)};
    const workspace=await this.businessState?.();
    const reason=workspace?businessDenial(workspace,input):null;
    const legacy=this.authorizationInputs.get(originalKey);
    const existing = this.authorizationInputs.get(input.idempotencyKey)??(legacy&&sameAuthorizationScope(legacy.fingerprint,fingerprint)?legacy:undefined);
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
        && (input.purpose!=='application'||!!item.accounting===(workspace?.applications.find(a=>a.id===input.identity.subjectId)?.billingMode==='accounting'))
        && !item.closedAt && new Date(item.expiresAt).getTime() > Date.now(),
    ).sort((a, b) => a.expiresAt.localeCompare(b.expiresAt) || a.id.localeCompare(b.id));
    let batch:QuotaBatch|undefined;
    let admission=legacyAdmission();
    let eligible=0;
    let candidateReason:AuthorizeResponse['reasonCode']='no_quota';
    let candidateLimits:AuthorizeResponse['requestLimits'];
    const windowStart=Math.floor(Date.now()/60000)*60000;
    const activeReservations=[...this.reservationsByRequest.values()].filter(r=>!r.finalized&&Date.parse(r.expiresAt)>Date.now());
    let limitedAdmission:AdmissionSnapshot|undefined;
    const choices:{batch:QuotaBatch;admission:AdmissionSnapshot}[]=[];
    for(const candidate of batches){
      for(const quote of admissionOptionsForBatch(workspace,input,candidate)){
        if(quote.reason){candidateReason=quote.reason;candidateLimits=quote.requestLimits;continue;}
        eligible++;choices.push({batch:candidate,admission:quote.admission});
      }
    }
    const scopeIds=[...new Set(choices.flatMap(choice=>choice.admission.scopes.map(scope=>scope.id)))];
    const counters=scopeIds.map(id=>{
      const window=this.admissionWindows.get(id);
      return {id,requests:window?.start===windowStart?window.requests:0,tokens:window?.start===windowStart?window.tokens:0,active:activeReservations.filter(reservation=>reservation.admission.scopes.some(scope=>scope.id===id)).length};
    });
    const routingAt=Date.now(),serviceIds=[...new Set(choices.flatMap(choice=>choice.admission.route?[choice.admission.route.serviceId]:[]))];
    const observations=memoryRouteObservations(this.callLogs,routingAt,serviceIds);
    const ranked=rankRoutes(choices,workspace??{pools:[]},counters,observations,input.requestId,routingAt);
    const funded=choices.filter(choice=>choice.batch.accounting||choice.batch.availableAmount>=choice.admission.reservedAmount);
    const cooling=funded.length>0&&!ranked.some(choice=>funded.includes(choice));
    for(const choice of ranked){
      const current=choice.admission;
      if(!funded.includes(choice)){recordRoutingOutcome(current,'quota_insufficient');continue;}
      const blocked=current.scopes.filter(scope=>{
        const counter=counters.find(row=>row.id===scope.id)!;
        return scope.rpm!==undefined&&counter.requests+1>scope.rpm||scope.tpm!==undefined&&counter.tokens+current.estimatedTokens>scope.tpm||scope.concurrency!==undefined&&counter.active>=scope.concurrency;
      });
      if(blocked.length){recordRoutingOutcome(current,'capacity',blocked.map(scope=>scope.id));limitedAdmission??=current;continue;}
      recordRoutingOutcome(current,'selected');batch=choice.batch;admission=current;break;
    }
    if (!batch) {
      response.reasonCode = cooling?'service_unavailable':limitedAdmission?'rate_limited':eligible?'quota_insufficient':batches.length?candidateReason:'no_quota';
      if(choices.length)response.admission=limitedAdmission??choices[0].admission;
      if(response.reasonCode==='request_limit_exceeded')response.requestLimits=candidateLimits;
      response.reasonMessage = limitedAdmission?'an applicable subject, pool, service or shared-resource limit is reached':admissionDenialMessage(response.reasonCode,response.requestLimits);
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
    const reservation = this.reservationsByRequest.get(input.requestId);
    if (!reservation || reservation.reservationId !== input.reservationId) {
      throw new ConflictException('reservation does not match request');
    }
    checkSettlementScope(input, reservation);
    input={...input,idempotencyKey:scopedSettlementKey(input,reservation.identity,reservation.purpose)};
    const keyRequest=this.settlementKeys.get(input.idempotencyKey);if(keyRequest&&keyRequest!==input.requestId)throw new ConflictException('settlement key belongs to another request');
    const existing = this.settlementResponsesByRequest.get(input.requestId);
    if (existing) {
      const known=settlementAmount(input,reservation.amount,reservation.admission);
      if(existing.status==='pending_review'&&this.settlementKeys.get(`${input.requestId}:lease-expired`)===input.requestId&&input.usageFinal===true&&input.inputTokens!==undefined&&input.outputTokens!==undefined&&!known.pending&&(known.billable||(input.outcome==='rejected_before_upstream'&&input.forwarded===false))){
        const response=await this.reconcileWithinBusinessTransaction({requestId:input.requestId,idempotencyKey:`${input.idempotencyKey}:recovered-final`,actorId:'system:data-plane-recovery',reason:known.billable?'迟到的完整上游用量，按原预占价格自动核对':'数据面持久化记录确认未转发，释放原预占',mode:known.billable?'confirm_usage':'release_hold',meteredUsage:input.meteredUsage,inputTokens:input.inputTokens,outputTokens:input.outputTokens,cachedInputTokens:input.cachedInputTokens,actualAmount:input.actualAmount});
        const log=this.callLogs.find(log=>log.requestId===input.requestId)!;log.outcome=input.outcome;log.forwarded=input.forwarded??log.forwarded;log.usageFinal=true;log.meteredUsage=input.meteredUsage??null;log.errorCode=input.errorCode??log.errorCode;log.completedAt=input.completedAt;log.latencyMs=Math.max(0,Date.parse(input.completedAt)-Date.parse(log.startedAt));
        if(!known.billable)for(const scope of reservation.admission.scopes){const window=this.admissionWindows.get(scope.id);if(window?.start===reservation.windowStart)window.tokens=Math.max(0,window.tokens-reservation.admission.estimatedTokens+input.inputTokens+input.outputTokens);}
        return response;
      }
      return { ...existing, status: 'already_finalized' };
    }
    if (reservation.finalized) {
      return { requestId: input.requestId, status: 'already_finalized', billableState: 'confirmed', ledgerEntryId: null };
    }
    const batch = this.quotaBatches.get(reservation.batchId);
    if (!batch) throw new ConflictException('quota batch no longer exists');
    const capacity=batch.closedAt?(batch.closedAmount??0):batch.availableAmount;
    const calculated=settlementAmount(input,reservation.amount,reservation.admission,true);
    const additional=Number((calculated.amount-reservation.amount).toFixed(6));
    const actualAmount=calculated.amount,billable=calculated.billable;
    const pendingReview=calculated.pending||(additional>0&&!(batch.accounting&&!batch.closedAt)&&capacity<additional);
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
      meteredUsage:input.meteredUsage??null,requestId: input.requestId,
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
    const workspace=await this.businessState?.(),key=workspace?.keys.find(k=>k.credentialId===credential.credentialId);
    if(key&&(key.status!=='active'||Date.parse(key.expiresAt)<=Date.now()))return null;
    return { credentialId: credential.credentialId, identity: credential.identity, purpose: credential.purpose, modelIds: [...credential.modelIds] };
  }

  async listCalls(): Promise<CallLog[]> {
    return [...this.callLogs].reverse();
  }
  async queryCalls(input:CallQuery,scope:CallScope=null,_client?:import('pg').PoolClient){return queryMemoryCalls(this.callLogs,input,scope);}
  async queryUsage(input:UsageAnalyticsQuery|undefined,scope:CallScope=null,timezone='Asia/Shanghai',_client?:import('pg').PoolClient){return aggregateUsage(this.callLogs,input,scope,timezone);}
  protected readonly mediaJobs=new Map<string,import('@ai-gateway/contracts').MediaJob>();
  private readonly mediaJobLeases=new Map<string,number>();
  async createMediaJob(input:{id:string;requestId:string;reservationId:string}):Promise<import('@ai-gateway/contracts').MediaJob>{
    const prior=[...this.mediaJobs.values()].find(j=>j.requestId===input.requestId);if(prior)return structuredClone(prior);
    const r=this.reservationsByRequest.get(input.requestId);if(!r||r.finalized||r.reservationId!==input.reservationId||r.admission.route?.kind!=='video')throw new ConflictException('active video reservation required');
    const at=new Date().toISOString(),job:import('@ai-gateway/contracts').MediaJob={id:input.id,requestId:input.requestId,reservationId:r.reservationId,identity:structuredClone(r.identity),purpose:r.purpose,modelId:r.modelId,callbackChannelId:r.admission.callbackChannelId??null,route:structuredClone(r.admission.route),status:'submitting',upstreamId:null,createdAt:at,updatedAt:at,meterUnit:r.admission.price?.meter?.unit,estimatedUnits:r.admission.meterEstimate?.quantity??null,result:null,errorCode:null,settled:false};
    this.mediaJobs.set(job.id,job);return structuredClone(job);
  }
  async findMediaJob(requestId:string):Promise<import('@ai-gateway/contracts').MediaJob|null>{return structuredClone([...this.mediaJobs.values()].find(j=>j.requestId===requestId)??null);}
  async getMediaJob(id:string):Promise<import('@ai-gateway/contracts').MediaJob|null>{const job=this.mediaJobs.get(id);return job?structuredClone({...job,reservationFinalized:this.reservationsByRequest.get(job.requestId)?.finalized,reservationStatus:this.settlementResponsesByRequest.get(job.requestId)?.status}):null;}
  async listMediaJobs(limit:number,cursor:string|undefined,scope:CallScope):Promise<import('@ai-gateway/contracts').MediaJob[]>{
    const before=cursor?decodeCursor(cursor):null;
    const rows=[...this.mediaJobs.values()].filter(job=>(!scope||(job.identity.subjectType==='employee'&&job.identity.subjectId===scope.employeeId)||(job.identity.subjectType==='application'&&scope.applicationIds.includes(job.identity.subjectId)))&&(!before||job.createdAt<before[0]||job.createdAt===before[0]&&job.id<before[1])).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id)).slice(0,limit);
    return Promise.all(rows.map(async job=>(await this.getMediaJob(job.id))!));
  }
  async pendingMediaCallbacks(activeChannelIds?:string[]):Promise<import('@ai-gateway/contracts').MediaJob[]>{return structuredClone([...this.mediaJobs.values()].filter(job=>job.callbackChannelId&&(!activeChannelIds||activeChannelIds.includes(job.callbackChannelId))&&!job.callbackQueued&&job.finishedAt&&job.settled).slice(0,100));}
  async markMediaCallbacksQueued(ids:string[]){return this.exclusive(async()=>{for(const id of ids){const job=this.mediaJobs.get(id);if(job)job.callbackQueued=true;}});}
  async claimMediaJobs(_workerId:string):Promise<import('@ai-gateway/contracts').MediaJob[]>{
    return this.exclusive(async()=>{const jobs=[...this.mediaJobs.values()].filter(j=>!j.settled&&(this.mediaJobLeases.get(j.id)??0)<Date.now()).slice(0,4);for(const j of jobs)this.mediaJobLeases.set(j.id,Date.now()+30000);return structuredClone(jobs);});
  }
  async mediaJobReceipt(raw:import('@ai-gateway/contracts').MediaJobReceipt){const v=jobReceipt(raw);return this.exclusive(async()=>{const job=this.mediaJobs.get(v.id);if(!job)throw new ConflictException('job unavailable');if(applyJobReceipt(job,v))this.mediaJobLeases.delete(job.id);return {recorded:true};});}
  async updateMediaJob(raw:import('@ai-gateway/contracts').MediaJobUpdate){const v=jobUpdate(raw);return this.exclusive(async()=>{const job=this.mediaJobs.get(v.id);if(!job)throw new ConflictException('job unavailable');const recorded=applyJobUpdate(job,v);if(recorded)this.mediaJobLeases.delete(job.id);return {recorded};});}
  async claimMediaCancellation(id:string,token:string){return this.exclusive(async()=>{const job=this.mediaJobs.get(id);return {claimed:!!job&&claimJobCancellation(job,token),job:structuredClone(job??null)};});}
  private readonly gatewayTraces=new Map<string,import('@ai-gateway/contracts').GatewayRequestTrace>();
  async recordGatewayTrace(raw:import('@ai-gateway/contracts').GatewayRequestTrace){
    const row=validateGatewayTrace(raw),old=this.gatewayTraces.get(row.attemptId);
    if(!old||!old.completedAt&&old.revision<row.revision&&old.traceId===row.traceId&&old.requestId===row.requestId&&old.startedAt===row.startedAt)this.gatewayTraces.set(row.attemptId,structuredClone(row));
  }
  async queryGatewayTraces(raw:import('@ai-gateway/contracts').GatewayTraceQuery={}):Promise<import('@ai-gateway/contracts').GatewayTracePage>{
    const q=traceQuery(raw),rows=[...this.gatewayTraces.values()].filter(row=>traceMatches(row,q)).sort((a,b)=>b.startedAt.localeCompare(a.startedAt)||b.attemptId.localeCompare(a.attemptId));
    const items=rows.slice(0,q.limit),last=items.at(-1);
    return {items:structuredClone(items),nextCursor:rows.length>q.limit&&last?{at:last.startedAt,id:last.attemptId}:null,collectedAt:new Date().toISOString()};
  }
  async operationalBacklog(filter:import('../platform/operational-metrics').BacklogFilter):Promise<import('../platform/operational-metrics').BacklogSnapshot>{
    const now=Date.now();
    const matches=(route:{serviceId:string;poolId:string}|null|undefined,modelId:string)=>!filter.serviceId||route?.serviceId===filter.serviceId;
    const scoped=(route:{serviceId:string;poolId:string}|null|undefined,modelId:string)=>matches(route,modelId)&&(!filter.poolId||route?.poolId===filter.poolId)&&(!filter.modelId||modelId===filter.modelId);
    const media=[...this.mediaJobs.values()].filter(job=>!job.finishedAt&&scoped(job.route,job.modelId));
    const settlement=this.callLogs.filter(call=>call.billableState==='pending_review'&&scoped(call.admission?.route,call.modelId));
    const stats=(times:string[])=>({count:times.length,oldestSeconds:times.length?Math.max(0,(now-Math.min(...times.map(Date.parse)))/1000):0});
    return {collectedAt:new Date(now).toISOString(),media:stats(media.map(job=>job.createdAt)),settlement:stats(settlement.map(call=>call.completedAt))};
  }
  async upstreamCredentialUsage(id:string){
    const groups=new Map<number,{version:number;calls:number;failures:number;lastUsedAt:string}>();
    for(const call of this.callLogs){
      const credential=call.admission?.route?.credential;
      if(credential?.id!==id||call.forwarded!==true)continue;
      const row=groups.get(credential.version)??{version:credential.version,calls:0,failures:0,lastUsedAt:call.completedAt};
      row.calls++;if(call.outcome!=='completed')row.failures++;if(call.completedAt>row.lastUsedAt)row.lastUsedAt=call.completedAt;
      groups.set(row.version,row);
    }
    return [...groups.values()].sort((a,b)=>b.version-a.version);
  }
  async routeObservations(serviceIds:string[]){return memoryRouteObservations(this.callLogs,Date.now(),serviceIds);}
  async capacityCounters(scopeIds:string[]):Promise<import('@ai-gateway/contracts').CapacityCounters>{
    const now=Date.now(),start=Math.floor(now/60000)*60000;
    const active=new Map<string,number>();
    for(const r of this.reservationsByRequest.values())if(!r.finalized&&Date.parse(r.expiresAt)>now)for(const scope of r.admission.scopes)active.set(scope.id,(active.get(scope.id)??0)+1);
    return {collectedAt:new Date(now).toISOString(),windowStart:new Date(start).toISOString(),windowEnd:new Date(start+60000).toISOString(),rows:[...new Set(scopeIds)].map(scopeId=>{
      const window=this.admissionWindows.get(scopeId);
      return {scopeId,requests:window?.start===start?window.requests:0,tokens:window?.start===start?window.tokens:0,active:active.get(scopeId)??0};
    })};
  }
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
        if(prior.serviceId!==input.serviceId||prior.mappings[0]?.requestFingerprint!==input.mappings[0]?.requestFingerprint)throw new ConflictException('verification key was reused for another request');
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
  async dispatchRoute(requestId:string,reservationId:string,jobId?:string):Promise<import('@ai-gateway/contracts').RouteSnapshot|null>{
    if(jobId){const job=this.mediaJobs.get(jobId);return job?.requestId===requestId&&job.reservationId===reservationId?structuredClone(job.route):null;}
    const reservation=this.reservationsByRequest.get(requestId);
    return reservation?.reservationId===reservationId&&!reservation.finalized&&Date.parse(reservation.expiresAt)>Date.now()?structuredClone(reservation.admission.route):null;
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
    if((!batch.accounting&&available<0)||available+(batch.returnedAmount??0)+(batch.closedAt?batch.availableAmount:batch.closedAmount??0)>batch.totalAmount)throw new ConflictException('original quota batch has insufficient funds or invalid balance');
    if(batch.closedAt)batch.closedAmount=available;else batch.availableAmount=available;
    const response:SettlementResponse={requestId:input.requestId,status:result.billable?'settled':'released',billableState:result.billable?'confirmed':'not_billable',ledgerEntryId:`ledger-${randomUUID()}`};
    this.settlementResponsesByRequest.set(input.requestId,response);this.reconciliationRecords.set(input.requestId,{idempotencyKey:input.idempotencyKey,fingerprint,response});
    log.actualAmount=result.amount;log.billableState=response.billableState;
    if(input.mode==='confirm_usage'){const previousTokens=log.usageFinal===true?log.inputTokens+log.outputTokens:reservation.admission.estimatedTokens;for(const scope of reservation.admission.scopes){const window=this.admissionWindows.get(scope.id);if(window?.start===reservation.windowStart)window.tokens=Math.max(0,window.tokens-previousTokens+(input.inputTokens??0)+(input.outputTokens??0));}log.meteredUsage=input.meteredUsage??null;log.inputTokens=input.inputTokens??0;log.outputTokens=input.outputTokens??0;log.cachedInputTokens=input.cachedInputTokens??0;log.usageFinal=true;}
    this.ledgerEntries.push({id:response.ledgerEntryId!,requestId:input.requestId,reservationId:reservation.reservationId,batchId:reservation.batchId,kind:'reconciliation',amount:result.amount,createdAt:new Date().toISOString()});return response;
  }
  async confirmedAmountsForBatches(ids:string[],_client?:import('pg').PoolClient):Promise<Record<string,number>>{
    const wanted=new Set(ids),amounts:Record<string,number>={};
    for(const log of this.callLogs){const r=this.reservationsByRequest.get(log.requestId);if(r&&wanted.has(r.batchId)&&log.billableState==='confirmed')amounts[r.batchId]=Number(((amounts[r.batchId]??0)+log.actualAmount).toFixed(6));}
    return amounts;
  }
}
