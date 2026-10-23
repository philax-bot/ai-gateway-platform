import type { PoolClient } from 'pg';
import type { CallLog, CallPage, CallQuery, CallSummary } from '@ai-gateway/contracts';
import { decodeCursor,encodeCursor,filterColumns,normalizeCallQuery,type CallScope } from './call-query';

export async function queryPostgresCalls(client:PoolClient,input:CallQuery,scope:CallScope,map:(r:Record<string,any>)=>CallLog):Promise<CallPage>{
  const q=normalizeCallQuery(input),values:unknown[]=[],conditions:string[]=[];
  const bind=(value:unknown)=>{values.push(value);return `$${values.length}`;};
  if(scope)conditions.push(`((subject_type='employee' and subject_id=${bind(scope.employeeId)}) or (subject_type='application' and subject_id=any(${bind(scope.applicationIds)}::text[])))`);
  for(const key of Object.keys(filterColumns) as (keyof typeof filterColumns)[]){const value=q[key];if(value!==undefined)conditions.push(`${filterColumns[key]}${key==='from'?'>=':key==='to'?'<':'='}${bind(value)}`);}
  const where=conditions.length?conditions.join(' and '):'true';
  const count=(condition:string)=>`count(*) filter(where ${condition})`;
  const sum=(column:string,condition:string)=>`coalesce(sum(${column}) filter(where ${condition}),0)`;
  const metrics:Record<keyof CallSummary,string>={
    ended:'count(*)',forwarded:count('forwarded=true'),unknownForwarding:count('forwarded is null'),errors:count("outcome not in ('completed','client_cancelled')"),
    upstreamFailures:count("forwarded=true and outcome='upstream_error'"),cancelled:count("outcome='client_cancelled'"),timeouts:count("outcome='timeout'"),
    partial:count("outcome='partial'"),rejected:count("outcome='rejected_before_upstream'"),pendingReview:count("billable_state='pending_review'"),
    knownUsage:count('usage_final=true'),unknownUsage:count('usage_final is distinct from true'),
    inputTokens:sum('input_tokens','usage_final=true'),outputTokens:sum('output_tokens','usage_final=true'),cachedInputTokens:sum('cached_input_tokens','usage_final=true'),
    confirmedAmount:sum('actual_amount',"billable_state='confirmed'"),
    activeUsers:"count(distinct subject_id) filter(where subject_type='employee')",activeApplications:"count(distinct subject_id) filter(where subject_type='application')",activeProjects:'count(distinct project_id)',
    rateLimited:count("error_code='rate_limited'"),latencySamples:count('forwarded=true and latency_ms is not null'),
    averageLatencyMs:'avg(latency_ms) filter(where forwarded=true)',p95LatencyMs:'percentile_disc(0.95) within group(order by latency_ms) filter(where forwarded=true and latency_ms is not null)',
    ttftSamples:count('forwarded=true and ttft_ms is not null'),p95TtftMs:'percentile_disc(0.95) within group(order by ttft_ms) filter(where forwarded=true and ttft_ms is not null)',
  };
  const aggregate=await client.query(`select ${Object.entries(metrics).map(([key,sql])=>`${sql} as "${key}"`).join(',')} from call_logs where ${where}`,values);
  const summary=Object.fromEntries(Object.entries(aggregate.rows[0]).map(([k,v])=>[k,v==null?null:Number(v)])) as unknown as CallSummary;
  let pageWhere=where;
  if(q.cursor){const [at,id]=decodeCursor(q.cursor);pageWhere+=` and (completed_at,request_id)<(${bind(at)}::timestamptz,${bind(id)}::text)`;}
  const result=await client.query(`select *,completed_at::text as cursor_time from call_logs where ${pageWhere} order by completed_at desc,request_id desc limit ${bind(q.limit!+1)}`,values);
  const page=result.rows.slice(0,q.limit),last=page.at(-1);
  return {items:page.map(map),nextCursor:result.rows.length>page.length&&last?encodeCursor(last.cursor_time,last.request_id):null,summary,collectedAt:new Date().toISOString()};
}
