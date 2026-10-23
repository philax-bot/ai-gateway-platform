import { describe,it,expect,vi } from 'vitest';
import { DemoStore } from '../store/demo.store';
import { summarizeCalls } from '../store/call-query';
import { initialWorkspace } from './seed';
import { applyAlertReading,metricReading,monitoringState,saveAlertRule } from './monitoring.domain';
import { MonitoringService } from './monitoring.service';
import { WorkspaceRepository } from './workspace.repository';
const config={name:'上游故障',metric:'upstream_failure_rate',windowMinutes:5,threshold:10,minSamples:20,triggerCount:2,recoveryThreshold:5,recoveryCount:2};
const from='2026-10-18T01:00:00.000Z',to='2026-10-18T01:05:00.000Z';
const summary=(values={})=>({...summarizeCalls([]),ended:100,forwarded:100,upstreamFailures:20,...values});
describe('windowed alerts with explicit evidence and recovery',()=>{
  it('merges continuous failures, deduplicates evaluations, requires recovery evidence and opens a later event',()=>{
    const s=initialWorkspace(),r=saveAlertRule(s,config),m=monitoringState(s);
    const reading=(n:number,stats=summary())=>metricReading(r,stats,from,to,new Date(Date.parse(to)+n*60000).toISOString());
    applyAlertReading(s,r,reading(1),1);expect(m.events).toHaveLength(0);
    applyAlertReading(s,r,reading(2),2);expect(m.events).toHaveLength(1);expect(m.events[0].status).toBe('active');
    const notifications=s.notifications.length;applyAlertReading(s,r,reading(2),2);expect(s.notifications).toHaveLength(notifications);expect(m.events[0].occurrences).toBe(1);
    applyAlertReading(s,r,reading(3),3);expect(m.events).toHaveLength(1);expect(m.events[0].occurrences).toBe(2);expect(s.notifications).toHaveLength(notifications);
    m.events[0].acknowledgedAt=to;expect(m.events[0].status).toBe('active');
    for(const [bucket,stats] of [[4,summary({ended:0,forwarded:0,upstreamFailures:0})],[5,summary({forwarded:10,upstreamFailures:0})],[6,summary({upstreamFailures:0,unknownForwarding:1})]] as const){applyAlertReading(s,r,reading(bucket,stats),bucket);expect(m.events[0].status).toBe('active');}
    applyAlertReading(s,r,metricReading(r,null,from,to,to),7);expect(m.events[0].status).toBe('active');
    applyAlertReading(s,r,reading(8,summary({upstreamFailures:0})),8);expect(m.events[0].status).toBe('active');
    applyAlertReading(s,r,reading(9,summary({upstreamFailures:0})),9);expect(m.events[0].status).toBe('recovered');
    applyAlertReading(s,r,reading(10),10);applyAlertReading(s,r,reading(11),11);expect(m.events).toHaveLength(2);expect(m.events[1].status).toBe('active');
  });
  it('breaks consecutive counts after skipped minutes and validates rule changes',()=>{
    const s=initialWorkspace(),r=saveAlertRule(s,config),reading=metricReading(r,summary(),from,to,to);
    applyAlertReading(s,r,reading,1);applyAlertReading(s,r,reading,3);expect(monitoringState(s).events).toHaveLength(0);
    expect(()=>saveAlertRule(s,{...config,recoveryThreshold:10})).toThrow();expect(()=>saveAlertRule(s,{...config,windowMinutes:0})).toThrow();
    const v2=saveAlertRule(s,{...r,threshold:15});expect(v2.version).toBe(2);expect(monitoringState(s).evaluations[r.id]).toBeUndefined();
  });
  it('persists minute deduplication and continues original active rules across configuration edits',async()=>{
    vi.useFakeTimers({toFake:['Date']});
    try{
      vi.setSystemTime(new Date(to));const store=new DemoStore(),repo=new WorkspaceRepository(store);await repo.initialize();
      await repo.transact(async tx=>saveAlertRule(tx.state,{...config,triggerCount:1}));vi.spyOn(store,'queryCalls').mockImplementation(async()=>({items:[],nextCursor:null,summary:summary(),collectedAt:to}));
      const monitoring=new MonitoringService(repo,store);expect((await monitoring.evaluate()).evaluated).toBe(1);expect((await monitoring.evaluate()).evaluated).toBe(0);
      let s=await repo.read();expect(s.monitoring!.events).toHaveLength(1);const r=s.monitoring!.rules[0];
      await repo.transact(async tx=>saveAlertRule(tx.state,{...r,active:false,threshold:90}));
      vi.setSystemTime(new Date(Date.parse(to)+60000));await new MonitoringService(repo,store).evaluate();s=await repo.read();expect(s.monitoring!.events[0].ruleSnapshot.threshold).toBe(10);expect(s.monitoring!.events).toHaveLength(1);expect(s.monitoring!.evaluations[r.id].ruleVersion).toBe(1);
    }finally{vi.useRealTimers();}
  });
});
