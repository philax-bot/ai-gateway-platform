import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AdmissionScope, AdmissionSnapshot, AuthorizeRequest, PriceSnapshot, ReasonCode, RoutingCandidate, RequestLimitDiagnostic, UsageLimits } from '@ai-gateway/contracts';
import { businessDenial } from '../platform/domain';
import type {AdmissionWorkspace} from './admission-policy-lock';
import {effectiveUsageLimits,modelProviders} from '@ai-gateway/contracts';

export const LEGACY_RESERVATION_AMOUNT=0.02;
/** Initial reservation only; never used as a generation limit. Models may override it. */
export const DEFAULT_ESTIMATED_OUTPUT_TOKENS=16384;
export const legacyAdmission=():AdmissionSnapshot=>({kind:'legacy_simulation',route:null,price:null,reservedAmount:LEGACY_RESERVATION_AMOUNT,estimatedTokens:0,scopes:[]});
export function publicLogAdmission(admission:AdmissionSnapshot|null|undefined){
  if(!admission)return null;
  const route=admission.route;
  return {routing:admission.routing,meterEstimate:admission.meterEstimate,...(admission.costPrice!==undefined?{costPrice:admission.costPrice}:{}),...(admission.attributionOrganizationId?{attributionOrganizationId:admission.attributionOrganizationId}:{}),...(admission.protocol?{protocol:admission.protocol}:{}),kind:admission.kind,price:admission.price,reservedAmount:admission.reservedAmount,route:route?{serviceId:route.serviceId,poolId:route.poolId,definitionId:route.definitionId,credential:route.credential,upstreamModel:route.upstreamModel,kind:route.kind,...(route.audit?{audit:route.audit}:{})}:null};
}
export interface BatchScope {entitlementId?:string|null;projectId:string|null;purpose:string;sourceId:string}
type AdmissionResult=({admission:AdmissionSnapshot;reason?:never;requestLimits?:never}|{admission?:never;reason:ReasonCode;requestLimits?:RequestLimitDiagnostic})&{exclusions?:RoutingCandidate[]};
export function admissionDenialMessage(reason:ReasonCode,limits?:RequestLimitDiagnostic):string {
  if(reason==='request_limit_exceeded'&&limits){
    const sources=limits.limitSources.filter(cap=>cap.maxOutputTokens===limits.allowedOutputTokens).map(cap=>cap.source).join(', ');
    return `requested output ${limits.requestedOutputTokens??'default'} exceeds allowed ${limits.allowedOutputTokens} tokens (${sources}); estimated input ${limits.estimatedInputTokens}, model context ${limits.modelContextTokens}`;
  }
  const messages:Partial<Record<ReasonCode,string>>={
    no_quota:'no unexpired quota batch applies to this purpose and model',
    quota_insufficient:'no single eligible quota batch can fund this request reservation',
    price_unconfigured:'input, output and cached-input prices must be explicitly configured',
    service_unavailable:'the selected model has no active verified service route',
    model_not_open:'the model is not open for the current entitlement and purpose',
    policy_stale:'the requested price version is outdated; obtain a new quote',
    subject_disabled:'the subject, credential or entitlement is inactive or expired',
    request_limit_exceeded:'the request exceeds the applicable output or model context limit',
  };
  return messages[reason]??'the request is denied by the current policy';
}
function priceUnits(price:number):bigint {
  if(!Number.isFinite(price)||price<0||price>1e9||Math.abs(price*1e6-Math.round(price*1e6))>0.001)throw new BadRequestException('prices support up to six decimals per million tokens');
  return BigInt(Math.round(price*1e6));
}
/** Round once, upwards, at the complete request amount in micro-CNY. */
export function costForUsage(price:PriceSnapshot,inputTokens:number,outputTokens:number,cachedInputTokens=0,metered?:import('@ai-gateway/contracts').MeteredUsage):number {
  if(price.meter){
    const m=price.meter,q=metered?.quantity;
    if(!metered||metered.unit!==m.unit||typeof q!=='number'||!Number.isFinite(q)||q<0||q>1e9||Math.abs(q*1e6-Math.round(q*1e6))>0.001)throw new BadRequestException('complete metered usage is required');
    const denominator=1000000000000n*(m.unit==='per_1000_characters'?1000n:1n);
    const numerator=BigInt(Math.round(q*1e6))*priceUnits(m.price)*priceUnits(m.multiplier);
    const micros=(numerator+denominator-1n)/denominator;if(micros>BigInt(Number.MAX_SAFE_INTEGER))throw new BadRequestException('metered price exceeds supported money precision');
    return Number(micros)/1e6;
  }
  if(![inputTokens,outputTokens,cachedInputTokens].every(n=>Number.isSafeInteger(n)&&n>=0)||cachedInputTokens>inputTokens)throw new BadRequestException('invalid upstream usage');
  const basis=price.billing?.base??price,multiplier=price.billing?.multiplier??1;
  const numerator=(BigInt(inputTokens-cachedInputTokens)*priceUnits(basis.inputPrice)+BigInt(outputTokens)*priceUnits(basis.outputPrice)+BigInt(cachedInputTokens)*priceUnits(basis.cachedInputPrice))*priceUnits(multiplier);
  const denominator=1000000000000n;
  const micros=(numerator+denominator-1n)/denominator;
  if(micros>BigInt(Number.MAX_SAFE_INTEGER))throw new BadRequestException('request price exceeds supported money precision');
  return Number(micros)/1e6;
}

