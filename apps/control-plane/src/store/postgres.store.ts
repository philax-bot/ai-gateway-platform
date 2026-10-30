import {guardrailPolicy,type SafetyQuery,type SafetyEvent} from '@ai-gateway/contracts';
import {admissionGuardrail,safetyQuery,safetyCursor} from './guardrail';
import { ConflictException, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import Redis from 'ioredis';
import type { AdmissionSnapshot, AuthorizeRequest, AuthorizeResponse, CallLog, CallQuery, InFlightCount, ReconciliationRequest, SettlementRequest, SettlementResponse, VerificationMappingResult, VerificationMappingSnapshot, VerificationRun, VerificationRunPage, WorkspaceState } from '@ai-gateway/contracts';
import { businessDenial } from '../platform/domain';
import { DemoStore } from './demo.store';
import type { DemoCredential, QuotaSnapshot, StartVerificationInput, VerificationPageQuery } from './control-plane.store';
import { authorizationFingerprint, checkSettlementScope, reconciliationCalculation, RESERVATION_AMOUNT, retryLinkAllowed, sameIdentity, settlementAmount, type RetryTarget } from './accounting';
import { admissionForBatch, admissionDenialMessage, publicLogAdmission } from './admission';
import { callVisible, type CallScope } from './call-query';
import { queryPostgresCalls, type CallRow } from './postgres-call-query';
import { databaseSchema,runtimeMode } from '@ai-gateway/contracts';
import { applyMigrations,loadMigrations } from './migrations';
import { hotPathDiagnostics } from './hot-path-diagnostics';
import { ADMISSION_POLICY_SQL,lockAdmissionPolicy,type AdmissionWorkspace } from './admission-policy-lock';

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
    options: databaseSchema(process.env)?`-c search_path=${databaseSchema(process.env)}`:process.env.PGOPTIONS, connectionTimeoutMillis: 5000 });
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
    const fingerprint = authorizationFingerprint(input);
    const trace=hotPathDiagnostics.start('authorize');
    const raw=await this.pool.connect().catch(error=>{trace.finish(true);throw error;});
    const client=trace.acquired(raw);let failed=false;
    try {
      await client.query('begin isolation level read committed');
      await this.lock(client, [`authorize-key:${input.idempotencyKey}`, `authorize-request:${input.requestId}`]);
      const previous = await client.query('select * from authorization_records where idempotency_key=$1 or request_id=$2', [input.idempotencyKey,input.requestId]);
      if (previous.rowCount) {
        const r = previous.rows[0];
        if (r.idempotency_key !== input.idempotencyKey || r.fingerprint !== fingerprint) throw new ConflictException('authorization key or request ID was reused with different input');
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
        const values = [input.purpose,input.identity.subjectId,input.identity.organizationId ?? null,input.identity.projectId ?? null,JSON.stringify([input.modelId])];
        const scope = 'purpose=$1 and source_id=$2 and organization_id is not distinct from $3 and project_id is not distinct from $4 and model_ids @> $5::jsonb and expires_at > now() and closed_at is null';
        const batches = await client.query(`select * from quota_batches where ${scope} order by expires_at,id for update`, values);
        let b:Record<string,any>|undefined,admission:AdmissionSnapshot|undefined,eligible=0;
        let candidateReason:AuthorizeResponse['reasonCode']='no_quota';
        let candidateLimits:AuthorizeResponse['requestLimits'];
        for(const candidate of batches.rows){
          const quote=admissionForBatch(workspace.rows[0]?.payload as AdmissionWorkspace|undefined,input,{sourceId:candidate.source_id,purpose:candidate.purpose,projectId:candidate.project_id,entitlementId:candidate.entitlement_id});
          if(quote.reason){candidateReason=quote.reason;candidateLimits=quote.requestLimits;continue;}eligible++;
          if(Number(candidate.available_amount)>=quote.admission.reservedAmount){b=candidate;admission=quote.admission;break;}
        }
        if (!b) {
          response.reasonCode = eligible?'quota_insufficient':batches.rowCount?candidateReason:'no_quota';
          if(response.reasonCode==='request_limit_exceeded')response.requestLimits=candidateLimits;
          response.reasonMessage=admissionDenialMessage(response.reasonCode,response.requestLimits);
        } else {
          const a=admission!;
          await this.lock(client,a.scopes.map(scope=>`limit:${scope.id}`));
          const windowResult=await client.query("select date_trunc('minute',clock_timestamp()) as start,clock_timestamp() as now");
          const windowStart=windowResult.rows[0].start as Date;
          const limits=await client.query(`select s.id,coalesce(w.requests,0) as requests,coalesce(w.tokens,0) as tokens,
            (select count(*)::int from reservation_limit_scopes r where r.scope_id=s.id and r.active=true and r.expires_at>clock_timestamp()) as active
            from unnest($1::text[]) s(id) left join admission_windows w on w.scope_id=s.id and w.window_start=$2`,[a.scopes.map(scope=>scope.id),windowStart]);
          const limited=a.scopes.some(scope=>{
            const row=limits.rows.find(row=>row.id===scope.id)!;
            return (scope.rpm!==undefined&&Number(row.requests)+1>scope.rpm)||(scope.tpm!==undefined&&Number(row.tokens)+a.estimatedTokens>scope.tpm)||(scope.concurrency!==undefined&&Number(row.active)>=scope.concurrency);
          });
          if(limited){
            response.reasonCode='rate_limited';response.reasonMessage='an applicable subject, pool, service or shared-resource limit is reached';
            response.admission=a;await this.saveAuthorization(client,input,response,fingerprint);
            await client.query('commit');return response;
          }
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
    const trace=hotPathDiagnostics.start('settle');
    const raw=await this.pool.connect().catch(error=>{trace.finish(true);throw error;});
    const client=trace.acquired(raw);let failed=false;
    try {
      await client.query('begin');
      await this.lock(client, [`settle-key:${input.idempotencyKey}`, `settle-request:${input.requestId}`]);
      const result = await client.query('select * from reservations where request_id=$1 for update', [input.requestId]);
      const r = result.rows[0];
      if (!r || r.reservation_id !== input.reservationId) throw new ConflictException('reservation does not match request');
      checkSettlementScope(input, { identity:r.identity,purpose:r.purpose,modelId:r.model_id });
      const previous = await client.query('select * from settlement_records where request_id=$1 or idempotency_key=$2', [input.requestId,input.idempotencyKey]);
      if (previous.rows.some((p) => p.request_id !== input.requestId)) throw new ConflictException('settlement key belongs to another request');
      if (previous.rowCount) {
        const known=settlementAmount(input,Number(r.amount),r.admission);
        if(previous.rows[0].response?.status==='pending_review'&&previous.rows[0].idempotency_key===`${input.requestId}:lease-expired`&&input.usageFinal===true&&input.inputTokens!==undefined&&input.outputTokens!==undefined&&!known.pending&&(known.billable||(input.outcome==='rejected_before_upstream'&&input.forwarded===false))){
          const recovered=await this.reconcileWithinBusinessTransaction({requestId:input.requestId,idempotencyKey:`${input.idempotencyKey}:recovered-final`,actorId:'system:data-plane-recovery',reason:known.billable?'迟到的完整上游用量，按原预占价格自动核对':'数据面持久化记录确认未转发，释放原预占',mode:known.billable?'confirm_usage':'release_hold',inputTokens:input.inputTokens,outputTokens:input.outputTokens,cachedInputTokens:input.cachedInputTokens,actualAmount:input.actualAmount},client);
          const scopes=await client.query('select scope_id from reservation_limit_scopes where reservation_id=$1',[r.reservation_id]);await this.lock(client,scopes.rows.map(scope=>`limit:${scope.scope_id}`));
          await client.query(`update admission_windows w set tokens=greatest(0,w.tokens-(r.estimated_tokens-$2::bigint-$3::bigint)) from reservation_limit_scopes r where r.reservation_id=$1 and w.scope_id=r.scope_id and w.window_start=r.window_start`,[r.reservation_id,input.inputTokens,input.outputTokens]);
          await client.query('update call_logs set outcome=$1,completed_at=$2,latency_ms=$3,forwarded=coalesce($5,forwarded),usage_final=true,error_code=coalesce($6,error_code) where request_id=$4',[input.outcome,input.completedAt,Math.max(0,Math.min(2147483647,Date.parse(input.completedAt)-r.created_at.getTime())),input.requestId,input.forwarded??null,input.errorCode??null]);await client.query('commit');return recovered;
        }
        await client.query('commit');
        return { ...(previous.rows[0].response as SettlementResponse),status:'already_finalized' };
      }
      if (r.finalized) throw new ConflictException('finalized reservation has no settlement record');
      const { amount, pending, billable } = settlementAmount(input, Number(r.amount),r.admission as AdmissionSnapshot|null);
      if (!pending) await client.query('update quota_batches set available_amount=available_amount+case when closed_at is null then $1::numeric else 0 end,closed_amount=closed_amount+case when closed_at is not null then $1::numeric else 0 end where id=$2', [Number(r.amount)-amount,r.batch_id]);
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
      const result=await client.query('select * from credentials where (api_key=$1 or api_key=$2) and active=true',[apiKey,`sha256:${createHash('sha256').update(apiKey).digest('hex')}`]);
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
    return this.withClient(async client=>{
    await client.query('begin isolation level repeatable read read only');
    try{const result=await queryPostgresCalls(client,input,scope,r=>this.mapCall(r));await client.query('commit');return result;}catch(error){await client.query('rollback');throw error;}
  });}
  private mapCall(r:CallRow):CallLog{return {safety:r.safety??null,requestId:r.request_id,upstreamRequestId:r.upstream_request_id??null,retryOfRequestId:r.retry_of_request_id??null,startedAt:r.started_at.toISOString(),completedAt:r.completed_at.toISOString(),subjectType:r.subject_type,subjectId:r.subject_id,credentialId:r.credential_id,purpose:r.purpose,projectId:r.project_id,modelId:r.model_id,outcome:r.outcome,inputTokens:r.input_tokens,outputTokens:r.output_tokens,cachedInputTokens:r.cached_input_tokens,actualAmount:Number(r.actual_amount),billableState:r.billable_state,reservationId:r.reservation_id,admission:publicLogAdmission(r.admission as AdmissionSnapshot|null),organizationId:r.organization_id,errorCode:r.error_code,latencyMs:r.latency_ms,usageFinal:r.usage_final??undefined,forwarded:r.forwarded??null,ttftMs:r.ttft_ms??null};}
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
        if(prior.rowCount){const run=this.mapVerification(prior.rows[0]);if(run.serviceId!==input.serviceId)throw new ConflictException('verification key was reused for another service');await client.query('commit');return {run,replayed:true};}
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
      where id=$2 and (case when closed_at is null then available_amount else closed_amount end)+$1>=0
      and available_amount+closed_amount+$1<=total_amount returning id`,[release,r.batch_id]);
    if(!updated.rowCount)throw new ConflictException('original quota batch has insufficient funds or invalid balance');
    const response:SettlementResponse={requestId:input.requestId,status:result.billable?'settled':'released',billableState:result.billable?'confirmed':'not_billable',ledgerEntryId:`ledger-${randomUUID()}`};
    const changed=await client.query(`update call_logs set actual_amount=$1,billable_state=$2,
      input_tokens=case when $3 then $4 else input_tokens end,output_tokens=case when $3 then $5 else output_tokens end,
      cached_input_tokens=case when $3 then $6 else cached_input_tokens end,usage_final=case when $3 then true else usage_final end where request_id=$7 returning request_id`,[result.amount,response.billableState,input.mode==='confirm_usage',input.inputTokens??0,input.outputTokens??0,input.cachedInputTokens??0,input.requestId]);
    if(!changed.rowCount)throw new ConflictException('pending call log is missing');
    await client.query('update settlement_records set response=$1 where request_id=$2',[response,input.requestId]);
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
