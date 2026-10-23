import { useEffect,useRef,useState } from 'react';
import type { AlertEvent,CollectionAlertEvent,MonitorSnapshot } from '@ai-gateway/contracts';
import { api } from './client';
import { date,Modal } from './components';
import { collectionStages,metricLabels,qualityLabels } from './Monitoring';
import type { RunCommand } from './editors';

export function AlertWatcher({enabled,run,onOpen}:{enabled:boolean;run:RunCommand;onOpen:()=>void}){
  const dismissed=useRef(new Set<string>()),[event,setEvent]=useState<AlertEvent|CollectionAlertEvent|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{if(!enabled)return;let current=true;const load=()=>void api<MonitorSnapshot>('/api/v1/platform/monitoring').then(report=>{if(current)setEvent(previous=>{const events=[...report.collectionEvents,...report.events];if(previous&&!dismissed.current.has(previous.id)){const updated=events.find(e=>e.id===previous.id&&e.status==='active'&&!e.acknowledgedAt);if(updated)return updated;}return events.find(e=>e.status==='active'&&!e.acknowledgedAt&&!dismissed.current.has(e.id))??null;});}).catch(()=>undefined);load();const timer=setInterval(load,60000);return()=>{current=false;clearInterval(timer);};},[enabled]);
  if(!enabled||!event)return null;
  const close=()=>{if(!busy){dismissed.current.add(event.id);setEvent(null);setError('');}};
  const collection='kind' in event;
  return <Modal title={collection?'监控采集失败':`运行告警：${event.ruleSnapshot.name}`} onClose={close} footer={<><button className="ghost" disabled={busy} onClick={close}>关闭本次弹窗</button><button className="ghost" disabled={busy} onClick={()=>{close();onOpen();}}>{collection?'查看采集与处理入口':'查看异常与调用'}</button><button className="primary" disabled={busy} onClick={()=>{setBusy(true);setError('');void run('alert.ack',{id:event.id},false).then(()=>{dismissed.current.add(event.id);setEvent(null);}).catch(e=>setError(e instanceof Error?e.message:'操作失败')).finally(()=>setBusy(false));}}>我已知晓</button></>}>
    {collection?<><p>无法读取{collectionStages(event.failedStages)}，当前运行指标未知。请平台运维检查统计数据库连接、相关表及查询权限。</p><p>前往监控页重新检查采集；连续两个不同分钟完整采集成功才恢复。当前连续成功 {event.recoveries} / 2 个分钟。检查不会调用模型或发放额度。</p></>:<><p>{metricLabels[event.ruleSnapshot.metric]}：{event.reading.value==null?'未知':`${event.reading.value.toFixed(2)}%`}，触发阈值 {event.ruleSnapshot.threshold}%。</p><p>对象：{event.ruleSnapshot.serviceId??'全部服务'} / {event.ruleSnapshot.modelId??'全部模型'}。窗口 {event.ruleSnapshot.windowMinutes} 分钟，样本 {event.reading.sampleCount}；{qualityLabels[event.reading.quality]}。</p></>}
    <p>首次触发：{date(event.openedAt)}。知晓会记录操作人，只有连续达到恢复条件才解除事件。</p>{error&&<div className="notice danger" role="alert">{error}</div>}
  </Modal>;
}
