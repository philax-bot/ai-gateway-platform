import { ConflictException, Injectable } from '@nestjs/common';
import type { BusinessQuotaBatch, ProjectBudgetBatch, ReconciliationRequest, SettlementResponse, WorkspaceState } from '@ai-gateway/contracts';
import type { PoolClient } from 'pg';
import { DemoStore, type CredentialRecord } from '../store/demo.store';
import { PostgresStore } from '../store/postgres.store';
import { initialWorkspace } from './seed';
import {hotPathDiagnostics,type DiagnosticContext} from '../store/hot-path-diagnostics';
import {admissionPolicyState,lockAdmissionPolicy} from '../store/admission-policy-lock';

export interface WorkspaceTransaction {
  state: WorkspaceState;
  queryCalls: DemoStore['queryCalls'];
  inFlightCounts: DemoStore['inFlightCounts'];
  batches(): Promise<BusinessQuotaBatch[]>;
  grant(batch: BusinessQuotaBatch): Promise<void>;
  updateBatchModels(id: string, modelIds: string[]): Promise<void>;
  saveCredential(credential: CredentialRecord): Promise<void>;
  disableCredentials(subjectId: string): Promise<void>;
  budgetBatches(): Promise<ProjectBudgetBatch[]>;
  fundBudget(batch: ProjectBudgetBatch): Promise<void>;
  allocateBudget(id: string, amount: number): Promise<void>;
  closeProjectBalances(projectId:string):Promise<{memberAmount:number;budgetAmount:number}>;
  changeQuota(id:string,value:number,operation:'reclaim'|'return'):Promise<void>;
  reclaimBudget(id:string,value:number):Promise<void>;
  extendQuota(id:string,expiresAt:string,budget:boolean):Promise<void>;
  closeMemberBalances(projectId:string,memberId:string):Promise<void>;
  reconcile(input:ReconciliationRequest):Promise<SettlementResponse>;
}

@Injectable()
export class WorkspaceRepository {
  private memory = initialWorkspace();
  private budgets = new Map<string, ProjectBudgetBatch>();
  constructor(private readonly store: DemoStore) {}

  async initialize(): Promise<void> {
    if (this.store instanceof PostgresStore) {
      await this.store.withClient(async client => {
        await client.query('insert into platform_workspace(id,payload) values($1,$2) on conflict do nothing', ['org-demo', initialWorkspace()]);
      });
    }
  }

  async read(): Promise<WorkspaceState> {
    return this.readSelected();
  }
  async readGatewayConfiguration():Promise<Pick<WorkspaceState,'services'|'definitions'>>{
    if(!(this.store instanceof PostgresStore))return structuredClone({services:this.memory.services,definitions:this.memory.definitions});
    return this.store.withClient(async client=>(await client.query("select jsonb_build_object('services',payload->'services','definitions',payload->'definitions') as payload from platform_workspace where id=$1",['org-demo'])).rows[0].payload);
  }
  readUpstreamCredentials(){return this.readSelected(['upstreamCredentials'] as const,'maintenance_read');}
  readPeople(){return this.readSelected(['members','organizations','projects'] as const);}
  readNotifications(){return this.readSelected(['monitoring'] as const,'maintenance_read');}
  readCapacity(){return this.readSelected(['tenantId','members','organizations','services','definitions','pools','settings'] as const,'maintenance_read');}
  readAuthentication(){return this.readSelected(['members','organizations','sessions'] as const,'auth_session');}
  readMaintenance(){return this.readSelected(['tenantId','members','organizations','pools','entitlements','rules','services','definitions','monitoring','settings','retention'] as const,'maintenance_read');}

  // Field sets come only from the internal methods above. Filter the JSON object
  // on the server, preserving explicit nulls and absent optional top-level fields.
  private async readSelected<K extends keyof WorkspaceState=keyof WorkspaceState>(fields?:readonly K[],context:DiagnosticContext|null=null):Promise<Pick<WorkspaceState,K>> {
    if (!(this.store instanceof PostgresStore)) {
      const state=fields?Object.fromEntries(Object.entries(this.memory).filter(([key])=>fields.includes(key as K))):this.memory;
      return structuredClone(state) as Pick<WorkspaceState,K>;
    }
    const trace=hotPathDiagnostics.start('workspace_read',context);
    return this.store.withClient(async raw => {
      const client=trace.acquired(raw);let failed=false;
      try{const result=await client.query(fields?"select (select jsonb_object_agg(key,value) from jsonb_each(payload) where key=any($2::text[])) as payload from platform_workspace where id=$1":'select payload from platform_workspace where id=$1',fields?['org-demo',fields]:['org-demo']);return result.rows[0].payload as Pick<WorkspaceState,K>;}
      catch(error){failed=true;throw error;}finally{trace.finish(failed);}
    }).catch(error=>{trace.finish(true);throw error;});
  }

