import type { UsageLimits } from '@ai-gateway/contracts';
import type { FieldSpec, FormValues } from './components';

export function limitFields(prefix:string,label='使用限制',visible?:(values:FormValues)=>boolean):FieldSpec[]{
  const modeKey=`${prefix}:mode`;
  return [{key:modeKey,label,type:'select',group:'使用保护（按需调整）',show:visible,options:[{value:'inherit',label:'继承企业默认保护'},{value:'none',label:'本级不额外限制'},{value:'custom',label:'自定义本级上限'}],help:'本级不额外限制仍受其他适用主体、池、服务与共享资源的保护。'},
    ...[['rpm','每分钟请求数（RPM）'],['tpm','每分钟预占 Token（TPM）'],['concurrency','并发请求数'],['maxOutputTokens','单次最大输出 Token']].map(([key,name])=>({key:`${prefix}:${key}`,label:name,type:'number' as const,group:'使用保护（按需调整）',step:'1',show:(values:FormValues)=>(!visible||visible(values))&&values[modeKey]==='custom',help:'留空表示本级不增加该项上限；其他适用边界仍然生效。'}))];
}
export function limitInitial(prefix:string,value?:UsageLimits):FormValues{return {[`${prefix}:mode`]:value?.mode??'inherit',...Object.fromEntries(['rpm','tpm','concurrency','maxOutputTokens'].map(key=>[`${prefix}:${key}`,String(value?.[key as keyof UsageLimits]??'')]))};}
export function readLimits(prefix:string,values:FormValues):UsageLimits{
  const mode=String(values[`${prefix}:mode`]??'inherit') as UsageLimits['mode'];
  if(mode!=='custom')return {mode};
  return {mode,...Object.fromEntries(['rpm','tpm','concurrency','maxOutputTokens'].filter(key=>values[`${prefix}:${key}`]!==''&&values[`${prefix}:${key}`]!==undefined).map(key=>[key,Number(values[`${prefix}:${key}`])]))};
}
