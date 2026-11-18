import type { PoolClient } from 'pg';
import type { CallErrorBreakdown, CallErrorQuery, CallLog, CallPage, CallQuery, CallSummary } from '@ai-gateway/contracts';
import { aggregateCallErrors,callConditions,decodeCursor,encodeCursor,normalizeCallErrorQuery,normalizeCallQuery,type CallScope } from './call-query';

export interface CallRow {
  metered_usage?:CallLog['meteredUsage'];
  safety?:CallLog['safety'];
  request_id:string; upstream_request_id?:string|null; retry_of_request_id?:string|null;
  started_at:Date; completed_at:Date; subject_type:CallLog['subjectType']; subject_id:string;
  credential_id:string; purpose:CallLog['purpose']; project_id:string|null; model_id:string;
  outcome:CallLog['outcome']; input_tokens:number; output_tokens:number; cached_input_tokens:number;
  actual_amount:string|number; billable_state:CallLog['billableState']; reservation_id:string|null;
  admission:unknown; organization_id:string|null; error_code:string|null; latency_ms:number|null;
  usage_final:boolean|null; forwarded:boolean|null; ttft_ms:number|null;
}

/** Shared scope + filter predicate. Every call read path starts here. */
function whereClause(q:CallQuery,scope:CallScope,bind:(value:unknown)=>string){
  const conditions:string[]=[];
  if(scope)conditions.push(`((subject_type='employee' and subject_id=${bind(scope.employeeId)}) or (subject_type='application' and subject_id=any(${bind(scope.applicationIds)}::text[])))`);
  conditions.push(...callConditions(q,bind));
  return conditions.length?conditions.join(' and '):'true';
}

export async function queryPostgresCalls(client:PoolClient,input:CallQuery,scope:CallScope,map:(r:CallRow)=>CallLog):Promise<CallPage>{
  const q=normalizeCallQuery(input),values:unknown[]=[];
  const bind=(value:unknown)=>{values.push(value);return `$${values.length}`;};
  const where=whereClause(q,scope,bind);
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
  // pi-lens-ignore: no-sql-in-code, sql-injection — 列名与片段来自静态映射，所有值均为绑定参数。
  const aggregate=await client.query(`select ${Object.entries(metrics).map(([key,sql])=>`${sql} as "${key}"`).join(',')} from call_logs where ${where}`,values);
  // SAFETY: the aggregate selects exactly the keys of CallSummary, and pg returns bigint/numeric as strings; every column is numeric or null.
  const summary=Object.fromEntries(Object.entries(aggregate.rows[0]).map(([k,v])=>[k,v==null?null:Number(v)])) as unknown as CallSummary;
  let pageWhere=where;
  if(q.cursor){const [at,id]=decodeCursor(q.cursor);pageWhere+=` and (completed_at,request_id)<(${bind(at)}::timestamptz,${bind(id)}::text)`;}
  // pi-lens-ignore: no-sql-in-code, sql-injection — 列名与片段来自静态映射，所有值均为绑定参数。
  const result=await client.query(`select *,completed_at::text as cursor_time from call_logs where ${pageWhere} order by completed_at desc,request_id desc limit ${bind(q.limit!+1)}`,values);
  const page=result.rows.slice(0,q.limit),last=page.at(-1);
  return {items:page.map(map),nextCursor:result.rows.length>page.length&&last?encodeCursor(last.cursor_time,last.request_id):null,summary,collectedAt:new Date().toISOString()};
}

/**
 * Reason distribution. Both statements run inside the caller's read-only
 * transaction, and both use `whereClause`, so `errors` here equals
 * `CallSummary.errors` for the same window and every bucket is drillable with
 * `callErrorFilter` without the drill-down disagreeing about the row set.
 */
export async function queryPostgresCallErrors(client:PoolClient,input:CallErrorQuery,scope:CallScope):Promise<CallErrorBreakdown>{
  const q=normalizeCallErrorQuery(input),values:unknown[]=[];
  const bind=(value:unknown)=>{values.push(value);return `$${values.length}`;};
  const where=whereClause(q,scope,bind);
  // pi-lens-ignore: no-sql-in-code, sql-injection — 窗口与筛选条件均为绑定参数，错误码按值比较而非拼接。
  const totals=(await client.query(`select count(*) as ended,
      count(*) filter(where outcome not in ('completed','client_cancelled')) as errors,
      count(*) filter(where outcome='client_cancelled') as cancelled,
      count(*) filter(where outcome not in ('completed','client_cancelled') and coalesce(error_code,'')='') as "unknownCode"
    from call_logs where ${where}`,values)).rows[0];
  // pi-lens-ignore: no-sql-in-code, sql-injection — 分组列与排序均为静态列名，limit 为绑定参数。
  const rows=(await client.query(`select admission->'route'->>'serviceId' as service_id,model_id,outcome,nullif(error_code,'') as error_code,
      count(*) as calls,count(*) over() as bucket_count
    from call_logs where ${where} and outcome<>'completed'
    group by 1,2,3,4
    order by (outcome not in ('completed','client_cancelled')) desc,calls desc,1 nulls last,2,3,4
    limit ${bind(q.limit!)}`,values)).rows;
  return {
    from:q.from??null,to:q.to??null,collectedAt:new Date().toISOString(),
    ended:Number(totals.ended),errors:Number(totals.errors),cancelled:Number(totals.cancelled),unknownCode:Number(totals.unknownCode),
    bucketCount:rows.length?Number(rows[0].bucket_count):0,
    buckets:rows.map(row=>({serviceId:row.service_id??null,modelId:String(row.model_id),outcome:row.outcome,errorCode:row.error_code??null,
      group:row.outcome==='client_cancelled'?'cancelled' as const:'error' as const,calls:Number(row.calls)})),
  };
}

/** Memory stores reuse the shared aggregation so both stores cannot drift. */
export function queryMemoryCallErrors(rows:CallLog[],input:CallErrorQuery,scope:CallScope){return aggregateCallErrors(rows,input,scope);}
