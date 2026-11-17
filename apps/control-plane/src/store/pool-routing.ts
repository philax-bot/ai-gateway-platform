import {createHash} from 'node:crypto';
import type {AdmissionSnapshot,CallLog,WorkspaceState,RoutingCandidate} from '@ai-gateway/contracts';
export interface RouteCounter {id:string;requests:number;tokens:number;active:number}
export interface RouteObservation {serviceId:string;definitionId:string;failures:number;recent:number;failedAt:number;latency:number|null;samples:number}
export function memoryRouteObservations(calls:CallLog[],now=Date.now(),serviceIds?:string[]):RouteObservation[]{
  const recent=calls.filter(call=>{
    const route=call.admission?.route;
    return !!route&&(!serviceIds||serviceIds.includes(route.serviceId))&&call.forwarded===true&&Date.parse(call.completedAt)>now-600000&&['completed','upstream_error','timeout','partial'].includes(call.outcome);
  }).sort((a,b)=>b.completedAt.localeCompare(a.completedAt)).slice(0,10000);
  const groups=new Map<string,CallLog[]>();
  for(const call of recent){
    const route=call.admission!.route!,key=JSON.stringify([route.serviceId,route.definitionId]);
    const group=groups.get(key);if(group)group.push(call);else groups.set(key,[call]);
  }
  return [...groups.values()].map(rows=>{
    const route=rows[0].admission!.route!;
    const latencies=rows.filter(row=>row.outcome==='completed'&&row.latencyMs!==null&&row.latencyMs!==undefined).map(row=>row.ttftMs??row.latencyMs!);
    let failures=0;for(const row of rows){if(row.outcome==='completed')break;failures++;}
    return {serviceId:route.serviceId,definitionId:route.definitionId,failures,recent:rows.length,failedAt:Date.parse(rows[0].completedAt),latency:latencies.length?latencies.reduce((sum,value)=>sum+value,0)/latencies.length:null,samples:latencies.length};
  });
}
/** Ranking and explanation share the exact sampled counters used before reservation. */
export function rankRoutes<T extends {admission?:AdmissionSnapshot}>(choices:T[],state:Pick<WorkspaceState,'pools'>,counts:RouteCounter[],observations:RouteObservation[],requestId:string,now=Date.now()):T[]{
  const counters=new Map(counts.map(row=>[row.id,row]));
  const candidatePairs=new Set(choices.flatMap(choice=>choice.admission?.route?[JSON.stringify([choice.admission.route.serviceId,choice.admission.route.definitionId])]:[]));
  const latencies=observations.filter(row=>candidatePairs.has(JSON.stringify([row.serviceId,row.definitionId]))&&row.samples>=3&&row.latency!==null).map(row=>row.latency!).sort((a,b)=>a-b);
  const cold=latencies[Math.floor(latencies.length/2)]??0;
  const excluded=new Map<string,RoutingCandidate>();
  for(const choice of choices)for(const row of choice.admission?.routing?.candidates??[]){
    if(row.status==='excluded')excluded.set(`${row.serviceId}:${row.definitionId}`,structuredClone(row));
  }
  const candidates:RoutingCandidate[]=[...excluded.values()];
  const ranked=choices.flatMap<{choice:T;index:number;score:number;tie:number;priority:number;row:RoutingCandidate|null}>((choice,index)=>{
    const admission=choice.admission,route=admission?.route;
    if(!admission||!route)return [{choice,index,score:0,tie:0,priority:0,row:null}];
    const pool=state.pools.find(item=>item.id===route.poolId),policy=pool?.routing;
    const strategy=policy?.strategy??'stable';
    const entry=pool?.entries.find(item=>item.serviceId===route.serviceId&&item.definitionId===route.definitionId);
    const observation=observations.find(item=>item.serviceId===route.serviceId&&item.definitionId===route.definitionId);
    const weight=entry?.weight??1;
    const hash=parseInt(createHash('sha256').update(`${requestId}:${route.serviceId}`).digest('hex').slice(0,12),16);
    const tie=strategy==='stable'?index:-Math.log((hash+1)/(0xffffffffffff+2))/weight;
    const scopes=admission.scopes.map(scope=>({...scope,...(counters.get(scope.id)??{requests:0,tokens:0,active:0})}));
    const local=scopes.filter(scope=>/(^|:)(service|service-model|shared):/.test(scope.id));
    let score=0;
    if(strategy==='least_busy')score=Math.max(0,...local.map(scope=>scope.active))/weight;
    if(strategy==='usage')score=Math.max(0,...local.flatMap(scope=>[scope.rpm?scope.requests/scope.rpm:0,scope.tpm?scope.tokens/scope.tpm:0,scope.concurrency?scope.active/scope.concurrency:0]));
    if(strategy==='latency')score=observation&&observation.samples>=3?observation.latency??cold:cold;
    const cooldown=!!policy?.failureThreshold&&!!observation&&observation.failures>=policy.failureThreshold&&now-observation.failedAt<policy.cooldownSeconds*1000;
    const row:RoutingCandidate={
      id:`candidate-${index}`,serviceId:route.serviceId,definitionId:route.definitionId,
      serviceName:route.audit?.serviceName??route.serviceId,configVersion:route.audit?.configVersion??null,
      weight,priority:entry?.priority??0,rank:null,score,tie,status:cooldown?'cooldown':'eligible',
      reason:cooldown?'consecutive_upstream_failures':null,blockedScopes:[],scopes,
      latencyMs:observation?.latency??null,latencySamples:observation?.samples??0,
      cooldownUntil:cooldown?new Date(observation!.failedAt+policy!.cooldownSeconds*1000).toISOString():null,
    };
    candidates.push(row);
    admission.routing={strategy,candidateCount:0,sampledAt:new Date(now).toISOString(),
      policyVersion:createHash('sha256').update(JSON.stringify([pool,route.definitionId])).digest('hex').slice(0,24),
      candidateId:row.id,selectedServiceId:null,candidates};
    return cooldown?[]:[{choice,index,score,tie,priority:strategy==='priority'?entry?.priority??0:0,row}];
  });
  ranked.sort((a,b)=>a.priority-b.priority||a.score-b.score||a.tie-b.tie||a.index-b.index);
  ranked.forEach((item,index)=>{if(item.row)item.row.rank=index+1;});
  const count=new Set(candidates.map(row=>row.serviceId)).size;
  for(const choice of choices)if(choice.admission?.routing)choice.admission.routing.candidateCount=count;
  return ranked.map(item=>item.choice);
}

export function recordRoutingOutcome(admission:AdmissionSnapshot,status:'capacity'|'quota_insufficient'|'selected',blockedScopes:string[]=[]):void {
  const decision=admission.routing;
  const row=decision?.candidates?.find(item=>item.id===decision.candidateId);
  if(!decision||!row)return;
  row.status=status;row.blockedScopes=blockedScopes;
  row.reason=status==='selected'?'best_available_rank':status==='capacity'?'admission_limit_reached':'batch_cannot_fund_reservation';
  if(status==='selected'){
    decision.selectedServiceId=row.serviceId;
    for(const candidate of decision.candidates??[])if(candidate.status==='eligible'){
      candidate.status='not_selected';candidate.reason='lower_rank';
    }
  }
}
