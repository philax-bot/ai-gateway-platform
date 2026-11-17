import {beforeEach,describe,expect,it} from 'vitest';
import type {ApprovalKind,PlatformCommand} from '@ai-gateway/contracts';
import {DemoStore} from '../store/demo.store';
import {WorkspaceRepository} from './workspace.repository';
import {PlatformService} from './platform.service';

const ops='operator-demo-001',employee='employee-demo-001';
const range={poolId:'pool-local-test',mode:'follow',definitionIds:[]};
const future=()=>new Date(Date.now()+7*86400000).toISOString();
const kinds:ApprovalKind[]=['project_create','project_budget','project_member_quota','personal_open','personal_topup','application_quota','application_billing'];
describe('approval lifecycle, recovery and immutable execution receipts',()=>{
  let repo:WorkspaceRepository,platform:PlatformService,plan:any,manager:any,project:any,budget:any;
  async function command(type:string,payload:Record<string,unknown>,actor=ops,key=crypto.randomUUID()){
    const c:PlatformCommand={type,payload,idempotencyKey:key},preview=await platform.preview(actor,c);
    return (await platform.execute(actor,{...c,previewToken:preview.previewToken})).result as any;
  }
  beforeEach(async()=>{
    const store=new DemoStore();repo=new WorkspaceRepository(store);await repo.initialize();platform=new PlatformService(repo,store);
    await repo.transact(async tx=>{tx.state.services[0].verification='passed';tx.state.pools[0].entries[0].open=true;});
    plan=await command('save.plan',{name:'日常方案',range,amount:10,cadence:'once',quotaDays:30,entitlementDays:365});
    manager=await command('save.member',{directoryId:'approval-manager',name:'项目经理',organizationId:'org-demo'});
    project=await command('save.project',{initialAmount:1,validity:'permanent',name:'知识助手',managerId:manager.id,range});
    await command('project.members',{projectId:project.id,memberIds:[employee]});
    budget=await command('project.fund',{projectId:project.id,amount:100,expiresAt:future()});
  });
  async function setup(kind:ApprovalKind){
    let objectId:string|undefined,actor=employee,approver=ops;
    if(kind==='project_create')objectId=undefined;
    else if(kind==='project_budget'){objectId=project.id;actor=manager.id;}
    else if(kind==='project_member_quota'){objectId=project.id;approver=manager.id;}
    else if(kind==='personal_topup'){
      await command('distribution.execute',{planId:plan.id,memberIds:[employee]});
      objectId=(await repo.read()).entitlements.find(e=>e.memberId===employee)!.id;
    }else if(kind.startsWith('application_')){
      objectId=(await command('save.application',{initialAmount:1,validity:'permanent',name:'业务应用',billingMode:kind==='application_billing'?'accounting':'quota',ownerId:employee,organizationId:'org-demo',range})).id;
    }
    const payload={kind,objectId,amount:30,expiresAt:future(),name:'申请创建的项目',managerId:manager.id,scenario:'知识整理',reason:'业务需求'};
    const approval=await command('approval.submit',payload,actor);
    return {actor,approver,approval,payload};
  }
  it.each(kinds)('keeps failed %s requests active until explicitly closed',async kind=>{
    const {approval,payload,actor,approver}=await setup(kind);
    await repo.transact(async tx=>{const a=tx.state.approvals.find(v=>v.id===approval.id)!;a.status='failed';a.approverId=approver;a.failure='plan not found';});
    await expect(command('approval.submit',payload,actor)).rejects.toThrow('already pending');
    await expect(command('approval.close',{id:approval.id,reason:'本人关闭'},actor)).rejects.toThrow('self approval');
    const before=await repo.view();
    await command('approval.close',{id:approval.id,reason:'业务取消'},approver);
    const after=await repo.view(),closed=after.state.approvals.find(a=>a.id===approval.id)!;
    expect(closed).toMatchObject({status:'closed',closedBy:approver,closeReason:'业务取消',failure:'plan not found'});
    expect(after.batches).toEqual(before.batches);expect(after.budgets).toEqual(before.budgets);
    await expect(command('approval.execute',{id:approval.id},approver)).rejects.toThrow('not approved');
    await expect(command('approval.repair',{id:approval.id,reason:'试图恢复'},approver)).rejects.toThrow('only an approved');
    expect((await command('approval.submit',payload,actor)).id).not.toBe(approval.id);
    const detail=await platform.approvalDetail(actor,approval.id);
    expect(detail.permissions).toEqual({decide:false,repair:false,execute:false,withdraw:false,close:false});
    expect(detail.history.some(h=>h.action==='approval.close'&&h.reason==='业务取消')).toBe(true);
    expect(after.state.notifications.some(n=>n.recipientId===actor&&n.title==='申请已关闭')).toBe(true);
  });
  it.each(kinds)('records actual %s outputs atomically and preserves receipts on replay',async kind=>{
    const {approval,approver}=await setup(kind);
    await command('approval.decide',{id:approval.id,decision:'approve',reason:'按需批准',amount:7,expiresAt:kind==='project_member_quota'?budget.expiresAt:future(),managerId:manager.id,range,planId:plan.id,sourceBatchId:budget.id},approver);
    expect((await platform.approvalDetail(approver,approval.id)).approval.receipt).toBeUndefined();
    const result=await command('approval.execute',{id:approval.id},approver),before=await repo.view();
    expect(result.receipt).toMatchObject({amount:7,modelNames:['本地测试模型']});
    if(kind==='project_create')expect(before.state.projects.some(p=>p.id===result.receipt.objectId&&p.name==='申请创建的项目')).toBe(true);
    else if(kind==='project_budget')expect(before.budgets.find(b=>b.id===result.receipt.batchId)).toMatchObject({totalAmount:7,expiresAt:result.receipt.expiresAt});
    else expect(before.batches.find(b=>b.id===result.receipt.batchId)).toMatchObject({totalAmount:7,expiresAt:result.receipt.expiresAt});
    if(kind==='project_member_quota')expect(result.receipt.expiresAt).toBe(budget.expiresAt);
    expect((await command('approval.execute',{id:approval.id},approver)).receipt).toEqual(result.receipt);
    expect((await repo.view()).batches).toEqual(before.batches);
  });
  it.each(['disabled','expired','organization'] as const)('routes member requests to operators when the manager is %s, then requires audited takeover',async failure=>{
    const {approval}=await setup('project_member_quota');
    await expect(command('approval.decide',{id:approval.id,decision:'approve',reason:'无权越过有效经理'})).rejects.toThrow('not responsible');
    await command('approval.decide',{id:approval.id,decision:'approve',reason:'经理批准',amount:7,expiresAt:budget.expiresAt,sourceBatchId:budget.id},manager.id);
    await repo.transact(async tx=>{
      const m=tx.state.members.find(m=>m.id===manager.id)!;
      if(failure==='disabled')m.active=false;
      else if(failure==='expired')m.validUntil=new Date(Date.now()-1000).toISOString();
      else {tx.state.organizations.push({id:'disabled-manager-org',name:'停用组织',parentId:'org-demo',active:false});m.organizationId='disabled-manager-org';}
    });
    const detail=await platform.approvalDetail(ops,approval.id);
    expect(detail.responsible.map(m=>m.id)).toContain(ops);expect(detail.permissions).toMatchObject({repair:true,execute:false,close:true});
    expect((await platform.snapshot(ops)).approvals.find(a=>a.id===approval.id)?.responsibleIds).toContain(ops);
    await expect(command('approval.execute',{id:approval.id})).rejects.toThrow('responsibility changed');
    await command('approval.repair',{id:approval.id,reason:'经理失效后接手',sourceBatchId:budget.id,expiresAt:budget.expiresAt});
    await command('approval.execute',{id:approval.id});
    expect((await platform.approvalDetail(ops,approval.id)).approval.status).toBe('effective');
  });
  it('requires a fresh signed preview to close and refuses to close pending or effective work',async()=>{
    const {approval}=await setup('personal_open');
    await expect(command('approval.close',{id:approval.id,reason:'仍待审批'})).rejects.toThrow('only an approved');
    await command('approval.decide',{id:approval.id,decision:'approve',reason:'批准',amount:7,expiresAt:future(),planId:plan.id});
    await expect(platform.execute(ops,{type:'approval.close',payload:{id:approval.id,reason:'跳过预览'},idempotencyKey:crypto.randomUUID()})).rejects.toThrow('preview');
    await command('approval.execute',{id:approval.id});
    await expect(command('approval.close',{id:approval.id,reason:'已经生效'})).rejects.toThrow('only an approved');
  });
  it('requires a valid initial budget expiry when approving and repairing project creation',async()=>{
    const {approval}=await setup('project_create');
    await repo.transact(async tx=>{tx.state.approvals.find(a=>a.id===approval.id)!.requestedExpiresAt=new Date(Date.now()-86400000).toISOString();});
    await expect(command('approval.decide',{id:approval.id,decision:'approve',managerId:employee,range,reason:'过期不能发放'})).rejects.toThrow('future expiry');
    const result=await command('approval.decide',{id:approval.id,decision:'approve',expiresAt:future(),managerId:employee,range,reason:'确认创建项目'});
    expect(result.approvedAmount).toBe(30);
    await command('approval.repair',{id:approval.id,managerId:manager.id,range,reason:'变更最终经理'});
    expect((await command('approval.execute',{id:approval.id})).receipt).toMatchObject({amount:30,expiresAt:result.approvedExpiresAt});
  });
});