  async view(projectId?:string) {
    if(!(this.store instanceof PostgresStore)) return this.store.exclusive(async()=>{const batches=await this.context(this.memory).batches();return {state:structuredClone(this.memory),batches,budgets:await this.context(this.memory).budgetBatches(),consumedByBatch:projectId?await this.store.confirmedAmountsForBatches(batches.filter(b=>(b.projectId===projectId||b.purpose==='application'&&b.sourceId===projectId)).map(b=>b.id)):{}};});
    const trace=hotPathDiagnostics.start('workspace_view');
    return this.store.withClient(async raw=>{
      const client=trace.acquired(raw);let failed=false;
      await client.query('begin isolation level repeatable read read only');
      try {
        const result=await client.query('select payload from platform_workspace where id=$1',['org-demo']);
        const state=result.rows[0].payload as WorkspaceState;
        const tx=this.context(state,client);
        const batches=await tx.batches();
        const value={state,batches,budgets:await tx.budgetBatches(),consumedByBatch:projectId?await this.store.confirmedAmountsForBatches(batches.filter(b=>(b.projectId===projectId||b.purpose==='application'&&b.sourceId===projectId)).map(b=>b.id),client):{}};
        await client.query('commit');return value;
      } catch(error){failed=true;await client.query('rollback');throw error;}finally{trace.finish(failed);}
    }).catch(error=>{trace.finish(true);throw error;});
  }

  async transact<T>(work: (tx: WorkspaceTransaction) => Promise<T>,options:{incrementRevision?:boolean;diagnosticContext?:DiagnosticContext;runtimeOnly?:boolean}={}): Promise<T> {
    const runtimeOnly=options.runtimeOnly===true;
    if (this.store instanceof PostgresStore) {
      const trace=hotPathDiagnostics.start('workspace_write',options.diagnosticContext??null);
      return this.store.withClient(async raw => {
        const client=trace.acquired(raw);let failed=false;
        await client.query('begin isolation level read committed');
        try {
          if(!runtimeOnly)await lockAdmissionPolicy(client,false);
          const result = await client.query('select payload from platform_workspace where id=$1 for update', ['org-demo']);
          const state = result.rows[0].payload as WorkspaceState;
          const before=JSON.stringify(state),policyBefore=runtimeOnly?admissionPolicyState(state):null;
          const value = await work(this.context(state, client,runtimeOnly));
          if(runtimeOnly&&admissionPolicyState(state)!==policyBefore)throw new ConflictException('runtime transaction cannot change admission policy');
          if(JSON.stringify(state)!==before){if(!runtimeOnly&&options.incrementRevision!==false)state.revision++;await client.query('update platform_workspace set payload=$1,revision=$2,updated_at=now() where id=$3', [state,state.revision,state.tenantId]);}
          await client.query('commit'); return value;
        } catch (error) { failed=true;await client.query('rollback'); throw error; }finally{trace.finish(failed);}
      }).catch(error=>{trace.finish(true);throw error;});
    }
    return this.store.exclusive(async () => {
      const state = structuredClone(this.memory);
      const before=JSON.stringify(state),policyBefore=runtimeOnly?admissionPolicyState(state):null;
      const oldBatches = structuredClone(this.store.quotaBatches);
      const oldCredentials = structuredClone(this.store.credentials);
      const oldBudgets = structuredClone(this.budgets);
      const previousReview=structuredClone({reservations:this.store.reservationsByRequest,idempotency:this.store.reservationsByIdempotency,responses:this.store.settlementResponsesByRequest,logs:this.store.callLogs,ledger:this.store.ledgerEntries,reconciliations:this.store.reconciliationRecords});
      try {
        const result = await work(this.context(state,undefined,runtimeOnly));
        if(runtimeOnly&&admissionPolicyState(state)!==policyBefore)throw new ConflictException('runtime transaction cannot change admission policy');
        if(JSON.stringify(state)!==before){if(!runtimeOnly&&options.incrementRevision!==false)state.revision++;this.memory=state;}return result;
      } catch (error) {
        this.store.quotaBatches.clear(); oldBatches.forEach((value,key) => this.store.quotaBatches.set(key,value));
        this.store.credentials.clear(); oldCredentials.forEach((value,key) => this.store.credentials.set(key,value));
        this.store.reservationsByRequest.clear();previousReview.reservations.forEach((v,k)=>this.store.reservationsByRequest.set(k,v));
        this.store.reservationsByIdempotency.clear();previousReview.idempotency.forEach((v,k)=>this.store.reservationsByIdempotency.set(k,v));
        this.store.settlementResponsesByRequest.clear();previousReview.responses.forEach((v,k)=>this.store.settlementResponsesByRequest.set(k,v));
        this.store.reconciliationRecords.clear();previousReview.reconciliations.forEach((v,k)=>this.store.reconciliationRecords.set(k,v));
        this.store.callLogs.splice(0,this.store.callLogs.length,...previousReview.logs);
        this.store.ledgerEntries.splice(0,this.store.ledgerEntries.length,...previousReview.ledger);
        this.budgets = oldBudgets; throw error;
      }
    });
  }

