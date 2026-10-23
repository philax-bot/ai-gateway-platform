import { describe, expect, it } from 'vitest';
import type { AuthorizeRequest, Entitlement, Plan, SettlementRequest } from '@ai-gateway/contracts';
import { initialWorkspace } from '../platform/seed';
import { DemoStore } from './demo.store';
import { costForUsage } from './admission';

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
