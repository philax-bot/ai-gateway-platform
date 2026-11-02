import { BadRequestException } from '@nestjs/common';
import type { CallLog, UsageAnalytics, UsageAnalyticsQuery, UsageBucket, UsageTotals } from '@ai-gateway/contracts';
import { callVisible, type CallScope } from './call-query';

const DAY = 24*60*60*1000;
const MAX_WINDOW_DAYS = 93;
const purposes = ['personal','project','application'];

export interface NormalizedUsageQuery { from:string; to:string; organizationId?:string; modelId?:string; purpose?:UsageAnalyticsQuery['purpose'] }

/**
 * The window is resolved here, not by the caller, so the page, the endpoint and
 * the tests agree on the same boundaries: `from` inclusive, `to` exclusive.
 */
export function normalizeUsageQuery(raw:UsageAnalyticsQuery|undefined,now=new Date(),timezone='Asia/Shanghai'):NormalizedUsageQuery{
  if(raw!==undefined&&(typeof raw!=='object'||raw===null||Array.isArray(raw)))throw new BadRequestException('invalid usage query');
  const input:UsageAnalyticsQuery=raw??{};
  for(const key of Object.keys(input))if(!['from','to','organizationId','modelId','purpose'].includes(key))throw new BadRequestException(`unknown usage query field ${key}`);
  const parse=(key:'from'|'to')=>{
    const value=input[key];if(value===undefined||value==='')return null;
    if(typeof value!=='string'||value.length>64||!/^\d{4}-\d\d-\d\dT/.test(value)||!Number.isFinite(Date.parse(value)))throw new BadRequestException(`invalid ${key}`);
    return new Date(value).toISOString();
  };
  const to=parse('to')??now.toISOString(),from=parse('from')??monthStart(to,timezone);
  if(from>=to)throw new BadRequestException('from must be before to');
  if(Date.parse(to)-Date.parse(from)>MAX_WINDOW_DAYS*DAY)throw new BadRequestException(`window must be ${MAX_WINDOW_DAYS} days or less`);
  const text=(key:'organizationId'|'modelId')=>{
    const value=input[key];if(value===undefined||value==='')return undefined;
    if(typeof value!=='string'||value.length>160)throw new BadRequestException(`invalid ${key}`);
    return value;
  };
  const rawPurpose:unknown=(input as Record<string,unknown>).purpose;
  if(rawPurpose!==undefined&&rawPurpose!==''&&(typeof rawPurpose!=='string'||!purposes.includes(rawPurpose)))throw new BadRequestException('invalid purpose');
  return {from,to,organizationId:text('organizationId'),modelId:text('modelId'),purpose:(rawPurpose as UsageAnalyticsQuery['purpose'])||undefined};
}

function zoneOffset(instant:number,timezone:string){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,hour12:false,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).formatToParts(new Date(instant));
  const get=(type:string)=>Number(parts.find(part=>part.type===type)?.value??0);
  return Date.UTC(get('year'),get('month')-1,get('day'),get('hour')%24,get('minute'),get('second'))-instant;
}

/** The instant the workspace month containing `iso` began. */
export function monthStart(iso:string,timezone:string){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit'}).formatToParts(new Date(iso));
  const year=Number(parts.find(part=>part.type==='year')?.value),month=Number(parts.find(part=>part.type==='month')?.value);
  const guess=Date.UTC(year,month-1,1);
  return new Date(guess-zoneOffset(guess-zoneOffset(guess,timezone),timezone)).toISOString();
}

/** YYYY-MM-DD in the workspace time zone, so a "day" matches the page's own clock. */
export function dayKey(iso:string,timezone:string):string{
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(iso));
  const get=(type:string)=>parts.find(part=>part.type===type)?.value??'';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

type Acc = Omit<UsageBucket,'key'|'lastActiveAt'> & {lastActiveAt:string|null};
const empty=():Acc=>({requests:0,unknownUsage:0,inputTokens:0,outputTokens:0,cachedInputTokens:0,confirmedAmount:0,pendingReview:0,pendingAmount:0,errors:0,forwarded:0,upstreamFailures:0,lastActiveAt:null});

