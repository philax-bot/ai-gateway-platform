import type { UsageLimits } from './platform.js';

/** Same inheritance rule as admission; monitoring must never invent a second limit. */
export function effectiveUsageLimits(value:UsageLimits|undefined,defaults:UsageLimits):UsageLimits {
  return !value||value.mode==='inherit'?defaults:value;
}
export interface CapacityCounter {scopeId:string;requests:number;tokens:number;active:number}
export interface CapacityCounters {collectedAt:string;windowStart:string;windowEnd:string;rows:CapacityCounter[]}
export interface CapacityMetric {used:number;limit:number|null;percent:number|null}
export interface CapacityRow {
  scopeId:string;kind:'service'|'service_model'|'pool'|'shared';resourceId:string;name:string;modelId:string|null;
  poolIds?:string[];
  inherited:boolean;enabled:boolean;rpm:CapacityMetric;tpm:CapacityMetric;concurrency:CapacityMetric;
}
export interface CapacitySnapshot {
  collectedAt:string;windowStart:string;windowEnd:string;quality:'collected'|'collection_failed';rows:CapacityRow[];
}
