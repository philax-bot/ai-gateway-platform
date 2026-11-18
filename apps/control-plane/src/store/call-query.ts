import { BadRequestException } from '@nestjs/common';
import type { CallErrorBreakdown, CallErrorBucket, CallErrorQuery, CallFilters, CallLog, CallPage, CallQuery, CallSummary } from '@ai-gateway/contracts';

// Scope is supplied by the authenticated service, never accepted from the request body.
/* `projectIds` only exists for the analytics scope: a project manager sees
   project-purpose calls inside the projects they manage, plus their own usage. */
export type CallScope = { employeeId:string; applicationIds:string[]; projectIds?:string[] } | null;
export const filterColumns:Record<keyof CallFilters,string>={
  from:'completed_at',to:'completed_at',requestId:'request_id',subjectId:'subject_id',subjectType:'subject_type',
  organizationId:"coalesce(admission->>'attributionOrganizationId',organization_id)",resultGroup:'outcome',credentialId:'credential_id',
  projectId:'project_id',modelId:'model_id',serviceId:"admission->'route'->>'serviceId'",poolId:"admission->'route'->>'poolId'",
  purpose:'purpose',outcome:'outcome',billableState:'billable_state',
  errorCode:'error_code',errorCodeMissing:'error_code',serviceMissing:"admission->'route'->>'serviceId'",
};
const outcomes=['completed','upstream_error','timeout','client_cancelled','partial','rejected_before_upstream'];
export function normalizeCallQuery(raw:CallQuery):CallQuery{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new BadRequestException('invalid call query');
  const q:Record<string,unknown>={limit:raw.limit??50};
  if(!Number.isInteger(q.limit)||Number(q.limit)<1||Number(q.limit)>200)throw new BadRequestException('page size must be between 1 and 200');
  for(const key of Object.keys(filterColumns) as (keyof CallFilters)[]){const value=raw[key];if(value===undefined||value==='')continue;
    if(typeof value!=='string'||value.length>160)throw new BadRequestException(`invalid ${key}`);
    if(key==='from'||key==='to'){if(!/^\d{4}-\d\d-\d\dT/.test(value)||!Number.isFinite(Date.parse(value)))throw new BadRequestException(`invalid ${key}`);q[key]=new Date(value).toISOString();}
    else q[key]=value;
  }
  if(q.from&&q.to&&String(q.from)>=String(q.to))throw new BadRequestException('from must be before to');
  if(q.purpose&&!['personal','project','application'].includes(String(q.purpose)))throw new BadRequestException('invalid purpose');
  if(q.outcome&&!outcomes.includes(String(q.outcome)))throw new BadRequestException('invalid outcome');
  if(q.subjectType&&!['employee','application'].includes(String(q.subjectType)))throw new BadRequestException('invalid subject type');
  if(q.resultGroup&&q.resultGroup!=='errors')throw new BadRequestException('invalid result group');
  for(const flag of ['errorCodeMissing','serviceMissing'] as const)if(q[flag]!==undefined&&q[flag]!=='true')throw new BadRequestException(`invalid ${flag}`);
  if(q.errorCodeMissing&&q.errorCode)throw new BadRequestException('errorCode and errorCodeMissing are exclusive');
  if(q.billableState&&!['confirmed','pending_review','not_billable'].includes(String(q.billableState)))throw new BadRequestException('invalid billing state');
  if(raw.cursor!==undefined){decodeCursor(raw.cursor);q.cursor=raw.cursor;}
  return q as CallQuery;
}
export function encodeCursor(at:string,id:string){return Buffer.from(JSON.stringify([at,id])).toString('base64url');}
export function decodeCursor(value:string):[string,string]{
  try{if(typeof value!=='string'||value.length>512)throw 0;const v=JSON.parse(Buffer.from(value,'base64url').toString());if(!Array.isArray(v)||v.length!==2||!v.every(x=>typeof x==='string')||!Number.isFinite(Date.parse(v[0]))||v[1].length>160)throw 0;return [v[0],v[1]];}catch{throw new BadRequestException('invalid page cursor');}
}
export function callVisible(c:CallLog,scope:CallScope):boolean{
  if(!scope)return true;
  if(c.subjectType==='employee'&&c.subjectId===scope.employeeId)return true;
  if(c.subjectType==='application'&&scope.applicationIds.includes(c.subjectId))return true;
  return !!scope.projectIds?.length&&c.purpose==='project'&&!!c.projectId&&scope.projectIds.includes(c.projectId);
}
export function matchesCall(c:CallLog,q:CallFilters,scope:CallScope){
  if(!callVisible(c,scope))return false;
  for(const [key,value] of Object.entries(q)){if(value===undefined||!Object.hasOwn(filterColumns,key))continue;
    if(key==='from'){if(Date.parse(c.completedAt)<Date.parse(value))return false;}
    else if(key==='to'){if(Date.parse(c.completedAt)>=Date.parse(value))return false;}
    else if(key==='resultGroup'){if(['completed','client_cancelled'].includes(c.outcome))return false;}
    else if(key==='organizationId'){if((c.admission?.attributionOrganizationId??c.organizationId)!==value)return false;}
    else if(key==='serviceId'||key==='poolId'){if(c.admission?.route?.[key]!==value)return false;}
    else if(key==='errorCode'){if((c.errorCode??'')!==value)return false;}
    else if(key==='errorCodeMissing'){if(c.errorCode)return false;}
    else if(key==='serviceMissing'){if(c.admission?.route?.serviceId!=null)return false;}
    else if(c[key as keyof CallLog]!==value)return false;
  }return true;
}
/**
 * One SQL predicate builder for every call read path. The distribution and its
 * drill-down list must never be able to disagree about which rows they count,
 * so both are built from this function and the same bind order.
 */
