import {BadRequestException} from '@nestjs/common';
import type {AuthorizeRequest,RoutingSimulation,RoutingSimulationInput,WorkspaceState} from '@ai-gateway/contracts';
import type {DemoStore} from '../store/demo.store';
import {poolSimulationOptions} from '../store/admission';
import {rankRoutes,recordRoutingOutcome} from '../store/pool-routing';
import {poolRouting} from './model-configuration';
import {pick} from './validation';
import {randomUUID} from 'node:crypto';

export async function simulatePoolRouting(source:WorkspaceState,store:DemoStore,poolId:string,input:RoutingSimulationInput):Promise<RoutingSimulation>{
  if(!input||typeof input.modelId!=='string')throw new BadRequestException('modelId required');
  const state=structuredClone(source),pool=pick(state.pools,poolId,'pool');
  const definition=state.definitions.find(item=>item.modelId===input.modelId);
  if(!definition||!pool.entries.some(entry=>entry.definitionId===definition.id))throw new BadRequestException('model is outside this pool');
  if(input.routing!==undefined)pool.routing=poolRouting(input.routing);
  if(input.entries!==undefined){
    if(!Array.isArray(input.entries)||input.entries.length>pool.entries.length)throw new BadRequestException('invalid routing entries');
    const seen=new Set<string>();
    for(const draft of input.entries){
      if(!draft||seen.has(draft.serviceId)||!Number.isInteger(draft.weight)||draft.weight<1||draft.weight>1000||!Number.isInteger(draft.priority)||draft.priority<0||draft.priority>100)throw new BadRequestException('invalid routing weight or priority');
      seen.add(draft.serviceId);
      const entry=pool.entries.find(item=>item.serviceId===draft.serviceId&&item.definitionId===definition.id);
      if(!entry)throw new BadRequestException('service is outside this pool model');
      entry.weight=draft.weight;entry.priority=draft.priority;
    }
  }
  for(const field of ['estimatedInputTokens','maxOutputTokens','estimatedUnits'] as const){
    const value=input[field];
    if(value!==undefined&&(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1e9||field!=='estimatedUnits'&&!Number.isSafeInteger(value)))throw new BadRequestException(`invalid ${field}`);
  }
  const requestId=input.requestId??`simulation-${randomUUID()}`;
  if(typeof requestId!=='string'||requestId.length<1||requestId.length>160)throw new BadRequestException('invalid requestId');
  const request:AuthorizeRequest={
    requestId,idempotencyKey:requestId,identity:{credentialId:'simulation',subjectType:'application',subjectId:'simulation',organizationId:state.tenantId,projectId:null},
    purpose:'application',modelId:input.modelId,mode:definition.kind??'chat',
    estimatedInputTokens:input.estimatedInputTokens??0,maxOutputTokens:input.maxOutputTokens,estimatedUnits:input.estimatedUnits,policyVersion:'simulation',
  };
  const options=poolSimulationOptions(state,request,poolId);
  const scopes=[...new Set(options.flatMap(option=>option.admission?.scopes.map(scope=>scope.id)??[]))];
  const [counters,observations]=await Promise.all([store.capacityCounters(scopes),store.routeObservations([...new Set(pool.entries.map(entry=>entry.serviceId))])]);
  const ranked=rankRoutes(options,state,counters.rows.map(({scopeId,...row})=>({id:scopeId,...row})),observations,requestId,Date.parse(counters.collectedAt));
  let selected:typeof options[number]|undefined;
  for(const option of ranked){
    const admission=option.admission;
    if(!admission)continue;
    const blocked=admission.scopes.filter(scope=>{
      const count=counters.rows.find(row=>row.scopeId===scope.id);
      return scope.rpm!==undefined&&(count?.requests??0)+1>scope.rpm||scope.tpm!==undefined&&(count?.tokens??0)+admission.estimatedTokens>scope.tpm||scope.concurrency!==undefined&&(count?.active??0)>=scope.concurrency;
    });
    if(blocked.length){recordRoutingOutcome(admission,'capacity',blocked.map(scope=>scope.id));continue;}
    selected=option;recordRoutingOutcome(admission,'selected');break;
  }
  const decision=selected?.admission?.routing??options.find(option=>option.admission)?.admission?.routing??{
    strategy:pool.routing?.strategy??'stable',candidateCount:options[0]?.exclusions?.length??0,
    sampledAt:counters.collectedAt,selectedServiceId:null,candidates:options[0]?.exclusions??[],
  };
  return {poolId,modelId:input.modelId,requestId,decision,scope:'pool_and_services',notice:'读取当前池、服务与共享容量快照，不创建预占、不发送上游请求。未检查用户、用途和资金授权。实际调用会重新准入。健康窗口最近十分钟，最多采样 10000 条。'};
}
