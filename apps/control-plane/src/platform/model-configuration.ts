import {BadRequestException} from '@nestjs/common';
import {MODEL_KINDS,METER_UNITS,ROUTING_STRATEGIES,type MeterPrice,type ModelKind,type PoolRouting,type ModelService} from '@ai-gateway/contracts';
import {text} from './validation';

export function serviceBaseUrl(value: unknown): string {
  let url: URL;
  try { url = new URL(text(value, 'baseUrl', 1000)); }
  catch { throw new BadRequestException('invalid service URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new BadRequestException('service URL must be HTTP(S) without embedded credentials, query or fragment');
  }
  return url.toString().replace(/\/$/, '');
}

export function modelKind(value:unknown):ModelKind {if(typeof value!=='string'||!Object.hasOwn(MODEL_KINDS,value))throw new BadRequestException('invalid model kind');return value as ModelKind;}
export function modalityPaths(raw:unknown):ModelService['modalityPaths']{
  if(raw===undefined)return undefined;if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new BadRequestException('invalid modality paths');
  const result:NonNullable<ModelService['modalityPaths']>={};for(const [key,value]of Object.entries(raw)){const kind=modelKind(key);if(value==='')continue;if(typeof value!=='string'||value.length>500||!/^\/(?!\/)[A-Za-z0-9_./{}~-]+$/.test(value)||value.includes('..'))throw new BadRequestException('modality paths must stay on the controlled service');result[kind]=value;}return result;
}
export function meterPrice(raw:unknown,kind:ModelKind):MeterPrice|undefined {
  if(raw===undefined||raw===null)return undefined;
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||kind==='chat')throw new BadRequestException('invalid metered pricing');
  const m=raw as MeterPrice,allowed:Record<ModelKind,string[]>={chat:[],embeddings:['per_request'],rerank:['per_request'],image:['per_request','per_image'],asr:['per_request','per_second'],tts:['per_request','per_1000_characters'],video:['per_request','per_second']};
  if(m.costPrice===undefined||m.costPrice===null)throw new BadRequestException('单位上游成本为必填项；免费请填 0。');
  const price=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1e9&&Math.abs(v*1e6-Math.round(v*1e6))<=0.001;
  if(!Object.hasOwn(METER_UNITS,m.unit)||!allowed[kind].includes(m.unit)||!price(m.price)||m.costPrice!==undefined&&m.costPrice!==null&&!price(m.costPrice)||!price(m.estimatedUnits)||!price(m.maxUnits)||m.maxUnits<=0||m.estimatedUnits>m.maxUnits)throw new BadRequestException('invalid metered price or unit limits');
  return {unit:m.unit,price:m.price,costPrice:m.costPrice??null,estimatedUnits:m.estimatedUnits,maxUnits:m.maxUnits};
}
export function poolRouting(raw:unknown):PoolRouting|undefined {
  if(raw===undefined)return undefined;if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new BadRequestException('invalid pool routing');
  const v=raw as PoolRouting;if(!Object.hasOwn(ROUTING_STRATEGIES,v.strategy)||!Number.isInteger(v.failureThreshold)||v.failureThreshold<0||v.failureThreshold>20||!Number.isInteger(v.cooldownSeconds)||v.cooldownSeconds<1||v.cooldownSeconds>600)throw new BadRequestException('invalid routing strategy or cooldown');return {strategy:v.strategy,failureThreshold:v.failureThreshold,cooldownSeconds:v.cooldownSeconds};
}