export function callConditions(q:CallFilters,bind:(value:unknown)=>string):string[]{
  const conditions:string[]=[];
  for(const key of Object.keys(filterColumns) as (keyof CallFilters)[]){const value=q[key];if(value===undefined)continue;
    if(key==='resultGroup'){conditions.push("outcome not in ('completed','client_cancelled')");continue;}
    if(key==='errorCodeMissing'){conditions.push("coalesce(error_code,'')=''");continue;}
    if(key==='serviceMissing'){conditions.push("(admission->'route'->>'serviceId') is null");continue;}
    if(key==='errorCode'){conditions.push(`coalesce(error_code,'')=${bind(value)}`);continue;}
    conditions.push(`${filterColumns[key]}${key==='from'?'>=':key==='to'?'<':'='}${bind(value)}`);
  }
  return conditions;
}
export function summarizeCalls(rows:CallLog[]):CallSummary{
  const known=rows.filter(c=>c.usageFinal===true),forwarded=rows.filter(c=>c.forwarded===true);
  const latencies=forwarded.flatMap(c=>c.latencyMs==null?[]:[c.latencyMs]).sort((a,b)=>a-b),ttfts=forwarded.flatMap(c=>c.ttftMs==null?[]:[c.ttftMs]).sort((a,b)=>a-b);
  const p95=(values:number[])=>values.length?values[Math.ceil(values.length*0.95)-1]:null;
  return {
    ended:rows.length,forwarded:forwarded.length,unknownForwarding:rows.filter(c=>c.forwarded==null).length,
    errors:rows.filter(c=>!['completed','client_cancelled'].includes(c.outcome)).length,
    upstreamFailures:forwarded.filter(c=>c.outcome==='upstream_error').length,
    cancelled:rows.filter(c=>c.outcome==='client_cancelled').length,timeouts:rows.filter(c=>c.outcome==='timeout').length,
    partial:rows.filter(c=>c.outcome==='partial').length,rejected:rows.filter(c=>c.outcome==='rejected_before_upstream').length,
    pendingReview:rows.filter(c=>c.billableState==='pending_review').length,knownUsage:known.length,unknownUsage:rows.length-known.length,
    inputTokens:known.reduce((s,c)=>s+c.inputTokens,0),outputTokens:known.reduce((s,c)=>s+c.outputTokens,0),cachedInputTokens:known.reduce((s,c)=>s+c.cachedInputTokens,0),
    confirmedAmount:Number(rows.filter(c=>c.billableState==='confirmed').reduce((s,c)=>s+c.actualAmount,0).toFixed(6)),
    activeUsers:new Set(rows.filter(c=>c.subjectType==='employee').map(c=>c.subjectId)).size,
    activeApplications:new Set(rows.filter(c=>c.subjectType==='application').map(c=>c.subjectId)).size,
    activeProjects:new Set(rows.map(c=>c.projectId).filter(Boolean)).size,
    rateLimited:rows.filter(c=>c.errorCode==='rate_limited').length,
    latencySamples:latencies.length,averageLatencyMs:latencies.length?latencies.reduce((s,n)=>s+n,0)/latencies.length:null,p95LatencyMs:p95(latencies),
    ttftSamples:ttfts.length,p95TtftMs:p95(ttfts),
  };
}
export function queryMemoryCalls(rows:CallLog[],input:CallQuery,scope:CallScope):CallPage{
  const q=normalizeCallQuery(input),all=rows.filter(c=>matchesCall(c,q,scope)).sort((a,b)=>Date.parse(b.completedAt)-Date.parse(a.completedAt)||(a.requestId===b.requestId?0:a.requestId<b.requestId?1:-1));
  const cursor=q.cursor?decodeCursor(q.cursor):null,after=cursor?all.filter(c=>Date.parse(c.completedAt)<Date.parse(cursor[0])||(Date.parse(c.completedAt)===Date.parse(cursor[0])&&c.requestId<cursor[1])):all;
  const items=after.slice(0,q.limit),last=items.at(-1);
  return {items:structuredClone(items),summary:summarizeCalls(all),nextCursor:after.length>items.length&&last?encodeCursor(last.completedAt,last.requestId):null,collectedAt:new Date().toISOString()};
}
/** A breakdown query never paginates; `limit` only bounds how many groups are returned. */
export function normalizeCallErrorQuery(raw:CallErrorQuery):CallErrorQuery{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new BadRequestException('invalid error breakdown query');
  const {limit,cursor,...filters}=raw as CallErrorQuery&{cursor?:string};void cursor;void limit;
  const q=normalizeCallQuery({...filters,limit:50}) as CallErrorQuery&{cursor?:string};
  delete q.cursor;
  const size=Number.isInteger(limit)?limit!:50;
  if(size<1||size>200)throw new BadRequestException('bucket limit must be between 1 and 200');
  return {...q,limit:size};
}
/** Same predicates as `summarizeCalls`; only error and cancelled rows are grouped. */
export function aggregateCallErrors(rows:CallLog[],input:CallErrorQuery,scope:CallScope):CallErrorBreakdown{
  const q=normalizeCallErrorQuery(input),matched=rows.filter(c=>matchesCall(c,q,scope));
  const isError=(c:CallLog)=>!['completed','client_cancelled'].includes(c.outcome);
  const errors=matched.filter(isError),cancelled=matched.filter(c=>c.outcome==='client_cancelled');
  const groups=new Map<string,CallErrorBucket>();
  for(const c of [...errors,...cancelled]){
    const serviceId=c.admission?.route?.serviceId??null,errorCode=c.errorCode||null;
    const key=JSON.stringify([serviceId,c.modelId,c.outcome,errorCode]);
    const current=groups.get(key);
    if(current)current.calls++;
    else groups.set(key,{serviceId,modelId:c.modelId,outcome:c.outcome,errorCode,group:isError(c)?'error':'cancelled',calls:1});
  }
  const buckets=[...groups.values()].sort((a,b)=>Number(b.group==='error')-Number(a.group==='error')||b.calls-a.calls
    ||(a.serviceId??'').localeCompare(b.serviceId??'')||a.modelId.localeCompare(b.modelId)||a.outcome.localeCompare(b.outcome)||(a.errorCode??'').localeCompare(b.errorCode??''));
  return {from:q.from??null,to:q.to??null,collectedAt:new Date().toISOString(),ended:matched.length,errors:errors.length,cancelled:cancelled.length,unknownCode:errors.filter(c=>!c.errorCode).length,bucketCount:buckets.length,buckets:buckets.slice(0,q.limit)};
}
