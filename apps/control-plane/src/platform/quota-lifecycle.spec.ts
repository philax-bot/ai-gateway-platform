import {beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {QUOTA_FOREVER,type PlatformCommand} from '@ai-gateway/contracts';
import {DemoStore} from '../store/demo.store';
import {WorkspaceRepository} from './workspace.repository';
import {PlatformService} from './platform.service';
const ops='operator-demo-001',employee='employee-demo-001',range={poolId:'pool-local-test',mode:'follow',definitionIds:[]};
const future=(days=10)=>new Date(Date.now()+days*86400000).toISOString();
describe('project and application initial grants and quota changes',()=>{
  let store:DemoStore,repo:WorkspaceRepository,service:PlatformService;
  async function command(type:string,payload:Record<string,unknown>,actor=ops,key=randomUUID()){
    const c:PlatformCommand={type,payload,idempotencyKey:key};c.previewToken=(await service.preview(actor,c)).previewToken;return (await service.execute(actor,c)).result as any;
  }
  const project=(extra:Record<string,unknown>={})=>command('save.project',{name:'项目',managerId:employee,range,initialAmount:20,expiresAt:future(),...extra});
  const app=(extra:Record<string,unknown>={})=>command('save.application',{name:'应用',ownerId:employee,organizationId:'org-demo',range,billingMode:'quota',initialAmount:10,validity:'permanent',...extra});
  beforeEach(async()=>{
    store=new DemoStore();repo=new WorkspaceRepository(store);await repo.initialize();store.businessState=()=>repo.read();service=new PlatformService(repo,store);
    await repo.transact(async tx=>{tx.state.settings.limits={mode:'none'};tx.state.services[0].verification='passed';Object.assign(tx.state.services[0].mappings[0],{inputPrice:2,outputPrice:3,cachedInputPrice:0.5});tx.state.pools[0].entries[0].open=true;});
  });
  it.each([undefined,'',0,-1,NaN])('rejects invalid initial amount %s without creating an object or grant',async initialAmount=>{
    const before=await repo.view();await expect(project({initialAmount})).rejects.toThrow();await expect(app({initialAmount})).rejects.toThrow();expect(await repo.view()).toEqual(before);
  });
  it('creates initial budget atomically, never allocates to manager, and replays only once',async()=>{
    const key=randomUUID(),payload={name:'一次授额',managerId:employee,range,initialAmount:20,validity:'permanent'};
    const first=await command('save.project',payload,ops,key);expect((await command('save.project',payload,ops,key)).id).toBe(first.id);
    const view=await repo.view();expect(view.budgets.filter(b=>b.projectId===first.id)).toMatchObject([{totalAmount:20,expiresAt:QUOTA_FOREVER}]);expect(view.batches.filter(b=>b.projectId===first.id)).toEqual([]);
    await command('save.project',{...first,name:'改名',initialAmount:99});expect((await repo.view()).budgets).toEqual(view.budgets);
    await expect(project({expiresAt:'2000-01-01T00:00:00Z'})).rejects.toThrow();expect((await repo.read()).projects).toHaveLength(1);
  });
  it('shows the manager expiring unspent funds once and only current active unfunded members',async()=>{
    const p=await project({expiresAt:future(3)}),budget=(await repo.view()).budgets[0];
    const colleague=await command('save.member',{directoryId:'project-colleague',name:'项目成员',organizationId:'org-demo'});
    await command('project.members',{projectId:p.id,memberIds:[colleague.id]},employee);
    await command('project.allocate',{projectId:p.id,sourceBatchId:budget.id,memberId:colleague.id,amount:6},employee);
    const manager=(await service.snapshot(employee)).projects.find(item=>item.id===p.id)!;
    expect(manager.attention).toMatchObject({unfundedMemberIds:[employee],expiringBudgets:[{id:budget.id,amount:20}]});
    expect((await service.projectDetail(employee,p.id)).attention).toEqual(manager.attention);
    expect((await service.projectDetail(colleague.id,p.id)).attention).toBeUndefined();
    await command('project.extend',{projectId:p.id,batchId:budget.id,expiresAt:future(20),reason:'延长项目期限'});
    expect((await service.projectDetail(employee,p.id)).attention?.expiringBudgets).toEqual([]);
  });
  it('rolls back object creation if granting fails',async()=>{
    const original=repo.transact.bind(repo),before=await repo.view();
    repo.transact=(work,options)=>original(tx=>work({...tx,fundBudget:async()=>{throw new Error('grant storage failed');}}),options);
    await expect(project()).rejects.toThrow('grant storage failed');repo.transact=original;expect(await repo.view()).toEqual(before);
  });
  it.each(['quota','accounting'])('creates %s applications through approval and preserves receipts on replay',async billingMode=>{
    const a=await command('approval.submit',{kind:'application_create',name:'申请应用',ownerId:employee,organizationId:'org-demo',billingMode,amount:8,validity:'permanent',scenario:'业务接入',reason:'创建'},employee);
    expect((await repo.read()).applications).toHaveLength(0);
    await expect(command('approval.decide',{id:a.id,decision:'approve',range,reason:'自批'},employee)).rejects.toThrow();
    await command('approval.decide',{id:a.id,decision:'approve',amount:6,range,reason:'确认范围'});
    const result=await command('approval.execute',{id:a.id});expect(result.receipt.amount).toBe(billingMode==='quota'?6:0);
    const before=await repo.view();await command('approval.execute',{id:a.id});expect((await repo.view()).batches).toEqual(before.batches);
    expect((await service.applicationDetail(employee,result.objectId)).application.billingMode).toBe(billingMode);
  });
  it('keeps top-up batches independent and extends a project source together with its open children',async()=>{
    const p=await project(),budget=(await repo.view()).budgets[0];
    const member=await command('project.allocate',{projectId:p.id,sourceBatchId:budget.id,memberId:employee,amount:8},employee);
    await command('project.fund',{projectId:p.id,amount:3,validity:'permanent'});
    expect((await repo.view()).budgets.find(b=>b.id===budget.id)?.expiresAt).toBe(budget.expiresAt);
    await command('project.extend',{projectId:p.id,batchId:budget.id,validity:'permanent',reason:'长期项目'});
    expect(store.quotaBatches.get(member.id)?.expiresAt).toBe(QUOTA_FOREVER);expect((await repo.view()).budgets.find(b=>b.id===budget.id)?.availableAmount).toBe(12);
    await expect(command('project.extend',{projectId:p.id,batchId:budget.id,expiresAt:future(),reason:'不能缩短'})).rejects.toThrow();
  });
  it('returns only unused member money to its original budget and preserves in-flight settlement',async()=>{
    const p=await project(),budget=(await repo.view()).budgets[0],b=await command('project.allocate',{projectId:p.id,sourceBatchId:budget.id,memberId:employee,amount:8},employee);
    const key=await command('key.issue',{purpose:'project',projectId:p.id,name:'接入'},employee),credential=(await store.getDemoCredential(key.secret))!;
    const input={requestId:randomUUID(),idempotencyKey:randomUUID(),identity:credential.identity,purpose:'project' as const,modelId:'test-model',mode:'chat' as const,estimatedInputTokens:100,maxOutputTokens:32,policyVersion:'test'};
    const auth=await store.authorize(input);expect(auth.decision).toBe('allow');
    await expect(command('project.return',{projectId:p.id,batchId:b.id,amount:8,reason:'不能退预占'},employee)).rejects.toThrow();
    await command('project.return',{projectId:p.id,batchId:b.id,amount:3,reason:'退回部分'},employee);
    await store.settle({requestId:input.requestId,idempotencyKey:randomUUID(),reservationId:auth.reservation!.reservationId,outcome:'completed',usageFinal:true,inputTokens:10,outputTokens:8,completedAt:new Date().toISOString()});
    expect(store.quotaBatches.get(b.id)).toMatchObject({returnedAmount:3,availableAmount:4.999956});expect((await repo.view()).budgets[0].availableAmount).toBe(15);
    expect((await service.projectDetail(employee,p.id)).consumedByBatch[b.id]).toBe(0.000044);
  });
  it('closes removed member batches, keeps late releases returnable, and never revives them on rejoin',async()=>{
    const p=await project({managerId:ops}),budget=(await repo.view()).budgets[0];await command('project.members',{projectId:p.id,memberIds:[employee]});
    const b=await command('project.allocate',{projectId:p.id,sourceBatchId:budget.id,memberId:employee,amount:8});
    const key=await command('key.issue',{purpose:'project',projectId:p.id,name:'接入'},employee),identity=(await store.getDemoCredential(key.secret))!.identity;
    const input={requestId:randomUUID(),idempotencyKey:randomUUID(),identity,purpose:'project' as const,modelId:'test-model',mode:'chat' as const,estimatedInputTokens:100,maxOutputTokens:32,policyVersion:'test'},a=await store.authorize(input);
    await command('project.members',{projectId:p.id,removeMemberIds:[employee]});const closed=store.quotaBatches.get(b.id)!;
    await command('project.return',{projectId:p.id,batchId:b.id,amount:closed.closedAmount,reason:'退回离组余额'});
    await store.settle({requestId:input.requestId,idempotencyKey:randomUUID(),reservationId:a.reservation!.reservationId,outcome:'rejected_before_upstream',forwarded:false,usageFinal:true,inputTokens:0,outputTokens:0,completedAt:new Date().toISOString()});
    expect(closed.closedAmount).toBe(a.reservation!.reservedAmount);
    await command('project.return',{projectId:p.id,batchId:b.id,amount:closed.closedAmount,reason:'退回释放预占'});
    expect((await repo.view()).budgets[0].availableAmount).toBe(20);
    await command('project.members',{projectId:p.id,memberIds:[employee]});expect(store.quotaBatches.get(b.id)).toMatchObject({availableAmount:0,modelIds:[],returnedAmount:8});
  });
  it('reclaims application balances once, refuses stale amounts and cannot reclaim accounting money',async()=>{
    const a=await app(),b=(await service.applicationDetail(ops,a.id)).batches[0],payload={applicationId:a.id,batchId:b.id,amount:7,reason:'错发纠正'},key=randomUUID();
    const c:PlatformCommand={type:'application.reclaim',payload,idempotencyKey:key};c.previewToken=(await service.preview(ops,c)).previewToken;await service.execute(ops,c);expect((await service.execute(ops,c)).replayed).toBe(true);
    expect(store.quotaBatches.get(b.id)).toMatchObject({availableAmount:3,closedAmount:7,totalAmount:10});
    await expect(command('application.reclaim',{...payload,amount:4})).rejects.toThrow();await expect(command('application.reclaim',{...payload,amount:1},employee)).rejects.toThrow();
    const accounting=await app({billingMode:'accounting'}),ledger=(await service.applicationDetail(ops,accounting.id)).batches[0];await expect(command('application.reclaim',{...payload,applicationId:accounting.id,batchId:ledger.id})).rejects.toThrow();
  });
  it('invalidates a pending extension after ownership change and explicitly revokes keys on handoff',async()=>{
    const a=await app({validity:'dated',expiresAt:future()}),batch=(await service.applicationDetail(ops,a.id)).batches[0];
    const key=await command('key.issue',{purpose:'application',applicationId:a.id,name:'旧负责人密钥'},employee);
    const approval=await command('approval.submit',{kind:'application_extend',objectId:a.id,batchId:batch.id,validity:'permanent',reason:'长期使用',scenario:'业务'},employee);
    await command('approval.decide',{id:approval.id,decision:'approve',reason:'同意'});
    await command('save.application',{...a,ownerId:ops,handoffKeys:'revoke'});
    await expect(command('approval.execute',{id:approval.id})).rejects.toThrow('owner or state changed');expect((await repo.read()).keys.find(k=>k.id===key.key.id)?.status).toBe('revoked');expect(store.quotaBatches.get(batch.id)?.expiresAt).toBe(batch.expiresAt);
  });
  it('returns expired member funds into the original budget closeout, never resurrecting quota',async()=>{
    const p=await project(),budget=(await repo.view()).budgets[0],b=await command('project.allocate',{projectId:p.id,sourceBatchId:budget.id,memberId:employee,amount:8},employee);
    const clock=vi.spyOn(Date,'now').mockReturnValue(Date.parse(budget.expiresAt)+1);
    try{
      await command('project.return',{projectId:p.id,batchId:b.id,amount:8,reason:'过期余额归还'},employee);
      const result=(await repo.view()).budgets[0];expect(result).toMatchObject({availableAmount:12,closedAmount:8});
      await expect(command('project.extend',{projectId:p.id,batchId:budget.id,validity:'permanent',reason:'不能复活'})).rejects.toThrow('未过期');
      expect((await service.snapshot(employee)).purposes.find(v=>v.projectId===p.id)?.availableAmount).toBe(0);
    }finally{clock.mockRestore();}
  });
  it('requires a new preview after a concurrent quota change and preserves the untouched remainder',async()=>{
    const a=await app(),b=(await service.applicationDetail(ops,a.id)).batches[0];
    const c:PlatformCommand={type:'application.reclaim',payload:{applicationId:a.id,batchId:b.id,amount:7,reason:'旧预览'},idempotencyKey:randomUUID()};c.previewToken=(await service.preview(ops,c)).previewToken;
    await command('application.reclaim',{applicationId:a.id,batchId:b.id,amount:4,reason:'先完成的回收'});
    await expect(service.execute(ops,c)).rejects.toThrow('preview is stale');expect(store.quotaBatches.get(b.id)).toMatchObject({availableAmount:6,closedAmount:4});
  });
  it('requires explicit approval repair when an object model range changed after approval',async()=>{
    const a=await app(),request=await command('approval.submit',{kind:'application_quota',objectId:a.id,amount:3,validity:'permanent',scenario:'追加',reason:'需要额度'},employee);
    await command('approval.decide',{id:request.id,decision:'approve',reason:'同意'});
    await command('save.application',{...a,range:{...range,mode:'specific',definitionIds:['definition-test-model']}});
    await expect(command('approval.execute',{id:request.id})).rejects.toThrow('模型范围已变化');expect((await service.applicationDetail(ops,a.id)).availableAmount).toBe(10);
    await command('approval.repair',{id:request.id,reason:'已核对新的指定模型范围'});await command('approval.execute',{id:request.id});expect((await service.applicationDetail(ops,a.id)).availableAmount).toBe(13);
  });
});
