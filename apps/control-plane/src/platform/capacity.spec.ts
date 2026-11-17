import {afterEach,describe,it,expect,vi} from 'vitest';
import {initialWorkspace} from './seed';
import {capacityResources,capacityRows} from './capacity';
import {DemoStore} from '../store/demo.store';
import {MonitoringService} from './monitoring.service';
import {WorkspaceRepository} from './workspace.repository';
afterEach(()=>vi.useRealTimers());
describe('authoritative capacity readings',()=>{
  it('keeps inheritance, explicit unlimited scopes, per-model scope ids and shared group deduplication',()=>{
    const s=initialWorkspace();s.settings.limits={mode:'custom',rpm:600,tpm:100000,concurrency:20};s.services[0].limits={mode:'inherit'};s.services[0].sharedCapacityId='same';
    s.services.push({...structuredClone(s.services[0]),id:'second',limits:{mode:'none'}});s.pools[0].limits={mode:'custom',rpm:300};
    const resources=capacityResources(s),counters={collectedAt:'2026-11-12T01:00:15.000Z',windowStart:'2026-11-12T01:00:00.000Z',windowEnd:'2026-11-12T01:01:00.000Z',rows:resources.map(r=>({scopeId:r.scopeId,requests:240,tokens:60000,active:18}))};
    const rows=capacityRows(resources,counters),service=rows.find(r=>r.kind==='service'&&r.resourceId===s.services[0].id)!;
    expect(service.rpm.percent).toBe(40);expect(service.tpm.percent).toBe(60);expect(service.concurrency.percent).toBe(90);
    expect(rows.find(r=>r.resourceId==='second')!.concurrency.percent).toBeNull();expect(rows.filter(r=>r.kind==='shared')).toHaveLength(1);
    expect(resources.find(r=>r.kind==='service_model')!.scopeId).toBe(`${s.tenantId}:service-model:${s.services[0].id}:${s.definitions[0].id}`);
    expect(rows.find(r=>r.kind==='pool')!.rpm.percent).toBe(80);expect(rows.find(r=>r.kind==='pool')!.tpm.limit).toBeNull();
    const overloaded=capacityRows(resources,{...counters,rows:[{scopeId:service.scopeId,requests:700,tokens:0,active:0}]});expect(overloaded[0].rpm.percent).toBeGreaterThan(100);
  });
  it('resets minute counters without dropping active reservations, counts no duplicate scopes and excludes expired/finalized holds',async()=>{
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime('2026-11-12T01:00:59Z');
    const store=new DemoStore(),scopeId='test:pool:a';
    // Insert realistic admissions through the store, then inspect the same limiter counters.
    const identity=store.credentials.get('local-employee-key')!.identity;
    const input={requestId:'capacity-test',idempotencyKey:'capacity-test',identity,purpose:'personal' as const,modelId:'test-model',mode:'chat' as const,policyVersion:'test'};
    const auth=await store.authorize(input),hold=store.reservationsByRequest.get(input.requestId)!;hold.admission.scopes=[{id:scopeId}];
    expect((await store.capacityCounters([scopeId,scopeId])).rows).toEqual([{scopeId,requests:0,tokens:0,active:1}]);
    vi.setSystemTime('2026-11-12T01:01:01Z');expect((await store.capacityCounters([scopeId])).rows[0].active).toBe(1);
    await store.settle({requestId:input.requestId,idempotencyKey:'finish',reservationId:auth.reservation!.reservationId,outcome:'completed',usageFinal:true,inputTokens:1,outputTokens:1,completedAt:new Date().toISOString()});
    expect((await store.capacityCounters([scopeId])).rows[0].active).toBe(0);
  });
  it('returns unknown on read failure and restricts capacity to operators',async()=>{
    const store=new DemoStore(),repo=new WorkspaceRepository(store);await repo.initialize();const monitor=new MonitoringService(repo,store);
    await expect(monitor.capacity('employee-demo-001')).rejects.toThrow();
    vi.spyOn(store,'capacityCounters').mockRejectedValue(new Error('private database address'));
    const result=await monitor.capacity('operator-demo-001');expect(result.quality).toBe('collection_failed');expect(result.rows).toEqual([]);expect(JSON.stringify(result)).not.toContain('private');
  });
});