function admissionForServiceBatch(state:AdmissionWorkspace|undefined,input:AuthorizeRequest,batch:BatchScope,managedQuote=false,serviceId?:string,simulationPoolId?:string):AdmissionResult {
  const key=state?.keys.find(k=>k.credentialId===input.identity.credentialId);
  if(!state||(!key&&!managedQuote))return {admission:legacyAdmission()};
  if(batch.sourceId!==input.identity.subjectId||batch.purpose!==input.purpose||batch.projectId!==(input.identity.projectId??null))return {reason:'model_not_open'};
  const denial=managedQuote?null:businessDenial(state,input);if(denial)return {reason:denial};
  let range;
  let purposeLimits:UsageLimits|undefined;
  let purposeScope='';
  if(simulationPoolId){range={poolId:simulationPoolId,mode:'follow' as const,definitionIds:[]};}
  else if(input.purpose==='personal'){
    if(key?.entitlementIds!==undefined&&(!batch.entitlementId||!key.entitlementIds.includes(batch.entitlementId)))return {reason:'model_not_open'};
    const entitlement=state.entitlements.find(e=>e.id===batch.entitlementId&&e.memberId===input.identity.subjectId&&e.status==='active'&&Date.parse(e.expiresAt)>Date.now());
    if(!entitlement)return {reason:'model_not_open'};range=entitlement.range;purposeLimits=entitlement.planSnapshot.limits;purposeScope=`entitlement:${entitlement.id}`;
  }else if(input.purpose==='project'){
    const project=state.projects.find(p=>p.id===input.identity.projectId&&p.status==='active'&&p.memberIds.includes(input.identity.subjectId));
    if(!project||batch.projectId!==project.id)return {reason:'model_not_open'};range=project.range;purposeLimits=project.limits;purposeScope=`project:${project.id}`;
  }else{
    const app=state.applications.find(a=>a.id===input.identity.subjectId&&a.active);
    if(!app||batch.sourceId!==app.id)return {reason:'model_not_open'};range=app.range;purposeLimits=app.limits;purposeScope=`application:${app.id}`;
  }
  const definition=state.definitions.find(d=>d.modelId===input.modelId&&d.active);
  const pool=state.pools.find(p=>p.id===range.poolId);
  const entry=pool?.entries.find(e=>e.definitionId===definition?.id&&(!serviceId||e.serviceId===serviceId)&&e.open&&(range.mode==='follow'||range.definitionIds.includes(e.definitionId)));
  const service=state.services.find(s=>s.id===entry?.serviceId&&s.active&&s.verification==='passed');
  const mapping=service?.mappings.find(m=>m.definitionId===definition?.id);
  if(!definition||!pool||!entry||!service||!mapping)return {reason:'service_unavailable'};
  const managed=service.credentialId?state.upstreamCredentials?.find(item=>item.id===service.credentialId):undefined;
  if(service.credentialId&&!managed?.active)return {reason:'service_unavailable'};
  const kind=definition.kind??'chat';if(kind!==input.mode)return {reason:'service_unavailable'};
  const provider=modelProviders(state.providers).find(p=>p.id===(service.providerId??'openai-compatible'));
  if(!provider?.active||!provider.kinds.includes(kind))return {reason:'service_unavailable'};
  if(!mapping.meter&&(['image','asr','tts','video'].includes(kind)||[mapping.inputPrice,mapping.outputPrice,mapping.cachedInputPrice].some(p=>typeof p!=='number'||!Number.isFinite(p)||p<0)))return {reason:'price_unconfigured'};
  let price:PriceSnapshot;
  try{
    (mapping.meter?[mapping.meter.price]:[mapping.inputPrice!,mapping.outputPrice!,mapping.cachedInputPrice!]).forEach(priceUnits);
    const multiplier=definition.billingMultiplier??1;
    if(!Number.isFinite(multiplier)||multiplier<0||multiplier>100)throw new Error('invalid multiplier');
    priceUnits(multiplier);
    const base={inputPrice:mapping.inputPrice??0,outputPrice:mapping.outputPrice??0,cachedInputPrice:mapping.cachedInputPrice??0};
    const versionBasis:unknown[]=[pool.id,definition.id,mapping.inputPrice,mapping.outputPrice,mapping.cachedInputPrice];
    if(multiplier!==1)versionBasis.push('multiplier-v1',multiplier);
    if(mapping.meter)versionBasis.push(mapping.meter.unit,mapping.meter.price);
    price={...(mapping.meter?{meter:{unit:mapping.meter.unit,price:mapping.meter.price,multiplier}}:{}),version:createHash('sha256').update(JSON.stringify(versionBasis)).digest('hex').slice(0,24),currency:'CNY',unit:mapping.meter?.unit??'per_million_tokens',inputPrice:base.inputPrice*multiplier,outputPrice:base.outputPrice*multiplier,cachedInputPrice:base.cachedInputPrice*multiplier,billing:{base,multiplier}};
  }catch{return {reason:'price_unconfigured'};}
  if(input.expectedPriceVersion&&input.expectedPriceVersion!==price.version)return {reason:'policy_stale'};
  const defaults=state.settings.limits;
  const scopes:AdmissionScope[]=[];
  const outputCaps:number[]=[];
  const limitSources:RequestLimitDiagnostic['limitSources']=[];
  const append=(id:string,value:UsageLimits|undefined)=>{
    const inherited=!value||value.mode==='inherit',effective=effectiveUsageLimits(value,defaults);
    if(effective.mode==='none'){scopes.push({id:`${state.tenantId}:${id}`});return;}
    scopes.push({id:`${state.tenantId}:${id}`,rpm:effective.rpm,tpm:effective.tpm,concurrency:effective.concurrency});
    if(effective.maxOutputTokens){
      outputCaps.push(effective.maxOutputTokens);
      const kind=id.split(':')[0],source:RequestLimitDiagnostic['limitSources'][number]['source']=inherited?'enterprise':kind==='service-model'?'service_model':kind==='shared'?'shared_capacity':kind as RequestLimitDiagnostic['limitSources'][number]['source'];
      if(!limitSources.some(cap=>cap.source===source&&cap.maxOutputTokens===effective.maxOutputTokens))limitSources.push({source,maxOutputTokens:effective.maxOutputTokens});
    }
  };
  if(!simulationPoolId){
    append(`subject:${input.identity.subjectType}:${input.identity.subjectId}`,state.members.find(m=>m.id===input.identity.subjectId)?.limits);
    append(purposeScope,purposeLimits);
  }
  append(`pool:${pool.id}`,pool.limits);
  append(`service:${service.id}`,service.limits);append(`service-model:${service.id}:${definition.id}`,mapping.limits);
  if(service.sharedCapacityId)append(`shared:${service.sharedCapacityId}`,undefined);
  const estimatedInputTokens=input.estimatedInputTokens??0;
  const contextInputTokens=kind==='embeddings'?(input.maxInputTokens??estimatedInputTokens):estimatedInputTokens;
  const outputLimit=Math.min(...outputCaps,definition.contextTokens-contextInputTokens);
  // Preserve an omitted provider option unless an administrator explicitly set a policy cap.
  // Context headroom constrains admission/estimation; it must not become a provider default.
  const maxOutputTokens=kind==='chat'?(input.maxOutputTokens??(outputCaps.length?outputLimit:undefined)):undefined;
  limitSources.push({source:'model_context',maxOutputTokens:Math.max(0,definition.contextTokens-contextInputTokens)});
  if(!Number.isSafeInteger(estimatedInputTokens)||estimatedInputTokens<0||(kind==='embeddings'?contextInputTokens>definition.contextTokens:outputLimit<1)||(maxOutputTokens!==undefined&&(!Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>outputLimit)))return {reason:'request_limit_exceeded',requestLimits:{estimatedInputTokens,requestedOutputTokens:input.maxOutputTokens??null,allowedOutputTokens:Math.max(0,outputLimit),modelContextTokens:definition.contextTokens,limitSources}};
  const outputTokens=kind==='chat'?Math.min(definition.estimatedOutputTokens??DEFAULT_ESTIMATED_OUTPUT_TOKENS,maxOutputTokens??outputLimit):0;
  const estimate:NonNullable<AdmissionSnapshot['estimate']>={inputTokens:estimatedInputTokens,outputTokens,outputSource:definition.estimatedOutputTokens===undefined?'default':'model'};
  const reservePrice={...price,inputPrice:Math.max(price.inputPrice,price.cachedInputPrice),billing:price.billing?{...price.billing,base:{...price.billing.base,inputPrice:Math.max(price.billing.base.inputPrice,price.billing.base.cachedInputPrice)}}:undefined};
  const estimatedUnits=mapping.meter?.unit==='per_request'?1:input.estimatedUnits??mapping.meter?.estimatedUnits;
  if(mapping.meter&&(typeof estimatedUnits!=='number'||!Number.isFinite(estimatedUnits)||estimatedUnits<0||estimatedUnits>mapping.meter.maxUnits))return {reason:'request_limit_exceeded'};
  const reservedAmount=costForUsage(reservePrice,estimatedInputTokens,outputTokens,0,mapping.meter?{unit:mapping.meter.unit,quantity:estimatedUnits!}:undefined);
  const requested=input.modelProtocol??'chat';if(!['chat','responses','messages'].includes(requested))throw new BadRequestException('unsupported model protocol');
  const native=requested==='chat'||service.protocolCapabilities?.configVersion===service.configVersion&&service.protocolCapabilities.mappings[definition.id]?.[requested]?.status==='supported';
  const attributionOrganizationId=input.identity.subjectType==='application'?state.applications.find(app=>app.id===input.identity.subjectId)?.organizationId:state.members.find(member=>member.id===input.identity.subjectId)?.organizationId;
  const costPrice=mapping.meter?mapping.meter.costPrice===undefined||mapping.meter.costPrice===null?null:{...price,billing:undefined,inputPrice:0,outputPrice:0,cachedInputPrice:0,meter:{unit:mapping.meter.unit,price:mapping.meter.costPrice,multiplier:1}}:mapping.costPrice?{...mapping.costPrice,version:createHash('sha256').update(JSON.stringify([service.id,definition.id,mapping.costPrice])).digest('hex').slice(0,24),currency:'CNY' as const,unit:'per_million_tokens' as const}:null;
  return {admission:{callbackChannelId:input.purpose==='application'?state.applications.find(app=>app.id===input.identity.subjectId)?.completionChannelId??null:null,...(mapping.meter?{meterEstimate:{unit:mapping.meter.unit,quantity:estimatedUnits!}}:{}),costPrice,estimate,attributionOrganizationId,...(input.modelProtocol?{protocol:{requested,upstream:native?requested:'chat',mode:native?'native' as const:'adapted' as const}}:{}),kind:'configured',route:{serviceId:service.id,poolId:pool.id,definitionId:definition.id,baseUrl:service.baseUrl,kind,adapter:provider.adapter,videoCancellation:service.videoCancellation,modalityPaths:service.modalityPaths,audit:{serviceName:service.name,poolName:pool.name,configVersion:service.configVersion,endpoint:new URL(service.baseUrl).origin+new URL(service.baseUrl).pathname},protocolPaths:service.protocolPaths,protocols:service.protocolCapabilities?.configVersion===service.configVersion?service.protocolCapabilities.mappings[definition.id]:undefined,upstreamModel:mapping.upstreamModel,credentialRef:service.credentialRef,...(managed?{credential:{id:managed.id,version:managed.currentVersion}}:{}),...(maxOutputTokens===undefined?{}:{maxOutputTokens})},price,reservedAmount,estimatedTokens:estimatedInputTokens+outputTokens,scopes}};
}

