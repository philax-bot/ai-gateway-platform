import { afterEach,describe,it,expect,vi } from 'vitest';
import { DemoStore } from '../store/demo.store';
import { summarizeCalls } from '../store/call-query';
import { initialWorkspace } from './seed';
import { applyAlertReading,applyCollectionReading,metricReading,monitoringState,saveAlertRule } from './monitoring.domain';
import { MonitoringService } from './monitoring.service';
import { MaintenanceService } from './maintenance.service';
import { WorkspaceRepository } from './workspace.repository';
import { PlatformService } from './platform.service';
const at=(bucket:number)=>new Date(bucket*60000).toISOString();
const page=()=>({items:[],nextCursor:null,summary:summarizeCalls([]),collectedAt:at(100)});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});

describe('collection failures are independent, actionable and evidence based',()=>{
  it('opens without a metric rule, merges by minute, records acknowledgement and requires two new consecutive minutes',()=>{
    const s=initialWorkspace(),m=monitoringState(s);
    applyCollectionReading(s,['call_totals'],100,at(100));
    const event=m.collectionEvents[0],notifications=s.notifications.length;
    expect(event.status).toBe('active');expect(m.events).toHaveLength(0);expect(notifications).toBeGreaterThan(0);
    expect(s.notifications.every(n=>s.members.find(v=>v.id===n.recipientId)?.roles.includes('operator'))).toBe(true);
    applyCollectionReading(s,['rule_windows'],100,at(100));expect(event.occurrences).toBe(1);expect(s.notifications).toHaveLength(notifications);
    applyCollectionReading(s,['call_totals'],101,at(101));expect(event.occurrences).toBe(2);
    event.acknowledgedAt=at(101);event.acknowledgedBy='operator-demo-001';expect(event.status).toBe('active');
    applyCollectionReading(s,[],101,at(101));expect(event.recoveries).toBe(0);
    applyCollectionReading(s,[],102,at(102));applyCollectionReading(s,[],102,at(102));expect(event.recoveries).toBe(1);expect(event.status).toBe('active');
    applyCollectionReading(s,[],103,at(103));expect(event.status).toBe('recovered');expect(event.recoveredAt).toBe(at(103));
    expect(s.audit.filter(a=>a.action==='alert.collection_recovered')).toHaveLength(1);
    applyCollectionReading(s,['in_flight'],104,at(104));expect(m.collectionEvents).toHaveLength(2);expect(m.collectionEvents[1].id).not.toBe(event.id);expect(m.collectionEvents[1].acknowledgedAt).toBeNull();
  });
  it('breaks recovery after gaps or new failures, ignores older evidence and keeps the last successful timestamp',()=>{
    const s=initialWorkspace(),m=monitoringState(s);
    applyCollectionReading(s,[],99,at(99));applyCollectionReading(s,['call_totals'],100,at(100));expect(m.collection.lastSuccessAt).toBe(at(99));
    applyCollectionReading(s,[],101,at(101));applyCollectionReading(s,[],103,at(103));expect(m.collectionEvents[0].recoveries).toBe(1);
    applyCollectionReading(s,['call_totals'],103,at(103));expect(m.collectionEvents[0].recoveries).toBe(0);
    const before=structuredClone(m);applyCollectionReading(s,[],102,at(102));expect(m).toEqual(before);
    applyCollectionReading(s,[],104,at(104));expect(m.collectionEvents[0].status).toBe('active');
    applyCollectionReading(s,[],105,at(105));expect(m.collectionEvents[0].status).toBe('recovered');
  });
  it('does not recover a business failure when collection succeeds with no traffic',()=>{
    const s=initialWorkspace(),m=monitoringState(s),r=saveAlertRule(s,{name:'故障',metric:'request_error_rate',windowMinutes:5,threshold:10,minSamples:1,triggerCount:1,recoveryThreshold:5,recoveryCount:1});
    applyAlertReading(s,r,metricReading(r,{...summarizeCalls([]),ended:1,errors:1},at(95),at(100),at(100)),100);
    applyCollectionReading(s,['rule_windows'],100,at(100));
    for(const b of [101,102]){applyCollectionReading(s,[],b,at(b));applyAlertReading(s,r,metricReading(r,summarizeCalls([]),at(b-5),at(b),at(b)),b);}
    expect(m.collectionEvents[0].status).toBe('recovered');expect(m.events[0].status).toBe('active');expect(m.events[0].reading.quality).toBe('no_traffic');
  });
  it('collects without rules, persists deduplication across instances and does not invalidate business previews',async()=>{
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(at(100));
    const store=new DemoStore(),repo=new WorkspaceRepository(store);await repo.initialize();const before=await repo.view();
    const query=vi.spyOn(store,'queryCalls').mockRejectedValue(new Error('private database address and credentials'));
    await new MonitoringService(repo,store).evaluate();const calls=query.mock.calls.length;
    const s=await repo.read();expect(s.monitoring!.collectionEvents).toHaveLength(1);expect(JSON.stringify(s.monitoring)).not.toContain('private');expect(s.revision).toBe(before.state.revision);
    await new MonitoringService(repo,store).evaluate();expect(query).toHaveBeenCalledTimes(calls);
    query.mockResolvedValue(page());await new MonitoringService(repo,store).evaluate(true);expect((await repo.read()).monitoring!.collectionEvents![0].recoveries).toBe(0);
    for(const b of [101,102]){vi.setSystemTime(at(b));await new MonitoringService(repo,store).evaluate();}
    const after=await repo.view();expect(after.state.monitoring!.collectionEvents![0].status).toBe('recovered');expect(after.state.revision).toBe(before.state.revision);expect(after.batches).toEqual(before.batches);expect(after.budgets).toEqual(before.budgets);
    await expect(new MonitoringService(repo,store).snapshot('employee-demo-001')).rejects.toThrow();
  });
  it('requires every collection stage and discards partial rows on service/model failures',async()=>{
    const store=new DemoStore(),repo=new WorkspaceRepository(store);await repo.initialize();const monitor=new MonitoringService(repo,store);
    const flight=vi.spyOn(store,'inFlightCounts').mockRejectedValue(new Error('private'));
    await monitor.evaluate(true);expect((await repo.read()).monitoring!.collection?.failedStages).toEqual(['in_flight']);
    flight.mockResolvedValue([]);const query=vi.spyOn(store,'queryCalls').mockImplementation(async q=>{if(q.serviceId)throw new Error('private');return page();});
    const report=await monitor.snapshot('operator-demo-001');expect(report.quality).toBe('collection_failed');expect(report.failedStages).toEqual(['service_models']);expect(report.rows).toEqual([]);expect(JSON.stringify(report)).not.toContain('private');
    await repo.transact(async tx=>{saveAlertRule(tx.state,{name:'窗口',metric:'request_error_rate',windowMinutes:10,threshold:10,minSamples:1,triggerCount:1,recoveryThreshold:5,recoveryCount:1});});
    query.mockImplementation(async q=>{if(Date.parse(q.to!)-Date.parse(q.from!)===10*60000)throw new Error('private');return page();});
    await monitor.evaluate(true);expect((await repo.read()).monitoring!.collection?.failedStages).toEqual(['rule_windows']);expect((await repo.read()).monitoring!.collectionEvents).toHaveLength(1);
  });
  it('allows only operators to acknowledge a collection event and never treats acknowledgement as recovery',async()=>{
    const store=new DemoStore(),repo=new WorkspaceRepository(store);await repo.initialize();await repo.transact(async tx=>{applyCollectionReading(tx.state,['call_totals'],100,at(100));});
    const platform=new PlatformService(repo,store),id=(await repo.read()).monitoring!.collectionEvents![0].id;
    const cmd={type:'alert.ack',payload:{id},idempotencyKey:crypto.randomUUID()};
    await expect(platform.execute('employee-demo-001',cmd)).rejects.toThrow();await platform.execute('operator-demo-001',cmd);
    const event=(await repo.read()).monitoring!.collectionEvents![0];expect(event.acknowledgedBy).toBe('operator-demo-001');expect(event.status).toBe('active');expect(event.recoveredAt).toBeNull();
  });
  it('keeps login workspace and authoritative balances reachable when call statistics fail, with unknown review count',async()=>{
    const store=new DemoStore(),repo=new WorkspaceRepository(store);await repo.initialize();const platform=new PlatformService(repo,store),before=await platform.snapshot('operator-demo-001');
    vi.spyOn(store,'queryCalls').mockRejectedValue(new Error('private database connection'));
    const result=await platform.snapshot('operator-demo-001');expect(result.callDataQuality).toBe('collection_failed');expect(result.pendingReviewCount).toBeNull();expect(result.callLogs).toEqual([]);expect(result.quotaBatches).toEqual(before.quotaBatches);expect(result.projectBudgets).toEqual(before.projectBudgets);expect(result.actor.id).toBe(before.actor.id);expect(JSON.stringify(result)).not.toContain('private');
  });
});

