import { describe, expect, it } from 'vitest';
import type { AuthorizeRequest, SettlementRequest } from '@ai-gateway/contracts';
import { DemoStore } from './demo.store';
import { authorizationFingerprint } from './accounting';

function fixture(){
  const store=new DemoStore(),identity=store.credentials.get('local-employee-key')!.identity;
  const request:AuthorizeRequest={requestId:crypto.randomUUID(),idempotencyKey:crypto.randomUUID(),admissionAttemptId:crypto.randomUUID(),identity,purpose:'personal',modelId:'test-model',mode:'chat',policyVersion:'recovery-1'};
  return {store,request};
}
describe('physical authorization ownership and recovery',()=>{
  it('preserves the first owner across logical replays without changing legacy fingerprints',async()=>{
    const {store,request}=fixture(),legacy={...request};delete legacy.admissionAttemptId;
    expect(authorizationFingerprint(request)).toBe(authorizationFingerprint(legacy));
    const first=await store.authorize(request),replay=await store.authorize({...request,admissionAttemptId:crypto.randomUUID()});
    expect(replay).toMatchObject({replayed:true,admissionAttemptId:request.admissionAttemptId,reservation:first.reservation});
    expect((await store.getQuota()).availableAmount).toBe(9.98);
    expect(()=>authorizationFingerprint({...request,admissionAttemptId:'bad\nowner'})).toThrow();
  });
  it('keeps old records ownerless rather than claiming them for a retry',async()=>{
    const {store,request}=fixture(),legacy={...request};delete legacy.admissionAttemptId;
    await store.authorize(legacy);expect((await store.authorize(request)).admissionAttemptId).toBeUndefined();
  });
  it('retains the first owner for denied records too',async()=>{
    const {store,request}=fixture();request.modelId='not-open';await store.authorize(request);
    expect(await store.authorize({...request,admissionAttemptId:'second-attempt'})).toMatchObject({decision:'deny',replayed:true,admissionAttemptId:request.admissionAttemptId});
  });
  it('recovers a known unforwarded hold even after lease maintenance and releases it only once',async()=>{
    const {store,request}=fixture(),auth=await store.authorize(request);
    const base={requestId:request.requestId,reservationId:auth.reservation!.reservationId,completedAt:new Date().toISOString()};
    await store.settle({...base,idempotencyKey:`${request.requestId}:lease-expired`,outcome:'partial',usageFinal:false,inputTokens:0,outputTokens:0});
    const release:SettlementRequest={...base,idempotencyKey:`${request.idempotencyKey}:settlement`,outcome:'rejected_before_upstream',forwarded:false,usageFinal:true,inputTokens:0,outputTokens:0,errorCode:'authorization_response_lost'};
    expect((await store.settle(release)).status).toBe('released');expect((await store.settle(release)).status).toBe('already_finalized');
    expect((await store.getQuota()).availableAmount).toBe(10);expect(store.ledgerEntries).toHaveLength(1);
    expect(await store.getCall(request.requestId)).toMatchObject({billableState:'not_billable',usageFinal:true,forwarded:false,errorCode:'authorization_response_lost'});
  });
  it('leaves interrupted dispatched usage pending instead of releasing it from a zero-token guess',async()=>{
    const {store,request}=fixture(),auth=await store.authorize(request),base={requestId:request.requestId,reservationId:auth.reservation!.reservationId,completedAt:new Date().toISOString()};
    await store.settle({...base,idempotencyKey:`${request.requestId}:lease-expired`,outcome:'partial',usageFinal:false});
    const replay=await store.settle({...base,idempotencyKey:`${request.idempotencyKey}:settlement`,outcome:'partial',forwarded:true,usageFinal:false,inputTokens:0,outputTokens:0});
    expect(replay.billableState).toBe('pending_review');expect((await store.getQuota()).availableAmount).toBe(9.98);expect(store.ledgerEntries).toHaveLength(0);
  });
});
