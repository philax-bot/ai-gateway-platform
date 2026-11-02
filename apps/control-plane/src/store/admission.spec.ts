import { describe, expect, it } from 'vitest';
import type { AuthorizeRequest, Entitlement, Plan, SettlementRequest } from '@ai-gateway/contracts';
import { initialWorkspace } from '../platform/seed';
import { DemoStore } from './demo.store';
import { costForUsage,UPSTREAM_MAX_OUTPUT_TOKENS } from './admission';
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
  it('defaults an omitted output limit to the upstream ceiling, still capped by policy and context',async()=>{
    const {store,state,request}=configured();state.settings.limits={mode:'custom',maxOutputTokens:500000};
    const context=state.definitions[0].contextTokens;
    const wide=await store.authorize(request({maxOutputTokens:undefined,estimatedInputTokens:100}));
    expect(wide.decision).toBe('allow');
    expect(wide.admission!.route!.maxOutputTokens).toBe(Math.min(UPSTREAM_MAX_OUTPUT_TOKENS,context-100));
    state.settings.limits={mode:'custom',maxOutputTokens:20000};
    const capped=await store.authorize(request({maxOutputTokens:undefined,estimatedInputTokens:100}));
    expect(capped.admission!.route!.maxOutputTokens).toBe(20000);
    expect(capped.requestLimits).toBeUndefined();
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
