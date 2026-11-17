import { describe, expect, it } from 'vitest';
import type { AuthorizeRequest, Entitlement, Plan, SettlementRequest } from '@ai-gateway/contracts';
import { initialWorkspace } from '../platform/seed';
import { DemoStore } from './demo.store';
import { admissionForBatch,costForUsage,DEFAULT_ESTIMATED_OUTPUT_TOKENS } from './admission';
import { WorkspaceRepository } from '../platform/workspace.repository';
import { PlatformService } from '../platform/platform.service';
import {aggregateUsage} from './call-analytics';

function configured(){
  const store=new DemoStore(),state=initialWorkspace(),identity=store.credentials.get('local-employee-key')!.identity;
  state.services[0].verification='passed';state.pools[0].entries[0].open=true;
  Object.assign(state.services[0].mappings[0],{inputPrice:2,outputPrice:3,cachedInputPrice:0.5});
  const plan:Plan={id:'plan-metered',version:1,name:'计价方案',range:{poolId:state.pools[0].id,mode:'follow',definitionIds:[]},amount:10,cadence:'once',quotaDays:30,entitlementDays:365,active:true,limits:{mode:'inherit'}};
  const entitlement:Entitlement={id:'entitlement-metered',memberId:identity.subjectId,planId:plan.id,planVersion:1,planSnapshot:plan,range:plan.range,grantedAt:new Date().toISOString(),expiresAt:'2099-01-01T00:00:00Z',status:'active',futureGrants:true,source:'manual',ruleIds:[],periods:['once']};
  state.plans.push(plan);state.entitlements.push(entitlement);
  state.keys.push({id:'key-metered',credentialId:identity.credentialId,name:'测试凭据',ownerId:identity.subjectId,subjectType:'employee',subjectId:identity.subjectId,purpose:'personal',projectId:null,masked:'test',keyHash:'unit-only',status:'active',createdAt:new Date().toISOString(),expiresAt:'2099-01-01T00:00:00Z',lastUsedAt:null});
  const batch=store.quotaBatches.get('personal-batch-demo-001')!;batch.entitlementId=entitlement.id;batch.expiresAt='2099-01-01T00:00:00Z';
  store.businessState=async()=>structuredClone(state);
  const request=(overrides:Partial<AuthorizeRequest>={}):AuthorizeRequest=>({requestId:crypto.randomUUID(),idempotencyKey:crypto.randomUUID(),identity,purpose:'personal',modelId:'test-model',mode:'chat',estimatedInputTokens:100,maxOutputTokens:200,policyVersion:'metered-1',...overrides});
  return {store,state,batch,request};
}
describe('trusted admission and immutable billing',()=>{
  it('freezes a model multiplier and independent cost across repricing, replay and settlement',async()=>{
    const {store,state,batch,request}=configured();
    state.definitions[0].billingMultiplier=1.5;
    state.services[0].mappings[0].costPrice={inputPrice:1,outputPrice:2,cachedInputPrice:0.1};
    const input=request(),auth=await store.authorize(input);
    expect(auth.admission!.reservedAmount).toBe(0.0012);
    expect(auth.admission!.price).toMatchObject({inputPrice:3,outputPrice:4.5,cachedInputPrice:0.75,billing:{multiplier:1.5}});
    state.definitions[0].billingMultiplier=3;state.services[0].mappings[0].costPrice!.outputPrice=99;
    const replay=await store.authorize(input);expect(replay.admission).toEqual(auth.admission);
    await store.settle({requestId:input.requestId,idempotencyKey:'multiplier-finish',reservationId:auth.reservation!.reservationId,outcome:'completed',inputTokens:100,outputTokens:100,cachedInputTokens:20,usageFinal:true,forwarded:true,completedAt:new Date().toISOString()});
    expect(store.callLogs[0].actualAmount).toBe(0.000705);expect(batch.availableAmount).toBe(9.999295);
    expect(store.callLogs[0].admission!.costPrice!.outputPrice).toBe(2);
    const report=aggregateUsage(store.callLogs,{to:new Date(Date.now()+1000).toISOString()},null,'Asia/Shanghai');
    expect(report.totals.cost).toMatchObject({knownAmount:0.000282,comparableRequests:1,differenceAmount:0.000423});
    expect((await store.authorize(request())).admission!.price!.inputPrice).toBe(6);
  });
  it('allows a zero billing multiplier while retaining a nonzero upstream cost',async()=>{
    const {store,state,batch,request}=configured();state.definitions[0].billingMultiplier=0;
    state.services[0].mappings[0].costPrice={inputPrice:2,outputPrice:3,cachedInputPrice:0.5};
    const input=request(),auth=await store.authorize(input);expect(auth.decision).toBe('allow');expect(auth.reservation!.reservedAmount).toBe(0);
    await store.settle({requestId:input.requestId,idempotencyKey:'free-model-finish',reservationId:auth.reservation!.reservationId,outcome:'completed',inputTokens:100,outputTokens:100,usageFinal:true,forwarded:true,completedAt:new Date().toISOString()});
    expect(batch.availableAmount).toBe(10);expect(store.callLogs[0].actualAmount).toBe(0);
    expect(aggregateUsage(store.callLogs,{to:new Date(Date.now()+1000).toISOString()},null,'Asia/Shanghai').totals.cost).toMatchObject({knownAmount:0.0005,differenceAmount:-0.0005});
  });
  it('applies a six-decimal multiplier before rounding the entire request once',()=>{
    const base={inputPrice:0.000001,outputPrice:0.000001,cachedInputPrice:0.000001};
    const price={version:'exact',currency:'CNY' as const,unit:'per_million_tokens' as const,inputPrice:0.0000001,outputPrice:0.0000001,cachedInputPrice:0.0000001,billing:{base,multiplier:0.1}};
    expect(costForUsage(price,1000000,1000000,500000)).toBe(0.000001);
    expect(costForUsage({...price,billing:{base,multiplier:0}},1000000,1000000,500000)).toBe(0);
  });
  it('reconciles unknown usage using the original multiplier after a price change',async()=>{
    const {store,state,request}=configured();state.definitions[0].billingMultiplier=2;
    const input=request(),auth=await store.authorize(input);
    await store.settle({requestId:input.requestId,idempotencyKey:'hold-multiplier',reservationId:auth.reservation!.reservationId,outcome:'partial',usageFinal:false,forwarded:true,completedAt:new Date().toISOString()});
    state.definitions[0].billingMultiplier=5;
    const result=await store.reconcileWithinBusinessTransaction({requestId:input.requestId,idempotencyKey:'reconcile-multiplier',actorId:'operator-demo-001',reason:'complete fixture usage',mode:'confirm_usage',inputTokens:100,outputTokens:100,cachedInputTokens:20});
    expect(result.billableState).toBe('confirmed');expect(store.callLogs[0].actualAmount).toBe(0.00094);
  });
  function addSource(state:ReturnType<typeof configured>['state']){
    const source={...structuredClone(state.services[0]),id:'service-second',name:'第二来源',limits:{mode:'custom' as const,concurrency:1}};
    state.services.push(source);state.services[0].limits={mode:'custom',concurrency:1};
    state.settings.limits={mode:'none'};
    state.pools[0].entries.push({...state.pools[0].entries[0],serviceId:source.id});
    return source;
  }
  it('uses both independent service slots concurrently, rejects only when both fill, and preserves replay',async()=>{
    const {store,state,request,batch}=configured();addSource(state);
    const inputs=[request(),request(),request()];
    const results=await Promise.all(inputs.map(input=>store.authorize(input)));
    expect(results.map(r=>r.decision)).toEqual(['allow','allow','deny']);
    expect(new Set(results.slice(0,2).map(r=>r.admission!.route!.serviceId)).size).toBe(2);
    expect(results[2].reasonCode).toBe('rate_limited');
    expect(batch.availableAmount).toBe(9.9984);
    const replay=await store.authorize(inputs[0]);
    expect(replay.replayed).toBe(true);expect(replay.admission).toEqual(results[0].admission);
    expect(batch.availableAmount).toBe(9.9984);
    await store.settle({requestId:inputs[0].requestId,idempotencyKey:crypto.randomUUID(),reservationId:results[0].reservation!.reservationId,outcome:'upstream_error',inputTokens:0,outputTokens:0,usageFinal:true,completedAt:new Date().toISOString()});
    const next=await store.authorize(request());expect(next.decision).toBe('allow');expect(next.admission!.route!.serviceId).toBe(results[0].admission!.route!.serviceId);
  });
  it('distributes sequential independent requests and skips disabled, closed and unpriced sources',()=>{
    const {state,request,batch}=configured(),source=addSource(state);
    const routes=Array.from({length:100},(_,i)=>admissionForBatch(state,request({requestId:`route-${i}`}),batch).admission!.route!.serviceId);
    const count=routes.filter(id=>id===source.id).length;expect(count).toBeGreaterThan(25);expect(count).toBeLessThan(75);
    for(const mode of ['disabled','unverified','closed','unpriced']){
      source.active=mode!=='disabled';source.verification=mode==='unverified'?'unverified':'passed';state.pools[0].entries[1].open=mode!=='closed';source.mappings[0].inputPrice=mode==='unpriced'?null:2;
      for(let i=0;i<10;i++)expect(admissionForBatch(state,request(),batch).admission!.route!.serviceId).toBe(state.services[0].id);
    }
  });
  it.each(['rpm','tpm','concurrency'] as const)('uses spare service capacity for %s while respecting pool and shared caps',async metric=>{
    const {store,state,request}=configured(),source=addSource(state);
    for(const s of [state.services[0],source])s.limits={mode:'custom',[metric]:metric==='tpm'?300:1};
    expect((await store.authorize(request())).decision).toBe('allow');
    expect((await store.authorize(request())).decision).toBe('allow');
    expect((await store.authorize(request())).reasonCode).toBe('rate_limited');
    const other=configured();addSource(other.state);other.state.pools[0].limits={mode:'custom',concurrency:1};
    expect((await other.store.authorize(other.request())).decision).toBe('allow');expect((await other.store.authorize(other.request())).reasonCode).toBe('rate_limited');
    const shared=configured(),second=addSource(shared.state);shared.state.services[0].sharedCapacityId=second.sharedCapacityId='same-hardware';shared.state.settings.limits={mode:'custom',concurrency:1};
    // Common subject/pool scopes are explicitly unbounded; only shared capacity inherits the enterprise cap.
    shared.state.members.find(m=>m.id===shared.request().identity.subjectId)!.limits={mode:'none'};shared.state.pools[0].limits={mode:'none'};shared.state.entitlements[0].planSnapshot.limits={mode:'none'};
    expect((await shared.store.authorize(shared.request())).decision).toBe('allow');expect((await shared.store.authorize(shared.request())).reasonCode).toBe('rate_limited');
  });
  it('allows same-price quote fallback but never changes a pinned tariff',async()=>{
    const {store,state,request,batch}=configured(),source=addSource(state);
    const quoted=admissionForBatch(state,request(),batch).admission!;
    const first=await store.authorize(request({expectedPriceVersion:quoted.price!.version}));
    const second=await store.authorize(request({expectedPriceVersion:quoted.price!.version}));
    expect(first.decision).toBe('allow');expect(second.decision).toBe('allow');
    expect(first.admission!.route!.serviceId).not.toBe(second.admission!.route!.serviceId);
    const changed=configured(),expensive=addSource(changed.state);expensive.mappings[0].inputPrice=99;
    const cheapVersion=admissionForBatch({...changed.state,services:changed.state.services.filter(s=>s.id!==expensive.id)},changed.request(),changed.batch).admission!.price!.version;
    const a=await changed.store.authorize(changed.request({expectedPriceVersion:cheapVersion}));expect(a.admission!.price!.inputPrice).toBe(2);
    expect((await changed.store.authorize(changed.request({expectedPriceVersion:cheapVersion}))).reasonCode).toBe('rate_limited');
  });
  it('freezes directory organization for analytics without changing tenant identity or retry scope',async()=>{
    const {store,state,request}=configured(),input=request(),member=state.members.find(member=>member.id===input.identity.subjectId)!;
    const original=member.organizationId,authorized=await store.authorize(input);
    expect(authorized.admission?.attributionOrganizationId).toBe(original);
    member.organizationId='moved-after-admission';
    await store.settle({requestId:input.requestId,idempotencyKey:crypto.randomUUID(),reservationId:authorized.reservation!.reservationId,outcome:'completed',completedAt:new Date().toISOString(),inputTokens:13,outputTokens:14,cachedInputTokens:0,usageFinal:true,forwarded:true});
    const log=(await store.listCalls()).find(log=>log.requestId===input.requestId)!;
    expect(log.organizationId).toBe(input.identity.organizationId);
    expect(log.admission?.attributionOrganizationId).toBe(original);
    const report=aggregateUsage([log],{from:new Date(Date.now()-86400000).toISOString(),to:new Date(Date.now()+86400000).toISOString(),organizationId:original},null,'Asia/Shanghai');
    expect(report.organizations.map(row=>row.key)).toEqual([original]);
  });
  it('freezes native versus adapted protocol selection from current per-model capability evidence',async()=>{
    const {store,state,request}=configured(),service=state.services[0],definitionId=service.mappings[0].definitionId;
    const first=await store.authorize(request({modelProtocol:'responses'}));expect(first.admission?.protocol).toEqual({requested:'responses',upstream:'chat',mode:'adapted'});
    service.protocolCapabilities={configVersion:service.configVersion,mappings:{[definitionId]:{responses:{status:'supported',checkedAt:new Date().toISOString(),httpStatus:200,errorCode:null}}}};
    const second=await store.authorize(request({modelProtocol:'responses'}));expect(second.admission?.protocol).toEqual({requested:'responses',upstream:'responses',mode:'native'});
    service.configVersion++;const third=await store.authorize(request({modelProtocol:'responses'}));expect(third.admission?.protocol?.mode).toBe('adapted');expect(second.admission?.protocol?.mode).toBe('native');
  });
  it('quotes the same refusal as admission when an unfunded eligible source precedes a more restrictive source',async()=>{
    const {store,state,batch,request}=configured();batch.availableAmount=0;
    const original=state.entitlements[0],second={...structuredClone(original),id:'second-entitlement'};
    second.planId='restrictive-plan';second.planSnapshot.id=second.planId;second.planSnapshot.limits={mode:'custom',maxOutputTokens:128};state.plans.push(second.planSnapshot);state.entitlements.push(second);
    store.quotaBatches.set('later-restrictive',{...structuredClone(batch),id:'later-restrictive',availableAmount:10,entitlementId:second.id,expiresAt:'2099-12-31T00:00:00Z'});
    const repository=new WorkspaceRepository(store);await repository.transact(async tx=>Object.assign(tx.state,state));
    const platform=new PlatformService(repository,store),input=request();
    const admitted=await store.authorize(input),quoted=await platform.quote(input.identity.subjectId,{purpose:'personal',model:'test-model',messages:[],max_tokens:200});
    expect(admitted.reasonCode).toBe('quota_insufficient');expect(quoted.reasonCode).toBe(admitted.reasonCode);expect(quoted).not.toHaveProperty('requestLimits');
  });
  it('preserves an omitted output option and separates its estimate from explicit policy caps',async()=>{
    const {store,state,request}=configured();state.settings.limits={mode:'none'};
    const wide=await store.authorize(request({maxOutputTokens:undefined,estimatedInputTokens:100}));
    expect(wide.decision).toBe('allow');
    expect(wide.admission!.route).not.toHaveProperty('maxOutputTokens');
    expect(wide.admission!.estimate).toEqual({inputTokens:100,outputTokens:DEFAULT_ESTIMATED_OUTPUT_TOKENS,outputSource:'default'});
    state.settings.limits={mode:'custom',maxOutputTokens:20000};
    const capped=await store.authorize(request({maxOutputTokens:undefined,estimatedInputTokens:100}));
    expect(capped.admission!.route!.maxOutputTokens).toBe(20000);
    expect(capped.admission!.estimate!.outputTokens).toBe(DEFAULT_ESTIMATED_OUTPUT_TOKENS);
    expect(capped.requestLimits).toBeUndefined();
  });
  it('keeps a large explicit generation cap while reserving the independent model estimate, including on replay',async()=>{
    const {store,state,request}=configured();state.settings.limits={mode:'none'};
    Object.assign(state.definitions[0],{contextTokens:1000000,estimatedOutputTokens:4096});
    const input=request({maxOutputTokens:80000}),first=await store.authorize(input);
    expect(first.admission!.route!.maxOutputTokens).toBe(80000);
    expect(first.admission!.estimate!.outputTokens).toBe(4096);
    expect(first.reservation!.reservedAmount).toBe(0.012488);
    state.definitions[0].estimatedOutputTokens=8192;
    expect((await store.authorize(input)).admission).toEqual(first.admission);
    const small=await store.authorize(request({maxOutputTokens:128}));
    expect(small.admission!.estimate!.outputTokens).toBe(128);
    const nearContext=await store.authorize(request({maxOutputTokens:undefined,estimatedInputTokens:999900}));
    expect(nearContext.admission!.estimate!.outputTokens).toBe(100);
    expect(nearContext.admission!.route).not.toHaveProperty('maxOutputTokens');
  });
  it('supplements complete usage from the original batch exactly once and keeps unknown usage pending',async()=>{
    const {store,state,batch,request}=configured();state.definitions[0].estimatedOutputTokens=10;
    const input=request(),auth=await store.authorize(input);
    const usage:SettlementRequest={requestId:input.requestId,idempotencyKey:'supplement-complete',reservationId:auth.reservation!.reservationId,outcome:'completed',inputTokens:100,outputTokens:1000,usageFinal:true,completedAt:new Date().toISOString()};
    expect(auth.reservation!.reservedAmount).toBe(0.00023);
    expect((await store.settle(usage)).status).toBe('settled');
    expect(batch.availableAmount).toBe(9.9968);
    expect((await store.settle(usage)).status).toBe('already_finalized');
    expect(batch.availableAmount).toBe(9.9968);expect(store.ledgerEntries).toHaveLength(1);
    const next=request(),a=await store.authorize(next);
    expect((await store.settle({...usage,requestId:next.requestId,reservationId:a.reservation!.reservationId,idempotencyKey:'supplement-unknown',usageFinal:false})).status).toBe('pending_review');
  });
  it('does not overdraw or borrow another batch to fund above-estimate usage',async()=>{
    const {store,state,batch,request}=configured();state.definitions[0].estimatedOutputTokens=10;batch.totalAmount=batch.availableAmount=0.001;
    const unrelated={...structuredClone(batch),id:'unrelated-batch',availableAmount:10,totalAmount:10};store.quotaBatches.set(unrelated.id,unrelated);
    const input=request(),auth=await store.authorize(input);
    expect(auth.reservation!.sourceId).toBe(batch.id);
    const response=await store.settle({requestId:input.requestId,idempotencyKey:'supplement-insufficient',reservationId:auth.reservation!.reservationId,outcome:'completed',inputTokens:100,outputTokens:1000,usageFinal:true,completedAt:new Date().toISOString()});
    expect(response.status).toBe('pending_review');expect(batch.availableAmount).toBe(0.00077);expect(unrelated.availableAmount).toBe(10);expect(store.ledgerEntries).toHaveLength(0);
  });
  it('explains the binding output limit without reserving funds and preserves it on replay',async()=>{
    const {store,state,batch,request}=configured();state.services[0].limits={mode:'custom',maxOutputTokens:128};
    const input=request(),denied=await store.authorize(input);
    expect(denied.reasonCode).toBe('request_limit_exceeded');expect(denied.reservation).toBeNull();
    expect(denied.requestLimits).toMatchObject({requestedOutputTokens:200,allowedOutputTokens:128,estimatedInputTokens:100});
    expect(denied.requestLimits!.limitSources).toContainEqual({source:'service',maxOutputTokens:128});
    expect(denied.reasonMessage).toContain('allowed 128');expect(denied.reasonMessage).not.toContain('quota');
    expect(batch.availableAmount).toBe(10);expect(store.reservationsByRequest.size).toBe(0);
    state.services[0].limits.maxOutputTokens=64;
    expect((await store.authorize(input)).requestLimits).toEqual(denied.requestLimits);
    expect(JSON.stringify(denied.requestLimits)).not.toMatch(/baseUrl|credentialRef|service-local|org-demo/);
  });
  it('distinguishes exhausted model context, unconfigured pricing and insufficient funds',async()=>{
    const {store,state,batch,request}=configured();
    const denied=await store.authorize(request({estimatedInputTokens:state.definitions[0].contextTokens}));
    expect(denied.requestLimits!.allowedOutputTokens).toBe(0);
    expect(denied.requestLimits!.limitSources).toContainEqual({source:'model_context',maxOutputTokens:0});
    state.services[0].mappings[0].inputPrice=null;
    const price=await store.authorize(request());expect(price.reasonMessage).toContain('prices');expect(price.requestLimits).toBeUndefined();
    state.services[0].mappings[0].inputPrice=2;batch.availableAmount=0;
    const funds=await store.authorize(request());expect(funds.reasonCode).toBe('quota_insufficient');expect(funds.reasonMessage).toContain('eligible quota batch');expect(funds.requestLimits).toBeUndefined();
  });
  it('reserves a bounded estimate, prices cache as an input subset, and freezes the old price',async()=>{
    const {store,state,batch,request}=configured(),input=request(),admitted=await store.authorize(input);
    expect(admitted.reservation!.reservedAmount).toBe(0.0008);expect(admitted.admission!.route!.serviceId).toBe(state.services[0].id);
    state.services[0].mappings[0].inputPrice=999;
    const response=await store.settle({requestId:input.requestId,idempotencyKey:'settle-metered',reservationId:admitted.reservation!.reservationId,outcome:'completed',inputTokens:10,outputTokens:8,cachedInputTokens:4,actualAmount:999,usageFinal:true,completedAt:new Date().toISOString()});
    expect(response.status).toBe('settled');expect(batch.availableAmount).toBe(9.999962);
    const log=(await store.listCalls())[0];expect(log.actualAmount).toBe(0.000038);expect(log.admission!.price!.inputPrice).toBe(2);
    expect(log.admission!.route).not.toHaveProperty('baseUrl');expect(log.admission!.route).not.toHaveProperty('credentialRef');expect(store.ledgerEntries).toHaveLength(1);
  });
  it('does not interpret unknown pricing as zero, but permits explicitly free routes',async()=>{
    const {store,state,batch,request}=configured();state.services[0].mappings[0].outputPrice=null;
    expect((await store.authorize(request())).reasonCode).toBe('price_unconfigured');expect(batch.availableAmount).toBe(10);
    Object.assign(state.services[0].mappings[0],{inputPrice:0,outputPrice:0,cachedInputPrice:0});batch.availableAmount=0;
    const allowed=await store.authorize(request());expect(allowed.decision).toBe('allow');expect(allowed.reservation!.reservedAmount).toBe(0);
  });
  it('checks current price pin and context/output bounds before reserving money',async()=>{
    const {store,batch,request}=configured();
    expect((await store.authorize(request({expectedPriceVersion:'outdated'}))).reasonCode).toBe('policy_stale');
    expect((await store.authorize(request({maxOutputTokens:5000}))).reasonCode).toBe('request_limit_exceeded');
    expect((await store.authorize(request({estimatedInputTokens:32768}))).reasonCode).toBe('request_limit_exceeded');expect(batch.availableAmount).toBe(10);
  });
  it('shares subject concurrency across keys and releases capacity on settlement',async()=>{
    const {store,state,request}=configured();state.settings.limits={mode:'custom',concurrency:1,rpm:100,maxOutputTokens:4096};
    const first=request(),a=await store.authorize(first);
    expect((await store.authorize(request())).reasonCode).toBe('rate_limited');
    await store.settle({requestId:first.requestId,idempotencyKey:crypto.randomUUID(),reservationId:a.reservation!.reservationId,outcome:'upstream_error',inputTokens:0,outputTokens:0,usageFinal:true,completedAt:new Date().toISOString()});
    expect((await store.authorize(request())).decision).toBe('allow');
  });
  it('reserves TPM against input estimate plus output allowance and charges positive fractions once',async()=>{
    const {store,state,batch,request}=configured();state.settings.limits={mode:'custom',tpm:299,maxOutputTokens:4096};
    expect((await store.authorize(request())).reasonCode).toBe('rate_limited');expect(batch.availableAmount).toBe(10);
    expect(costForUsage({version:'test',currency:'CNY',unit:'per_million_tokens',inputPrice:0.1,outputPrice:0,cachedInputPrice:0},1,0)).toBe(0.000001);
  });
  it('keeps unknown or above-reservation costs pending and refuses impossible cached usage',async()=>{
    const {store,batch,request}=configured(),input=request(),a=await store.authorize(input);
    const settlement:SettlementRequest={requestId:input.requestId,idempotencyKey:'invalid-cache',reservationId:a.reservation!.reservationId,outcome:'completed',inputTokens:10,outputTokens:8,cachedInputTokens:11,completedAt:new Date().toISOString(),usageFinal:true};
    await expect(store.settle(settlement)).rejects.toThrow('cached');
    const pending=await store.settle({...settlement,idempotencyKey:'missing-final-usage',cachedInputTokens:0,usageFinal:false});
    expect(pending.status).toBe('pending_review');expect(batch.availableAmount).toBe(9.9992);expect(store.ledgerEntries).toHaveLength(0);
  });
});
