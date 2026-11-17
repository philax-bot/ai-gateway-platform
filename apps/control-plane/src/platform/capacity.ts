import {effectiveUsageLimits,type CapacityCounters,type CapacityRow,type UsageLimits,type WorkspaceState} from '@ai-gateway/contracts';

export function capacityResources(s:Pick<WorkspaceState,'tenantId'|'services'|'pools'|'definitions'|'settings'>){
  const rows:(Omit<CapacityRow,'rpm'|'tpm'|'concurrency'>&{limits:UsageLimits})[]=[];
  const add=(kind:CapacityRow['kind'],resourceId:string,name:string,value:UsageLimits|undefined,enabled:boolean,modelId:string|null=null,scope=kind==='service_model'?'service-model':kind)=>{
    rows.push({kind,resourceId,name,modelId,scopeId:`${s.tenantId}:${scope}:${resourceId}`,limits:effectiveUsageLimits(value,s.settings.limits),inherited:!value||value.mode==='inherit',enabled});
  };
  for(const service of s.services){
    add('service',service.id,service.name,service.limits,service.active);
    for(const mapping of service.mappings){const definition=s.definitions.find(d=>d.id===mapping.definitionId);if(definition)add('service_model',`${service.id}:${definition.id}`,`${service.name} / ${definition.name}`,mapping.limits,service.active&&definition.active,definition.modelId);}
  }
  for(const pool of s.pools)add('pool',pool.id,pool.name,pool.limits,pool.entries.some(e=>e.open));
  for(const id of new Set(s.services.map(s=>s.sharedCapacityId).filter((id):id is string=>!!id)))add('shared',id,id,undefined,s.services.some(s=>s.sharedCapacityId===id&&s.active));
  return rows.map(row=>{
    const serviceIds=row.kind==='service'?[row.resourceId]:row.kind==='service_model'?s.services.filter(service=>row.resourceId.startsWith(service.id+':')).map(service=>service.id):row.kind==='shared'?s.services.filter(service=>service.sharedCapacityId===row.resourceId).map(service=>service.id):[];
    const poolIds=row.kind==='pool'?[row.resourceId]:s.pools.filter(pool=>pool.entries.some(entry=>serviceIds.includes(entry.serviceId))).map(pool=>pool.id);
    return {...row,poolIds};
  });
}
export function capacityRows(resources:ReturnType<typeof capacityResources>,snapshot:CapacityCounters):CapacityRow[]{
  const counts=new Map(snapshot.rows.map(row=>[row.scopeId,row]));
  return resources.map(({limits,...row})=>{
    const count=counts.get(row.scopeId),metric=(used:number,limit:number|undefined)=>({used,limit:limits.mode==='none'?null:limit??null,percent:limits.mode==='none'||!limit?null:100*used/limit});
    return {...row,rpm:metric(count?.requests??0,limits.rpm),tpm:metric(count?.tokens??0,limits.tpm),concurrency:metric(count?.active??0,limits.concurrency)};
  });
}