/** Stable per-request distribution; replay keeps its reserved route and does not consume another slot. */
export function admissionOptionsForBatch(state:AdmissionWorkspace|undefined,input:AuthorizeRequest,batch:BatchScope,managedQuote=false):AdmissionResult[]{
  const range=input.purpose==='personal'?state?.entitlements.find(e=>e.id===batch.entitlementId)?.range
    :input.purpose==='project'?state?.projects.find(p=>p.id===input.identity.projectId)?.range
    :state?.applications.find(a=>a.id===input.identity.subjectId)?.range;
  const definition=state?.definitions.find(d=>d.modelId===input.modelId);
  const serviceIds=[...new Set(state?.pools.find(p=>p.id===range?.poolId)?.entries.filter(e=>e.definitionId===definition?.id&&e.open).map(e=>e.serviceId)??[])];
  const rank=(id:string)=>createHash('sha256').update(`${input.requestId}:${id}`).digest('hex');
  serviceIds.sort((a,b)=>rank(a).localeCompare(rank(b)));
  if(!serviceIds.length)return [admissionForServiceBatch(state,input,batch,managedQuote)];
  const options=serviceIds.map(id=>admissionForServiceBatch(state,input,batch,managedQuote,id));
  const exclusions=routingExclusions(state,range?.poolId,definition?.id,serviceIds.map((id,index)=>({id,result:options[index]})));
  const allowed=options.filter(option=>option.admission);
  for(const option of allowed)option.admission!.routing={strategy:state?.pools.find(pool=>pool.id===range?.poolId)?.routing?.strategy??'stable',candidateCount:serviceIds.length,candidates:exclusions};
  return allowed.length?allowed:[options.find(option=>option.reason!=='service_unavailable'&&option.reason!=='policy_stale')??options.find(option=>option.reason==='policy_stale')??options[0]];
}
export function admissionForBatch(state:AdmissionWorkspace|undefined,input:AuthorizeRequest,batch:BatchScope,managedQuote=false):AdmissionResult{
  const options=admissionOptionsForBatch(state,input,batch,managedQuote);
  return options.find(option=>option.admission)??options[0];
}

