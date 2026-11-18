import {DemoStore} from './demo.store';
import { describe,it,expect } from 'vitest';
import type { CallLog } from '@ai-gateway/contracts';
import { callErrorFilter,describeCallError } from '@ai-gateway/contracts';
import { aggregateCallErrors,normalizeCallErrorQuery,normalizeCallQuery,queryMemoryCalls,summarizeCalls } from './call-query';

function call(n:number,changes:Partial<CallLog>={}):CallLog{return {requestId:`r-${String(n).padStart(4,'0')}`,startedAt:'2026-10-01T00:00:00.000Z',completedAt:'2026-10-01T00:00:01.000Z',subjectType:'employee',subjectId:'employee',credentialId:'key',purpose:'personal',modelId:'model',outcome:'completed',inputTokens:10,outputTokens:20,cachedInputTokens:3,actualAmount:0.1,billableState:'confirmed',reservationId:'reservation',usageFinal:true,forwarded:true,...changes};}
describe('scoped call queries and metric denominators',()=>{
  it('finds application milestones outside the page window without crossing identities',async()=>{
    const store=new DemoStore();
    const app={subjectType:'application',subjectId:'owned',purpose:'application'} as const;
    store.callLogs.push(call(2,{...app,outcome:'timeout'}),call(1,app),
      ...Array.from({length:210},(_,i)=>call(i+3,app)),
      call(213,{...app,outcome:'client_cancelled'}),call(214,{...app,subjectId:'another'}),
      call(215,{...app,subjectType:'employee',purpose:'personal'}));
    const activity=await store.applicationActivity(['owned']);
    expect(Object.keys(activity)).toEqual(['owned']);
    expect(activity.owned).toMatchObject({firstSuccess:{requestId:'r-0001'},lastSuccess:{requestId:'r-0212'},
      lastFailure:{requestId:'r-0002'},lastCall:{requestId:'r-0213'}});
  });
  it('keeps drilldown organization, subject type and grouped errors aligned with analytics',()=>{
    const rows=[call(1,{organizationId:'org-a',outcome:'partial'}),call(2,{organizationId:'org-a',outcome:'client_cancelled'}),call(3,{organizationId:'org-b',outcome:'timeout'}),call(4,{organizationId:'org-a',subjectType:'application',outcome:'upstream_error'})];
    const query={organizationId:'org-a',subjectType:'employee' as const,resultGroup:'errors' as const};
    expect(queryMemoryCalls(rows,query,null).items.map(row=>row.requestId)).toEqual([rows[0].requestId]);
    expect(queryMemoryCalls(rows,{...query,subjectId:'other'},{employeeId:'employee',applicationIds:[]}).items).toEqual([]);
    expect(()=>normalizeCallQuery({resultGroup:'completed'} as never)).toThrow();
    expect(()=>normalizeCallQuery({subjectType:'all'} as never)).toThrow();
  });
  it('filters before pagination and summaries; stable keysets retain equal timestamps',()=>{
    const rows=Array.from({length:410},(_,n)=>call(n,{subjectId:n<205?'employee':'other'}));
    const scope={employeeId:'employee',applicationIds:[]},first=queryMemoryCalls(rows,{limit:200},scope),second=queryMemoryCalls(rows,{limit:200,cursor:first.nextCursor!},scope);
    expect(first.summary.ended).toBe(205);expect(first.items).toHaveLength(200);expect(second.items).toHaveLength(5);expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items,...second.items].map(c=>c.requestId)).size).toBe(205);
    expect(queryMemoryCalls(rows,{subjectId:'other'},scope).summary.ended).toBe(0);
  });
  it('does not count cache twice, unknown usage as zero or rejections as upstream failures',()=>{
    const rows=[call(1),call(2,{outcome:'upstream_error'}),call(3,{outcome:'rejected_before_upstream',forwarded:false,usageFinal:true,inputTokens:0,outputTokens:0,cachedInputTokens:0,actualAmount:0,billableState:'not_billable'}),call(4,{outcome:'client_cancelled',usageFinal:false,inputTokens:99999,billableState:'pending_review'}),call(5,{outcome:'partial',forwarded:null,usageFinal:false,billableState:'pending_review'})];
    expect(summarizeCalls(rows)).toMatchObject({ended:5,forwarded:3,unknownForwarding:1,upstreamFailures:1,errors:3,cancelled:1,rejected:1,knownUsage:3,unknownUsage:2,inputTokens:20,outputTokens:40,cachedInputTokens:6,pendingReview:2,confirmedAmount:0.2});
  });
  it('validates dates, enums, cursor and page bounds while ignoring client-supplied scope',()=>{
    for(const query of [{limit:0},{limit:201},{cursor:'not-json'},{outcome:'all'},{from:'yesterday'},{from:'2026-10-02T00:00:00Z',to:'2026-10-01T00:00:00Z'}])expect(()=>normalizeCallQuery(query as any)).toThrow();
    expect(normalizeCallQuery({scope:null,subjectId:'other'} as any)).toEqual({limit:50,subjectId:'other'});
  });
});

