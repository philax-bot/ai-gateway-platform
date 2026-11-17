import { describe,it,expect } from 'vitest';
import type { CallLog } from '@ai-gateway/contracts';
import { aggregateUsage,dayKey,monthStart,normalizeUsageQuery } from './call-analytics';

function call(n:number,changes:Partial<CallLog>={}):CallLog{
  return {
    requestId:`r-${String(n).padStart(4,'0')}`,startedAt:'2026-10-25T01:59:59.000Z',completedAt:'2026-10-25T02:00:00.000Z',
    subjectType:'employee',subjectId:'employee-a',credentialId:'key',purpose:'personal',modelId:'model-a',
    outcome:'completed',inputTokens:10,outputTokens:20,cachedInputTokens:3,actualAmount:0.5,billableState:'confirmed',
    reservationId:'reservation',usageFinal:true,forwarded:true,...changes,
  };
}
const window={from:'2026-10-25T00:00:00.000Z',to:'2026-10-26T00:00:00.000Z'};
const scope=null;

describe('usage analytics aggregation',()=>{
  it('separates unknown costs, known zero and pending costs, comparing only matching confirmed calls',()=>{
    const costPrice={version:'c',currency:'CNY' as const,unit:'per_million_tokens' as const,inputPrice:2,outputPrice:3,cachedInputPrice:0.5};
    const admission={kind:'configured' as const,route:{serviceId:'svc',poolId:'pool',definitionId:'model',upstreamModel:'u'},price:null,costPrice,reservedAmount:1};
    const rows=[call(1,{admission}),call(2,{admission,billableState:'pending_review',actualAmount:7}),call(3),call(4,{admission,usageFinal:false}),call(5,{admission,forwarded:undefined}),call(6,{admission:undefined,forwarded:false,billableState:'not_billable',actualAmount:0})];
    const report=aggregateUsage(rows,window,null,'Asia/Shanghai');
    expect(report.totals.cost).toEqual({knownAmount:0.000152,unknownRequests:3,comparableRequests:1,comparableBilledAmount:0.5,comparableCostAmount:0.000076,differenceAmount:0.499924});
    expect(report.services.reduce((sum,row)=>sum+row.requests,0)).toBe(6);
    expect(aggregateUsage(rows,{...window,serviceId:'svc'},null,'Asia/Shanghai').totals.requests).toBe(4);
    expect(aggregateUsage(rows,window,{employeeId:'employee-a',applicationIds:[]},'Asia/Shanghai').totals).not.toHaveProperty('cost');
    expect(aggregateUsage(rows,{...window,applicationId:'not-owned'},null,'Asia/Shanghai').totals.requests).toBe(0);
  });
  it('keeps unknown usage and pending review out of the money and token columns',()=>{
    const rows=[
      call(1),
      call(2,{subjectId:'employee-a',inputTokens:900,outputTokens:900,actualAmount:9,billableState:'pending_review'}),
      call(3,{subjectId:'employee-a',usageFinal:false,inputTokens:99999,outputTokens:99999,cachedInputTokens:99999,actualAmount:2,billableState:'confirmed'}),
      call(4,{subjectId:'employee-a',outcome:'upstream_error'}),
    ];
    const result=aggregateUsage(rows,window,scope,'Asia/Shanghai'),person=result.people.find(row=>row.key==='employee-a')!;
    expect(person).toMatchObject({requests:4,unknownUsage:1,inputTokens:920,outputTokens:940,cachedInputTokens:9,confirmedAmount:3,pendingReview:1,pendingAmount:9,errors:1,forwarded:4,upstreamFailures:1});
    expect(result.totals).toMatchObject({requests:4,inputTokens:920,confirmedAmount:3,pendingAmount:9,activePeople:1,activeApplications:0});
    expect(result.projects).toEqual([expect.objectContaining({key:'',requests:4})]);
    // A row with unknown usage still counts as a request, so denominators stay honest.
    expect(result.totals.unknownUsage).toBe(1);
  });

  it('filters by window, caller scope, model, organization and purpose before grouping',()=>{
    const rows=[
      call(1),
      call(2,{completedAt:'2026-10-26T00:00:00.000Z'}),
      call(3,{completedAt:'2026-10-24T23:59:59.000Z'}),
      call(4,{subjectId:'employee-b'}),
      call(5,{subjectType:'application',subjectId:'app-a',purpose:'application'}),
      call(6,{modelId:'model-b'}),
      call(7,{organizationId:'org-a'}),
      call(8,{purpose:'project',projectId:'project-a'}),
    ];
    const scoped=aggregateUsage(rows,window,{employeeId:'employee-a',applicationIds:[]},'Asia/Shanghai');
    expect(scoped.people.map(row=>row.key)).toEqual(['employee-a']);
    expect(scoped.applications).toHaveLength(0);
    // Only employee-a rows inside the window survive: calls 1, 6, 7 and 8.
    expect(scoped.totals.requests).toBe(4);
    expect(aggregateUsage(rows,{...window,modelId:'model-b'},scope,'Asia/Shanghai').totals.requests).toBe(1);
    expect(aggregateUsage(rows,{...window,organizationId:'org-a'},scope,'Asia/Shanghai').totals.requests).toBe(1);
    expect(aggregateUsage(rows,{...window,purpose:'application'},scope,'Asia/Shanghai').applications[0].key).toBe('app-a');
  });

  it('lets a project manager see project calls in managed projects but never personal spend',()=>{
    const rows=[
      call(1,{subjectId:'employee-a',purpose:'personal'}),
      call(2,{subjectId:'employee-b',purpose:'project',projectId:'project-a'}),
      call(3,{subjectId:'employee-b',purpose:'project',projectId:'project-b'}),
      call(4,{subjectType:'application',subjectId:'app-a',purpose:'application'}),
      call(5,{subjectId:'employee-b',purpose:'personal'}),
    ];
    const scope={employeeId:'employee-a',applicationIds:['app-a'],projectIds:['project-a']};
    const result=aggregateUsage(rows,window,scope,'Asia/Shanghai');
    // Own personal call, the managed project's call and the owned application: employee-b's personal call stays out.
    expect(result.totals.requests).toBe(3);
    expect(result.people.map(row=>row.key)).toEqual(['employee-a','employee-b']);
    expect(result.applications.map(row=>row.key)).toEqual(['app-a']);
    const projectOnly=aggregateUsage(rows,window,{employeeId:'employee-a',applicationIds:[],projectIds:['project-a']},'Asia/Shanghai');
    expect(projectOnly.totals.requests).toBe(2);
    // The manager's own personal call has no project, so it lands in the unattributed bucket.
    expect(projectOnly.projects.map(row=>[row.key,row.requests])).toEqual([['',1],['project-a',1]]);
  });

  it('buckets days in the workspace time zone and keeps unattributed organizations separate',()=>{
    const rows=[call(1,{completedAt:'2026-10-30T15:30:00.000Z'}),call(2,{completedAt:'2026-10-30T16:30:00.000Z',organizationId:'org-a'})];
    const result=aggregateUsage(rows,{from:'2026-10-30T00:00:00.000Z',to:'2026-10-31T00:00:00.000Z'},scope,'Asia/Shanghai');
    expect(result.days.map(day=>day.key)).toEqual(['2026-10-30','2026-10-31']);
    expect(result.organizations.map(org=>org.key)).toEqual(['','org-a']);
    expect(dayKey('2026-10-30T16:30:00.000Z','Asia/Shanghai')).toBe('2026-10-31');
    expect(dayKey('2026-10-30T16:30:00.000Z','UTC')).toBe('2026-10-30');
  });

  it('sorts people and models by confirmed money and totals equal the dimension sums',()=>{
    const rows=[call(1,{subjectId:'employee-a',modelId:'model-a',actualAmount:1}),call(2,{subjectId:'employee-b',modelId:'model-b',actualAmount:3})];
    const result=aggregateUsage(rows,window,scope,'Asia/Shanghai');
    expect(result.people.map(row=>row.key)).toEqual(['employee-b','employee-a']);
    expect(result.models.map(row=>row.key)).toEqual(['model-b','model-a']);
    const sum=(rows:typeof result.people)=>Number(rows.reduce((total,row)=>total+row.confirmedAmount,0).toFixed(6));
    expect(sum(result.people)+sum(result.applications)).toBe(result.totals.confirmedAmount);
    expect(result.people.reduce((total,row)=>total+row.requests,0)+result.applications.reduce((total,row)=>total+row.requests,0)).toBe(result.totals.requests);
  });

  it('groups projects and keeps project-less calls in their own bucket',()=>{
    const rows=[
      call(1,{projectId:'project-a',purpose:'project'}),
      call(2,{projectId:'project-a',purpose:'project',subjectId:'employee-b'}),
      call(3,{projectId:undefined}),
    ];
    const result=aggregateUsage(rows,window,scope,'Asia/Shanghai');
    expect(result.projects.map(row=>[row.key,row.requests])).toEqual([['project-a',2],['',1]]);
    expect(result.projects.reduce((total,row)=>total+row.requests,0)).toBe(result.totals.requests);
  });

  it('defaults to the current month in the workspace time zone and rejects unbounded or malformed queries',()=>{
    const now=new Date('2026-10-31T00:00:00.000Z'),normalized=normalizeUsageQuery({},now);
    // 2026-10-01 00:00 in Asia/Shanghai is 2026-09-30T16:00Z.
    expect(normalized.from).toBe('2026-09-30T16:00:00.000Z');
    expect(normalized.to).toBe('2026-10-31T00:00:00.000Z');
    expect(normalizeUsageQuery({},now,'UTC').from).toBe('2026-10-01T00:00:00.000Z');
    expect(monthStart('2026-01-05T00:00:00.000Z','Asia/Shanghai')).toBe('2025-12-31T16:00:00.000Z');
    for(const query of [
      {from:'2026-06-01T00:00:00Z',to:'2026-10-31T00:00:00Z'},
      {from:'2026-10-31T00:00:00Z',to:'2026-10-01T00:00:00Z'},
      {from:'yesterday'},
      {purpose:'everything'},
      {unknown:'x'},
      [],
      'window',
    ])expect(()=>normalizeUsageQuery(query as never,now)).toThrow();
  });
});
