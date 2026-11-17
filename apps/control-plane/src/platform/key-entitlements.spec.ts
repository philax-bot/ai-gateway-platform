import {beforeEach,describe,expect,it} from 'vitest';
import type {AuthorizeRequest,PlatformCommand} from '@ai-gateway/contracts';
import {DemoStore} from '../store/demo.store';
import {WorkspaceRepository} from './workspace.repository';
import {PlatformService} from './platform.service';
import {syncResources} from './domain';

const admin='operator-demo-001',employee='employee-demo-001';
describe('personal key entitlement scope',()=>{
  let store:DemoStore,repo:WorkspaceRepository,platform:PlatformService,first:string,second:string;
  async function command(type:string,payload:Record<string,unknown>,actor=admin){const c:PlatformCommand={type,payload,idempotencyKey:crypto.randomUUID()},preview=await platform.preview(actor,c);return (await platform.execute(actor,{...c,previewToken:preview.previewToken})).result as any;}
  async function grant(poolId:string,name:string,memberId=employee){const plan=await command('save.plan',{name,range:{poolId,mode:'follow',definitionIds:[]},amount:10,cadence:'once',quotaDays:30,entitlementDays:365});await command('distribution.execute',{planId:plan.id,memberIds:[memberId]});return (await repo.read()).entitlements.find(e=>e.planId===plan.id&&e.memberId===memberId)!.id;}
  async function key(entitlementIds?:unknown){return command('key.issue',{name:'套餐密钥',purpose:'personal',entitlementIds},employee);}
  async function request(issued:any,modelId='test-model'):Promise<AuthorizeRequest>{const credential=(await store.getDemoCredential(issued.secret))!;return {requestId:crypto.randomUUID(),idempotencyKey:crypto.randomUUID(),identity:credential.identity,purpose:'personal',modelId,mode:'chat',estimatedInputTokens:100,maxOutputTokens:100,policyVersion:'scope-test'};}
  beforeEach(async()=>{
    store=new DemoStore();repo=new WorkspaceRepository(store);await repo.initialize();platform=new PlatformService(repo,store);
    await repo.transact(async tx=>{const s=tx.state;s.settings.limits={mode:'none'};s.services[0].verification='passed';s.pools[0].entries[0].open=true;Object.assign(s.services[0].mappings[0],{inputPrice:2,outputPrice:3,cachedInputPrice:0});
      s.definitions.push({...s.definitions[0],id:'second-definition',modelId:'second-only',name:'第二套餐专属模型'});
      s.services.push({...structuredClone(s.services[0]),id:'second-service',name:'第二来源',mappings:[structuredClone(s.services[0].mappings[0]),{...structuredClone(s.services[0].mappings[0]),definitionId:'second-definition',upstreamModel:'second-only'}]});
      s.pools.push({id:'second-pool',name:'第二池',limits:{mode:'none'},entries:s.services[1].mappings.map(m=>({serviceId:'second-service',definitionId:m.definitionId,open:true}))});
    });
    first=await grant('pool-local-test','套餐一');second=await grant('second-pool','套餐二');
  });
  it('restricts same-model routing, reservation and settlement to the chosen entitlement',async()=>{
    const issued=await key([second]),input=await request(issued),auth=await store.authorize(input);
    expect(auth.decision).toBe('allow');expect(auth.admission!.route!.poolId).toBe('second-pool');
    const batch=store.quotaBatches.get(auth.reservation!.sourceId)!;expect(batch.entitlementId).toBe(second);
    const outside=[...store.quotaBatches.values()].find(b=>b.entitlementId===first)!,before=outside.availableAmount;
    await store.settle({requestId:input.requestId,idempotencyKey:crypto.randomUUID(),reservationId:auth.reservation!.reservationId,outcome:'completed',inputTokens:100,outputTokens:100,usageFinal:true,forwarded:true,completedAt:new Date().toISOString()});
    expect(outside.availableAmount).toBe(before);expect(batch.availableAmount).toBe(9.9995);
    expect((await platform.keyDetail(employee,issued.key.id)).sources.map(s=>s.name)).toEqual(['套餐二']);
  });
  it('does not borrow an unselected balance for the same public model',async()=>{
    const issued=await key([first]);[...store.quotaBatches.values()].find(b=>b.entitlementId===first)!.availableAmount=0;
    const auth=await store.authorize(await request(issued));expect(auth.decision).toBe('deny');expect(auth.reasonCode).toBe('quota_insufficient');
    expect([...store.quotaBatches.values()].find(b=>b.entitlementId===second)!.availableAmount).toBe(10);
  });
  it('restricts model discovery and authorization to the chosen scope',async()=>{
    const issued=await key([first]);expect((await store.getDemoCredential(issued.secret))!.modelIds).toEqual(['test-model']);
    expect((await store.authorize(await request(issued,'second-only'))).reasonCode).toBe('model_not_open');
    expect((await platform.keyDetail(employee,issued.key.id)).models.map(m=>m.modelId)).toEqual(['test-model']);
  });
  it('supports several chosen entitlements and keeps legacy/all keys dynamic',async()=>{
    const multi=await key([first,second,first]);expect(multi.key.entitlementIds).toEqual([first,second]);
    expect((await store.authorize(await request(multi,'second-only'))).decision).toBe('allow');
    const all=await key(),fixed=await key([first]);expect(all.key).not.toHaveProperty('entitlementIds');
    const third=await grant('second-pool','后来开通的套餐');
    expect((await platform.keyDetail(employee,all.key.id)).sources.map(s=>s.name)).toContain('后来开通的套餐');
    expect((await platform.keyDetail(employee,fixed.key.id)).sources.map(s=>s.name)).toEqual(['套餐一']);
    expect((await repo.read()).keys.find(k=>k.id===fixed.key.id)!.entitlementIds).not.toContain(third);
  });
  it('denies revoked, expired or emptied selections without widening the scope',async()=>{
    for(const change of ['revoked','expired','empty'] as const){
      const issued=await key([first]);await repo.transact(async tx=>{if(change==='empty')tx.state.keys.find(k=>k.id===issued.key.id)!.entitlementIds=[];else {const e=tx.state.entitlements.find(e=>e.id===first)!;if(change==='revoked')e.status='revoked';else e.expiresAt='2020-01-01T00:00:00Z';}await syncResources(tx);});
      expect((await store.getDemoCredential(issued.secret))!.modelIds).toEqual([]);expect((await store.authorize(await request(issued))).decision).toBe('deny');
      await repo.transact(async tx=>{const e=tx.state.entitlements.find(e=>e.id===first)!;e.status='active';e.expiresAt='2099-01-01T00:00:00Z';await syncResources(tx);});
    }
  });
  it('validates ownership, input shape, validity and purpose for direct API callers',async()=>{
    const other=await grant('pool-local-test','他人的套餐',admin);
    for(const ids of [[],null,'all',['missing'],[other]])await expect(key(ids)).rejects.toThrow();
    await repo.transact(async tx=>{tx.state.entitlements.find(e=>e.id===first)!.status='revoked';});await expect(key([first])).rejects.toThrow('已停用');
    const app=await command('save.application',{name:'套餐范围测试应用',ownerId:employee,organizationId:'org-demo',billingMode:'accounting',range:{poolId:'pool-local-test',mode:'follow',definitionIds:[]}});
    for(const purpose of ['project','application'])await expect(command('key.issue',{name:'非法范围',purpose,applicationId:app.id,entitlementIds:[second]},employee)).rejects.toThrow('仅适用于个人密钥');
    const issued=await command('key.issue',{name:'运营代签',purpose:'personal',memberId:employee,entitlementIds:[second]});expect(issued.key.subjectId).toBe(employee);expect(issued.key.entitlementIds).toEqual([second]);
  });
});
