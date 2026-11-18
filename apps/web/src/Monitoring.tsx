import {hasPermission,ALERT_METRICS} from '@ai-gateway/contracts';
import {CapacityMonitoring} from './CapacityMonitoring';
import {RequestTraces} from './RequestTraces';
import { useEffect,useState,type ReactNode } from 'react';
import type { AlertEvent,CallQuery,CollectionAlertEvent,CollectionStage,MonitorSnapshot,PlatformSnapshot } from '@ai-gateway/contracts';
import { api } from './client';
import { CallExplorer } from './CallExplorer';
import { CallErrorBreakdown } from './CallErrorBreakdown';
import { date,Panel,Table } from './components';
import type { makeEditors,RunCommand } from './editors';

export const metricLabels=Object.fromEntries(Object.entries(ALERT_METRICS).map(([key,value])=>[key,value.label]));
export const qualityLabels:Record<string,string>={ready:'样本充分',no_traffic:'无流量，证据不足',insufficient:'样本 / 转发证据不足',collection_failed:'采集失败'};
export const collectionStageLabels:Record<CollectionStage,string>={in_flight:'在途预占统计',call_totals:'调用总量统计',service_models:'服务与模型统计',rule_windows:'告警窗口统计',capacity:'实时容量统计',backlog:'任务与结算积压统计'};
export const collectionStages=(stages:CollectionStage[])=>stages.map(s=>collectionStageLabels[s]).join('、');
type Props={data:PlatformSnapshot;edit:ReturnType<typeof makeEditors>;run:RunCommand;detail:(title:string,content:ReactNode)=>void;refreshWorkspace:()=>Promise<boolean>;active?:boolean};
export function Monitoring({data,edit,run,detail,refreshWorkspace,active=true}:Props){
  const [report,setReport]=useState<MonitorSnapshot|null>(null),[error,setError]=useState(''),[paused,setPaused]=useState(false),[clock,setClock]=useState(Date.now()),[lastSuccess,setLastSuccess]=useState<string|null>(null),[lastAttempt,setLastAttempt]=useState<string|null>(null),[checking,setChecking]=useState(false),[actionError,setActionError]=useState(''),[checkResult,setCheckResult]=useState('');
  function receive(r:MonitorSnapshot){setReport(r);setError('');setCheckResult('');setLastAttempt(r.collectedAt);if(r.quality==='collected')setLastSuccess(r.collectedAt);}
  function unreadable(){setLastAttempt(new Date().toISOString());setCheckResult('');setError('暂时无法连接监控服务，请重试；若持续失败，请联系平台运维。');}
  async function refresh(){try{const current=await api<MonitorSnapshot>('/api/v1/platform/monitoring');receive(current);return current;}catch{unreadable();}}
  useEffect(()=>{if(!active)return;const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[active]);
  useEffect(()=>{if(paused||!active)return;let current=true;const load=()=>void api<MonitorSnapshot>('/api/v1/platform/monitoring').then(r=>{if(current)receive(r);}).catch(()=>{if(current)unreadable();});load();const timer=setInterval(load,15000);return()=>{current=false;clearInterval(timer);};},[paused,data,active]);
  const service=(id:string|null)=>id?data.services.find(s=>s.id===id)?.name??id:'全部服务',model=(id:string|null)=>id&&id!=='*'?data.definitions.find(m=>m.modelId===id)?.name??id:'全部模型';
  const stale=report?clock-Date.parse(report.collectedAt)>90000:false;
  const activeCollection=report?.collectionEvents.find(e=>e.status==='active'),activeEvents=report?.events.filter(e=>e.status==='active')??[];
  const lastGood=[lastSuccess,report?.collection.lastSuccessAt].filter((v):v is string=>!!v).sort().at(-1);
  const total=report?.rows.find(r=>r.serviceId===null),readable=!error&&!stale&&report?.quality==='collected'&&!!total,collectionProblem=!!error||stale||report?.quality==='collection_failed'||!!activeCollection;
  function inspect(event:AlertEvent){
    const q:CallQuery={from:event.reading.from,to:event.reading.to,serviceId:event.ruleSnapshot.serviceId??undefined,modelId:event.ruleSnapshot.modelId??undefined,limit:50};
    const outcome=({upstream_failure_rate:'upstream_error',timeout_rate:'timeout',stream_failure_rate:'partial',cancellation_rate:'client_cancelled'} as const)[event.ruleSnapshot.metric as 'upstream_failure_rate'];if(outcome)q.outcome=outcome;
    detail('告警窗口内的调用',<CallExplorer key={event.id+event.reading.to} data={data} kind="calls" initialQuery={q} reconcile={edit.reconcile} detail={detail}/>);
  }
  async function acknowledge(event:AlertEvent|CollectionAlertEvent){setActionError('');try{await run('alert.ack',{id:event.id},false);await refresh();}catch{setActionError('知晓未成功，请重试。故障状态没有改变。');}}
  async function check(){setChecking(true);setActionError('');setCheckResult('');try{const r=await api<{collectionQuality:string}>('/api/v1/platform/monitoring/check',{});await refreshWorkspace();const current=await refresh();setCheckResult(r.collectionQuality==='collected'?(current?.collectionEvents.some(e=>e.status==='active')?'本次完整采集成功。采集故障仍需连续两个不同分钟的成功检查才能恢复。':'本次完整采集成功；故障恢复状态以采集记录为准。'):'本次采集仍失败，请按下方故障环节检查数据源。');}catch{setActionError('检查未完成，请确认控制面和统计数据库可用后重试。');}finally{setChecking(false);}}
  const knownBy=(e:AlertEvent|CollectionAlertEvent)=>e.acknowledgedAt?`${data.members.find(m=>m.id===e.acknowledgedBy)?.name??e.acknowledgedBy} 已知晓`:'待知晓';
  const eventRows=(events:AlertEvent[])=>events.slice().reverse().map(e=>[
    <>{e.ruleSnapshot.name}<small className="cell-help">{service(e.ruleSnapshot.serviceId)} / {model(e.ruleSnapshot.modelId)}</small></>,<>{e.status==='active'?'告警中':'已恢复'}<small className="cell-help">{knownBy(e)}</small></>,<>{e.reading.value===null?'未知':`${e.reading.value.toFixed(2)}${ALERT_METRICS[e.ruleSnapshot.metric].unit}`} / {e.ruleSnapshot.threshold}{ALERT_METRICS[e.ruleSnapshot.metric].unit}<small className="cell-help">{qualityLabels[e.reading.quality]} · 持续异常 {e.occurrences} 次</small></>,`${e.ruleSnapshot.windowMinutes} 分钟 / ${e.reading.sampleCount}`,<>{date(e.openedAt)}<small className="cell-help">{date(e.updatedAt)}</small></>,<div className="inline-actions"><button onClick={()=>inspect(e)}>查看窗口调用</button>{!e.acknowledgedAt&&hasPermission(data.actor,'monitoring.write')&&<button onClick={()=>void acknowledge(e)}>我已知晓</button>}</div>,
  ]);
  return <>
    <Panel title="当前运行情况" actions={<><button className="ghost" onClick={()=>setPaused(p=>!p)}>{paused?'恢复自动刷新':'暂停刷新'}</button><button className="ghost" onClick={()=>void refresh()}>刷新读数</button></>}>
      <div className="project-summary"><div>近 5 分钟已结束请求<strong>{readable?total.summary.ended:'未知'}</strong></div><div>请求异常<strong>{readable?total.summary.errors:'未知'}</strong></div><div>在途预占<strong>{readable?total.activeReservations:'未知'}</strong></div><div>待恢复告警<strong>{readable?activeEvents.length+(activeCollection?1:0):'未知'}</strong></div></div>
      <div className={`notice ${collectionProblem?'warning':''}`} role="status">{error?'当前无法读取运行指标':report?.quality==='collection_failed'?`当前采集失败：${collectionStages(report.failedStages)}`:stale?'采集延迟，当前读数已超过 90 秒':readable&&!total.summary.ended?'近 5 分钟没有已结束调用，暂不能判断模型健康':report?'当前页面读数采集成功':'正在读取…'}{paused?' · 自动刷新已暂停':' · 每 15 秒刷新读数'}</div>
      <p className="secondary">最近读取尝试：{lastAttempt?date(lastAttempt):'正在读取'} · 最近成功：{lastGood?date(lastGood):'暂无成功记录'}</p>
      <details className="disclosure" open={collectionProblem||undefined}><summary>采集状态与处理</summary>
      {error&&<p>{error}</p>}<p className="secondary">重新检查只读取统计数据，不调用模型、不发放额度；同一分钟内重复检查不会加快恢复。</p>
      <button className={collectionProblem?'primary':'ghost'} disabled={checking||!hasPermission(data.actor,'monitoring.write')} onClick={()=>void check()}>{checking?'正在检查…':'重新检查采集'}</button>
      {activeCollection?<div className="notice warning"><strong>采集故障尚未恢复 · {knownBy(activeCollection)}</strong><p>故障环节：{collectionStages(activeCollection.failedStages)}。请平台运维检查统计数据库连接、相关表及查询权限，再重新检查采集。</p><p>连续成功 {activeCollection.recoveries} / 2 个分钟 · 首次发现 {date(activeCollection.openedAt)}。知晓只记录处理人，不解除故障。</p>{!activeCollection.acknowledgedAt&&hasPermission(data.actor,'monitoring.write')&&<button onClick={()=>void acknowledge(activeCollection)}>我已知晓</button>}</div>:report&&<p>{report.collection.quality==='unknown'?'后台尚未完成首轮完整检查；可点击“重新检查采集”。':report.collection.quality==='collected'?'后台上次完整检查结果：采集成功。':'后台上次完整检查结果待核验，请重新检查。'}{report.collection.lastAttemptAt&&` 检查时间 ${date(report.collection.lastAttemptAt)}。`}</p>}
      {checkResult&&!stale&&!error&&<p className="notice" role="status">{checkResult}</p>}
      </details>
      {actionError&&<p className="notice danger" role="alert">{actionError}</p>}
    </Panel>
    <Panel title={readable?`需要处理的调用异常（${activeEvents.length}）`:report?'最近记录的调用异常':'调用异常'}>{activeEvents.length?<><p className="secondary">先查看异常窗口中的调用，再决定处理措施。知晓会记录操作人；有足够样本且达到恢复条件后，告警才会恢复。</p><Table headers={['事件 / 对象','状态 / 知晓','实际值 / 阈值','窗口 / 样本','首次 / 最近更新','操作']} rows={eventRows(activeEvents)}/></>:<p className="secondary">{!report&&!error?'正在读取告警…':!readable?'当前告警状态待核验，请刷新读数。':'当前没有待恢复的调用告警；无流量时不能据此判断模型健康。'}</p>}
    </Panel>
    {(report||error)&&<CallErrorBreakdown key={data.actor.id} data={data} window={report?{from:report.from,to:report.to}:null} readable={readable} active={active} detail={detail} reconcile={edit.reconcile}/>}
    <CapacityMonitoring data={data} active={active} detail={detail}/>
    <details className="disclosure"><summary>查看近 5 分钟运行指标</summary>
      <p className="secondary">近 5 分钟已结束的已识别身份请求；在途单列为有效预占数量。吞吐是窗口平均值；预占在途包含授权后尚未转发的请求。无流量不能用于判断健康，控制面未收到的请求不在样本中。</p>
      {!error&&!stale&&report?.quality==='collected'?<Table headers={['服务 / 模型','已结束 / 平均 RPM','预占在途','错误 / 上游失败','拒绝 / 限流','取消 / 超时 / 部分异常','P95 时延 / 样本','P95 TTFT / 样本','数据质量']} rows={report.rows.map(row=>{const s=row.summary;return [<>{service(row.serviceId)}<small className="cell-help">{model(row.modelId)}</small></>,`${s.ended} / ${(s.ended/5).toFixed(2)}`,row.activeReservations,`${s.errors} / ${s.upstreamFailures}`,`${s.rejected} / ${s.rateLimited}`,`${s.cancelled} / ${s.timeouts} / ${s.partial}`,s.latencySamples?`${s.p95LatencyMs} ms / ${s.latencySamples}`:'未知 / 0',s.ttftSamples?`${s.p95TtftMs} ms / ${s.ttftSamples}`:'未采集 / 0',s.ended?`${s.unknownUsage} 条用量未知；${s.unknownForwarding} 条转发未知`:'无流量，证据不足'];})}/>:<p className="notice warning">当前指标不可用。请先在上方重新检查采集，再刷新读数。</p>}
      <p className="secondary">上游故障分母是已转发且已结束的请求；授权拒绝和平台限流不算上游故障。TTFT 仅对流式正文或工具参数首个有效增量采样，非流式显示未采集。授权后的总时延与 TTFT 分别统计。</p>
    </details>
    <details className="disclosure"><summary>查看告警与采集恢复记录</summary><h3>采集故障与恢复</h3><Table headers={['首次发现 / 最近更新','状态 / 知晓','故障环节','恢复证据']} rows={(report?.collectionEvents??[]).slice().reverse().map(e=>[<>{date(e.openedAt)}<small className="cell-help">{date(e.updatedAt)}</small></>,<>{e.status==='active'?'待恢复':'已恢复'}<small className="cell-help">{knownBy(e)}</small></>,collectionStages(e.failedStages),e.recoveredAt?`恢复于 ${date(e.recoveredAt)}`:`连续成功 ${e.recoveries} / 2 个分钟`])}/><h3>已恢复的调用告警</h3><Table headers={['事件 / 对象','状态 / 知晓','实际值 / 阈值','窗口 / 样本','首次 / 最近更新','操作']} rows={eventRows(report?.events.filter(e=>e.status==='recovered')??[])}/></details>
    <RequestTraces data={data} active={active} detail={detail}/>
    <details className="disclosure"><summary>配置调用告警规则</summary><button className="primary" disabled={!hasPermission(data.actor,'monitoring.write')} onClick={()=>edit.alertRule()}>创建告警规则</button><p className="secondary">每分钟评估上一完整分钟结束时的滚动窗口。无流量、样本不足、转发覆盖不完整或采集失败不会自动解除已有告警。配置变更仅影响后续新事件。</p><Table headers={['规则 / 范围','指标 / 状态','触发条件','恢复条件','最近评估','操作']} rows={(report?.rules??[]).map(r=>{
      const evaluation=report?.evaluations[r.id];return [<>{r.name}<small className="cell-help">{r.poolId?data.pools.find(pool=>pool.id===r.poolId)?.name??r.poolId:'全部模型池'} / {service(r.serviceId)} / {model(r.modelId)}</small></>,<>{metricLabels[r.metric]}<small className="cell-help">{r.active?'产生新事件':'暂停新事件，已有事件继续核验恢复'}</small>{r.silencedUntil&&Date.parse(r.silencedUntil)>Date.now()&&<small className="cell-help">静默至 {date(r.silencedUntil)}</small>}</>,`≥ ${r.threshold}${ALERT_METRICS[r.metric].unit} · 连续 ${r.triggerCount} 次 · ≥ ${r.minSamples} 样本 · ${r.windowMinutes} 分钟`,`< ${r.recoveryThreshold}${ALERT_METRICS[r.metric].unit} · 连续 ${r.recoveryCount} 次`,evaluation?<>{qualityLabels[evaluation.reading.quality]}<small className="cell-help">{date(evaluation.reading.collectedAt)}</small></>:'等待首个完整评估窗口',<div className="inline-actions"><button className="link-button" disabled={!hasPermission(data.actor,'monitoring.write')} onClick={()=>edit.alertRule(r)}>编辑规则</button><button className="link-button" disabled={!hasPermission(data.actor,'monitoring.write')} onClick={()=>edit.alertSilence(r)}>静默 / 恢复通知</button></div>];
    })}/></details>
    <details className="disclosure"><summary>告警 Webhook 与投递记录</summary>
      <button className="primary" disabled={!hasPermission(data.actor,'monitoring.write')} onClick={()=>edit.notificationChannel()}>创建接收端</button>
      <p className="secondary">事件和投递任务一起保存。后台每分钟检查，失败退避重试最多 8 次。接收端应按事件编号去重，并校验时间戳与签名。修改或停用接收端会抑制旧配置的待发通知。</p>
      <Table headers={['接收端','地址 / 版本','状态','操作']} rows={(report?.channels??[]).map(channel=>[channel.name,<>{channel.url}<small className="cell-help">v{channel.version} · {channel.signingKeyRef}</small></>,channel.active?'启用':'停用',<button className="link-button" disabled={!hasPermission(data.actor,'monitoring.write')} onClick={()=>edit.notificationChannel(channel)}>编辑接收端</button>])} empty="还没有接收端。站内告警继续可用，可按需要配置 Webhook。"/>
      <Table headers={['事件 / 接收端','投递状态','尝试 / HTTP','最近尝试 / 下次重试','说明','操作']} rows={(report?.deliveries??[]).slice(-100).reverse().map(delivery=>[
        <>{delivery.eventId}<small className="cell-help">{delivery.channel.name} · v{delivery.channel.version}</small></>,
        ({pending:'等待投递',sending:'投递中',succeeded:'投递成功',failed:'重试已耗尽',suppressed:'配置变化或静默，已抑制'})[delivery.status],
        `${delivery.attempts} / ${delivery.httpStatus??'未返回'}`,
        <>{delivery.lastAttemptAt?date(delivery.lastAttemptAt):'未尝试'}<small className="cell-help">{delivery.nextAttemptAt?date(delivery.nextAttemptAt):'无自动重试'}</small></>,delivery.lastError??'—',
        delivery.status==='failed'&&hasPermission(data.actor,'monitoring.write')?<button className="link-button" onClick={()=>void run('notification.delivery.retry',{id:delivery.id}).then(()=>refresh()).catch(()=>setActionError('重试安排失败，请刷新后核对接收端配置。'))}>安排重试</button>:'—',
      ])} empty="还没有投递记录，配置接收端后产生的告警会在这里保留投递结果。"/>
    </details>
  </>;
}
