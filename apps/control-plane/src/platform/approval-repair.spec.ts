import { beforeEach,describe,it,expect } from 'vitest';
import type { PlatformCommand } from '@ai-gateway/contracts';
import { DemoStore } from '../store/demo.store';
import { WorkspaceRepository } from './workspace.repository';
import { PlatformService } from './platform.service';
const operator='operator-demo-001',employee='employee-demo-001';
const future=()=>new Date(Date.now()+86400000*7).toISOString(),range={poolId:'pool-local-test',mode:'follow',definitionIds:[]};
describe('approval execution repairs and current responsibility',()=>{
  let repo:WorkspaceRepository,platform:PlatformService,plan:any;
  async function command(type:string,payload:Record<string,unknown>,actor=operator,key=crypto.randomUUID()){
    const c:PlatformCommand={type,payload,idempotencyKey:key},preview=await platform.preview(actor,c);return (await platform.execute(actor,{...c,previewToken:preview.previewToken})).result as any;
  }
  beforeEach(async()=>{
    const store=new DemoStore();repo=new WorkspaceRepository(store);await repo.initialize();platform=new PlatformService(repo,store);
    await repo.transact(async tx=>{tx.state.services[0].verification='passed';tx.state.pools[0].entries[0].open=true;});
    plan=await command('save.plan',{name:'审批开通方案',range,amount:10,cadence:'monthly',quotaDays:30,entitlementDays:365});
  });
  async function failedApproval(){
    const a=await command('approval.submit',{kind:'personal_open',amount:10,expiresAt:future(),scenario:'办公',reason:'开通申请'},employee);
    await command('approval.decide',{id:a.id,decision:'approve',amount:8,expiresAt:future(),reason:'原批准',planId:'wrong-plan'});
    await expect(command('approval.execute',{id:a.id})).rejects.toThrow('plan');return a;
  }
  it('previews and repairs without funding, then executes adjusted values exactly once with full history',async()=>{
    const a=await failedApproval(),before=await repo.view();expect(before.state.approvals.find(v=>v.id===a.id)?.status).toBe('failed');
    expect((await platform.approvalDetail(operator,a.id)).permissions).toEqual({decide:false,repair:true,execute:true,withdraw:false});
    expect((await platform.approvalDetail(employee,a.id)).permissions).toEqual({decide:false,repair:false,execute:false,withdraw:false});
    const c:PlatformCommand={type:'approval.repair',payload:{id:a.id,planId:plan.id,amount:6,expiresAt:future(),reason:'修正不存在的方案'},idempotencyKey:crypto.randomUUID()};
    const preview=await platform.preview(operator,c);expect(preview.impact.approvalBefore).toMatchObject({status:'failed',approvedAmount:8});expect(preview.impact.approvalAfter).toMatchObject({status:'approved',approvedAmount:6});
    expect((await repo.view()).batches).toEqual(before.batches);
    await platform.execute(operator,{...c,previewToken:preview.previewToken});expect((await repo.view()).batches).toEqual(before.batches);
    const repaired=(await repo.read()).approvals.find(v=>v.id===a.id)!;expect(repaired.amount).toBe(10);expect(repaired.approvedAmount).toBe(6);expect(repaired.failure).toBeNull();
    const key=crypto.randomUUID();await command('approval.execute',{id:a.id},operator,key);await command('approval.execute',{id:a.id},operator,key);await command('approval.execute',{id:a.id});
    expect((await repo.view()).batches.filter(b=>b.entitlementId).map(b=>b.totalAmount)).toEqual([6]);
    const detail=await platform.approvalDetail(employee,a.id);expect(detail.history.map(h=>h.action)).toEqual(expect.arrayContaining(['approval.submit','approval.decide','approval.execution_failed','approval.execution_repaired','approval.execute']));
    expect((await platform.approvalDetail(operator,a.id)).permissions).toEqual({decide:false,repair:false,execute:false,withdraw:false});
    expect(detail.history.find(h=>h.action==='approval.execution_repaired')?.detail.before).toMatchObject({approvedAmount:8,execution:{planId:'wrong-plan'}});
    await expect(command('approval.repair',c.payload)).rejects.toThrow('only an approved or failed');
    await expect(platform.approvalDetail('missing-member',a.id)).rejects.toThrow();
  });
  it('requires a fresh signed repair and denies applicants or unrelated employees',async()=>{
    const a=await failedApproval(),payload={id:a.id,planId:plan.id,reason:'修正'},c:PlatformCommand={type:'approval.repair',payload,idempotencyKey:crypto.randomUUID()};
    await expect(platform.execute(operator,c)).rejects.toThrow('preview');
    await expect(command('approval.repair',payload,employee)).rejects.toThrow('responsible');
    const other=await command('save.member',{directoryId:'unrelated',name:'无关员工',organizationId:'org-demo'});
    await expect(platform.approvalDetail(other.id,a.id)).rejects.toThrow('outside');
    const signed=await platform.preview(operator,c);await command('settings.update',{name:'新配置'});await expect(platform.execute(operator,{...c,previewToken:signed.previewToken})).rejects.toThrow('stale');
    expect((await repo.read()).approvals.find(v=>v.id===a.id)?.status).toBe('failed');
  });
  it('allows a current responsible operator to take over with an explicit audited repair',async()=>{
    const a=await failedApproval();const second=await command('save.member',{directoryId:'second-ops',name:'第二运营',organizationId:'org-demo',roles:['employee','operator']});
    expect((await platform.approvalDetail(second.id,a.id)).permissions).toMatchObject({repair:true,execute:false});
    await expect(command('approval.execute',{id:a.id},second.id)).rejects.toThrow('responsibility changed');
    await command('approval.repair',{id:a.id,planId:plan.id,reason:'原批准人转交处理'},second.id);
    expect((await platform.approvalDetail(second.id,a.id)).permissions.execute).toBe(true);
    expect((await platform.approvalDetail(operator,a.id)).permissions.execute).toBe(false);
    await expect(command('approval.execute',{id:a.id})).rejects.toThrow('responsibility changed');
    await command('approval.execute',{id:a.id},second.id);expect((await repo.read()).approvals.find(v=>v.id===a.id)?.approverId).toBe(second.id);
    const event=(await platform.approvalDetail(employee,a.id)).history.find(h=>h.action==='approval.execution_repaired')!;expect((event.detail.before as any).approverId).toBe(operator);expect(event.actorId).toBe(second.id);
  });
  it('repairs project member quota from a same-project batch and inherits its exact expiry',async()=>{
    const manager=await command('save.member',{directoryId:'manager',name:'经理',organizationId:'org-demo'}),project=await command('save.project',{name:'项目',managerId:manager.id,range});await command('project.members',{projectId:project.id,memberIds:[employee]});
    const a=await command('approval.submit',{kind:'project_member_quota',objectId:project.id,amount:3,expiresAt:future(),scenario:'项目',reason:'申请'},employee);
    await command('approval.decide',{id:a.id,decision:'approve',amount:3,expiresAt:future(),sourceBatchId:'missing',reason:'批准'},manager.id);await expect(command('approval.execute',{id:a.id},manager.id)).rejects.toThrow();
    const budget=await command('project.fund',{projectId:project.id,amount:5,expiresAt:future()});
    const other=await command('save.project',{name:'其他项目',managerId:manager.id,range}),otherBudget=await command('project.fund',{projectId:other.id,amount:5,expiresAt:future()});
    await expect(command('approval.repair',{id:a.id,sourceBatchId:otherBudget.id,expiresAt:otherBudget.expiresAt,reason:'跨项目'},manager.id)).rejects.toThrow('belong');
    await command('approval.repair',{id:a.id,sourceBatchId:budget.id,expiresAt:budget.expiresAt,reason:'新有效批次'},manager.id);await command('approval.execute',{id:a.id},manager.id);
    const view=await repo.view();expect(view.budgets.find(b=>b.id===budget.id)?.availableAmount).toBe(2);expect(view.batches.find(b=>b.sourceBatchId===budget.id)?.expiresAt).toBe(budget.expiresAt);
  });
});
