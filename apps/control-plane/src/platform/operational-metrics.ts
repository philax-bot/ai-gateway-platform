import {ALERT_METRICS,type AlertRule,type CallSummary,type CapacitySnapshot,type MonitorReading} from '@ai-gateway/contracts';

export interface BacklogFilter {serviceId?:string|null;poolId?:string|null;modelId?:string|null}
export interface BacklogSnapshot {
  collectedAt:string;
  media:{count:number;oldestSeconds:number};
  settlement:{count:number;oldestSeconds:number};
}

export function operationalReading(rule:AlertRule,from:string,to:string,summary:CallSummary|null,capacity:CapacitySnapshot|null,backlog:BacklogSnapshot|null):MonitorReading{
  const collectedAt=new Date().toISOString();
  const reading:MonitorReading={ruleId:rule.id,from,to,collectedAt,unit:ALERT_METRICS[rule.metric].unit,quality:'collection_failed',value:null,sampleCount:0,numerator:null,denominator:null};
  if(rule.metric.endsWith('_utilization')){
    if(capacity?.quality!=='collected')return reading;
    const metric=rule.metric==='rpm_utilization'?'rpm':rule.metric==='tpm_utilization'?'tpm':'concurrency';
    const rows=capacity.rows.filter(row=>{
      if(!row.enabled)return false;
      if(rule.poolId&&row.kind!=='pool'&&!row.poolIds?.includes(rule.poolId))return false;
      if(rule.serviceId&&rule.modelId)return row.kind==='service_model'&&row.resourceId.startsWith(`${rule.serviceId}:`)&&row.modelId===rule.modelId;
      if(rule.serviceId)return row.kind==='service'&&row.resourceId===rule.serviceId;
      if(rule.poolId)return row.kind==='pool'&&row.resourceId===rule.poolId;
      if(rule.modelId)return row.kind==='service_model'&&row.modelId===rule.modelId;
      return row.kind==='pool'||row.kind==='service'||row.kind==='shared';
    }).map(row=>row[metric]).filter(value=>value.percent!==null);
    if(!rows.length)return {...reading,quality:'insufficient',collectedAt:capacity.collectedAt};
    const peak=rows.reduce((left,right)=>left.percent!>=right.percent!?left:right);
    return {...reading,quality:'ready',value:peak.percent,numerator:peak.used,denominator:peak.limit,sampleCount:rows.length,collectedAt:capacity.collectedAt,from:capacity.windowStart,to:capacity.collectedAt};
  }
  if(rule.metric==='p95_latency_ms'||rule.metric==='p95_ttft_ms'){
    if(!summary)return reading;
    const latency=rule.metric==='p95_latency_ms',samples=latency?summary.latencySamples:summary.ttftSamples;
    const value=latency?summary.p95LatencyMs:summary.p95TtftMs;
    return {...reading,quality:!samples?'no_traffic':samples<rule.minSamples||value===null?'insufficient':'ready',value,sampleCount:samples};
  }
  if(!backlog)return reading;
  const value=rule.metric==='media_backlog'?backlog.media.count:rule.metric==='media_oldest_seconds'?backlog.media.oldestSeconds:rule.metric==='settlement_backlog'?backlog.settlement.count:backlog.settlement.oldestSeconds;
  return {...reading,quality:'ready',value,sampleCount:1,collectedAt:backlog.collectedAt,from:backlog.collectedAt,to:backlog.collectedAt};
}
