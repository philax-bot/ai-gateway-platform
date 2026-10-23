import type { CallSummary } from './calls.js';
export type AlertMetric='request_error_rate'|'upstream_failure_rate'|'timeout_rate'|'stream_failure_rate'|'rate_limit_rate'|'cancellation_rate';
export interface AlertRule {
  id:string;name:string;active:boolean;serviceId:string|null;modelId:string|null;metric:AlertMetric;
  windowMinutes:number;threshold:number;minSamples:number;triggerCount:number;recoveryThreshold:number;recoveryCount:number;version:number;
}
export interface MonitorReading {
  ruleId:string;from:string;to:string;collectedAt:string;quality:'ready'|'no_traffic'|'insufficient'|'collection_failed';
  value:number|null;sampleCount:number;numerator:number|null;denominator:number|null;
}
export interface AlertEvaluation { ruleVersion:number;bucket:number;hits:number;recoveries:number;reading:MonitorReading }
export interface AlertEvent {
  id:string;ruleId:string;ruleSnapshot:AlertRule;status:'active'|'recovered';openedAt:string;updatedAt:string;recoveredAt:string|null;
  acknowledgedAt:string|null;acknowledgedBy:string|null;occurrences:number;reading:MonitorReading;
}
export type CollectionStage='in_flight'|'call_totals'|'service_models'|'rule_windows';
export interface CollectionHealth {
  bucket:number|null;quality:'unknown'|'collected'|'collection_failed';lastAttemptAt:string|null;lastSuccessAt:string|null;lastFailureAt:string|null;
  failedStages:CollectionStage[];recoveries:number;
}
export interface CollectionAlertEvent {
  id:string;kind:'collection_failure';status:'active'|'recovered';openedAt:string;updatedAt:string;recoveredAt:string|null;
  acknowledgedAt:string|null;acknowledgedBy:string|null;occurrences:number;lastFailureBucket:number;
  failedStages:CollectionStage[];lastSuccessAt:string|null;recoveries:number;
}
export interface MonitoringState { rules:AlertRule[];evaluations:Record<string,AlertEvaluation>;events:AlertEvent[];collection?:CollectionHealth;collectionEvents?:CollectionAlertEvent[] }
export interface InFlightCount {serviceId:string|null;modelId:string;count:number}
export interface MonitorSnapshot {
  from:string;to:string;collectedAt:string;quality:'collected'|'collection_failed';
  rows:{serviceId:string|null;modelId:string;summary:CallSummary;activeReservations:number}[];
  rules:AlertRule[];events:AlertEvent[];evaluations:Record<string,AlertEvaluation>;
  collection:CollectionHealth;collectionEvents:CollectionAlertEvent[];failedStages:CollectionStage[];
}
