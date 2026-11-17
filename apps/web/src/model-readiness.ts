import {modelProviders} from '@ai-gateway/contracts';
import type { ModelPool, Plan, PlatformSnapshot } from '@ai-gateway/contracts';

export function entryReadiness(d:PlatformSnapshot,entry:ModelPool['entries'][number]):string|null{
  const definition=d.definitions.find(m=>m.id===entry.definitionId),service=d.services.find(s=>s.id===entry.serviceId),mapping=service?.mappings.find(m=>m.definitionId===entry.definitionId);
  if(!definition?.active)return '模型已停用或不存在';
  if(!service?.active)return '来源服务已停用或不存在';
  const provider=modelProviders(d.providers).find(p=>p.id===(service.providerId??'openai-compatible'));if(!provider?.active)return '供应商已停用';if(!provider.kinds.includes(definition.kind??'chat'))return '供应商未配置该模型类型';
  if(service.verification!=='passed')return '来源连接尚未验证通过';
  if(!mapping)return '来源没有提供该模型';
  if(!mapping.meter&&(['image','asr','tts','video'].includes(definition.kind??'chat')||[mapping.inputPrice,mapping.outputPrice,mapping.cachedInputPrice].some(p=>p===null)))return '模型价格尚未确认完整';
  if(!entry.open)return '尚未开放使用';
  return null;
}

export function availablePlanModels(d:PlatformSnapshot,plan:Plan):string[]{
  return [...new Set((d.pools.find(p=>p.id===plan.range.poolId)?.entries??[])
    .filter(e=>!entryReadiness(d,e)&&(plan.range.mode==='follow'||plan.range.definitionIds.includes(e.definitionId)))
    .map(e=>d.definitions.find(m=>m.id===e.definitionId)!.name))];
}

export function planReadiness(d:PlatformSnapshot,plan:Plan):string|null{
  if(!plan.active)return '方案已停用';
  const pool=d.pools.find(p=>p.id===plan.range.poolId);
  if(!pool)return '模型池已不存在';
  if(!pool.entries.length)return '模型池尚未纳入模型服务';
  const entries=pool.entries.filter(e=>plan.range.mode==='follow'||plan.range.definitionIds.includes(e.definitionId));
  if(!entries.length)return plan.range.definitionIds.length?'指定模型已不在当前模型池中':'方案尚未指定可用模型';
  if(entries.some(e=>!entryReadiness(d,e)))return null;
  return [...new Set(entries.map(e=>entryReadiness(d,e)).filter((reason):reason is string=>!!reason))].join('；');
}
