import type { ModelPool, Plan, PlatformSnapshot } from '@ai-gateway/contracts';

export function entryReadiness(d:PlatformSnapshot,entry:ModelPool['entries'][number]):string|null{
  const definition=d.definitions.find(m=>m.id===entry.definitionId),service=d.services.find(s=>s.id===entry.serviceId),mapping=service?.mappings.find(m=>m.definitionId===entry.definitionId);
  if(!definition?.active)return '模型已停用或不存在';
  if(!service?.active)return '来源服务已停用或不存在';
  if(service.verification!=='passed')return '来源连接尚未验证通过';
  if(!mapping)return '来源没有提供该模型';
  if([mapping.inputPrice,mapping.outputPrice,mapping.cachedInputPrice].some(p=>p===null))return '模型价格尚未确认完整';
  if(!entry.open)return '尚未开放使用';
  return null;
}

export function availablePlanModels(d:PlatformSnapshot,plan:Plan):string[]{
  return (d.pools.find(p=>p.id===plan.range.poolId)?.entries??[])
    .filter(e=>!entryReadiness(d,e)&&(plan.range.mode==='follow'||plan.range.definitionIds.includes(e.definitionId)))
    .map(e=>d.definitions.find(m=>m.id===e.definitionId)!.name);
}