  private context(state: WorkspaceState, client?: PoolClient,runtimeOnly=false): WorkspaceTransaction {
    const writable=()=>{if(runtimeOnly)throw new ConflictException('runtime transaction cannot change funds or credentials');};
    return {
      state,
      queryCalls:(input,scope)=>this.store.queryCalls(input,scope,client),
      inFlightCounts:()=>this.store.inFlightCounts(client),
      reconcile:input=>{writable();return this.store.reconcileWithinBusinessTransaction(input,client);},
      batches: async () => {
        if (!client) return [...this.store.quotaBatches.values()].map(b => ({...b,entitlementId:b.entitlementId??null,sourceBatchId:b.sourceBatchId??null}));
        const result = await client.query('select * from quota_batches order by expires_at,id');
        return result.rows.map(r => ({id:r.id,accounting:r.accounting,returnedAmount:Number(r.returned_amount),sourceType:r.source_type,sourceId:r.source_id,organizationId:r.organization_id,projectId:r.project_id,totalAmount:Number(r.total_amount),availableAmount:Number(r.available_amount),modelIds:r.model_ids,expiresAt:r.expires_at.toISOString(),purpose:r.purpose,entitlementId:r.entitlement_id,sourceBatchId:r.source_batch_id,closedAt:r.closed_at?.toISOString()??null,closedAmount:Number(r.closed_amount)}));
      },
      grant: async batch => {
        writable();
        if (!client) {
          if (this.store.quotaBatches.has(batch.id)) throw new ConflictException('quota batch already exists');
          this.store.quotaBatches.set(batch.id, structuredClone(batch)); return;
        }
        await client.query(`insert into quota_batches(id,source_type,source_id,organization_id,project_id,total_amount,available_amount,model_ids,expires_at,purpose,entitlement_id,source_batch_id,accounting)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[batch.id,batch.sourceType,batch.sourceId,batch.organizationId,batch.projectId,batch.totalAmount,batch.availableAmount,JSON.stringify(batch.modelIds),batch.expiresAt,batch.purpose,batch.entitlementId,batch.sourceBatchId,batch.accounting===true]);
      },
      updateBatchModels: async (id, modelIds) => {
        writable();
        if(!client){const batch=this.store.quotaBatches.get(id);if(batch)batch.modelIds=[...modelIds];return;}
        await client.query('update quota_batches set model_ids=$1 where id=$2',[JSON.stringify(modelIds),id]);
      },
      saveCredential: async credential => {
        writable();
        if (!client) { this.store.credentials.set(credential.apiKey, structuredClone(credential)); return; }
        await client.query(`insert into credentials(credential_id,api_key,identity,purpose,active,model_ids) values($1,$2,$3,$4,$5,$6)
          on conflict(credential_id) do update set active=excluded.active,model_ids=excluded.model_ids,identity=excluded.identity`,
          [credential.credentialId,credential.apiKey,credential.identity,credential.purpose,credential.active,JSON.stringify(credential.modelIds)]);
      },
      disableCredentials: async subjectId => {
        writable();
        if (!client) {for(const c of this.store.credentials.values())if(c.identity.subjectId===subjectId)c.active=false;return;}
        await client.query("update credentials set active=false where identity->>'subjectId'=$1",[subjectId]);
      },
      budgetBatches: async () => {
        if (!client) return [...this.budgets.values()].map(b => structuredClone(b));
        const result = await client.query('select * from project_budget_batches order by expires_at,id');
        return result.rows.map(r => ({id:r.id,projectId:r.project_id,totalAmount:Number(r.total_amount),availableAmount:Number(r.available_amount),expiresAt:r.expires_at.toISOString(),createdAt:r.created_at.toISOString(),closedAt:r.closed_at?.toISOString()??null,closedAmount:Number(r.closed_amount)}));
      },
      fundBudget: async batch => {
        writable();
        if (!client) {if(this.budgets.has(batch.id))throw new ConflictException('budget batch already exists');this.budgets.set(batch.id,structuredClone(batch));return;}
        await client.query('insert into project_budget_batches(id,project_id,total_amount,available_amount,expires_at,created_at) values($1,$2,$3,$4,$5,$6)',[batch.id,batch.projectId,batch.totalAmount,batch.availableAmount,batch.expiresAt,batch.createdAt]);
      },
      allocateBudget: async (id,amount) => {
        writable();
        if (!client) {
          const batch=this.budgets.get(id);
          if(!batch || batch.closedAt || Date.parse(batch.expiresAt)<=Date.now() || batch.availableAmount<amount)throw new ConflictException('source budget is expired or insufficient');
          batch.availableAmount=Number((batch.availableAmount-amount).toFixed(6));return;
        }
        const result=await client.query('update project_budget_batches set available_amount=available_amount-$1 where id=$2 and expires_at>now() and available_amount >= $1 and closed_at is null returning id',[amount,id]);
        if(!result.rowCount)throw new ConflictException('source budget is expired or insufficient');
      },
      changeQuota:async(id,value,operation)=>{
        writable();
        if(!client){
          const b=this.store.quotaBatches.get(id);
          if(!b||b.accounting)throw new ConflictException('额度批次不可调整');
          const from=operation==='return'&&b.closedAt?'closedAmount':'availableAmount';
          if((b[from]??0)<value||operation==='reclaim'&&(b.closedAt||Date.parse(b.expiresAt)<=Date.now()))throw new ConflictException('当前可调整余额不足或批次已失效，请刷新');
          if(operation==='return'){
            const budget=this.budgets.get(b.sourceBatchId??'');if(!budget)throw new ConflictException('来源预算不存在');
            const target=budget.closedAt||Date.parse(budget.expiresAt)<=Date.now()?'closedAmount':'availableAmount';
            budget[target]=Number(((budget[target]??0)+value).toFixed(6));b.returnedAmount=Number(((b.returnedAmount??0)+value).toFixed(6));
          }else b.closedAmount=Number(((b.closedAmount??0)+value).toFixed(6));
          b[from]=Number(((b[from]??0)-value).toFixed(6));return;
        }
        // Lock only the source batch before its budget. Settlement never locks a budget.
        const b=(await client.query('select * from quota_batches where id=$1 for update',[id])).rows[0];
        if(!b||b.accounting)throw new ConflictException('额度批次不可调整');
        const from=operation==='return'&&b.closed_at?'closed_amount':'available_amount';
        if(Number(b[from])<value||operation==='reclaim'&&(b.closed_at||new Date(b.expires_at).getTime()<=Date.now()))throw new ConflictException('当前可调整余额不足或批次已失效，请刷新');
        if(operation==='return'){
          const changed=await client.query(`update project_budget_batches set available_amount=available_amount+case when closed_at is null and expires_at>now() then $1::numeric else 0 end,closed_amount=closed_amount+case when closed_at is not null or expires_at<=now() then $1::numeric else 0 end where id=$2 returning id`,[value,b.source_batch_id]);
          if(!changed.rowCount)throw new ConflictException('来源预算不存在');
        }
        await client.query(`update quota_batches set ${from}=${from}-$1,${operation==='return'?'returned_amount':'closed_amount'}=${operation==='return'?'returned_amount':'closed_amount'}+$1 where id=$2`,[value,id]);
      },
      reclaimBudget:async(id,value)=>{
        writable();
        if(!client){const b=this.budgets.get(id);if(!b||b.closedAt||Date.parse(b.expiresAt)<=Date.now()||b.availableAmount<value)throw new ConflictException('当前未分配预算不足或批次已失效，请刷新');b.availableAmount=Number((b.availableAmount-value).toFixed(6));b.closedAmount=Number(((b.closedAmount??0)+value).toFixed(6));return;}
        const r=await client.query('update project_budget_batches set available_amount=available_amount-$1,closed_amount=closed_amount+$1 where id=$2 and closed_at is null and expires_at>now() and available_amount>=$1 returning id',[value,id]);
        if(!r.rowCount)throw new ConflictException('当前未分配预算不足或批次已失效，请刷新');
      },
      extendQuota:async(id,expiresAt,budget)=>{
        writable();
        if(!client){const b=budget?this.budgets.get(id):this.store.quotaBatches.get(id);if(!b||b.closedAt||Date.parse(b.expiresAt)<=Date.now()||Date.parse(b.expiresAt)>=Date.parse(expiresAt))throw new ConflictException('仅可延长未关闭且未过期的额度');b.expiresAt=expiresAt;if(budget)for(const child of this.store.quotaBatches.values())if(child.sourceBatchId===id&&!child.closedAt)child.expiresAt=expiresAt;return;}
        const r=await client.query(`update ${budget?'project_budget_batches':'quota_batches'} set expires_at=$1 where id=$2 and closed_at is null and expires_at>now() and expires_at<$1 returning id`,[expiresAt,id]);if(!r.rowCount)throw new ConflictException('仅可延长未关闭且未过期的额度');
        if(budget)await client.query('update quota_batches set expires_at=$1 where source_batch_id=$2 and closed_at is null',[expiresAt,id]);
      },
      closeMemberBalances:async(projectId,memberId)=>{
        writable();
        if(!client){for(const b of this.store.quotaBatches.values())if(b.projectId===projectId&&b.sourceId===memberId&&!b.closedAt){b.closedAmount=Number(((b.closedAmount??0)+b.availableAmount).toFixed(6));b.availableAmount=0;b.closedAt=new Date().toISOString();b.modelIds=[];}return;}
        await client.query("update quota_batches set closed_amount=closed_amount+available_amount,available_amount=0,closed_at=clock_timestamp(),model_ids='[]'::jsonb where project_id=$1 and source_id=$2 and closed_at is null",[projectId,memberId]);
      },
      closeProjectBalances:async projectId=>{
        writable();
        if(!client){let memberAmount=0,budgetAmount=0;const at=new Date().toISOString();
          for(const batch of this.store.quotaBatches.values())if(batch.projectId===projectId&&!batch.closedAt){memberAmount+=batch.availableAmount;batch.closedAmount=Number(((batch.closedAmount??0)+batch.availableAmount).toFixed(6));batch.availableAmount=0;batch.closedAt=at;batch.modelIds=[];}
          for(const batch of this.budgets.values())if(batch.projectId===projectId&&!batch.closedAt){budgetAmount+=batch.availableAmount;batch.closedAmount=Number(((batch.closedAmount??0)+batch.availableAmount).toFixed(6));batch.availableAmount=0;batch.closedAt=at;}
          return {memberAmount:Number(memberAmount.toFixed(6)),budgetAmount:Number(budgetAmount.toFixed(6))};
        }
        const members=await client.query(`with before_close as materialized (select id,available_amount from quota_batches where project_id=$1 and closed_at is null for update), moved as (update quota_batches q set closed_amount=q.closed_amount+q.available_amount,available_amount=0,closed_at=clock_timestamp(),model_ids='[]'::jsonb from before_close b where q.id=b.id returning b.available_amount) select coalesce(sum(available_amount),0) as amount from moved`,[projectId]);
        const budgets=await client.query(`with before_close as materialized (select id,available_amount from project_budget_batches where project_id=$1 and closed_at is null for update), moved as (update project_budget_batches q set closed_amount=q.closed_amount+q.available_amount,available_amount=0,closed_at=clock_timestamp() from before_close b where q.id=b.id returning b.available_amount) select coalesce(sum(available_amount),0) as amount from moved`,[projectId]);
        return {memberAmount:Number(members.rows[0].amount),budgetAmount:Number(budgets.rows[0].amount)};
      },
    };
  }
}