function add(acc:Acc,call:CallLog){
  acc.requests++;
  if(call.usageFinal!==true)acc.unknownUsage++;
  else{acc.inputTokens+=call.inputTokens;acc.outputTokens+=call.outputTokens;acc.cachedInputTokens+=call.cachedInputTokens;}
  if(call.billableState==='confirmed')acc.confirmedAmount+=call.actualAmount;
  if(call.billableState==='pending_review'){acc.pendingReview++;acc.pendingAmount+=call.actualAmount;}
  if(call.outcome!=='completed'&&call.outcome!=='client_cancelled')acc.errors++;
  if(call.forwarded===true){acc.forwarded++;if(call.outcome==='upstream_error')acc.upstreamFailures++;}
  if(!acc.lastActiveAt||call.completedAt>acc.lastActiveAt)acc.lastActiveAt=call.completedAt;
}

const round=(value:number)=>Number(value.toFixed(6));
const bucket=(key:string,acc:Acc):UsageBucket=>({key,...acc,confirmedAmount:round(acc.confirmedAmount),pendingAmount:round(acc.pendingAmount)});
const byMoney=(a:UsageBucket,b:UsageBucket)=>b.confirmedAmount-a.confirmedAmount||b.requests-a.requests||a.key.localeCompare(b.key);

/**
 * Memory implementation used by the demo store and by tests. It mirrors the SQL
 * aggregation in `postgres-call-analytics.ts` field by field.
 */
export function aggregateUsage(rows:CallLog[],input:UsageAnalyticsQuery|undefined,scope:CallScope,timezone:string):UsageAnalytics{
  const query=normalizeUsageQuery(input,new Date(),timezone),from=Date.parse(query.from),to=Date.parse(query.to);
  const totals:Acc=empty(),groups={people:new Map<string,Acc>(),applications:new Map<string,Acc>(),projects:new Map<string,Acc>(),models:new Map<string,Acc>(),organizations:new Map<string,Acc>(),days:new Map<string,Acc>()};
  const push=(map:Map<string,Acc>,key:string,call:CallLog)=>{const acc=map.get(key)??empty();add(acc,call);map.set(key,acc);};
  for(const call of rows){
    const organizationId=call.admission?.attributionOrganizationId??call.organizationId;
    const at=Date.parse(call.completedAt);
    if(!Number.isFinite(at)||at<from||at>=to)continue;
    if(!callVisible(call,scope))continue;
    if(query.modelId&&call.modelId!==query.modelId)continue;
    if(query.organizationId&&organizationId!==query.organizationId)continue;
    if(query.purpose&&call.purpose!==query.purpose)continue;
    add(totals,call);
    push(call.subjectType==='employee'?groups.people:groups.applications,call.subjectId,call);
    push(groups.projects,call.projectId??'',call);
    push(groups.models,call.modelId,call);
    push(groups.organizations,organizationId??'',call);
    push(groups.days,dayKey(call.completedAt,timezone),call);
  }
  const {key:_unusedKey,...totalsFields}=bucket('',totals);
  const totalsRow:UsageTotals={...totalsFields,activePeople:groups.people.size,activeApplications:groups.applications.size};
  return {
    from:query.from,to:query.to,timezone,totals:totalsRow,
    people:[...groups.people].map(([key,acc])=>bucket(key,acc)).sort(byMoney),
    applications:[...groups.applications].map(([key,acc])=>bucket(key,acc)).sort(byMoney),
    projects:[...groups.projects].map(([key,acc])=>bucket(key,acc)).sort(byMoney),
    models:[...groups.models].map(([key,acc])=>bucket(key,acc)).sort(byMoney),
    organizations:[...groups.organizations].map(([key,acc])=>bucket(key,acc)).sort(byMoney),
    days:[...groups.days].map(([key,acc])=>bucket(key,acc)).sort((a,b)=>a.key.localeCompare(b.key)),
    collectedAt:new Date().toISOString(),
  };
}
