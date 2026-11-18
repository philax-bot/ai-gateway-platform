import {postgresRouteObservations} from './postgres-route-observations';
import {jobReceipt,jobUpdate,applyJobReceipt,applyJobUpdate,claimJobCancellation} from './media-jobs';
import {rankRoutes,recordRoutingOutcome,type RouteObservation} from './pool-routing';
import {guardrailPolicy,type SafetyQuery,type SafetyEvent} from '@ai-gateway/contracts';
import {admissionGuardrail,safetyQuery,safetyCursor} from './guardrail';
import { ConflictException, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import Redis from 'ioredis';
import type { AdmissionSnapshot, AuthorizeRequest, AuthorizeResponse, CallLog, CallQuery, InFlightCount, ReconciliationRequest, SettlementRequest, SettlementResponse, VerificationMappingResult, VerificationMappingSnapshot, VerificationRun, VerificationRunPage, WorkspaceState } from '@ai-gateway/contracts';
import { businessDenial } from '../platform/domain';
import { DemoStore } from './demo.store';
import type { DemoCredential, QuotaSnapshot, StartVerificationInput, VerificationPageQuery } from './control-plane.store';
import { scopedAuthorizationKey,scopedSettlementKey,sameAuthorizationScope,authorizationFingerprint, checkSettlementScope, reconciliationCalculation, RESERVATION_AMOUNT, retryLinkAllowed, sameIdentity, settlementAmount, type RetryTarget } from './accounting';
import { admissionOptionsForBatch, admissionDenialMessage, publicLogAdmission } from './admission';
import { callVisible,decodeCursor, type CallScope } from './call-query';
import { queryPostgresCalls, type CallRow } from './postgres-call-query';
import { credentialLookupValues } from './credential-key';
import { queryPostgresUsage } from './postgres-call-analytics';
import { databaseSchema,runtimeMode } from '@ai-gateway/contracts';
import { applyMigrations,loadMigrations } from './migrations';
import { hotPathDiagnostics } from './hot-path-diagnostics';
import { ADMISSION_POLICY_SQL,lockAdmissionPolicy,type AdmissionWorkspace } from './admission-policy-lock';
import {validateGatewayTrace,traceQuery} from './gateway-traces';

interface VerificationRow {
  id:string; operator_id:string; service_id:string; service_name:string; config_version:number; state:VerificationRun['state'];
  idempotency_key:string; mappings:VerificationMappingSnapshot[]|null; results:VerificationMappingResult[]|null;
  started_at:Date; completed_at:Date|null; lease_expires_at:Date; note:string|null;
}

/** pg may hand back jsonb as parsed JSON or as text; malformed values fail closed to no discovered models. */
function parseModelIds(value:string[]|string|null|undefined):string[]{
  let list:unknown=value;
  if(typeof value==='string'){
    try{list=JSON.parse(value);}
    catch{return [];}
  }
  if(!Array.isArray(list))return [];
  return list.filter((item):item is string=>typeof item==='string'&&item.length>0&&item.length<=160);
}

@Injectable()
export class PostgresStore extends DemoStore implements OnModuleDestroy {
  async withClient<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { return await work(client); } finally { client.release(); }
  }
  private readonly pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10,
    options: ['-c lock_timeout=5000 -c statement_timeout=30000 -c idle_in_transaction_session_timeout=30000',databaseSchema(process.env)?`-c search_path=${databaseSchema(process.env)}`:process.env.PGOPTIONS].filter(Boolean).join(' '),
    application_name:process.env.PGAPPNAME??`atlas-control:${databaseSchema(process.env)??'default'}`,
    keepAlive:true,keepAliveInitialDelayMillis:10000,connectionTimeoutMillis: 5000 });
  private readonly redis = process.env.REDIS_URL
    ? new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null })
    : null;

  constructor(){
    super();
    // pg evicts a broken idle client itself. An unhandled pool error would crash
    // the whole control plane and may dump client connection details to stderr.
    this.pool.on('error',(error:Error&{code?:string})=>{
      const code=typeof error.code==='string'&&/^[A-Z0-9_]{1,40}$/.test(error.code)?error.code:'unavailable';
      console.error(JSON.stringify({event:'postgres_idle_connection_error',code}));
    });
  }

  async initialize(): Promise<void> {
    const directory = [resolve(process.cwd(), 'apps/control-plane/migrations'), resolve(__dirname, '../../migrations')]
      .find((path) => { try { return readdirSync(path).includes('001_initial.sql'); } catch { return false; } });
    if (!directory) throw new Error('control-plane migrations were not found');
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const schema=databaseSchema(process.env);if(schema&&(await client.query('select current_schema() as name')).rows[0].name!==schema)throw new Error('Configured DATABASE_SCHEMA must already exist and be accessible');
      await applyMigrations(client,loadMigrations(directory));
      const mode=runtimeMode(process.env),installation=await client.query('select mode,admission_lock_version from platform_installation where singleton=true for update');
      if(installation.rowCount&&installation.rows[0].mode!==mode)throw new Error('Database installation mode differs; choose the matching mode or a separate schema');
      if(installation.rowCount&&installation.rows[0].admission_lock_version!==2)throw new Error('Database admission lock protocol is incompatible');
      if(mode==='production'){
        const fixtures=await client.query(`select credential_id from credentials where api_key in ('local-employee-key','local-project-key') union all select id from quota_batches where id in ('personal-batch-demo-001','project-member-batch-demo-001') union all select id from platform_workspace where payload->'members' @> '[{"id":"operator-demo-001"}]'::jsonb or payload->'members' @> '[{"id":"employee-demo-001"}]'::jsonb or payload->'definitions' @> '[{"id":"definition-test-model"}]'::jsonb`);
        if(fixtures.rowCount)throw new Error('Development fixtures detected; use a separate clean production schema');
      }
      await client.query('insert into platform_installation(singleton,mode) values(true,$1) on conflict do nothing',[mode]);
      // Development fixtures are insert-only; service restarts never reset balances or re-enable keys.
      for (const c of this.credentials.values()) {
        await client.query(`insert into credentials(credential_id,api_key,identity,purpose,model_ids)
          values($1,$2,$3,$4,$5) on conflict do nothing`,
          [c.credentialId, c.apiKey, c.identity, c.purpose, JSON.stringify(c.modelIds)]);
      }
      for (const b of this.quotaBatches.values()) {
        await client.query(`insert into quota_batches(id,source_type,source_id,purpose,total_amount,available_amount,model_ids,expires_at,organization_id,project_id)
          values($1,$2,$3,$4,$5,$5,$6,$7,$8,$9) on conflict do nothing`,
          [b.id,b.sourceType,b.sourceId,b.purpose,b.totalAmount,JSON.stringify(b.modelIds),b.expiresAt,b.organizationId,b.projectId]);
      }
      if(runtimeMode(process.env)!=='production')await client.query(`update credentials set model_ids='["test-model"]'::jsonb
        where credential_id='credential-demo-001' and jsonb_typeof(model_ids) <> 'array';
        update quota_batches set model_ids='["test-model"]'::jsonb
        where id='personal-batch-demo-001' and jsonb_typeof(model_ids) <> 'array'`);
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
    // A crash can leave a running verification lease behind; report it as interrupted,
    // never resend a request that may already have reached the upstream.
    await this.interruptStaleVerifications();
  }

  async onModuleDestroy(): Promise<void> { this.redis?.disconnect(); await this.pool.end(); }

  private async lock(client: PoolClient, keys: string[]): Promise<void> {
    if(keys.length)await client.query('select gateway_lock_keys($1::text[])',[[...new Set(keys)].sort()]);
  }

  private async saveAuthorization(client:PoolClient,input:AuthorizeRequest,response:AuthorizeResponse,fingerprint:string){
    await client.query('insert into authorization_records(request_id,response,idempotency_key,fingerprint) values($1,$2,$3,$4)',[input.requestId,response,input.idempotencyKey,fingerprint]);
    if(response.guardrail){const e=response.guardrail;await client.query('insert into safety_events(id,request_id,subject_id,purpose,project_id,model_id,policy_version,action,matches,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[e.id,e.requestId,e.subjectId,e.purpose,e.projectId,e.modelId,e.policyVersion,e.action,JSON.stringify(e.matches),e.createdAt]);}
    if(response.decision==='deny'){
      const c=this.deniedCall(input,response);
      await client.query(`insert into call_logs(request_id,started_at,completed_at,subject_type,subject_id,credential_id,purpose,model_id,outcome,input_tokens,output_tokens,cached_input_tokens,actual_amount,billable_state,project_id,admission,organization_id,latency_ms,usage_final,forwarded,error_code,retry_of_request_id)
        values($1,$2,$2,$3,$4,$5,$6,$7,'rejected_before_upstream',0,0,0,0,'not_billable',$8,$9,$10,0,true,false,$11,$12)`,[c.requestId,c.completedAt,c.subjectType,c.subjectId,c.credentialId,c.purpose,c.modelId,c.projectId,response.admission?{...response.admission,reservedAmount:0}:null,c.organizationId,c.errorCode,c.retryOfRequestId??null]);
      if(response.guardrail)await client.query('update call_logs set safety=$2 where request_id=$1',[input.requestId,response.guardrail]);
    }
  }

  async authorize(input: AuthorizeRequest): Promise<AuthorizeResponse> {
    const fingerprint = authorizationFingerprint(input),originalKey=input.idempotencyKey;input={...input,idempotencyKey:scopedAuthorizationKey(input)};
    const trace=hotPathDiagnostics.start('authorize');
    const raw=await this.pool.connect().catch(error=>{trace.finish(true);throw error;});
    const client=trace.acquired(raw);let failed=false;
    try {
      await client.query('begin isolation level read committed');
      await this.lock(client, [`authorize-key:${input.idempotencyKey}`, `authorize-request:${input.requestId}`]);
      const found=await client.query('select * from authorization_records where idempotency_key=$1 or request_id=$2 or idempotency_key=$3',[input.idempotencyKey,input.requestId,originalKey]);
      const rows=found.rows.filter(r=>r.idempotency_key===input.idempotencyKey||r.request_id===input.requestId||sameAuthorizationScope(r.fingerprint,fingerprint));
      const previous={rowCount:rows.length,rows};
      if (previous.rowCount) {
        const r = previous.rows[0];
        if (![input.idempotencyKey,originalKey].includes(r.idempotency_key) || r.fingerprint !== fingerprint) throw new ConflictException('authorization key or request ID was reused with different input');
        await client.query('commit');
        return { ...(r.response as AuthorizeResponse), replayed: true };
      }
      await lockAdmissionPolicy(client,true);
      const workspace=await client.query(`select ${ADMISSION_POLICY_SQL} as payload from platform_workspace where id=$1`,['org-demo']);
      const reason=workspace.rowCount?businessDenial(workspace.rows[0].payload as AdmissionWorkspace,input):null;
      if(input.retryOfRequestId){
        if(!retryLinkAllowed(input,await this.retryTargetWithin(client,input.retryOfRequestId)))throw new ConflictException('retry reference is not available');
      }
      const response: AuthorizeResponse = { ...(input.admissionAttemptId?{admissionAttemptId:input.admissionAttemptId}:{}),requestId: input.requestId, decision: 'deny', reasonCode: 'none', reasonMessage: '', policyVersion: input.policyVersion, reservation: null };
      if(reason){response.reasonCode=reason;response.reasonMessage=admissionDenialMessage(reason);await this.saveAuthorization(client,input,response,fingerprint);await client.query('commit');return response;}
      const result = await client.query('select * from credentials where credential_id=$1', [input.identity.credentialId]);
      const c = result.rows[0];
      if (!c || !c.active) {
        response.reasonCode = c ? 'subject_disabled' : 'credential_invalid'; response.reasonMessage = 'credential is unknown or disabled';
      } else if (!sameIdentity(c.identity, input.identity) || c.purpose !== input.purpose) {
        response.reasonCode = 'credential_invalid'; response.reasonMessage = 'credential identity or purpose does not match';
      } else if (!(Array.isArray(c.model_ids) ? c.model_ids : JSON.parse(c.model_ids)).includes(input.modelId)) {
        response.reasonCode = 'model_not_open'; response.reasonMessage = 'model is not open for this credential';
      } else if((response.guardrail=admissionGuardrail(workspace.rows[0]?.payload?.guardrail,input)??undefined)?.action==='block'){
        response.reasonCode='safety_policy_violation';response.reasonMessage='输入可能包含受限制的信息，已按企业安全策略阻止发送。请修改后重试。';
      } else {
        const accounting=input.purpose==='application'&&workspace.rows[0]?.payload?.applications?.find((a:{id:string})=>a.id===input.identity.subjectId)?.billingMode==='accounting';
        const values = [input.purpose,input.identity.subjectId,input.identity.organizationId ?? null,input.identity.projectId ?? null,JSON.stringify([input.modelId]),accounting];
        const scope = 'purpose=$1 and source_id=$2 and organization_id is not distinct from $3 and project_id is not distinct from $4 and model_ids @> $5::jsonb and expires_at > now() and closed_at is null and accounting=$6';
        const batches = await client.query(`select * from quota_batches where ${scope} order by expires_at,id for update`, values);
        let b:Record<string,any>|undefined,admission:AdmissionSnapshot|undefined,eligible=0;
        let candidateReason:AuthorizeResponse['reasonCode']='no_quota';
        let candidateLimits:AuthorizeResponse['requestLimits'];
        const choices:{batch:Record<string,any>;admission:AdmissionSnapshot}[]=[];
        for(const candidate of batches.rows){
          for(const quote of admissionOptionsForBatch(workspace.rows[0]?.payload as AdmissionWorkspace|undefined,input,{sourceId:candidate.source_id,purpose:candidate.purpose,projectId:candidate.project_id,entitlementId:candidate.entitlement_id})){
            if(quote.reason){candidateReason=quote.reason;candidateLimits=quote.requestLimits;continue;}eligible++;
            choices.push({batch:candidate,admission:quote.admission});
          }
        }
        // Lock the union once, in the existing canonical order, before checking any route.
        const candidateScopeIds=[...new Set(choices.flatMap(choice=>choice.admission.scopes.map(scope=>scope.id)))];
        await this.lock(client,candidateScopeIds.map(id=>`limit:${id}`));
        const windowResult=await client.query("select date_trunc('minute',clock_timestamp()) as start,clock_timestamp() as now");
        const windowStart=windowResult.rows[0].start as Date;
        const limits=await client.query(`select s.id,coalesce(w.requests,0) as requests,coalesce(w.tokens,0) as tokens,
          (select count(*)::int from reservation_limit_scopes r where r.scope_id=s.id and r.active=true and r.expires_at>clock_timestamp()) as active
          from unnest($1::text[]) s(id) left join admission_windows w on w.scope_id=s.id and w.window_start=$2`,[candidateScopeIds,windowStart]);
        const routingState=workspace.rows[0]?.payload as AdmissionWorkspace|undefined;
        let observations:RouteObservation[]=[];
        if(routingState?.pools.some(p=>p.routing&&(p.routing.strategy==='latency'||p.routing.failureThreshold>0))){
          const ids=[...new Set(choices.map(c=>c.admission.route?.serviceId).filter(Boolean))];
          observations=await postgresRouteObservations(client,ids as string[]);
        }
        const ranked=rankRoutes(choices,routingState??{pools:[]},limits.rows.map(r=>({id:r.id,requests:Number(r.requests),tokens:Number(r.tokens),active:Number(r.active)})),observations,input.requestId,windowResult.rows[0].now.getTime());
        const funded=choices.filter(choice=>choice.batch.accounting||Number(choice.batch.available_amount)>=choice.admission.reservedAmount);
        const cooling=funded.length>0&&!ranked.some(choice=>funded.includes(choice));
        const selected=ranked.find(choice=>{
          if(!funded.includes(choice)){recordRoutingOutcome(choice.admission,'quota_insufficient');return false;}
          const blocked=choice.admission.scopes.filter(scope=>{
            const row=limits.rows.find(row=>row.id===scope.id)!;
            return (scope.rpm!==undefined&&Number(row.requests)+1>scope.rpm)||(scope.tpm!==undefined&&Number(row.tokens)+choice.admission.estimatedTokens>scope.tpm)||(scope.concurrency!==undefined&&Number(row.active)>=scope.concurrency);
          });
          if(blocked.length){recordRoutingOutcome(choice.admission,'capacity',blocked.map(scope=>scope.id));return false;}
          recordRoutingOutcome(choice.admission,'selected');return true;
        });
        b=selected?.batch;admission=selected?.admission;
        if (!b) {
          response.reasonCode = cooling?'service_unavailable':funded.length?'rate_limited':eligible?'quota_insufficient':batches.rowCount?candidateReason:'no_quota';
          if(choices.length)response.admission=choices[0].admission;
          if(response.reasonCode==='request_limit_exceeded')response.requestLimits=candidateLimits;
          response.reasonMessage=choices.length?'an applicable subject, pool, service or shared-resource limit is reached':admissionDenialMessage(response.reasonCode,response.requestLimits);
        } else {
          const a=admission!;
          await client.query('update quota_batches set available_amount=available_amount-$1 where id=$2', [a.reservedAmount,b.id]);
          const reservationId = `reservation-${randomUUID()}`; const expiresAt = new Date(windowResult.rows[0].now.getTime()+300000).toISOString();
          response.decision = 'allow';response.admission=a; response.reservation = { reservationId,sourceType:b.source_type,sourceId:b.id,reservedAmount:a.reservedAmount,currency:'CNY',expiresAt };
          await client.query(`insert into reservations(reservation_id,request_id,idempotency_key,fingerprint,amount,batch_id,identity,purpose,model_id,created_at,expires_at,admission,retry_of_request_id)
            values($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10,$11,$12)`, [reservationId,input.requestId,input.idempotencyKey,fingerprint,a.reservedAmount,b.id,input.identity,input.purpose,input.modelId,expiresAt,a,input.retryOfRequestId??null]);
          const scopeIds=a.scopes.map(scope=>scope.id);
          await client.query(`insert into admission_windows(scope_id,window_start,requests,tokens) select id,$2,1,$3 from unnest($1::text[]) s(id)
            on conflict(scope_id,window_start) do update set requests=admission_windows.requests+1,tokens=admission_windows.tokens+excluded.tokens`,[scopeIds,windowStart,a.estimatedTokens]);
          await client.query(`insert into reservation_limit_scopes(reservation_id,scope_id,window_start,estimated_tokens,expires_at)
            select $1,id,$3,$4,$5 from unnest($2::text[]) s(id)`,[reservationId,scopeIds,windowStart,a.estimatedTokens,expiresAt]);
        }
      }
      await this.saveAuthorization(client,input,response,fingerprint);
      await client.query('commit'); return response;
    } catch (error) { failed=true;await client.query('rollback'); throw error; } finally { trace.finish(failed);raw.release(); }
  }

  async settle(input: SettlementRequest): Promise<SettlementResponse> {
    settlementAmount(input, RESERVATION_AMOUNT);
    // Scope caller-selected settlement keys after resolving the reservation identity.
    const trace=hotPathDiagnostics.start('settle');
    const raw=await this.pool.connect().catch(error=>{trace.finish(true);throw error;});
    const client=trace.acquired(raw);let failed=false;
    try {
      await client.query('begin');
      await this.lock(client, [`settle-request:${input.requestId}`]);
      const result = await client.query('select * from reservations where request_id=$1 for update', [input.requestId]);
      const r = result.rows[0];
      if (!r || r.reservation_id !== input.reservationId) throw new ConflictException('reservation does not match request');
      checkSettlementScope(input, { identity:r.identity,purpose:r.purpose,modelId:r.model_id });
      input={...input,idempotencyKey:scopedSettlementKey(input,r.identity,r.purpose)};await this.lock(client,[`settle-key:${input.idempotencyKey}`]);
      const previous = await client.query('select * from settlement_records where request_id=$1 or idempotency_key=$2', [input.requestId,input.idempotencyKey]);
      if (previous.rows.some((p) => p.request_id !== input.requestId)) throw new ConflictException('settlement key belongs to another request');
      if (previous.rowCount) {
        const known=settlementAmount(input,Number(r.amount),r.admission);
        if(previous.rows[0].response?.status==='pending_review'&&previous.rows[0].idempotency_key===`${input.requestId}:lease-expired`&&input.usageFinal===true&&input.inputTokens!==undefined&&input.outputTokens!==undefined&&!known.pending&&(known.billable||(input.outcome==='rejected_before_upstream'&&input.forwarded===false))){
          const recovered=await this.reconcileWithinBusinessTransaction({requestId:input.requestId,idempotencyKey:`${input.idempotencyKey}:recovered-final`,actorId:'system:data-plane-recovery',reason:known.billable?'迟到的完整上游用量，按原预占价格自动核对':'数据面持久化记录确认未转发，释放原预占',mode:known.billable?'confirm_usage':'release_hold',meteredUsage:input.meteredUsage,inputTokens:input.inputTokens,outputTokens:input.outputTokens,cachedInputTokens:input.cachedInputTokens,actualAmount:input.actualAmount},client);
          if(!known.billable){const scopes=await client.query('select scope_id from reservation_limit_scopes where reservation_id=$1',[r.reservation_id]);await this.lock(client,scopes.rows.map(scope=>`limit:${scope.scope_id}`));await client.query(`update admission_windows w set tokens=greatest(0,w.tokens-(r.estimated_tokens-$2::bigint-$3::bigint)) from reservation_limit_scopes r where r.reservation_id=$1 and w.scope_id=r.scope_id and w.window_start=r.window_start`,[r.reservation_id,input.inputTokens,input.outputTokens]);}
          await client.query('update call_logs set outcome=$1,completed_at=$2,latency_ms=$3,forwarded=coalesce($5,forwarded),usage_final=true,error_code=coalesce($6,error_code) where request_id=$4',[input.outcome,input.completedAt,Math.max(0,Math.min(2147483647,Date.parse(input.completedAt)-r.created_at.getTime())),input.requestId,input.forwarded??null,input.errorCode??null]);await client.query('commit');return recovered;
        }
        await client.query('commit');
        return { ...(previous.rows[0].response as SettlementResponse),status:'already_finalized' };
      }
      if (r.finalized) throw new ConflictException('finalized reservation has no settlement record');
      const calculated=settlementAmount(input,Number(r.amount),r.admission as AdmissionSnapshot|null,true);
      const {amount,billable}=calculated;let pending=calculated.pending;
      if(!pending){
        const release=Number((Number(r.amount)-amount).toFixed(6));
        // Conditional UPDATE is the funding lock: concurrent completions cannot
        // spend the same available balance or debit another purpose/batch.
        const funded=await client.query(`update quota_batches set
          available_amount=available_amount+case when closed_at is null then $1::numeric else 0 end,
          closed_amount=closed_amount+case when closed_at is not null then $1::numeric else 0 end
          where id=$2 and ((accounting and closed_at is null) or (case when closed_at is null then available_amount else closed_amount end)+$1>=0)
          returning id`,[release,r.batch_id]);
        if(!funded.rowCount)pending=true;
      }
      await client.query('update reservations set finalized=true where reservation_id=$1', [r.reservation_id]);
      const response: SettlementResponse = pending
        ? { requestId:input.requestId,status:'pending_review',billableState:'pending_review',ledgerEntryId:null }
        : { requestId:input.requestId,status:billable?'settled':'released',billableState:billable?'confirmed':'not_billable',ledgerEntryId:`ledger-${randomUUID()}` };
      const scopes=await client.query('select * from reservation_limit_scopes where reservation_id=$1',[r.reservation_id]);
      await this.lock(client,scopes.rows.map(scope=>`limit:${scope.scope_id}`));
      await client.query('update reservation_limit_scopes set active=false where reservation_id=$1',[r.reservation_id]);
      if(input.usageFinal!==false&&input.inputTokens!==undefined&&input.outputTokens!==undefined){
        await client.query(`update admission_windows w set tokens=greatest(0,w.tokens-(r.estimated_tokens-$2::bigint-$3::bigint))
          from reservation_limit_scopes r where r.reservation_id=$1 and w.scope_id=r.scope_id and w.window_start=r.window_start`,[r.reservation_id,input.inputTokens,input.outputTokens]);
      }
      if(response.ledgerEntryId)await client.query('insert into usage_ledger_entries(id,request_id,reservation_id,batch_id,kind,amount,detail) values($1,$2,$3,$4,$5,$6,$7)',[response.ledgerEntryId,input.requestId,r.reservation_id,r.batch_id,billable?'settlement':'release',amount,{reservedAmount:Number(r.amount),releasedAmount:Number(r.amount)-amount,admission:r.admission}]);
      await client.query('insert into settlement_records(request_id,idempotency_key,response) values($1,$2,$3)', [input.requestId,input.idempotencyKey,response]);
      await client.query(`insert into call_logs(request_id,started_at,completed_at,subject_type,subject_id,credential_id,purpose,model_id,outcome,input_tokens,output_tokens,cached_input_tokens,actual_amount,billable_state,reservation_id,project_id,admission,organization_id,latency_ms,usage_final,forwarded,upstream_request_id,retry_of_request_id,ttft_ms,error_code)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`, [input.requestId,r.created_at,input.completedAt,r.identity.subjectType,r.identity.subjectId,r.identity.credentialId,r.purpose,r.model_id,input.outcome,input.inputTokens??0,input.outputTokens??0,input.cachedInputTokens??0,amount,response.billableState,r.reservation_id,r.identity.projectId??null,r.admission,r.identity.organizationId??null,Math.max(0,Math.min(2147483647,Date.parse(input.completedAt)-r.created_at.getTime())),input.usageFinal!==false&&input.inputTokens!==undefined&&input.outputTokens!==undefined,input.forwarded??(input.outcome==='rejected_before_upstream'?false:null),input.upstreamRequestId??null,r.retry_of_request_id??null,input.ttftMs??null,input.errorCode??null]);
      if(input.meteredUsage)await client.query('update call_logs set metered_usage=$2 where request_id=$1',[input.requestId,JSON.stringify(input.meteredUsage)]);
      await client.query("update call_logs set safety=(select response->'guardrail' from authorization_records where request_id=$1) where request_id=$1",[input.requestId]);
      await client.query('commit'); return response;
    } catch (error) { failed=true;await client.query('rollback'); throw error; } finally { trace.finish(failed);raw.release(); }
  }

  async getDemoCredential(apiKey: string): Promise<DemoCredential | null> {
    if(typeof apiKey!=='string'||apiKey.length>4096)return null;
    const trace=hotPathDiagnostics.start('resolve_credential');
    const raw=await this.pool.connect().catch(error=>{trace.finish(true);throw error;});
    const client=trace.acquired(raw);let failed=false;
    try{
      // Only derived lookup values are matched; a persisted hash never authenticates by itself.
      const result=await client.query("select * from credentials where api_key=any($1::text[]) and active=true and not exists(select 1 from platform_workspace w cross join lateral jsonb_array_elements(w.payload->'keys') k where k->>'credentialId'=credentials.credential_id and (k->>'status'<>'active' or (k->>'expiresAt')::timestamptz<=clock_timestamp()))",[credentialLookupValues(apiKey)]);
      const r=result.rows[0];return r?{credentialId:r.credential_id,identity:r.identity,purpose:r.purpose,modelIds:parseModelIds(r.model_ids)}:null;
    }catch(error){failed=true;throw error;}finally{trace.finish(failed);raw.release();}
  }
  async readGuardrailPolicy(){const r=await this.pool.query("select payload->'guardrail' as policy from platform_workspace where id='org-demo'");return guardrailPolicy(r.rows[0]?.policy);}
  async querySafety(input:SafetyQuery={}){
    const {query:q,limit,cursor}=safetyQuery(input),values:unknown[]=[],conditions:string[]=[];
    const condition=(sql:string,value:unknown)=>{values.push(value);conditions.push(sql.replace('?',`$${values.length}`));};
    for(const [key,column]of [['modelId','model_id'],['subjectId','subject_id'],['requestId','request_id'],['action','action']]as const)if(q[key])condition(`${column}=?`,q[key]);
    if(q.from)condition('created_at>=?',q.from);if(q.to)condition('created_at<=?',q.to);
    if(q.category)condition('matches @> ?::jsonb',JSON.stringify([{category:q.category}]));
    const base=conditions.length?' where '+conditions.join(' and '):'';
    return this.withClient(async client=>{await client.query('begin isolation level repeatable read read only');try{
      const counts=(await client.query(`select count(*) filter(where action='block')::int as block,count(*) filter(where action='observe')::int as observe from safety_events${base}`,values)).rows[0];
      if(cursor){values.push(cursor.at,cursor.id);conditions.push(`(created_at,id)<($${values.length-1}::timestamptz,$${values.length})`);}
      values.push(limit+1);const result=await client.query(`select * from safety_events${conditions.length?' where '+conditions.join(' and '):''} order by created_at desc,id desc limit $${values.length}`,values);
      const events:SafetyEvent[]=result.rows.map(r=>({id:r.id,requestId:r.request_id,subjectId:r.subject_id,purpose:r.purpose,projectId:r.project_id,modelId:r.model_id,policyVersion:r.policy_version,action:r.action,matches:r.matches,createdAt:r.created_at.toISOString()})),items=events.slice(0,limit);
      await client.query('commit');return {items,nextCursor:events.length>limit?safetyCursor(items.at(-1)!):null,counts};
    }catch(error){await client.query('rollback');throw error;}});
  }
  async listCalls(): Promise<CallLog[]> {
    const result=await this.pool.query('select * from call_logs order by completed_at desc limit 200');
    return result.rows.map(r=>this.mapCall(r));
  }
  // Statistics failures must leave the caller's business transaction usable so
  // collection errors can be recorded. Reuse its connection instead of waiting
  // for another pool slot while holding the workspace lock.
  private async statisticsWithin<T>(client:PoolClient,read:()=>Promise<T>):Promise<T>{
    await client.query('savepoint statistics_read');
    try{const result=await read();await client.query('release savepoint statistics_read');return result;}
    catch(error){await client.query('rollback to savepoint statistics_read');await client.query('release savepoint statistics_read');throw error;}
  }
  async queryCalls(input:CallQuery,scope:CallScope=null,existingClient?:PoolClient){
    if(existingClient)return this.statisticsWithin(existingClient,()=>queryPostgresCalls(existingClient,input,scope,r=>this.mapCall(r)));
    const trace=hotPathDiagnostics.start('query_calls');
    return this.withClient(async raw=>{
      const client=trace.acquired(raw);let failed=false;
      await client.query('begin isolation level repeatable read read only');
      try{const result=await queryPostgresCalls(client,input,scope,r=>this.mapCall(r));await client.query('commit');return result;}
      catch(error){failed=true;await client.query('rollback');throw error;}finally{trace.finish(failed);}
    }).catch(error=>{trace.finish(true);throw error;});
  }
  async queryUsage(input:import('@ai-gateway/contracts').UsageAnalyticsQuery|undefined,scope:CallScope=null,timezone='Asia/Shanghai',existingClient?:PoolClient){
    if(existingClient)return this.statisticsWithin(existingClient,()=>queryPostgresUsage(existingClient,input,scope,timezone));
    const trace=hotPathDiagnostics.start('query_usage');
    return this.withClient(async raw=>{
      const client=trace.acquired(raw);let failed=false;
      await client.query('begin isolation level repeatable read read only');
      try{const result=await queryPostgresUsage(client,input,scope,timezone);await client.query('commit');return result;}
      catch(error){failed=true;await client.query('rollback');throw error;}finally{trace.finish(failed);}
    }).catch(error=>{trace.finish(true);throw error;});
  }
  private mapCall(r:CallRow):CallLog{return {meteredUsage:r.metered_usage??null,safety:r.safety??null,requestId:r.request_id,upstreamRequestId:r.upstream_request_id??null,retryOfRequestId:r.retry_of_request_id??null,startedAt:r.started_at.toISOString(),completedAt:r.completed_at.toISOString(),subjectType:r.subject_type,subjectId:r.subject_id,credentialId:r.credential_id,purpose:r.purpose,projectId:r.project_id,modelId:r.model_id,outcome:r.outcome,inputTokens:r.input_tokens,outputTokens:r.output_tokens,cachedInputTokens:r.cached_input_tokens,actualAmount:Number(r.actual_amount),billableState:r.billable_state,reservationId:r.reservation_id,admission:publicLogAdmission(r.admission as AdmissionSnapshot|null),organizationId:r.organization_id,errorCode:r.error_code,latencyMs:r.latency_ms,usageFinal:r.usage_final??undefined,forwarded:r.forwarded??null,ttftMs:r.ttft_ms??null};}
  async createMediaJob(input:{id:string;requestId:string;reservationId:string}):Promise<import('@ai-gateway/contracts').MediaJob>{
    return this.withClient(async client=>{await client.query('begin');try{
      const old=await client.query('select payload from model_media_jobs where request_id=$1',[input.requestId]);if(old.rowCount){await client.query('commit');return old.rows[0].payload;}
      const r=(await client.query('select * from reservations where request_id=$1 and reservation_id=$2 and finalized=false for update',[input.requestId,input.reservationId])).rows[0];if(!r||r.admission?.route?.kind!=='video')throw new ConflictException('active video reservation required');
      const at=new Date().toISOString(),job:import('@ai-gateway/contracts').MediaJob={id:input.id,requestId:input.requestId,reservationId:input.reservationId,identity:r.identity,purpose:r.purpose,modelId:r.model_id,callbackChannelId:r.admission.callbackChannelId??null,route:r.admission.route,status:'submitting',upstreamId:null,createdAt:at,updatedAt:at,meterUnit:r.admission.price?.meter?.unit,estimatedUnits:r.admission.meterEstimate?.quantity??null,result:null,errorCode:null,settled:false};
      await client.query('insert into model_media_jobs(id,request_id,payload) values($1,$2,$3)',[job.id,job.requestId,JSON.stringify(job)]);await client.query('commit');return job;
    }catch(error){await client.query('rollback');throw error;}});
  }
  async findMediaJob(requestId:string):Promise<import('@ai-gateway/contracts').MediaJob|null>{return (await this.pool.query('select payload from model_media_jobs where request_id=$1',[requestId])).rows[0]?.payload??null;}
  async getMediaJob(id:string):Promise<import('@ai-gateway/contracts').MediaJob|null>{const row=(await this.pool.query("select j.payload,r.finalized,s.response->>'status' as reservation_status from model_media_jobs j left join reservations r using(request_id) left join settlement_records s using(request_id) where j.id=$1",[id])).rows[0];return row?{...row.payload,reservationFinalized:row.finalized,reservationStatus:row.reservation_status??undefined}:null;}
  override async listMediaJobs(limit:number,cursor:string|undefined,scope:CallScope):Promise<import('@ai-gateway/contracts').MediaJob[]>{
    const before=cursor?decodeCursor(cursor):null;
    const result=await this.pool.query(`select j.payload,r.finalized,s.response->>'status' as reservation_status
      from model_media_jobs j left join reservations r using(request_id) left join settlement_records s using(request_id)
      where ($1::boolean or j.payload->'identity'->>'subjectType'='employee' and j.payload->'identity'->>'subjectId'=$2 or j.payload->'identity'->>'subjectType'='application' and j.payload->'identity'->>'subjectId'=any($3::text[]))
      and ($4::text is null or (j.payload->>'createdAt',j.id::text)<($4,$5))
      order by j.payload->>'createdAt' desc,j.id desc limit $6`,[scope===null,scope?.employeeId??null,scope?.applicationIds??[],before?.[0]??null,before?.[1]??null,limit]);
    return result.rows.map(row=>({...row.payload,reservationFinalized:row.finalized,reservationStatus:row.reservation_status??undefined}));
  }
  override async pendingMediaCallbacks(activeChannelIds?:string[]):Promise<import('@ai-gateway/contracts').MediaJob[]>{
    return (await this.pool.query("select payload from model_media_jobs where payload->>'callbackChannelId' is not null and coalesce(payload->>'callbackQueued','false')='false' and payload->>'finishedAt' is not null and payload->>'settled'='true' and ($1::text[] is null or payload->>'callbackChannelId'=any($1::text[])) order by updated_at limit 100",[activeChannelIds??null])).rows.map(row=>row.payload);
  }
  override async markMediaCallbacksQueued(ids:string[]){await this.pool.query("update model_media_jobs set payload=jsonb_set(payload,'{callbackQueued}','true'::jsonb) where id::text=any($1::text[])",[ids]);}
  async claimMediaJobs(workerId:string):Promise<import('@ai-gateway/contracts').MediaJob[]>{
    return (await this.pool.query(`with claimed as(select id from model_media_jobs where payload->>'settled'='false' and (lease_until is null or lease_until<now()) order by updated_at limit 4 for update skip locked)
      update model_media_jobs j set lease_until=now()+interval '30 seconds',lease_owner=$1 from claimed c where j.id=c.id returning j.payload`,[workerId])).rows.map(r=>r.payload);
  }
  private async mutateMediaJob<T>(id:string,change:(job:import('@ai-gateway/contracts').MediaJob|null)=>{changed:boolean;value:T}){return this.withClient(async client=>{await client.query('begin');try{const row=(await client.query('select payload from model_media_jobs where id=$1 for update',[id])).rows[0];const result=change(row?.payload??null);if(result.changed)await client.query('update model_media_jobs set payload=$2,updated_at=now(),lease_until=null where id=$1',[id,JSON.stringify(row.payload)]);await client.query('commit');return result.value;}catch(error){await client.query('rollback');throw error;}});}
  async mediaJobReceipt(raw:import('@ai-gateway/contracts').MediaJobReceipt){const v=jobReceipt(raw);return this.mutateMediaJob(v.id,job=>{if(!job)throw new ConflictException('job unavailable');return {changed:applyJobReceipt(job,v),value:{recorded:true}};});}
  async updateMediaJob(raw:import('@ai-gateway/contracts').MediaJobUpdate){const v=jobUpdate(raw);return this.mutateMediaJob(v.id,job=>{if(!job)throw new ConflictException('job unavailable');const recorded=applyJobUpdate(job,v);return {changed:recorded,value:{recorded}};});}
  async claimMediaCancellation(id:string,token:string){return this.mutateMediaJob(id,job=>{const claimed=!!job&&claimJobCancellation(job,token);return {changed:claimed,value:{claimed,job}};});}
  async recordGatewayTrace(raw:import('@ai-gateway/contracts').GatewayRequestTrace){
    const row=validateGatewayTrace(raw);
    await this.pool.query(`insert into gateway_request_traces(attempt_id,request_id,trace_id,started_at,revision,payload) values($1,$2,$3,$4,$5,$6)
      on conflict(attempt_id) do update set revision=excluded.revision,payload=excluded.payload
      where gateway_request_traces.revision<excluded.revision and gateway_request_traces.payload->>'completedAt' is null
      and gateway_request_traces.request_id=excluded.request_id and gateway_request_traces.trace_id=excluded.trace_id and gateway_request_traces.started_at=excluded.started_at`,[row.attemptId,row.requestId,row.traceId,row.startedAt,row.revision,JSON.stringify(row)]);
  }
  async queryGatewayTraces(raw:import('@ai-gateway/contracts').GatewayTraceQuery={}):Promise<import('@ai-gateway/contracts').GatewayTracePage>{
    const q=traceQuery(raw),values:unknown[]=[],conditions:string[]=[];
    const add=(sql:string,value:unknown)=>{values.push(value);conditions.push(sql.replace('?',`$${values.length}`));};
    for(const [key,column]of [['requestId','request_id'],['traceId','trace_id'],['subjectId',"payload#>>'{identity,subjectId}'"],['serviceId',"payload#>>'{route,serviceId}'"],['poolId',"payload#>>'{route,poolId}'"]] as const)if(q[key])add(`${column}=?`,q[key]);
    if(q.from)add('started_at>=?',q.from);if(q.to)add('started_at<?',q.to);
    if(q.state)conditions.push(q.state==='active'?"payload->>'completedAt' is null":q.state==='ended'?"payload->>'completedAt' is not null":"((payload->>'status')::int>=400 or payload->>'errorCode' is not null)");
    if(q.cursor){values.push(q.cursor.at,q.cursor.id);conditions.push(`(started_at,attempt_id)<($${values.length-1}::timestamptz,$${values.length}::uuid)`);}
    values.push(q.limit+1);const result=await this.pool.query(`select payload from gateway_request_traces ${conditions.length?'where '+conditions.join(' and '):''} order by started_at desc,attempt_id desc limit $${values.length}`,values);
    const items=result.rows.slice(0,q.limit).map(r=>r.payload as import('@ai-gateway/contracts').GatewayRequestTrace),last=items.at(-1);
    return {items,nextCursor:result.rows.length>q.limit&&last?{at:last.startedAt,id:last.attemptId}:null,collectedAt:new Date().toISOString()};
  }
  override async operationalBacklog(filter:import('../platform/operational-metrics').BacklogFilter):Promise<import('../platform/operational-metrics').BacklogSnapshot>{
    const result=await this.pool.query(`select 'media' as kind,count(*)::int as count,
      coalesce(greatest(0,extract(epoch from clock_timestamp()-min((payload->>'createdAt')::timestamptz))),0) as oldest
      from model_media_jobs where payload->>'finishedAt' is null
      and ($1::text is null or payload->'route'->>'serviceId'=$1)
      and ($2::text is null or payload->'route'->>'poolId'=$2)
      and ($3::text is null or payload->>'modelId'=$3)
      union all select 'settlement',count(*)::int,
      coalesce(greatest(0,extract(epoch from clock_timestamp()-min(completed_at))),0)
      from call_logs where billable_state='pending_review'
      and ($1::text is null or admission->'route'->>'serviceId'=$1)
      and ($2::text is null or admission->'route'->>'poolId'=$2)
      and ($3::text is null or model_id=$3)`,[filter.serviceId??null,filter.poolId??null,filter.modelId??null]);
    const stats=(kind:string)=>{const row=result.rows.find(row=>row.kind===kind);return {count:Number(row.count),oldestSeconds:Number(row.oldest)};};
    return {collectedAt:new Date().toISOString(),media:stats('media'),settlement:stats('settlement')};
  }
  override async upstreamCredentialUsage(id:string){
    const result=await this.pool.query(`select (admission->'route'->'credential'->>'version')::int as version,
      count(*)::int as calls,count(*) filter(where outcome<>'completed')::int as failures,max(completed_at) as last_used_at
      from call_logs where admission->'route'->'credential'->>'id'=$1 and forwarded=true group by 1 order by 1 desc`,[id]);
    return result.rows.map(row=>({version:row.version,calls:row.calls,failures:row.failures,lastUsedAt:row.last_used_at.toISOString()}));
  }
  override async routeObservations(serviceIds:string[]){return postgresRouteObservations(this.pool,serviceIds);}
  async capacityCounters(scopeIds:string[]):Promise<import('@ai-gateway/contracts').CapacityCounters>{
    // One MVCC snapshot and one database clock for every scope, across all gateway instances.
    const result=await this.pool.query(`with sample as materialized(select statement_timestamp() as at),
      active as(select scope_id,count(*)::int as count from reservation_limit_scopes,sample where active=true and expires_at>sample.at and scope_id=any($1::text[]) group by scope_id)
      select sample.at,date_trunc('minute',sample.at) as start,s.id,coalesce(w.requests,0) as requests,coalesce(w.tokens,0) as tokens,coalesce(a.count,0) as active
      from sample left join unnest($1::text[]) s(id) on true left join admission_windows w on w.scope_id=s.id and w.window_start=date_trunc('minute',sample.at) left join active a on a.scope_id=s.id`,[[...new Set(scopeIds)]]);
    const at=result.rows[0].at as Date,start=result.rows[0].start as Date;
    return {collectedAt:at.toISOString(),windowStart:start.toISOString(),windowEnd:new Date(start.getTime()+60000).toISOString(),rows:result.rows.filter(r=>r.id).map(r=>({scopeId:r.id,requests:Number(r.requests),tokens:Number(r.tokens),active:Number(r.active)}))};
  }
  async inFlightCounts(client?:PoolClient):Promise<InFlightCount[]>{
    const read=async()=>{const result=await (client??this.pool).query(`select admission->'route'->>'serviceId' as service_id,model_id,count(*)::int as count from reservations where finalized=false and expires_at>clock_timestamp() group by 1,2`);return result.rows.map(r=>({serviceId:r.service_id,modelId:r.model_id,count:r.count}));};
    return client?this.statisticsWithin(client,read):read();
  }
  async getCall(requestId:string):Promise<CallLog|null>{const result=await this.pool.query('select * from call_logs where request_id=$1',[requestId]);return result.rowCount?this.mapCall(result.rows[0]):null;}
  private async retryTargetWithin(client:PoolClient,requestId:string):Promise<RetryTarget|null>{
    const reservation=await client.query('select identity,purpose from reservations where request_id=$1',[requestId]);
    if(reservation.rowCount){const r=reservation.rows[0];return {subjectType:r.identity.subjectType,subjectId:r.identity.subjectId,organizationId:r.identity.organizationId??null,projectId:r.identity.projectId??null,purpose:r.purpose};}
    const log=await client.query('select subject_type,subject_id,organization_id,project_id,purpose from call_logs where request_id=$1',[requestId]);
    if(!log.rowCount)return null;const l=log.rows[0];
    return {subjectType:l.subject_type,subjectId:l.subject_id,organizationId:l.organization_id??null,projectId:l.project_id??null,purpose:l.purpose};
  }
  async relatedCalls(requestId:string,scope:CallScope):Promise<{original:CallLog|null;retries:CallLog[]}>{
    return this.withClient(async client=>{
      const original=await client.query<CallRow>('select * from call_logs where request_id=$1',[requestId]);
      const retries=await client.query<CallRow>('select * from call_logs where retry_of_request_id=$1 order by completed_at desc,request_id desc limit 100',[requestId]);
      const originalCall=original.rowCount?this.mapCall(original.rows[0]):null;
      return {
        original:originalCall&&callVisible(originalCall,scope)?originalCall:null,
        retries:retries.rows.map(row=>this.mapCall(row)).filter(call=>callVisible(call,scope)),
      };
    });
  }
  private mapVerification(r:VerificationRow):VerificationRun{return {id:r.id,operatorId:r.operator_id,serviceId:r.service_id,serviceName:r.service_name,configVersion:r.config_version,state:r.state,diagnostic:true,idempotencyKey:r.idempotency_key,mappings:r.mappings??[],results:r.results??[],startedAt:r.started_at.toISOString(),completedAt:r.completed_at?.toISOString()??null,leaseExpiresAt:r.lease_expires_at.toISOString(),note:r.note??null};}
  async interruptStaleVerifications():Promise<number>{
    const result=await this.pool.query(`update service_verification_runs set state='interrupted',completed_at=clock_timestamp(),note='验证进程中断，已发出的请求用量待确认；不会自动重发。' where state='running' and lease_expires_at<=clock_timestamp()`);
    return result.rowCount??0;
  }
  async startVerification(input:StartVerificationInput):Promise<{run:VerificationRun;replayed:boolean}>{
    return this.withClient(async client=>{
      await client.query('begin');
      try{
        await client.query(`update service_verification_runs set state='interrupted',completed_at=clock_timestamp(),note='验证进程中断，已发出的请求用量待确认；不会自动重发。' where state='running' and lease_expires_at<=clock_timestamp()`);
        const prior=await client.query('select * from service_verification_runs where idempotency_key=$1',[input.idempotencyKey]);
        if(prior.rowCount){const run=this.mapVerification(prior.rows[0]);if(run.serviceId!==input.serviceId||run.mappings[0]?.requestFingerprint!==input.mappings[0]?.requestFingerprint)throw new ConflictException('verification key was reused for another request');await client.query('commit');return {run,replayed:true};}
        const inserted=await client.query(`insert into service_verification_runs(id,idempotency_key,service_id,service_name,operator_id,config_version,state,mappings,results,note,started_at,completed_at,lease_expires_at)
          values($1,$2,$3,$4,$5,$6,'running',$7,'[]'::jsonb,null,clock_timestamp(),null,clock_timestamp()+interval '2 minutes') returning *`,[`verification-${randomUUID()}`,input.idempotencyKey,input.serviceId,input.serviceName,input.operatorId,input.configVersion,JSON.stringify(input.mappings)]);
        await client.query('commit');return {run:this.mapVerification(inserted.rows[0]),replayed:false};
      }catch(error){
        await client.query('rollback');
        if((error as {code?:string}).code==='23505')throw new ConflictException('another verification is already running for this service');
        throw error;
      }
    });
  }
  async markVerificationAttempt(runId:string,definitionId:string):Promise<void>{
    await this.pool.query(`update service_verification_runs set lease_expires_at=clock_timestamp()+interval '2 minutes',
      mappings=(select jsonb_agg(case when value->>'definitionId'=$2 then jsonb_set(value,'{attemptedAt}',to_jsonb(to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) else value end order by position) from jsonb_array_elements(mappings) with ordinality as items(value,position))
      where id=$1 and state='running'`,[runId,definitionId]);
  }
  async appendVerificationResult(runId:string,result:VerificationMappingResult):Promise<void>{
    await this.pool.query(`update service_verification_runs set results=results||$2::jsonb,lease_expires_at=clock_timestamp()+interval '2 minutes' where id=$1 and state='running'`,[runId,JSON.stringify([result])]);
  }
  async finishVerification(runId:string,state:'completed'|'interrupted'):Promise<VerificationRun>{
    const updated=await this.pool.query(`update service_verification_runs set state=$2,completed_at=clock_timestamp(),
      note=case when $2='interrupted' then '验证进程中断，已发出的请求用量待确认；不会自动重发。' else note end
      where id=$1 and state='running' returning *`,[runId,state]);
    if(updated.rowCount)return this.mapVerification(updated.rows[0]);
    const current=await this.pool.query('select * from service_verification_runs where id=$1',[runId]);
    if(!current.rowCount)throw new ConflictException('verification run not found');
    return this.mapVerification(current.rows[0]);
  }
  async listVerifications(serviceId:string,query:VerificationPageQuery={}):Promise<VerificationRunPage>{
    const limit=query.limit??20;
    const result=query.before
      ? await this.pool.query<VerificationRow>('select * from service_verification_runs where service_id=$1 and started_at<$2::timestamptz order by started_at desc,id desc limit $3',[serviceId,query.before,limit+1])
      : await this.pool.query<VerificationRow>('select * from service_verification_runs where service_id=$1 order by started_at desc,id desc limit $2',[serviceId,limit+1]);
    const rows=result.rows.slice(0,limit);
    return {items:rows.map(row=>this.mapVerification(row)),nextBefore:result.rows.length>rows.length?rows.at(-1)?.started_at.toISOString()??null:null};
  }
  override async dispatchRoute(requestId:string,reservationId:string,jobId?:string):Promise<import('@ai-gateway/contracts').RouteSnapshot|null>{
    if(jobId){const job=await this.getMediaJob(jobId);return job?.requestId===requestId&&job.reservationId===reservationId?job.route:null;}
    const result=await this.pool.query("select admission->'route' as route from reservations where request_id=$1 and reservation_id=$2 and not finalized and expires_at>clock_timestamp()",[requestId,reservationId]);
    return result.rows[0]?.route??null;
  }
  async getReservationSummary(requestId:string){const result=await this.pool.query('select amount,batch_id,admission from reservations where request_id=$1',[requestId]),r=result.rows[0];return r?{amount:Number(r.amount),batchId:String(r.batch_id),admission:(r.admission as AdmissionSnapshot|null)??null}:null;}
  async listExpiredReservations(){const result=await this.pool.query('select request_id,reservation_id from reservations where finalized=false and expires_at<=clock_timestamp() order by expires_at limit 100');return result.rows.map(r=>({requestId:String(r.request_id),reservationId:String(r.reservation_id)}));}
  async renewReservation(requestId:string,reservationId:string){return this.withClient(async client=>{
    await client.query('begin');try{
      const result=await client.query("update reservations set expires_at=clock_timestamp()+interval '5 minutes' where request_id=$1 and reservation_id=$2 and finalized=false and expires_at>clock_timestamp() returning expires_at",[requestId,reservationId]);
      if(result.rowCount)await client.query('update reservation_limit_scopes set expires_at=$1 where reservation_id=$2',[result.rows[0].expires_at,reservationId]);
      await client.query('commit');return result.rowCount?{renewed:true,expiresAt:result.rows[0].expires_at.toISOString()}:{renewed:false};
    }catch(error){await client.query('rollback');throw error;}
  });}
  async reconcileWithinBusinessTransaction(input:ReconciliationRequest,client?:PoolClient):Promise<SettlementResponse>{
    if(!client)throw new Error('reconciliation requires the existing business transaction');
    reconciliationCalculation(input,0,null);const fingerprint=JSON.stringify(input);
    await this.lock(client,[`review:${input.idempotencyKey}`]);
    const previous=await client.query('select * from reconciliation_records where request_id=$1 or idempotency_key=$2',[input.requestId,input.idempotencyKey]);
    if(previous.rowCount){const r=previous.rows[0];if(r.request_id!==input.requestId||r.idempotency_key!==input.idempotencyKey||r.fingerprint!==fingerprint)throw new ConflictException('request or reconciliation key was already used');return {...r.response,status:'already_finalized'};}
    const reservation=await client.query('select * from reservations where request_id=$1 for update',[input.requestId]),r=reservation.rows[0];
    const settled=await client.query('select response from settlement_records where request_id=$1 for update',[input.requestId]);
    if(!r||settled.rows[0]?.response?.status!=='pending_review')throw new ConflictException('only a pending-review reservation may be reconciled');
    const result=reconciliationCalculation(input,Number(r.amount),r.admission as AdmissionSnapshot|null),release=Number((Number(r.amount)-result.amount).toFixed(6));
    const updated=await client.query(`update quota_batches set
      available_amount=available_amount+case when closed_at is null then $1::numeric else 0 end,
      closed_amount=closed_amount+case when closed_at is not null then $1::numeric else 0 end
      where id=$2 and (accounting or (case when closed_at is null then available_amount else closed_amount end)+$1>=0)
      and available_amount+closed_amount+returned_amount+$1<=total_amount returning id`,[release,r.batch_id]);
    if(!updated.rowCount)throw new ConflictException('original quota batch has insufficient funds or invalid balance');
    const response:SettlementResponse={requestId:input.requestId,status:result.billable?'settled':'released',billableState:result.billable?'confirmed':'not_billable',ledgerEntryId:`ledger-${randomUUID()}`};
    const priorUsage=(await client.query('select usage_final,input_tokens,output_tokens from call_logs where request_id=$1 for update',[input.requestId])).rows[0];
    if(input.mode==='confirm_usage'){const scopes=await client.query('select scope_id from reservation_limit_scopes where reservation_id=$1',[r.reservation_id]);await this.lock(client,scopes.rows.map(scope=>`limit:${scope.scope_id}`));await client.query(`update admission_windows w set tokens=greatest(0,w.tokens-(case when $2::boolean then $3::bigint else r.estimated_tokens end)+$4::bigint) from reservation_limit_scopes r where r.reservation_id=$1 and w.scope_id=r.scope_id and w.window_start=r.window_start`,[r.reservation_id,priorUsage?.usage_final===true,Number(priorUsage?.input_tokens??0)+Number(priorUsage?.output_tokens??0),(input.inputTokens??0)+(input.outputTokens??0)]);}
    const changed=await client.query(`update call_logs set actual_amount=$1,billable_state=$2,
      input_tokens=case when $3 then $4 else input_tokens end,output_tokens=case when $3 then $5 else output_tokens end,
      cached_input_tokens=case when $3 then $6 else cached_input_tokens end,usage_final=case when $3 then true else usage_final end where request_id=$7 returning request_id`,[result.amount,response.billableState,input.mode==='confirm_usage',input.inputTokens??0,input.outputTokens??0,input.cachedInputTokens??0,input.requestId]);
    if(!changed.rowCount)throw new ConflictException('pending call log is missing');
    await client.query('update settlement_records set response=$1 where request_id=$2',[response,input.requestId]);
    if(input.meteredUsage&&input.mode==='confirm_usage')await client.query('update call_logs set metered_usage=$2 where request_id=$1',[input.requestId,JSON.stringify(input.meteredUsage)]);
    await client.query('insert into reconciliation_records(request_id,idempotency_key,fingerprint,actor_id,reason,response) values($1,$2,$3,$4,$5,$6)',[input.requestId,input.idempotencyKey,fingerprint,input.actorId,input.reason,response]);
    await client.query('insert into usage_ledger_entries(id,request_id,reservation_id,batch_id,kind,amount,detail) values($1,$2,$3,$4,$5,$6,$7)',[response.ledgerEntryId,input.requestId,r.reservation_id,r.batch_id,'reconciliation',result.amount,{actorId:input.actorId,reason:input.reason,mode:input.mode,reservedAmount:Number(r.amount),releasedAmount:release,admission:r.admission}]);
    return response;
  }
  async confirmedAmountsForBatches(ids:string[],client?:PoolClient):Promise<Record<string,number>>{
    if(!ids.length)return {};
    const read=async(c:PoolClient)=>Object.fromEntries((await c.query(`select r.batch_id,sum(c.actual_amount) as amount from call_logs c join reservations r using(request_id) where r.batch_id=any($1::text[]) and c.billable_state='confirmed' group by r.batch_id`,[ids])).rows.map(r=>[String(r.batch_id),Number(r.amount)]));
    return client?read(client):this.withClient(read);
  }
  async getQuota(purpose: 'personal' | 'project' = 'personal'): Promise<QuotaSnapshot> {
    const result=await this.pool.query('select * from quota_batches where id=$1', [purpose==='personal'?'personal-batch-demo-001':'project-member-batch-demo-001']);
    const r=result.rows[0]; return { purpose,projectId:r?.project_id??null,currency:'CNY',availableAmount:r?Number(r.available_amount):0,totalAmount:r?Number(r.total_amount):0,sourceId:r?.id??null,expiresAt:r?.expires_at?.toISOString()??null };
  }
  async health() {
    let database='down'; let cache=this.redis?'down':'disabled';
    try { await this.pool.query('select 1'); database='up'; } catch { /* report dependency state */ }
    if (this.redis) { try { await this.redis.ping(); cache='up'; } catch { /* report dependency state */ } }
    return { status:database==='up'&&cache!=='down'?'ok' as const:'degraded' as const,database,cache };
  }
}
