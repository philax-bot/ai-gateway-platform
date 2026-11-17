import type {ModelKind,ModelProvider,MeteredUsage,RequestIdentity,RouteSnapshot,Purpose} from './index.js';
export interface MediaJob {
  revision?:number;
  cancelOperation?:{token:string;expiresAt:string};
  callbackChannelId?:string|null;callbackQueued?:boolean;
  id:string;requestId:string;reservationId:string;identity:RequestIdentity;purpose:Purpose;modelId:string;route:RouteSnapshot;
  reservationFinalized?:boolean;reservationStatus?:string;
  status:'submitting'|'queued'|'in_progress'|'completed'|'failed'|'cancelled';upstreamId:string|null;createdAt:string;updatedAt:string;
  estimatedUnits:number|null;result:Record<string,unknown>|null;errorCode:string|null;settled:boolean;meterUnit?:MeteredUsage['unit'];finishedAt?:string;
}
export interface MediaTask {
  id:string;requestId:string;modelId:string;purpose:Purpose;purposeId:string;
  status:MediaJob['status'];result:Record<string,unknown>|null;errorCode:string|null;
  createdAt:string;updatedAt:string;finishedAt?:string;settled:boolean;reservationStatus?:string;
  serviceName?:string;poolName?:string;canCancel?:boolean;canDownload?:boolean;externalDownload?:boolean;
}
export interface MediaTaskPage {items:MediaTask[];nextCursor:string|null;collectedAt:string}
export interface MediaJobReceipt {id:string;upstreamId:string;status:'queued'|'in_progress';result:Record<string,unknown>|null}
export interface MediaJobUpdate {id:string;status:MediaJob['status'];result:Record<string,unknown>|null;errorCode?:string|null;settled?:boolean;expectedRevision?:number;cancelToken?:string}
export function modelEndpoint(baseUrl:string,kind:ModelKind,adapter:ModelProvider['adapter']='openai',override?:string,jobId?:string,content=false){
  const u=new URL(baseUrl);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error('invalid controlled model URL');
  if(override){if(!/^\/(?!\/)[A-Za-z0-9_./{}~-]+$/.test(override)||override.includes('..'))throw Error('invalid model path');u.pathname=override.replace(/\{id\}/g,jobId?encodeURIComponent(jobId):'');if(jobId&&!override.includes('{id}'))u.pathname+='/'+encodeURIComponent(jobId);if(content)u.pathname+='/content';return u.toString();}
  let base=u.pathname.replace(/\/+$/,'').replace(/\/(?:chat\/completions|responses|messages|embeddings|rerank|images\/generations|audio\/(?:speech|transcriptions)|videos(?:\/generations)?)$/,'');
  if(!/\/(?:v\d+(?:beta\d*)?|api\/v\d+)$/.test(base))base+='/v1';
  const paths:Record<ModelKind,string>={chat:'chat/completions',embeddings:'embeddings',rerank:'rerank',image:'images/generations',asr:'audio/transcriptions',tts:'audio/speech',video:'videos'};
  let path=paths[kind];if(kind==='video')path=adapter==='volcengine'?'contents/generations/tasks':adapter==='xai'&&!jobId?'videos/generations':'videos';
  u.pathname=base+'/'+path+(jobId?'/'+encodeURIComponent(jobId):'')+(content?'/content':'');return u.toString();
}
export function meteredQuantity(unit:MeteredUsage['unit'],kind:ModelKind,result:unknown,requested:number|undefined):number|null {
  if(unit==='per_request')return 1;
  const r=result&&typeof result==='object'?result as Record<string,unknown>:{};
  if(unit==='per_image'&&Array.isArray(r.data))return r.data.length;
  if(unit==='per_1000_characters'&&kind==='tts')return requested??null;
  const usage=r.usage&&typeof r.usage==='object'?r.usage as Record<string,unknown>:{};
  const seconds=r.duration??r.seconds??usage.duration??usage.duration_seconds;
  return typeof seconds==='number'&&Number.isFinite(seconds)&&seconds>=0&&seconds<=1e9?Number(seconds.toFixed(6)):null;
}
