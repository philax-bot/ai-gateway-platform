import type {PlatformSnapshot,PurposeView} from '@ai-gateway/contracts';

export type QuotaBatch=PlatformSnapshot['quotaBatches'][number];

/** Batches backing one purpose for the signed-in member. Closed and expired rows stay visible for traceability. */
export function purposeBatches(data:PlatformSnapshot,purpose:PurposeView):QuotaBatch[]{
  return data.quotaBatches.filter(b=>b.sourceId===data.actor.id&&b.purpose===purpose.purpose&&b.projectId===purpose.projectId);
}
export function liveBatch(batch:QuotaBatch){
  return !batch.closedAt&&Date.parse(batch.expiresAt)>Date.now();
}
/** Mirrors the server-side applicability check: a live batch also needs its personal entitlement to stay active. */
export function batchAppliesToMember(data:PlatformSnapshot,batch:QuotaBatch){
  if(!liveBatch(batch))return false;
  if(!batch.entitlementId)return true;
  const entitlement=data.entitlements.find(e=>e.id===batch.entitlementId);
  return !!entitlement&&entitlement.memberId===data.actor.id&&entitlement.status==='active'&&Date.parse(entitlement.expiresAt)>Date.now();
}
export function batchSourceName(data:PlatformSnapshot,batch:QuotaBatch){
  const entitlement=data.entitlements.find(e=>e.id===batch.entitlementId);
  if(entitlement)return entitlement.planSnapshot.name;
  if(batch.sourceBatchId){const project=data.projects.find(p=>p.id===batch.projectId);return project?`${project.name} · 额度分配`:'项目额度分配';}
  return '来源批次';
}
export function batchModelNames(data:PlatformSnapshot,batch:QuotaBatch){
  return batch.modelIds.map(id=>data.definitions.find(d=>d.modelId===id)?.name??id);
}
/** Funded, still-valid sources for one model. The same batch may serve several models. */
export function fundingSources(data:PlatformSnapshot,purpose:PurposeView,modelId:string){
  return purposeBatches(data,purpose).filter(b=>batchAppliesToMember(data,b)&&b.availableAmount>0&&b.modelIds.includes(modelId)).map(batch=>({batch,name:batchSourceName(data,batch)}));
}
export function fundingSourceSummary(sources:{name:string}[]){
  const counts=new Map<string,number>();
  for(const source of sources)counts.set(source.name,(counts.get(source.name)??0)+1);
  return [...counts].map(([name,count])=>count>1?`${name}（${count} 个批次）`:name).join('、');
}