describe('error reason breakdown and exact drill-down',()=>{
  const route=(serviceId:string)=>({kind:'configured' as const,price:null,reservedAmount:0,route:{serviceId,poolId:'pool',definitionId:'model',upstreamModel:'upstream'}});
  const window={from:'2026-09-30T00:00:00.000Z',to:'2026-10-02T00:00:00.000Z'};
  const rows:CallLog[]=[
    call(1,{outcome:'upstream_error',errorCode:'upstream_http_502',admission:route('svc-a')}),
    call(2,{outcome:'upstream_error',errorCode:'upstream_http_502',admission:route('svc-a')}),
    call(3,{outcome:'timeout',errorCode:'upstream_first_byte_timeout',admission:route('svc-b')}),
    call(4,{outcome:'partial',admission:route('svc-a')}),
    call(5,{outcome:'client_cancelled',errorCode:'client_cancelled',admission:route('svc-a')}),
    call(6),
    call(7,{outcome:'rejected_before_upstream',errorCode:'insufficient_quota',forwarded:false,admission:null}),
  ];
  it('groups by service, model, outcome and code, separating client cancellation from errors',()=>{
    const b=aggregateCallErrors(rows,window,null);
    expect(b).toMatchObject({from:window.from,to:window.to,ended:7,errors:5,cancelled:1,unknownCode:1,bucketCount:5});
    const sum=(group:string)=>b.buckets.filter(row=>row.group===group).reduce((n,row)=>n+row.calls,0);
    expect(sum('error')).toBe(b.errors);
    expect(sum('cancelled')).toBe(b.cancelled);
    expect(b.buckets[0]).toMatchObject({serviceId:'svc-a',errorCode:'upstream_http_502',group:'error',calls:2});
    expect(b.buckets.find(row=>row.group==='cancelled')).toMatchObject({outcome:'client_cancelled',calls:1});
    expect(b.buckets.find(row=>row.errorCode===null)).toMatchObject({serviceId:'svc-a',modelId:'model',calls:1});
    expect(b.buckets.find(row=>row.serviceId===null)).toMatchObject({errorCode:'insufficient_quota',calls:1});
  });
  it('drills every bucket to exactly its own rows without widening the window',()=>{
    for(const bucket of aggregateCallErrors(rows,window,null).buckets){
      const page=queryMemoryCalls(rows,callErrorFilter(bucket,window),null);
      expect(page.summary.ended).toBe(bucket.calls);
      expect(page.items.every(item=>item.outcome===bucket.outcome&&(item.errorCode??null)===bucket.errorCode)).toBe(true);
      if(bucket.serviceId)expect(page.items.every(item=>item.admission?.route?.serviceId===bucket.serviceId)).toBe(true);
      else expect(page.items.every(item=>item.admission?.route?.serviceId==null)).toBe(true);
    }
  });
  it('keeps the existing error denominator so the distribution and the list agree',()=>{
    const summary=summarizeCalls(queryMemoryCalls(rows,window,null).items),b=aggregateCallErrors(rows,window,null),grouped=queryMemoryCalls(rows,{...window,resultGroup:'errors'},null);
    expect(b.errors).toBe(summary.errors);
    expect(grouped.summary.ended).toBe(b.errors);
    expect(grouped.summary.cancelled).toBe(0);
  });
  it('bounds the returned groups without hiding that more exist',()=>{
    const b=aggregateCallErrors(rows,{...window,limit:2},null);
    expect(b.buckets).toHaveLength(2);
    expect(b.bucketCount).toBe(5);
  });
  it('rejects contradictory reason filters and out-of-range limits',()=>{
    expect(()=>normalizeCallErrorQuery({errorCode:'upstream_http_502',errorCodeMissing:'true'})).toThrow();
    expect(()=>normalizeCallErrorQuery({limit:0})).toThrow();
    expect(()=>normalizeCallErrorQuery({limit:201})).toThrow();
    expect(()=>normalizeCallQuery({errorCodeMissing:'yes'} as never)).toThrow();
    expect(()=>normalizeCallQuery({serviceMissing:'1'} as never)).toThrow();
    expect(normalizeCallErrorQuery({from:window.from,limit:20})).toMatchObject({from:window.from,limit:20});
  });
  it('keeps the window half-open and never counts an unknown code as a cause',()=>{
    const edge=[call(1,{completedAt:window.from,outcome:'timeout',errorCode:null}),call(2,{completedAt:window.to,outcome:'timeout',errorCode:null})];
    const b=aggregateCallErrors(edge,window,null);
    expect(b.ended).toBe(1);expect(b.errors).toBe(1);expect(b.unknownCode).toBe(1);
    expect(describeCallError(b.buckets[0].errorCode)).toEqual({label:'错误码未采集',known:false});
  });
});