function routingExclusions(state:AdmissionWorkspace|undefined,poolId:string|undefined,definitionId:string|undefined,options:{id:string;result:AdmissionResult}[]):RoutingCandidate[]{
  const pool=state?.pools.find(item=>item.id===poolId);
  return (pool?.entries??[]).filter(entry=>entry.definitionId===definitionId).flatMap(entry=>{
    const result=options.find(item=>item.id===entry.serviceId)?.result;
    if(entry.open&&result?.admission)return [];
    const service=state?.services.find(item=>item.id===entry.serviceId);
    return [{id:`excluded-${entry.serviceId}`,serviceId:entry.serviceId,definitionId:entry.definitionId,
      serviceName:service?.name??entry.serviceId,configVersion:service?.configVersion??null,
      weight:entry.weight??1,priority:entry.priority??0,rank:null,score:null,tie:null,status:'excluded' as const,
      reason:entry.open?result?.reason??'service_unavailable':'model_not_open',blockedScopes:[],scopes:[],latencyMs:null,latencySamples:0,cooldownUntil:null}];
  });
}

/** Operator simulation deliberately omits caller, purpose and funding scopes. */
export function poolSimulationOptions(state:AdmissionWorkspace,input:AuthorizeRequest,poolId:string):AdmissionResult[]{
  const definition=state.definitions.find(item=>item.modelId===input.modelId);
  const pool=state.pools.find(item=>item.id===poolId);
  const serviceIds=[...new Set(pool?.entries.filter(entry=>entry.definitionId===definition?.id&&entry.open).map(entry=>entry.serviceId)??[])];
  serviceIds.sort((a,b)=>createHash('sha256').update(`${input.requestId}:${a}`).digest('hex').localeCompare(createHash('sha256').update(`${input.requestId}:${b}`).digest('hex')));
  const options=serviceIds.map(id=>({id,result:admissionForServiceBatch(state,input,{sourceId:input.identity.subjectId,purpose:input.purpose,projectId:null},true,id,poolId)}));
  const exclusions=routingExclusions(state,poolId,definition?.id,options);
  const allowed=options.filter(option=>option.result.admission).map(option=>option.result);
  for(const option of allowed)option.admission!.routing={strategy:pool?.routing?.strategy??'stable',candidateCount:serviceIds.length,candidates:exclusions};
  return allowed.length?allowed:[{reason:options[0]?.result.reason??'service_unavailable',exclusions} as AdmissionResult];
}