describe('monitoring still runs when periodic business maintenance fails',()=>{
  it('preserves the business failure, reports maintenance unavailable and still evaluates monitoring',async()=>{
    const store=new DemoStore(),repo=new WorkspaceRepository(store),monitor=new MonitoringService(repo,store),failure=new Error('business maintenance unavailable');
    vi.spyOn(repo,'readMaintenance').mockRejectedValue(failure);const evaluate=vi.spyOn(monitor,'evaluate').mockResolvedValue({evaluated:0,collectionQuality:'collected'});
    const maintenance=new MaintenanceService(repo,store,monitor);await expect(maintenance.run()).rejects.toBe(failure);expect(evaluate).toHaveBeenCalledOnce();expect(maintenance.status()).toMatchObject({running:false,error:'maintenance_unavailable',lastSuccessAt:null});
  });
  it('serializes overlapping runs and surfaces monitoring failures',async()=>{
    const store=new DemoStore(),repo=new WorkspaceRepository(store),monitor=new MonitoringService(repo,store);await repo.initialize();
    let complete!:(value:Awaited<ReturnType<MonitoringService['evaluate']>>)=>void;const evaluate=vi.spyOn(monitor,'evaluate').mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
    const maintenance=new MaintenanceService(repo,store,monitor),a=maintenance.run(),b=maintenance.run();expect(a).toBe(b);
    await vi.waitFor(()=>expect(evaluate).toHaveBeenCalledOnce());complete({evaluated:0,collectionQuality:'collected'});await a;expect(maintenance.status()).toMatchObject({running:false,error:null});
    evaluate.mockRejectedValue(new Error('monitor unavailable'));await expect(maintenance.run()).rejects.toThrow('monitor unavailable');expect(maintenance.status().error).toBe('maintenance_unavailable');
  });
});
