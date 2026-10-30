import { BadRequestException } from '@nestjs/common';
import type { AlertMetric,AlertRule,CallSummary,CollectionHealth,CollectionAlertEvent,CollectionStage,MonitorReading,MonitoringState,WorkspaceState } from '@ai-gateway/contracts';
import { activeMember,pick,text } from './validation';
import { newId,notify } from './domain';

export function monitoringState(s:Pick<WorkspaceState,'monitoring'>):MonitoringState&{collection:CollectionHealth;collectionEvents:CollectionAlertEvent[]}{
  const m=s.monitoring??={rules:[],evaluations:{},events:[]};
  m.collection??={bucket:null,quality:'unknown',lastAttemptAt:null,lastSuccessAt:null,lastFailureAt:null,failedStages:[],recoveries:0};m.collectionEvents??=[];
  return m as MonitoringState&{collection:CollectionHealth;collectionEvents:CollectionAlertEvent[]};
}
function alertNotification(s:WorkspaceState,title:string,body:string,id:string,action:string,createdAt:string,detail:Record<string,unknown>){
  for(const member of s.members){try{if(member.roles.includes('operator')){activeMember(s,member.id);notify(s,member.id,title,body,'alert',id);}}catch{/* inactive operators do not receive new notifications */}}
  s.audit.push({id:newId('audit'),actorId:'system:monitor',action,objectId:id,reason:body,createdAt,detail});
}
export function applyCollectionReading(s:WorkspaceState,failedStages:CollectionStage[],bucket:number,at:string){
  const m=monitoringState(s),prior=m.collection;if(prior.bucket!==null&&bucket<prior.bucket)return;
  const failed=failedStages.length>0,same=prior.bucket===bucket,consecutive=prior.bucket===bucket-1;
  const active=m.collectionEvents.find(e=>e.status==='active');
  const recoveries=failed||!active?0:same?prior.recoveries:consecutive&&prior.quality==='collected'?prior.recoveries+1:1;
  m.collection={bucket,quality:failed?'collection_failed':'collected',lastAttemptAt:at,lastSuccessAt:failed?prior.lastSuccessAt:at,lastFailureAt:failed?at:prior.lastFailureAt,failedStages:[...new Set(failedStages)],recoveries};
  if(failed){
    if(active){active.updatedAt=at;active.failedStages=m.collection.failedStages;active.recoveries=0;if(active.lastFailureBucket!==bucket){active.occurrences++;active.lastFailureBucket=bucket;}}
    else{
      const event:CollectionAlertEvent={id:newId('collection-alert'),kind:'collection_failure',status:'active',openedAt:at,updatedAt:at,recoveredAt:null,acknowledgedAt:null,acknowledgedBy:null,occurrences:1,lastFailureBucket:bucket,failedStages:m.collection.failedStages,lastSuccessAt:prior.lastSuccessAt,recoveries:0};m.collectionEvents.push(event);
      alertNotification(s,'监控采集失败','运行指标暂不可用，请检查调用统计及预占统计。知晓后仍需连续两次不同分钟的完整采集成功才能恢复。',event.id,'alert.collection_opened',at,{failedStages:event.failedStages});
    }
  }else if(active){
    active.updatedAt=at;active.lastSuccessAt=at;active.recoveries=recoveries;
    if(recoveries>=2){active.status='recovered';active.recoveredAt=at;alertNotification(s,'监控采集已恢复','连续两次不同分钟的完整采集成功。业务故障告警仍按各自样本和阈值判断。',active.id,'alert.collection_recovered',at,{});}
  }
}
export const alertMetrics:AlertMetric[]=['request_error_rate','upstream_failure_rate','timeout_rate','stream_failure_rate','rate_limit_rate','cancellation_rate'];
export function saveAlertRule(s:WorkspaceState,p:Record<string,unknown>):AlertRule{
  const m=monitoringState(s),existing=p.id?pick(m.rules,p.id,'alert rule'):null;
  if(p.serviceId)pick(s.services,p.serviceId,'service');
  if(p.modelId&&!s.definitions.some(d=>d.modelId===p.modelId))throw new BadRequestException('model not found');
  if(!alertMetrics.includes(p.metric as AlertMetric))throw new BadRequestException('invalid alert metric');
  const integer=(key:string,max:number)=>{const n=p[key];if(typeof n!=='number'||!Number.isInteger(n)||n<1||n>max)throw new BadRequestException(`invalid ${key}`);return n;};
  const rate=(key:string)=>{const n=p[key];if(typeof n!=='number'||!Number.isFinite(n)||n<0||n>100)throw new BadRequestException(`invalid ${key}`);return n;};
  const rule:AlertRule={id:existing?.id??newId('alert-rule'),name:text(p.name,'name',100),active:p.active!==false,serviceId:p.serviceId?String(p.serviceId):null,modelId:p.modelId?String(p.modelId):null,metric:p.metric as AlertMetric,windowMinutes:integer('windowMinutes',60),threshold:rate('threshold'),minSamples:integer('minSamples',1000000),triggerCount:integer('triggerCount',60),recoveryThreshold:rate('recoveryThreshold'),recoveryCount:integer('recoveryCount',60),version:(existing?.version??0)+1};
  if(rule.recoveryThreshold>=rule.threshold)throw new BadRequestException('recovery threshold must be below trigger threshold');
  // Existing events keep evaluating their original rule through recovery; edits govern later events.
  if(existing)Object.assign(existing,rule);else m.rules.push(rule);if(!m.events.some(e=>e.ruleId===rule.id&&e.status==='active'))delete m.evaluations[rule.id];return rule;
}
export function metricReading(rule:AlertRule,summary:CallSummary|null,from:string,to:string,collectedAt:string):MonitorReading{
  const forwarded=rule.metric==='upstream_failure_rate';
  const denominator=summary?(forwarded?summary.forwarded:summary.ended):null;
  const numerator=summary?({request_error_rate:summary.errors,upstream_failure_rate:summary.upstreamFailures,timeout_rate:summary.timeouts,stream_failure_rate:summary.partial,rate_limit_rate:summary.rateLimited,cancellation_rate:summary.cancelled})[rule.metric]:null;
  // Legacy/lease-expiry rows may lack dispatch evidence. Never turn missing coverage into recovery.
  const incomplete=!!summary&&forwarded&&summary.unknownForwarding>0;
  return {ruleId:rule.id,from,to,collectedAt,quality:!summary?'collection_failed':!denominator?'no_traffic':denominator<rule.minSamples||incomplete?'insufficient':'ready',sampleCount:denominator??0,numerator,denominator,value:denominator?100*numerator!/denominator:null};
}
export function applyAlertReading(s:WorkspaceState,rule:AlertRule,reading:MonitorReading,bucket:number){
  const m=monitoringState(s),prior=m.evaluations[rule.id];if(prior?.bucket===bucket&&prior.ruleVersion===rule.version)return;
  const consecutive=prior?.ruleVersion===rule.version&&prior.bucket===bucket-1;
  const ready=reading.quality==='ready',hits=ready&&reading.value!>=rule.threshold?(consecutive?prior.hits:0)+1:0;
  const recoveries=ready&&reading.value!<rule.recoveryThreshold?(consecutive?prior.recoveries:0)+1:0;
  m.evaluations[rule.id]={ruleVersion:rule.version,bucket,hits,recoveries,reading};
  const active=m.events.find(e=>e.ruleId===rule.id&&e.status==='active');
  let notification:{title:string;body:string;id:string}|null=null;
  if(active){
    active.reading=reading;active.updatedAt=reading.collectedAt;if(ready&&reading.value!>=rule.threshold)active.occurrences++;
    if(recoveries>=rule.recoveryCount){active.status='recovered';active.recoveredAt=reading.collectedAt;notification={title:`告警已恢复：${rule.name}`,body:`连续 ${recoveries} 次低于恢复阈值 ${rule.recoveryThreshold}%，最近样本 ${reading.sampleCount}。`,id:active.id};}
  }else if(hits>=rule.triggerCount){
    const event={id:newId('alert'),ruleId:rule.id,ruleSnapshot:structuredClone(rule),status:'active' as const,openedAt:reading.collectedAt,updatedAt:reading.collectedAt,recoveredAt:null,acknowledgedAt:null,acknowledgedBy:null,occurrences:1,reading};m.events.push(event);
    notification={title:`运行告警：${rule.name}`,body:`${reading.value!.toFixed(2)}% ≥ ${rule.threshold}%，窗口 ${rule.windowMinutes} 分钟，样本 ${reading.sampleCount}。知晓不代表恢复。`,id:event.id};
  }
  if(notification)alertNotification(s,notification.title,notification.body,notification.id,notification.title.startsWith('告警已恢复')?'alert.recovered':'alert.opened',reading.collectedAt,{ruleId:rule.id});
}
