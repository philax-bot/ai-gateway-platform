import {BadRequestException} from '@nestjs/common';
import type {ModelKind,ModelService} from '@ai-gateway/contracts';
import {meterPrice} from './model-configuration';

type Mapping=ModelService['mappings'][number];

export function tokenPrice(value:unknown):number|null {
  if(value===null||value===undefined)return null;
  if(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1e9&&Math.abs(value*1e6-Math.round(value*1e6))<=0.001)return value;
  throw new BadRequestException('price must be nonnegative with at most six decimals, or explicitly unknown');
}

export function modelMultiplier(value:unknown):number {
  if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>100||Math.abs(value*1e6-Math.round(value*1e6))>0.001)throw new BadRequestException('billingMultiplier must be 0 to 100 with up to six decimals');
  return value;
}

export function mappingPrices(raw:Record<string,unknown>,current:Mapping|undefined,kind:ModelKind) {
  const meter=meterPrice(raw.meter===undefined?current?.meter:raw.meter,kind);
  const suppliedCost=raw.costPrice===undefined?current?.costPrice:raw.costPrice;
  let costPrice:Mapping['costPrice']=null;
  if(suppliedCost!==null&&suppliedCost!==undefined){
    if(typeof suppliedCost!=='object'||Array.isArray(suppliedCost))throw new BadRequestException('invalid cost price');
    const cost=suppliedCost as Record<string,unknown>;
    const inputPrice=tokenPrice(cost.inputPrice),outputPrice=tokenPrice(cost.outputPrice),cachedInputPrice=tokenPrice(cost.cachedInputPrice);
    if(inputPrice===null||outputPrice===null||cachedInputPrice===null)throw new BadRequestException('上游成本价必须完整填写输入、输出和缓存输入三项；免费请填 0。');
    costPrice={inputPrice,outputPrice,cachedInputPrice};
  }
  if(!meter&&!costPrice)throw new BadRequestException('上游成本价为必填项，请完整填写输入、输出和缓存输入成本价；免费请填 0。');
  return {
    inputPrice:tokenPrice(raw.inputPrice===undefined?current?.inputPrice:raw.inputPrice),
    outputPrice:tokenPrice(raw.outputPrice===undefined?current?.outputPrice:raw.outputPrice),
    cachedInputPrice:tokenPrice(raw.cachedInputPrice===undefined?current?.cachedInputPrice:raw.cachedInputPrice),
    costPrice,
    meter,
  };
}
