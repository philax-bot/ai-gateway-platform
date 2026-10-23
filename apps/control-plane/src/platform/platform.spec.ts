import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformCommand } from '@ai-gateway/contracts';
import { DemoStore } from '../store/demo.store';
import { PolicyService } from '../policy/policy.service';
import { WorkspaceRepository } from './workspace.repository';
import { PlatformService } from './platform.service';
import { AuthService } from './auth.service';
import { MaintenanceService } from './maintenance.service';

const operator='operator-demo-001',employee='employee-demo-001';
const future=()=>new Date(Date.now()+86400000*7).toISOString();
const modelRange={poolId:'pool-local-test',mode:'follow',definitionIds:[]};
describe('persistent business domain and ledger invariants',()=>{
  let ledger:DemoStore,repository:WorkspaceRepository,platform:PlatformService,auth:AuthService;
  async function command(type:string,payload:Record<string,unknown>,actor=operator,key=crypto.randomUUID()){
    const c:PlatformCommand={type,payload,idempotencyKey:key};
    const preview=await platform.preview(actor,c);c.previewToken=preview.previewToken;
    return (await platform.execute(actor,c)).result as any;
  }
  beforeEach(async()=>{
    ledger=new DemoStore();repository=new WorkspaceRepository(ledger);await repository.initialize();
    platform=new PlatformService(repository,ledger);auth=new AuthService(repository);
  });
  async function openTestPool(){
    // Unit fixture: actual HTTP verification is covered separately in the isolated integration run.
    await repository.transact(async tx=>{tx.state.services[0].verification='passed';});
    await command('save.pool',{id:'pool-local-test',name:'办公池',entries:[{definitionId:'definition-test-model',serviceId:'service-local-test',open:true}]});
  }
  async function plan(name='办公方案',range=modelRange){
    return command('save.plan',{name,range,amount:10,cadence:'monthly',quotaDays:30,entitlementDays:365});
  }

  it('bootstraps once, hashes passwords and revokes access when member is disabled',async()=>{
    await auth.setup({directoryId:'admin',name:'管理员',password:'a-long-local-password'},'127.0.0.1');
    await expect(auth.setup({directoryId:'admin',name:'管理员',password:'another-long-password'},'127.0.0.1')).rejects.toThrow('already initialized');
    const login=await auth.login({directoryId:'admin',password:'a-long-local-password'},'127.0.0.1');
    expect((await auth.authenticate(login.token)).id).toBe(operator);
    expect(JSON.stringify(await platform.snapshot(operator))).not.toContain('passwordHash');
    expect((await repository.read()).members.find(m=>m.id===operator)!.passwordHash).not.toContain('a-long-local-password');
    await auth.logout(login.token);await expect(auth.authenticate(login.token)).rejects.toThrow('expired');
    await expect(command('save.member',{id:operator,name:'管理员',directoryId:'admin',organizationId:'org-demo',roles:['employee'],active:false})).rejects.toThrow('last active operator');
  });

  it('requires verified sources and invalidates verification when mappings change',async()=>{
    await expect(command('save.pool',{name:'错误池',entries:[{definitionId:'definition-test-model',serviceId:'service-local-test',open:true}]})).rejects.toThrow('verified');
    await openTestPool();
    const service=(await repository.read()).services[0];
    const saved=await command('save.service',{...service,baseUrl:'http://127.0.0.1:4011'});
    expect(saved.verification).toBe('unverified');
  });

  it('previews without mutation and rejects stale confirmations',async()=>{
    const c:PlatformCommand={type:'project.fund',idempotencyKey:crypto.randomUUID(),payload:{projectId:'unknown',amount:10,expiresAt:future()}};
    const before=await repository.read();const preview=await platform.preview(operator,c);
    expect((await repository.read()).revision).toBe(before.revision);
    await command('settings.update',{name:'工作空间'});
    await expect(platform.execute(operator,{...c,previewToken:preview.previewToken})).rejects.toThrow('stale');
  });

  it('keeps project funding, allocation and consumption as distinct money movements',async()=>{
    await openTestPool();
    const project=await command('save.project',{name:'项目',managerId:employee,range:modelRange});
    expect((await repository.view()).budgets).toHaveLength(0);
    const budget=await command('project.fund',{projectId:project.id,amount:20,expiresAt:future()});
    const allocated=await command('project.allocate',{projectId:project.id,memberId:employee,sourceBatchId:budget.id,amount:8},employee);
    const view=await repository.view();expect(view.budgets[0].availableAmount).toBe(12);
    expect(allocated.availableAmount).toBe(8);expect(allocated.expiresAt).toBe(budget.expiresAt);expect(allocated.sourceBatchId).toBe(budget.id);
    expect(ledger.quotaBatches.get('personal-batch-demo-001')!.availableAmount).toBe(10);
    const before=await repository.view();
    await expect(command('project.allocate',{projectId:project.id,memberId:employee,sourceBatchId:budget.id,amount:13},employee)).rejects.toThrow('insufficient');
    expect((await repository.view()).batches).toEqual(before.batches);
    expect((await repository.view()).budgets).toEqual(before.budgets);
  });

  it('grants each plan once and never persists or replays a key plaintext',async()=>{
    await openTestPool();const configured=await plan();
    const distribution={planId:configured.id,memberIds:[employee]};
    const key=crypto.randomUUID();await command('distribution.execute',distribution,operator,key);
    const first=(await repository.view()).batches.length;
    await command('distribution.execute',distribution,operator,key);
    await command('distribution.execute',distribution);
    expect((await repository.view()).batches).toHaveLength(first);
    const issueKey=crypto.randomUUID();
    const issued=await command('key.issue',{purpose:'personal',name:'编辑器'},employee,issueKey);
    expect(issued.secret).toMatch(/^sa_/);
    expect((await ledger.getDemoCredential(issued.secret))?.identity.subjectId).toBe(employee);
    expect(JSON.stringify(await repository.read())).not.toContain(issued.secret);
    expect(await command('key.issue',{purpose:'personal',name:'编辑器'},employee,issueKey)).not.toHaveProperty('secret');
    const policy=new PolicyService(ledger,platform);
    await command('key.status',{id:issued.key.id,status:'revoked',reason:'验收吊销'},employee);
    expect(await ledger.getDemoCredential(issued.secret)).toBeNull();
    const response=await policy.authorize({requestId:crypto.randomUUID(),idempotencyKey:crypto.randomUUID(),identity:{credentialId:issued.key.credentialId,subjectType:'employee',subjectId:employee,organizationId:'org-demo',projectId:null},purpose:'personal',modelId:'test-model',mode:'chat',policyVersion:'v1'});
    expect(response.decision).toBe('deny');
  });

  it('separates approval from execution and applies adjusted amount exactly once',async()=>{
    await openTestPool();const configured=await plan();
    const request=await command('approval.submit',{kind:'personal_open',amount:30,expiresAt:future(),scenario:'办公',reason:'业务需要'},employee);
    await expect(command('approval.decide',{id:request.id,decision:'approve',amount:7,reason:'批准'},employee)).rejects.toThrow();
    const approved=await command('approval.decide',{id:request.id,decision:'approve',amount:7,expiresAt:request.requestedExpiresAt,planId:configured.id,reason:'批准 7 元'});
    expect(approved.status).toBe('approved');expect((await repository.read()).entitlements).toHaveLength(0);
    const effective=await command('approval.execute',{id:request.id});expect(effective.status).toBe('effective');
    expect((await repository.view()).batches.filter(b=>b.entitlementId)[0].totalAmount).toBe(7);
    await command('approval.execute',{id:request.id});expect((await repository.read()).entitlements).toHaveLength(1);
  });

  it('keeps application resources independent of owner personal status',async()=>{
    await openTestPool();const app=await command('save.application',{name:'应用',ownerId:employee,organizationId:'org-demo',range:modelRange});
    await command('application.fund',{applicationId:app.id,amount:50,expiresAt:future()});
    const issued=await command('key.issue',{purpose:'application',applicationId:app.id,name:'服务接入'},employee);
    await command('save.member',{id:employee,name:'离职员工',directoryId:'employee',organizationId:'department-engineering',active:false});
    expect((await ledger.getDemoCredential(issued.secret))?.identity.subjectType).toBe('application');
    expect((await repository.read()).applications[0].active).toBe(true);
    expect(JSON.stringify(await platform.snapshot(operator))).not.toContain(issued.secret);
  });

  it('reconciles captured usage using the original price, exactly once, in the business transaction',async()=>{
    await openTestPool();
    await repository.transact(async tx=>{Object.assign(tx.state.services[0].mappings[0],{inputPrice:2,outputPrice:3,cachedInputPrice:0.5});});
    const configured=await plan();await command('distribution.execute',{planId:configured.id,memberIds:[employee]});
    const key=await command('key.issue',{purpose:'personal',name:'计费'},employee),credential=(await ledger.getDemoCredential(key.secret))!;
    const input={requestId:crypto.randomUUID(),idempotencyKey:crypto.randomUUID(),identity:credential.identity,purpose:'personal' as const,modelId:'test-model',mode:'chat' as const,estimatedInputTokens:100,maxOutputTokens:32,policyVersion:'review'};
    const admitted=await ledger.authorize(input);
    await ledger.settle({requestId:input.requestId,idempotencyKey:crypto.randomUUID(),reservationId:admitted.reservation!.reservationId,outcome:'partial',usageFinal:false,inputTokens:0,outputTokens:0,completedAt:new Date().toISOString()});
    const batch=[...ledger.quotaBatches.values()].find(b=>b.entitlementId)!;expect(batch.availableAmount).toBe(9.999704);
    const c:PlatformCommand={type:'usage.reconcile',idempotencyKey:crypto.randomUUID(),payload:{requestId:input.requestId,mode:'confirm_usage',inputTokens:13,outputTokens:14,cachedInputTokens:4,reason:'已核对上游用量记录'}};
    await expect(platform.preview(employee,c)).rejects.toThrow('operator');
    const preview=await platform.preview(operator,c);c.previewToken=preview.previewToken;
    const result=await platform.execute(operator,c);expect(result.result).toMatchObject({status:'settled'});
    expect(batch.availableAmount).toBe(9.999938);expect((await ledger.getCall(input.requestId))!.actualAmount).toBe(0.000062);
    await platform.execute(operator,c);expect(batch.availableAmount).toBe(9.999938);expect(ledger.ledgerEntries.filter(e=>e.kind==='reconciliation')).toHaveLength(1);
    expect((await repository.read()).audit.some(a=>a.action==='usage.reconcile'&&a.reason==='已核对上游用量记录')).toBe(true);
  });

  it('rolls back review money, log state and ledger entries together if the business transaction fails',async()=>{
    const credential=(await ledger.getDemoCredential('local-employee-key'))!;
    const input={requestId:crypto.randomUUID(),idempotencyKey:crypto.randomUUID(),identity:credential.identity,purpose:'personal' as const,modelId:'test-model',mode:'chat' as const,policyVersion:'review'};
    const a=await ledger.authorize(input);await ledger.settle({requestId:input.requestId,idempotencyKey:crypto.randomUUID(),reservationId:a.reservation!.reservationId,outcome:'partial',usageFinal:false,completedAt:new Date().toISOString()});
    await expect(repository.transact(async tx=>{await tx.reconcile({requestId:input.requestId,idempotencyKey:crypto.randomUUID(),actorId:operator,reason:'失败回滚',mode:'release_hold'});throw new Error('simulated audit failure');})).rejects.toThrow('simulated audit');
    expect((await ledger.getQuota()).availableAmount).toBe(9.98);expect((await ledger.getCall(input.requestId))!.billableState).toBe('pending_review');expect(ledger.ledgerEntries).toHaveLength(0);expect(ledger.reconciliationRecords.size).toBe(0);
  });
  it('expires unknown leases conservatively and later replays complete usage automatically',async()=>{
    await openTestPool();await repository.transact(async tx=>{Object.assign(tx.state.services[0].mappings[0],{inputPrice:2,outputPrice:3,cachedInputPrice:0.5});});
    const configured=await plan();await command('distribution.execute',{planId:configured.id,memberIds:[employee]});
    const key=await command('key.issue',{purpose:'personal',name:'过期恢复'},employee),credential=(await ledger.getDemoCredential(key.secret))!;
    const input={requestId:crypto.randomUUID(),idempotencyKey:crypto.randomUUID(),identity:credential.identity,purpose:'personal' as const,modelId:'test-model',mode:'chat' as const,estimatedInputTokens:100,maxOutputTokens:32,policyVersion:'recovery'};
    const a=await ledger.authorize(input),record=ledger.reservationsByRequest.get(input.requestId)!;
    expect((await ledger.renewReservation(input.requestId,record.reservationId)).renewed).toBe(true);
    record.expiresAt=new Date(Date.now()-1000).toISOString();
    const maintenance=new MaintenanceService(repository,ledger);expect((await maintenance.run()).expired).toBe(1);
    expect((await ledger.getCall(input.requestId))!.billableState).toBe('pending_review');
    const late={requestId:input.requestId,idempotencyKey:`${input.idempotencyKey}:settlement`,reservationId:a.reservation!.reservationId,outcome:'completed' as const,usageFinal:true,inputTokens:13,outputTokens:14,cachedInputTokens:4,completedAt:new Date().toISOString()};
    expect((await ledger.settle(late)).status).toBe('settled');expect((await ledger.getCall(input.requestId))!.actualAmount).toBe(0.000062);
    expect((await ledger.settle(late)).status).toBe('already_finalized');expect((await ledger.renewReservation(input.requestId,record.reservationId)).renewed).toBe(false);
  });
  it('runs monthly grants once per Shanghai calendar month and preserves template snapshots',async()=>{
    vi.useFakeTimers({toFake:['Date']});
    try{
      vi.setSystemTime(new Date('2026-10-18T10:00:00+08:00'));
      await openTestPool();const configured=await plan();await command('distribution.execute',{planId:configured.id,memberIds:[employee]});
      await command('save.plan',{...configured,amount:99});
      const maintenance=new MaintenanceService(repository,ledger),before=(await repository.read()).revision;
      expect((await maintenance.run()).issued).toBe(0);expect((await repository.read()).revision).toBe(before);
      vi.setSystemTime(new Date('2026-11-01T00:00:00+08:00'));
      expect((await maintenance.run()).issued).toBe(1);expect((await maintenance.run()).issued).toBe(0);
      const monthly=(await repository.view()).batches.filter(b=>b.entitlementId);expect(monthly).toHaveLength(2);expect(monthly.every(b=>b.totalAmount===10)).toBe(true);
      expect(monthly.some(b=>b.expiresAt==='2026-11-30T15:59:59.999Z')).toBe(true);
    }finally{vi.useRealTimers();}
  });
});
