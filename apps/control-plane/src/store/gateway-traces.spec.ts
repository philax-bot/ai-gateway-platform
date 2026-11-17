import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {GatewayRequestTrace} from '@ai-gateway/contracts';
import {DemoStore} from './demo.store';
import {validateGatewayTrace,traceQuery} from './gateway-traces';
import {billingView} from '../platform/billing-visibility';
const row=():GatewayRequestTrace=>({attemptId:randomUUID(),requestId:'same-logical-request',traceId:'a'.repeat(32),spanId:'b'.repeat(16),parentSpanId:null,revision:1,startedAt:'2026-11-12T01:00:00.000Z',updatedAt:'2026-11-12T01:00:00.000Z',completedAt:null,method:'POST',path:'/v1/chat/completions',status:null,identity:null,purpose:null,modelId:null,route:null,upstreamRequestId:null,errorCode:null,replayed:false,stages:[{stage:'accepted',at:'2026-11-12T01:00:00.000Z'}]});
describe('access attempts separate from billable logical calls',()=>{
  it('deduplicates replayed delivery, rejects stale updates and preserves separate HTTP attempts and anonymous failures',async()=>{
    const store=new DemoStore(),first=row(),second=row();await store.recordGatewayTrace(first);await store.recordGatewayTrace(first);await store.recordGatewayTrace(second);
    const ended={...first,revision:2,updatedAt:'2026-11-12T01:00:01.000Z',completedAt:'2026-11-12T01:00:01.000Z',status:401,errorCode:'authentication_error',stages:[...first.stages,{stage:'completed' as const,at:'2026-11-12T01:00:01.000Z'}]};
    await store.recordGatewayTrace(ended);await store.recordGatewayTrace({...first,revision:3});
    const page=await store.queryGatewayTraces({requestId:first.requestId});expect(page.items).toHaveLength(2);expect(page.items.find(r=>r.attemptId===first.attemptId)?.status).toBe(401);
    expect((await store.queryGatewayTraces({state:'active'})).items).toHaveLength(1);expect((await store.queryGatewayTraces({state:'failed'})).items[0].identity).toBeNull();expect(store.callLogs).toHaveLength(0);
    const one=await store.queryGatewayTraces({limit:1});expect(one.nextCursor).toBeTruthy();expect((await store.queryGatewayTraces({limit:1,cursor:one.nextCursor!})).items[0].attemptId).not.toBe(one.items[0].attemptId);
  });
  it('validates and allowlists bounded metadata without storing request bodies, credentials or query secrets',()=>{
    expect(()=>validateGatewayTrace({...row(),path:'/v1/chat/completions?api_key=secret'})).toThrow();
    expect(()=>validateGatewayTrace({...row(),traceId:'0'.repeat(32)})).toThrow();expect(()=>traceQuery({limit:1000})).toThrow();
    const input={...row(),apiKey:'secret',messages:['secret']} as GatewayRequestTrace;expect(JSON.stringify(validateGatewayTrace(input))).not.toContain('secret');
    const audit={serviceName:'old-service',poolName:'old-pool',configVersion:3,endpoint:'https://private.example/v1'};
    expect(billingView({route:{audit}},false).route.audit).not.toHaveProperty('endpoint');expect(billingView({route:{audit}},true).route.audit.endpoint).toBe(audit.endpoint);
  });
});
