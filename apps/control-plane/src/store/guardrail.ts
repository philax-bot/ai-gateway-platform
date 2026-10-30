import {BadRequestException,ConflictException,ServiceUnavailableException} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import {guardrailPolicy,guardrailApplies,type GuardrailPolicy,type AuthorizeRequest,type SafetyEvent,type SafetyQuery} from '@ai-gateway/contracts';

export function admissionGuardrail(value:GuardrailPolicy|undefined,input:AuthorizeRequest):SafetyEvent|null{
  const policy=guardrailPolicy(value),assessment=input.guardrail;
  if(!assessment){if(guardrailApplies(policy,input.modelId))throw new ServiceUnavailableException('guardrail_unavailable');return null;}
  if(!Number.isSafeInteger(assessment.version)||!Array.isArray(assessment.matches)||assessment.matches.length>203||assessment.matches.some(m=>!m||!['phone','identity_card','api_key','custom_word'].includes(m.category)||typeof m.ruleId!=='string'||m.ruleId.length>80))throw new BadRequestException('invalid guardrail assessment');
  if(assessment.version!==policy.version)throw new ConflictException('guardrail_policy_stale');
  if(!guardrailApplies(policy,input.modelId))return null;
  if(assessment.error)throw new ServiceUnavailableException('guardrail_unavailable');
  const unique=new Map<string,(typeof assessment.matches)[number]>();
  for(const match of assessment.matches){
    const valid=match.category==='custom_word'?/^word-[1-9]\d*$/.test(match.ruleId)&&Number(match.ruleId.slice(5))<=policy.words.length:policy.presets.includes(match.category)&&match.ruleId===({'phone':'preset-phone','identity_card':'preset-identity-card','api_key':'preset-api-key'} as const)[match.category];
    if(!valid)throw new BadRequestException('invalid guardrail rule');unique.set(match.ruleId,{ruleId:match.ruleId,category:match.category});
  }
  if(!unique.size)return null;
  return {id:'safety-'+randomUUID(),requestId:input.requestId,subjectId:input.identity.subjectId,purpose:input.purpose,projectId:input.identity.projectId??null,modelId:input.modelId,policyVersion:policy.version,action:policy.mode as 'observe'|'block',matches:[...unique.values()],createdAt:new Date().toISOString()};
}
export function safetyQuery(input:SafetyQuery={}){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['before','from','to','modelId','subjectId','requestId','category','action','limit'].includes(k)))throw new BadRequestException('invalid safety query');
  for(const key of ['modelId','subjectId','requestId']as const)if(input[key]!==undefined&&(typeof input[key]!=='string'||!input[key]||input[key]!.length>160))throw new BadRequestException('invalid safety filter');
  for(const key of ['from','to']as const)if(input[key]!==undefined&&(typeof input[key]!=='string'||!/(Z|[+-]\d\d:\d\d)$/.test(input[key]!)||!Number.isFinite(Date.parse(input[key]!))))throw new BadRequestException('invalid safety time');
  if(input.from&&input.to&&Date.parse(input.from)>Date.parse(input.to))throw new BadRequestException('invalid safety interval');
  if(input.action&&!['observe','block'].includes(input.action)||input.category&&!['phone','identity_card','api_key','custom_word'].includes(input.category))throw new BadRequestException('invalid safety category');
  if(input.limit!==undefined&&(!Number.isInteger(input.limit)||input.limit<1||input.limit>100))throw new BadRequestException('invalid safety page size');
  let cursor:{at:string;id:string}|undefined;
  if(input.before){try{cursor=JSON.parse(Buffer.from(input.before,'base64url').toString());if(!cursor||!Number.isFinite(Date.parse(cursor.at))||!/^safety-[a-f0-9-]{36}$/.test(cursor.id))throw Error();}catch{throw new BadRequestException('invalid safety cursor');}}
  return {query:input,limit:input.limit??20,cursor};
}
export const safetyCursor=(event:SafetyEvent)=>Buffer.from(JSON.stringify({at:event.createdAt,id:event.id})).toString('base64url');
export function memorySafetyPage(events:SafetyEvent[],input:SafetyQuery){
  const {query:q,limit,cursor}=safetyQuery(input);
  const filtered=events.filter(e=>(!q.from||e.createdAt>=new Date(q.from).toISOString())&&(!q.to||e.createdAt<=new Date(q.to).toISOString())&&(!q.modelId||e.modelId===q.modelId)&&(!q.subjectId||e.subjectId===q.subjectId)&&(!q.requestId||e.requestId===q.requestId)&&(!q.action||e.action===q.action)&&(!q.category||e.matches.some(m=>m.category===q.category))).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
  const page=filtered.filter(e=>!cursor||e.createdAt<cursor.at||e.createdAt===cursor.at&&e.id<cursor.id).slice(0,limit+1),items=page.slice(0,limit);
  return {items,nextCursor:page.length>limit?safetyCursor(items.at(-1)!):null,counts:{block:filtered.filter(e=>e.action==='block').length,observe:filtered.filter(e=>e.action==='observe').length}};
}
