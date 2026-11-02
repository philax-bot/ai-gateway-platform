import { describe,it,expect } from 'vitest';
import type { CallLog } from '@ai-gateway/contracts';
import { normalizeCallQuery,queryMemoryCalls,summarizeCalls } from './call-query';

function call(n:number,changes:Partial<CallLog>={}):CallLog{return {requestId:`r-${String(n).padStart(4,'0')}`,startedAt:'2026-10-01T00:00:00.000Z',completedAt:'2026-10-01T00:00:01.000Z',subjectType:'employee',subjectId:'employee',credentialId:'key',purpose:'personal',modelId:'model',outcome:'completed',inputTokens:10,outputTokens:20,cachedInputTokens:3,actualAmount:0.1,billableState:'confirmed',reservationId:'reservation',usageFinal:true,forwarded:true,...changes};}
describe('scoped call queries and metric denominators',()=>{
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
