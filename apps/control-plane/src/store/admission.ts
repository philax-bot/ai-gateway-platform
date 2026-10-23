import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AdmissionScope, AdmissionSnapshot, AuthorizeRequest, PriceSnapshot, ReasonCode, UsageLimits, WorkspaceState } from '@ai-gateway/contracts';
import { businessDenial } from '../platform/domain';

export const LEGACY_RESERVATION_AMOUNT=0.02;
export const legacyAdmission=():AdmissionSnapshot=>({kind:'legacy_simulation',route:null,price:null,reservedAmount:LEGACY_RESERVATION_AMOUNT,estimatedTokens:0,scopes:[]});
export function publicLogAdmission(admission:AdmissionSnapshot|null|undefined){
  if(!admission)return null;
  const route=admission.route;
  return {kind:admission.kind,price:admission.price,reservedAmount:admission.reservedAmount,route:route?{serviceId:route.serviceId,poolId:route.poolId,definitionId:route.definitionId,upstreamModel:route.upstreamModel}:null};
}
export interface BatchScope {entitlementId?:string|null;projectId:string|null;purpose:string;sourceId:string}
type AdmissionResult={admission:AdmissionSnapshot;reason?:never}|{admission?:never;reason:ReasonCode};
function priceUnits(price:number):bigint {
  if(!Number.isFinite(price)||price<0||price>1e9||Math.abs(price*1e6-Math.round(price*1e6))>0.001)throw new BadRequestException('prices support up to six decimals per million tokens');
  return BigInt(Math.round(price*1e6));
}
/** Round once, upwards, at the complete request amount in micro-CNY. */
export function costForUsage(price:PriceSnapshot,inputTokens:number,outputTokens:number,cachedInputTokens=0):number {
  if(![inputTokens,outputTokens,cachedInputTokens].every(n=>Number.isSafeInteger(n)&&n>=0)||cachedInputTokens>inputTokens)throw new BadRequestException('invalid upstream usage');
  const numerator=BigInt(inputTokens-cachedInputTokens)*priceUnits(price.inputPrice)+BigInt(outputTokens)*priceUnits(price.outputPrice)+BigInt(cachedInputTokens)*priceUnits(price.cachedInputPrice);
  const micros=(numerator+999999n)/1000000n;
  if(micros>BigInt(Number.MAX_SAFE_INTEGER))throw new BadRequestException('request price exceeds supported money precision');
  return Number(micros)/1e6;
}

export function admissionForBatch(state:WorkspaceState|undefined,input:AuthorizeRequest,batch:BatchScope,managedQuote=false):AdmissionResult {
  const key=state?.keys.find(k=>k.credentialId===input.identity.credentialId);
  if(!state||(!key&&!managedQuote))return {admission:legacyAdmission()};
  if(batch.sourceId!==input.identity.subjectId||batch.purpose!==input.purpose||batch.projectId!==(input.identity.projectId??null))return {reason:'model_not_open'};
  const denial=managedQuote?null:businessDenial(state,input);if(denial)return {reason:denial};
  if(input.mode!=='chat')return {reason:'service_unavailable'};
  let range;
  let purposeLimits:UsageLimits|undefined;
  let purposeScope='';
  if(input.purpose==='personal'){
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
  const entry=pool?.entries.find(e=>e.definitionId===definition?.id&&e.open&&(range.mode==='follow'||range.definitionIds.includes(e.definitionId)));
  const service=state.services.find(s=>s.id===entry?.serviceId&&s.active&&s.verification==='passed');
  const mapping=service?.mappings.find(m=>m.definitionId===definition?.id);
  if(!definition||!pool||!entry||!service||!mapping)return {reason:'service_unavailable'};
  if([mapping.inputPrice,mapping.outputPrice,mapping.cachedInputPrice].some(p=>typeof p!=='number'||!Number.isFinite(p)||p<0))return {reason:'price_unconfigured'};
  let price:PriceSnapshot;
  try{
    [mapping.inputPrice!,mapping.outputPrice!,mapping.cachedInputPrice!].forEach(priceUnits);
    price={version:createHash('sha256').update(JSON.stringify([service.id,service.configVersion,mapping.definitionId,mapping.upstreamModel,mapping.inputPrice,mapping.outputPrice,mapping.cachedInputPrice])).digest('hex').slice(0,24),currency:'CNY',unit:'per_million_tokens',inputPrice:mapping.inputPrice!,outputPrice:mapping.outputPrice!,cachedInputPrice:mapping.cachedInputPrice!};
  }catch{return {reason:'price_unconfigured'};}
  if(input.expectedPriceVersion&&input.expectedPriceVersion!==price.version)return {reason:'policy_stale'};
  const defaults=state.settings.limits;
  const scopes:AdmissionScope[]=[];
  const outputCaps:number[]=[];
  const append=(id:string,value:UsageLimits|undefined)=>{
    const effective=!value||value.mode==='inherit'?defaults:value;
    if(effective.mode==='none')return;
    scopes.push({id:`${state.tenantId}:${id}`,rpm:effective.rpm,tpm:effective.tpm,concurrency:effective.concurrency});
    if(effective.maxOutputTokens)outputCaps.push(effective.maxOutputTokens);
  };
  append(`subject:${input.identity.subjectType}:${input.identity.subjectId}`,state.members.find(m=>m.id===input.identity.subjectId)?.limits);
  append(purposeScope,purposeLimits);append(`pool:${pool.id}`,pool.limits);
  append(`service:${service.id}`,service.limits);append(`service-model:${service.id}:${definition.id}`,mapping.limits);
  if(service.sharedCapacityId)append(`shared:${service.sharedCapacityId}`,undefined);
  const estimatedInputTokens=input.estimatedInputTokens??0;
  const outputLimit=Math.min(...outputCaps,definition.contextTokens-estimatedInputTokens);
  const maxOutputTokens=input.maxOutputTokens??Math.min(4096,outputLimit);
  if(!Number.isSafeInteger(estimatedInputTokens)||estimatedInputTokens<0||!Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>outputLimit)return {reason:'request_limit_exceeded'};
  const reservePrice={...price,inputPrice:Math.max(price.inputPrice,price.cachedInputPrice)};
  const reservedAmount=costForUsage(reservePrice,estimatedInputTokens,maxOutputTokens,0);
  return {admission:{kind:'configured',route:{serviceId:service.id,poolId:pool.id,definitionId:definition.id,baseUrl:service.baseUrl,upstreamModel:mapping.upstreamModel,credentialRef:service.credentialRef,maxOutputTokens},price,reservedAmount,estimatedTokens:estimatedInputTokens+maxOutputTokens,scopes}};
}
