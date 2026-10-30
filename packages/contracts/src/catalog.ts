import type {ModelDefinition,ModelPool,ModelService,ServiceModel} from './platform.js';

export type CatalogStage='disabled'|'unconfigured'|'source_unavailable'|'price_unknown'|'ready_unopened'|'open';
export interface CatalogSource {
  serviceId:string;serviceName:string;active:boolean;verification:ModelService['verification'];
  upstreamModel:string;prices:Pick<ServiceModel,'inputPrice'|'outputPrice'|'cachedInputPrice'>;
  priced:boolean;poolIds:string[];openPoolIds:string[];
  protocols?:import('./protocol.js').ServiceProtocolCapabilities['mappings'][string];
}
export interface CatalogModel {definition:ModelDefinition;sources:CatalogSource[];verified:boolean;openPoolIds:string[];stage:CatalogStage}
export interface CatalogFilter {query?:string;serviceId?:string;poolId?:string;stage?:CatalogStage|'';active?:'active'|'inactive'|'all'}

/** A read-only projection of existing configuration, never another model registry. */
export function modelCatalog(data:{definitions:ModelDefinition[];services:ModelService[];pools:ModelPool[]}):CatalogModel[]{
  return data.definitions.map(definition=>{
    const sources:CatalogSource[]=data.services.flatMap(service=>{
      const mapping=service.mappings.find(m=>m.definitionId===definition.id);if(!mapping)return [];
      const prices={inputPrice:mapping.inputPrice,outputPrice:mapping.outputPrice,cachedInputPrice:mapping.cachedInputPrice};
      const priced=Object.values(prices).every(p=>typeof p==='number'&&Number.isFinite(p)&&p>=0);
      const pools=data.pools.filter(p=>p.entries.some(e=>e.definitionId===definition.id&&e.serviceId===service.id));
      const openPoolIds=definition.active&&service.active&&service.verification==='passed'&&priced?pools.filter(p=>p.entries.some(e=>e.definitionId===definition.id&&e.serviceId===service.id&&e.open)).map(p=>p.id):[];
      return [{serviceId:service.id,serviceName:service.name,active:service.active,verification:service.verification,upstreamModel:mapping.upstreamModel,prices,priced,poolIds:pools.map(p=>p.id),openPoolIds,protocols:service.protocolCapabilities?.configVersion===service.configVersion?service.protocolCapabilities.mappings[definition.id]:undefined}];
    });
    const verified=sources.some(s=>s.active&&s.verification==='passed'),openPoolIds=[...new Set(sources.flatMap(s=>s.openPoolIds))];
    const stage:CatalogStage=!definition.active?'disabled':!sources.length?'unconfigured':!verified?'source_unavailable':!sources.some(s=>s.active&&s.verification==='passed'&&s.priced)?'price_unknown':!openPoolIds.length?'ready_unopened':'open';
    return {definition,sources,verified,openPoolIds,stage};
  });
}

/** Source/pool filters restrict matching models, not the displayed routing/price evidence. */
export function filterModelCatalog(rows:CatalogModel[],filter:CatalogFilter):CatalogModel[]{
  const query=(filter.query??'').trim().normalize('NFC').toLowerCase();
  return rows.filter(row=>((filter.active??'active')==='all'||row.definition.active===((filter.active??'active')==='active'))
    &&(!filter.stage||row.stage===filter.stage)
    &&(!(filter.serviceId||filter.poolId)||row.sources.some(s=>(!filter.serviceId||s.serviceId===filter.serviceId)&&(!filter.poolId||s.poolIds.includes(filter.poolId))))
    &&(!query||[row.definition.name,row.definition.modelId,row.definition.description,...row.sources.map(s=>s.serviceName)].some(v=>v.normalize('NFC').toLowerCase().includes(query))));
}

export function catalogPriceRange(row:CatalogModel,field:keyof CatalogSource['prices']):{min:number;max:number}|null{
  const values=row.sources.filter(s=>s.priced).map(s=>s.prices[field]!);return values.length?{min:Math.min(...values),max:Math.max(...values)}:null;
}
