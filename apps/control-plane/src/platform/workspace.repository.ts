import { ConflictException, Injectable } from '@nestjs/common';
import type { BusinessQuotaBatch, ProjectBudgetBatch, ReconciliationRequest, SettlementResponse, WorkspaceState } from '@ai-gateway/contracts';
import type { PoolClient } from 'pg';
import { DemoStore, type CredentialRecord } from '../store/demo.store';
import { PostgresStore } from '../store/postgres.store';
import { initialWorkspace } from './seed';

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
    if (!(this.store instanceof PostgresStore)) return structuredClone(this.memory);
    return this.store.withClient(async client => {
      const result = await client.query('select payload from platform_workspace where id=$1', ['org-demo']);
      return result.rows[0].payload as WorkspaceState;
    });
  }

  async view(projectId?:string) {
    if(!(this.store instanceof PostgresStore)) return this.store.exclusive(async()=>{const batches=await this.context(this.memory).batches();return {state:structuredClone(this.memory),batches,budgets:await this.context(this.memory).budgetBatches(),consumedByBatch:projectId?await this.store.confirmedAmountsForBatches(batches.filter(b=>b.projectId===projectId).map(b=>b.id)):{}};});
    return this.store.withClient(async client=>{
      await client.query('begin isolation level repeatable read read only');
      try {
        const result=await client.query('select payload from platform_workspace where id=$1',['org-demo']);
        const state=result.rows[0].payload as WorkspaceState;
        const tx=this.context(state,client);
        const batches=await tx.batches();
        const value={state,batches,budgets:await tx.budgetBatches(),consumedByBatch:projectId?await this.store.confirmedAmountsForBatches(batches.filter(b=>b.projectId===projectId).map(b=>b.id),client):{}};
        await client.query('commit');return value;
      } catch(error){await client.query('rollback');throw error;}
    });
  }

  async transact<T>(work: (tx: WorkspaceTransaction) => Promise<T>,options:{incrementRevision?:boolean}={}): Promise<T> {
    if (this.store instanceof PostgresStore) {
      return this.store.withClient(async client => {
        await client.query('begin');
        try {
          const result = await client.query('select payload from platform_workspace where id=$1 for update', ['org-demo']);
          const state = result.rows[0].payload as WorkspaceState;
          const before=JSON.stringify(state);
          const value = await work(this.context(state, client));
          if(JSON.stringify(state)!==before){if(options.incrementRevision!==false)state.revision++;await client.query('update platform_workspace set payload=$1,revision=$2,updated_at=now() where id=$3', [state,state.revision,state.tenantId]);}
          await client.query('commit'); return value;
        } catch (error) { await client.query('rollback'); throw error; }
      });
    }
    return this.store.exclusive(async () => {
      const state = structuredClone(this.memory);
      const before=JSON.stringify(state);
      const oldBatches = structuredClone(this.store.quotaBatches);
      const oldCredentials = structuredClone(this.store.credentials);
      const oldBudgets = structuredClone(this.budgets);
      const previousReview=structuredClone({reservations:this.store.reservationsByRequest,idempotency:this.store.reservationsByIdempotency,responses:this.store.settlementResponsesByRequest,logs:this.store.callLogs,ledger:this.store.ledgerEntries,reconciliations:this.store.reconciliationRecords});
      try {
        const result = await work(this.context(state));
        if(JSON.stringify(state)!==before){if(options.incrementRevision!==false)state.revision++;this.memory=state;}return result;
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

  private context(state: WorkspaceState, client?: PoolClient): WorkspaceTransaction {
    return {
      state,
      queryCalls:(input,scope)=>this.store.queryCalls(input,scope,client),
      inFlightCounts:()=>this.store.inFlightCounts(client),
      reconcile:input=>this.store.reconcileWithinBusinessTransaction(input,client),
      batches: async () => {
        if (!client) return [...this.store.quotaBatches.values()].map(b => ({...b,entitlementId:b.entitlementId??null,sourceBatchId:b.sourceBatchId??null}));
        const result = await client.query('select * from quota_batches order by expires_at,id');
        return result.rows.map(r => ({id:r.id,sourceType:r.source_type,sourceId:r.source_id,organizationId:r.organization_id,projectId:r.project_id,totalAmount:Number(r.total_amount),availableAmount:Number(r.available_amount),modelIds:r.model_ids,expiresAt:r.expires_at.toISOString(),purpose:r.purpose,entitlementId:r.entitlement_id,sourceBatchId:r.source_batch_id,closedAt:r.closed_at?.toISOString()??null,closedAmount:Number(r.closed_amount)}));
      },
      grant: async batch => {
        if (!client) {
          if (this.store.quotaBatches.has(batch.id)) throw new ConflictException('quota batch already exists');
          this.store.quotaBatches.set(batch.id, structuredClone(batch)); return;
        }
        await client.query(`insert into quota_batches(id,source_type,source_id,organization_id,project_id,total_amount,available_amount,model_ids,expires_at,purpose,entitlement_id,source_batch_id)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[batch.id,batch.sourceType,batch.sourceId,batch.organizationId,batch.projectId,batch.totalAmount,batch.availableAmount,JSON.stringify(batch.modelIds),batch.expiresAt,batch.purpose,batch.entitlementId,batch.sourceBatchId]);
      },
      updateBatchModels: async (id, modelIds) => {
        if(!client){const batch=this.store.quotaBatches.get(id);if(batch)batch.modelIds=[...modelIds];return;}
        await client.query('update quota_batches set model_ids=$1 where id=$2',[JSON.stringify(modelIds),id]);
      },
      saveCredential: async credential => {
        if (!client) { this.store.credentials.set(credential.apiKey, structuredClone(credential)); return; }
        await client.query(`insert into credentials(credential_id,api_key,identity,purpose,active,model_ids) values($1,$2,$3,$4,$5,$6)
          on conflict(credential_id) do update set active=excluded.active,model_ids=excluded.model_ids,identity=excluded.identity`,
          [credential.credentialId,credential.apiKey,credential.identity,credential.purpose,credential.active,JSON.stringify(credential.modelIds)]);
      },
      disableCredentials: async subjectId => {
        if (!client) {for(const c of this.store.credentials.values())if(c.identity.subjectId===subjectId)c.active=false;return;}
        await client.query("update credentials set active=false where identity->>'subjectId'=$1",[subjectId]);
      },
      budgetBatches: async () => {
        if (!client) return [...this.budgets.values()].map(b => structuredClone(b));
        const result = await client.query('select * from project_budget_batches order by expires_at,id');
        return result.rows.map(r => ({id:r.id,projectId:r.project_id,totalAmount:Number(r.total_amount),availableAmount:Number(r.available_amount),expiresAt:r.expires_at.toISOString(),createdAt:r.created_at.toISOString(),closedAt:r.closed_at?.toISOString()??null,closedAmount:Number(r.closed_amount)}));
      },
      fundBudget: async batch => {
        if (!client) {if(this.budgets.has(batch.id))throw new ConflictException('budget batch already exists');this.budgets.set(batch.id,structuredClone(batch));return;}
        await client.query('insert into project_budget_batches(id,project_id,total_amount,available_amount,expires_at,created_at) values($1,$2,$3,$4,$5,$6)',[batch.id,batch.projectId,batch.totalAmount,batch.availableAmount,batch.expiresAt,batch.createdAt]);
      },
      allocateBudget: async (id,amount) => {
        if (!client) {
          const batch=this.budgets.get(id);
          if(!batch || batch.closedAt || Date.parse(batch.expiresAt)<=Date.now() || batch.availableAmount<amount)throw new ConflictException('source budget is expired or insufficient');
          batch.availableAmount=Number((batch.availableAmount-amount).toFixed(6));return;
        }
        const result=await client.query('update project_budget_batches set available_amount=available_amount-$1 where id=$2 and expires_at>now() and available_amount >= $1 and closed_at is null returning id',[amount,id]);
        if(!result.rowCount)throw new ConflictException('source budget is expired or insufficient');
      },
      closeProjectBalances:async projectId=>{
        if(!client){let memberAmount=0,budgetAmount=0;const at=new Date().toISOString();
          for(const batch of this.store.quotaBatches.values())if(batch.projectId===projectId&&!batch.closedAt){memberAmount+=batch.availableAmount;batch.closedAmount=Number(((batch.closedAmount??0)+batch.availableAmount).toFixed(6));batch.availableAmount=0;batch.closedAt=at;batch.modelIds=[];}
          for(const batch of this.budgets.values())if(batch.projectId===projectId&&!batch.closedAt){budgetAmount+=batch.availableAmount;batch.closedAmount=Number(((batch.closedAmount??0)+batch.availableAmount).toFixed(6));batch.availableAmount=0;batch.closedAt=at;}
          return {memberAmount:Number(memberAmount.toFixed(6)),budgetAmount:Number(budgetAmount.toFixed(6))};
        }
        const members=await client.query(`with moved as (update quota_batches set closed_amount=closed_amount+available_amount,available_amount=0,closed_at=clock_timestamp(),model_ids='[]'::jsonb where project_id=$1 and closed_at is null returning closed_amount) select coalesce(sum(closed_amount),0) as amount from moved`,[projectId]);
        const budgets=await client.query(`with moved as (update project_budget_batches set closed_amount=closed_amount+available_amount,available_amount=0,closed_at=clock_timestamp() where project_id=$1 and closed_at is null returning closed_amount) select coalesce(sum(closed_amount),0) as amount from moved`,[projectId]);
        return {memberAmount:Number(members.rows[0].amount),budgetAmount:Number(budgets.rows[0].amount)};
      },
    };
  }
}
