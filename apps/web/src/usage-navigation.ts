import type {CallQuery,UsageAnalytics} from '@ai-gateway/contracts';

export type UsageSource='usage'|'leaderboard';
export interface UsageNavigation {id:string;source:UsageSource;label:string;query:CallQuery}
export function usageTarget(source:UsageSource,label:string,report:UsageAnalytics,extra:CallQuery={}):string{
  return JSON.stringify({id:crypto.randomUUID(),source,label,query:{...extra,from:report.from,to:report.to,limit:50}} satisfies UsageNavigation);
}
export function readUsageTarget(value?:string|null):UsageNavigation|null{
  if(!value)return null;
  try{const target=JSON.parse(value) as UsageNavigation;return typeof target.id==='string'&&['usage','leaderboard'].includes(target.source)&&typeof target.label==='string'&&target.query&&typeof target.query.from==='string'&&typeof target.query.to==='string'?target:null;}catch{return null;}
}
