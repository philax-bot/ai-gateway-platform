import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map } from 'rxjs';
import {hasPermission} from '@ai-gateway/contracts';

/** A single response boundary covers snapshots, details, quotes and command receipts. */
export function billingView<T>(value:T,operator:boolean,technicalRead=operator):T{
  if(operator)return value;
  const strip=(item:unknown):unknown=>Array.isArray(item)?item.map(strip):item&&typeof item==='object'?Object.fromEntries(Object.entries(item).filter(([key])=>!['billing','billingMultiplier','costPrice','cost','estimatedCost','beforeCost','afterCost','multiplier','internalCost'].includes(key)&&!(('attemptedAt' in item&&'upstreamModel' in item)&&['inputPrice','outputPrice','cachedInputPrice'].includes(key))&&!(!technicalRead&&['candidates','candidateId','policyVersion'].includes(key)&&'strategy' in item&&'candidateCount' in item)&&!( !technicalRead&&key==='endpoint'&&'serviceName' in item&&'poolName' in item&&'configVersion' in item)).map(([key,child])=>[key,strip(child)])):typeof item==='string'?item.replace(/内部诊断成本\s+[0-9.eE+-]+\s*元/g,'内部诊断成本已记录'):item;
  return strip(value) as T;
}

@Injectable()
export class BillingVisibilityInterceptor implements NestInterceptor {
  intercept(context:ExecutionContext,next:CallHandler){
    const actor=context.switchToHttp().getRequest<{actor:{roles:string[]}}>().actor;
    return next.handle().pipe(map(value=>billingView(value,hasPermission(actor,'costs.read'),hasPermission(actor,'models.read'))));
  }
}
