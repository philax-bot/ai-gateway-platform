import type { CallSummary } from './calls.js';
export const ALERT_METRICS={
  request_error_rate:{label:'请求错误率',unit:'%'},
  upstream_failure_rate:{label:'上游故障率',unit:'%'},
  timeout_rate:{label:'超时率',unit:'%'},
  stream_failure_rate:{label:'部分 / 流式异常率',unit:'%'},
  rate_limit_rate:{label:'限流拒绝率',unit:'%'},
  cancellation_rate:{label:'取消率',unit:'%'},
  rpm_utilization:{label:'RPM 利用率',unit:'%'},
  tpm_utilization:{label:'TPM 利用率',unit:'%'},
  concurrency_utilization:{label:'并发利用率',unit:'%'},
  p95_latency_ms:{label:'P95 总延迟',unit:'ms'},
  p95_ttft_ms:{label:'P95 首字延迟',unit:'ms'},
  media_backlog:{label:'视频未完成任务数',unit:'条'},
  media_oldest_seconds:{label:'最早视频任务等待时长',unit:'秒'},
  settlement_backlog:{label:'待核对结算数',unit:'条'},
  settlement_oldest_seconds:{label:'最早待核对结算时长',unit:'秒'},
} as const;
export type AlertMetric=keyof typeof ALERT_METRICS;
export interface AlertRule {
  id:string;name:string;active:boolean;serviceId:string|null;modelId:string|null;metric:AlertMetric;
  poolId?:string|null;silencedUntil?:string|null;silencedBy?:string|null;
  windowMinutes:number;threshold:number;minSamples:number;triggerCount:number;recoveryThreshold:number;recoveryCount:number;version:number;
}
export interface MonitorReading {
  ruleId:string;from:string;to:string;collectedAt:string;quality:'ready'|'no_traffic'|'insufficient'|'collection_failed';
  value:number|null;sampleCount:number;numerator:number|null;denominator:number|null;
  unit?:'%'|'ms'|'条'|'秒';
}
export interface AlertEvaluation { ruleVersion:number;bucket:number;hits:number;recoveries:number;reading:MonitorReading }
export interface AlertEvent {
  id:string;ruleId:string;ruleSnapshot:AlertRule;status:'active'|'recovered';openedAt:string;updatedAt:string;recoveredAt:string|null;
  acknowledgedAt:string|null;acknowledgedBy:string|null;occurrences:number;reading:MonitorReading;
}
export type CollectionStage='in_flight'|'call_totals'|'service_models'|'rule_windows'|'capacity'|'backlog';
export interface CollectionHealth {
  bucket:number|null;quality:'unknown'|'collected'|'collection_failed';lastAttemptAt:string|null;lastSuccessAt:string|null;lastFailureAt:string|null;
  failedStages:CollectionStage[];recoveries:number;
}
export interface CollectionAlertEvent {
  id:string;kind:'collection_failure';status:'active'|'recovered';openedAt:string;updatedAt:string;recoveredAt:string|null;
  acknowledgedAt:string|null;acknowledgedBy:string|null;occurrences:number;lastFailureBucket:number;
  failedStages:CollectionStage[];lastSuccessAt:string|null;recoveries:number;
}
export interface MonitoringState { channels?:import('./notifications.js').WebhookChannel[];deliveries?:import('./notifications.js').WebhookDelivery[];rules:AlertRule[];evaluations:Record<string,AlertEvaluation>;events:AlertEvent[];collection?:CollectionHealth;collectionEvents?:CollectionAlertEvent[] }
export interface InFlightCount {serviceId:string|null;modelId:string;count:number}
export interface MonitorSnapshot {
  from:string;to:string;collectedAt:string;quality:'collected'|'collection_failed';
  rows:{serviceId:string|null;modelId:string;summary:CallSummary;activeReservations:number}[];
  channels?:import('./notifications.js').WebhookChannel[];deliveries?:import('./notifications.js').WebhookDelivery[];
  rules:AlertRule[];events:AlertEvent[];evaluations:Record<string,AlertEvaluation>;
  collection:CollectionHealth;collectionEvents:CollectionAlertEvent[];failedStages:CollectionStage[];
}
