import { beforeEach,describe,it,expect } from 'vitest';
import type { PlatformCommand } from '@ai-gateway/contracts';
import { DemoStore } from '../store/demo.store';
import { WorkspaceRepository } from './workspace.repository';
import { PlatformService } from './platform.service';
const operator='operator-demo-001',employee='employee-demo-001',range={poolId:'pool-local-test',mode:'follow',definitionIds:[]};
describe('project financial closeout and member scope',()=>{
  let repo:WorkspaceRepository,platform:PlatformService,store:DemoStore,project:any,budget:any,batch:any,key:any;
  const future=()=>new Date(Date.now()+7*86400000).toISOString();
  async function command(type:string,payload:Record<string,unknown>,actor=operator,key=crypto.randomUUID()){
    const c:PlatformCommand={type,payload,idempotencyKey:key},p=await platform.preview(actor,c);return (await platform.execute(actor,{...c,previewToken:p.previewToken})).result as any;
  }
  async function admit(){const credential=(await store.getDemoCredential(key.secret))!,input={requestId:crypto.randomUUID(),idempotencyKey:crypto.randomUUID(),identity:credential.identity,purpose:'project' as const,modelId:'test-model',mode:'chat' as const,estimatedInputTokens:100,maxOutputTokens:32,policyVersion:'close'};return {input,authorization:await store.authorize(input)};}
  beforeEach(async()=>{
    store=new DemoStore();repo=new WorkspaceRepository(store);await repo.initialize();platform=new PlatformService(repo,store);
    await repo.transact(async tx=>{tx.state.services[0].verification='passed';Object.assign(tx.state.services[0].mappings[0],{inputPrice:2,outputPrice:3,cachedInputPrice:0.5});tx.state.pools[0].entries[0].open=true;});
    project=await command('save.project',{name:'结束回收项目',managerId:operator,range});await command('project.members',{projectId:project.id,memberIds:[employee]});
    budget=await command('project.fund',{projectId:project.id,amount:20,expiresAt:future()});batch=await command('project.allocate',{projectId:project.id,sourceBatchId:budget.id,memberId:employee,amount:8});
    key=await command('key.issue',{purpose:'project',projectId:project.id,name:'项目凭据'},employee);
  });
  it('retires only unused balances, keeps admitted work valid, and routes later releases into closeout',async()=>{
    const {input,authorization:a}=await admit();expect(a.decision).toBe('allow');const reserved=a.reservation!.reservedAmount;
    const result=await command('project.end',{projectId:project.id,reason:'项目验收结束'});expect(result.budgetAmount).toBe(12);expect(result.memberAmount).toBeCloseTo(8-reserved,6);
    const detail=await platform.projectDetail(operator,project.id);expect(detail.members.flatMap(m=>m.batches).every(b=>b.availableAmount===0&&b.closedAt)).toBe(true);expect(detail.budgets[0].availableAmount).toBe(0);
    expect((await store.renewReservation(input.requestId,a.reservation!.reservationId)).renewed).toBe(true);
    await store.settle({requestId:input.requestId,idempotencyKey:crypto.randomUUID(),reservationId:a.reservation!.reservationId,outcome:'completed',forwarded:true,usageFinal:true,inputTokens:13,outputTokens:14,cachedInputTokens:4,completedAt:new Date().toISOString()});
    const after=await platform.projectDetail(operator,project.id),closed=after.members.flatMap(m=>m.batches).find(b=>b.id===batch.id)!;
    expect(closed.availableAmount).toBe(0);expect(closed.closedAmount).toBe(7.999938);expect(after.consumedByBatch[batch.id]).toBe(0.000062);
    expect(Number((closed.closedAmount!+after.budgets[0].closedAmount!+after.consumedByBatch[batch.id]).toFixed(6))).toBe(20);
    const next=await store.authorize({...input,requestId:crypto.randomUUID(),idempotencyKey:crypto.randomUUID()});expect(next.decision).toBe('deny');
    await expect(command('project.fund',{projectId:project.id,amount:1,expiresAt:future()})).rejects.toThrow('not active');
    await expect(command('save.project',{...project,status:'active'})).rejects.toThrow('immutable');
    await expect(command('key.status',{id:key.key.id,status:'active',reason:'不允许恢复'})).rejects.toThrow('ended project');
    await command('project.end',{projectId:project.id,reason:'重复结束'});expect((await platform.projectDetail(operator,project.id)).members.flatMap(m=>m.batches).find(b=>b.id===batch.id)?.closedAmount).toBe(7.999938);
    expect(store.quotaBatches.get('personal-batch-demo-001')!.availableAmount).toBe(10);
  });
  it('keeps unknown holds separate, then reconciles only against the original closed batch',async()=>{
    const {input,authorization:a}=await admit();await store.settle({requestId:input.requestId,idempotencyKey:crypto.randomUUID(),reservationId:a.reservation!.reservationId,outcome:'partial',usageFinal:false,completedAt:new Date().toISOString()});
    await command('project.end',{projectId:project.id,reason:'保留待核对'});const before=await platform.projectDetail(operator,project.id);
    await expect(command('usage.reconcile',{requestId:input.requestId,mode:'confirm_usage',inputTokens:10000000,outputTokens:0,reason:'超出原来源'})).rejects.toThrow('insufficient');
    expect((await platform.projectDetail(operator,project.id)).budgets).toEqual(before.budgets);
    await command('usage.reconcile',{requestId:input.requestId,mode:'confirm_usage',inputTokens:2000,outputTokens:1000,reason:'原批次核对'});
    const after=await platform.projectDetail(operator,project.id),row=after.members.flatMap(m=>m.batches).find(b=>b.id===batch.id)!;
    expect(row.closedAmount).toBe(7.993);expect(row.availableAmount).toBe(0);expect(after.consumedByBatch[batch.id]).toBe(0.007);expect(after.budgets[0].closedAmount).toBe(12);
  });
  it('rolls back closeout amounts together with metadata on transaction failure',async()=>{
    await expect(repo.transact(async tx=>{await tx.closeProjectBalances(project.id);tx.state.projects[0].status='ended';throw new Error('failed audit');})).rejects.toThrow('failed audit');
    const view=await repo.view();expect(view.state.projects[0].status).toBe('active');expect(view.batches.find(b=>b.id===batch.id)?.availableAmount).toBe(8);expect(view.budgets[0].availableAmount).toBe(12);
    await expect(command('project.end',{projectId:project.id})).rejects.toThrow('reason');
    const c:PlatformCommand={type:'project.end',payload:{projectId:project.id,reason:'缺预览'},idempotencyKey:crypto.randomUUID()};await expect(platform.execute(operator,c)).rejects.toThrow('preview');
  });
  it('shows managers team finance, shows members only their own allocations, and scopes candidate discovery',async()=>{
    const other=await command('save.member',{directoryId:'candidate',name:'可加入',organizationId:'org-demo'});await command('save.member',{directoryId:'expired-candidate',name:'已到期',organizationId:'org-demo',validUntil:new Date(Date.now()-1000).toISOString()});
    const candidates=await platform.projectMemberCandidates(operator,project.id);expect(candidates.map(m=>m.id)).toContain(other.id);expect(candidates.some(m=>m.name==='已到期')).toBe(false);expect(candidates.some(m=>m.id===employee)).toBe(false);
    await expect(platform.projectMemberCandidates(employee,project.id)).rejects.toThrow('responsibility');await expect(platform.projectDetail(other.id,project.id)).rejects.toThrow('outside');
    const own=await platform.projectDetail(employee,project.id);expect(own.budgets).toHaveLength(0);expect(own.members.map(m=>m.id)).toEqual([employee]);expect(own.history).toHaveLength(0);
    await command('project.members',{projectId:project.id,removeMemberIds:[employee]});await expect(platform.projectDetail(employee,project.id)).rejects.toThrow('outside');expect((await platform.projectDetail(operator,project.id)).members.find(m=>m.id===employee)?.isMember).toBe(false);
  });
});
