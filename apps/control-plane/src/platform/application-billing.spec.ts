import {beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {applicationBillingMode,type PlatformCommand} from '@ai-gateway/contracts';
import {DemoStore} from '../store/demo.store';
import {WorkspaceRepository} from './workspace.repository';
import {PlatformService} from './platform.service';

const ops='operator-demo-001',employee='employee-demo-001',range={poolId:'pool-local-test',mode:'follow',definitionIds:[]};
const expiresAt=()=>new Date(Date.now()+86400000).toISOString();
describe('application accounting and approved quota transitions',()=>{
  let store:DemoStore,repo:WorkspaceRepository,platform:PlatformService;
  async function command(type:string,payload:Record<string,unknown>,actor=ops,key=randomUUID()){
    const c:PlatformCommand={type,payload,idempotencyKey:key};c.previewToken=(await platform.preview(actor,c)).previewToken;
    return (await platform.execute(actor,c)).result as any;
  }
  const app=(extra:Record<string,unknown>={})=>command('save.application',{name:'记账应用',ownerId:employee,organizationId:'org-demo',range,...extra});
  async function request(applicationId:string){
    const issued=await command('key.issue',{name:'接入',purpose:'application',applicationId},employee),credential=await store.getDemoCredential(issued.secret);
    const id=randomUUID();return {requestId:id,idempotencyKey:id,identity:credential!.identity,purpose:'application' as const,modelId:'test-model',mode:'chat' as const,estimatedInputTokens:100,maxOutputTokens:200,policyVersion:'test'};
  }
  const next=(r:Awaited<ReturnType<typeof request>>)=>({...r,requestId:randomUUID(),idempotencyKey:randomUUID()});
  async function settle(auth:Awaited<ReturnType<DemoStore['authorize']>>,extra:Record<string,unknown>={}){
    return store.settle({requestId:auth.requestId,idempotencyKey:randomUUID(),reservationId:auth.reservation!.reservationId,outcome:'completed',inputTokens:10,outputTokens:8,usageFinal:true,completedAt:new Date().toISOString(),...extra});
  }
  const submit=(id:string)=>command('approval.submit',{kind:'application_billing',objectId:id,amount:5,expiresAt:expiresAt(),scenario:'限制预算',reason:'纳入额度管理'},employee);
  const decide=(id:string)=>command('approval.decide',{id,decision:'approve',amount:5,expiresAt:expiresAt(),reason:'同意切换'});
  beforeEach(async()=>{
    store=new DemoStore();repo=new WorkspaceRepository(store);await repo.initialize();store.businessState=()=>repo.read();platform=new PlatformService(repo,store);
    await repo.transact(async tx=>{const s=tx.state;s.settings.limits={mode:'none'};s.services[0].verification='passed';Object.assign(s.services[0].mappings[0],{inputPrice:2,outputPrice:3,cachedInputPrice:0.5});s.pools[0].entries[0].open=true;});
  });
  it('starts at zero, uses a key without funding, settles negative exactly once and still admits',async()=>{
    const a=await app();expect(a.billingMode).toBe('accounting');expect((await platform.applicationDetail(employee,a.id))).toMatchObject({status:'ready',availableAmount:0,accountingBalance:0});
    const r=await request(a.id),auth=await store.authorize(r);expect(auth.decision).toBe('allow');
    const result=await settle(auth);expect(result.status).toBe('settled');await settle(auth);
    expect((await platform.applicationDetail(employee,a.id))).toMatchObject({status:'ready',availableAmount:-0.000044,accountingBalance:-0.000044});
    expect((await store.authorize(r)).reservation?.reservationId).toBe(auth.reservation?.reservationId);
    const again=await store.authorize(next(r));expect(again.decision).toBe('allow');await settle(again,{outcome:'upstream_error',inputTokens:0,outputTokens:0});
    expect((await platform.applicationDetail(employee,a.id)).accountingBalance).toBe(-0.000044);
  });
  it('keeps pricing, application status and concurrency protections on accounting applications',async()=>{
    const a=await app(),r=await request(a.id);
    await repo.transact(async tx=>{tx.state.applications[0].limits={mode:'custom',concurrency:1};});
    const auth=await store.authorize(r);expect(auth.decision).toBe('allow');expect((await store.authorize(next(r))).reasonCode).toBe('rate_limited');await settle(auth);
    await repo.transact(async tx=>{tx.state.services[0].mappings[0].inputPrice=null;});expect((await store.authorize(next(r))).reasonCode).toBe('price_unconfigured');
    await command('save.application',{...a,active:false});expect((await store.authorize(next(r))).reasonCode).toBe('subject_disabled');
  });
  it('rejects direct mode edits, funding and quota requests that would bypass switching approval',async()=>{
    const a=await app();await expect(command('save.application',{...a,billingMode:'quota'})).rejects.toThrow('require approval');
    await expect(command('application.fund',{applicationId:a.id,amount:10,expiresAt:expiresAt()})).rejects.toThrow('through approval');
    await expect(command('approval.submit',{kind:'application_quota',objectId:a.id,amount:5,expiresAt:expiresAt(),scenario:'错误入口',reason:'不能绕过切换'},employee)).rejects.toThrow('does not match');
    await expect(app({billingMode:'unknown'})).rejects.toThrow('invalid application billing mode');
  });
  it('switches only on execution, preserves historical debt and late settlement, and reuses the original key',async()=>{
    const a=await app(),r=await request(a.id),old=await store.authorize(r),approval=await submit(a.id);
    await expect(command('approval.decide',{id:approval.id,decision:'approve',reason:'自己批准'},employee)).rejects.toThrow('self approval');
    await decide(approval.id);expect((await repo.read()).applications[0].billingMode).toBe('accounting');
    const executionKey=randomUUID();await command('approval.execute',{id:approval.id},ops,executionKey);await command('approval.execute',{id:approval.id},ops,executionKey);await command('approval.execute',{id:approval.id});
    let detail=await platform.applicationDetail(employee,a.id);expect(detail).toMatchObject({availableAmount:5,status:'ready'});expect(detail.batches.filter(b=>!b.accounting)).toHaveLength(1);
    await settle(old);detail=await platform.applicationDetail(employee,a.id);expect(detail.accountingBalance).toBe(-0.000044);expect(detail.availableAmount).toBe(5);
    const auth=await store.authorize(next(r));expect(auth.decision).toBe('allow');expect(auth.reservation?.sourceId).not.toBe(old.reservation?.sourceId);await settle(auth);
    detail=await platform.applicationDetail(employee,a.id);expect(detail.availableAmount).toBe(4.999956);expect(detail.accountingBalance).toBe(-0.000044);
    expect(detail.history.some(h=>h.action==='application.billing_changed')).toBe(true);
    expect((await platform.keyDetail(employee,detail.keys[0].id)).sources[0].balance).toBe(4.999956);
  });
  it('keeps explicit and legacy quota applications gated, with no negative quota spending',async()=>{
    const a=await app({billingMode:'quota',initialAmount:0.000001,validity:'permanent'}),r=await request(a.id);expect((await store.authorize(r)).reasonCode).toBe('quota_insufficient');
    await command('application.fund',{applicationId:a.id,amount:0.000001,expiresAt:expiresAt()});expect((await store.authorize(next(r))).reasonCode).toBe('quota_insufficient');
    await repo.transact(async tx=>{delete tx.state.applications[0].billingMode;});expect(applicationBillingMode((await repo.read()).applications[0])).toBe('quota');expect((await store.authorize(next(r))).reasonCode).toBe('quota_insufficient');
  });
  it('retains the mode when an approval is rejected, withdrawn or invalidated by an owner change',async()=>{
    const a=await app(),first=await submit(a.id);await command('approval.withdraw',{id:first.id},employee);
    const second=await submit(a.id);await command('approval.decide',{id:second.id,decision:'reject',reason:'暂不切换'});
    const third=await submit(a.id);await decide(third.id);await command('save.application',{...a,ownerId:ops});
    await expect(command('approval.execute',{id:third.id})).rejects.toThrow('state or billing mode changed');expect((await repo.read()).applications[0].billingMode).toBe('accounting');
    expect((await repo.view()).batches.filter(b=>b.sourceId===a.id&&!b.accounting)).toHaveLength(0);
  });
  it('reconciles accounting holds below zero without borrowing quota or losing idempotency',async()=>{
    const a=await app(),r=await request(a.id),auth=await store.authorize(r);await settle(auth,{usageFinal:false});
    const payload={requestId:r.requestId,idempotencyKey:randomUUID(),actorId:ops,reason:'确认完整用量',mode:'confirm_usage' as const,inputTokens:1000,outputTokens:1000};
    await repo.transact(tx=>tx.reconcile(payload));await repo.transact(tx=>tx.reconcile(payload));
    expect((await platform.applicationDetail(employee,a.id)).accountingBalance).toBe(-0.005);
  });
});
