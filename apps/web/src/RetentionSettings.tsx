import {useEffect,useState} from 'react';
import type {PlatformSnapshot,RetentionCounts,RetentionReport} from '@ai-gateway/contracts';
import {api} from './client';
import {date,Panel} from './components';
import type {makeEditors,RunCommand} from './editors';

export const retentionTotal=(counts:RetentionCounts)=>counts.notifications+counts.alerts+counts.collectionAlerts+counts.sessions;
export function RetentionCountsView({counts}:{counts:RetentionCounts}){return <dl className="detail-list"><div><dt>已读且事项结束的通知</dt><dd>{counts.notifications} 条</dd></div><div><dt>已恢复业务告警</dt><dd>{counts.alerts} 条</dd></div><div><dt>已恢复采集告警</dt><dd>{counts.collectionAlerts} 条</dd></div><div><dt>过期登录会话</dt><dd>{counts.sessions} 条</dd></div></dl>;}

export function RetentionSettings({data,edit,run}:{data:PlatformSnapshot;edit:ReturnType<typeof makeEditors>;run:RunCommand}){
  const [report,setReport]=useState<RetentionReport|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[reason,setReason]=useState('');
  useEffect(()=>{let disposed=false;setLoading(true);void api<RetentionReport>('/api/v1/platform/retention').then(value=>{if(!disposed){setReport(value);setError('');}}).catch(error=>{if(!disposed){setReport(null);setError(error instanceof Error?error.message:'无法检查保留记录');}}).finally(()=>{if(!disposed)setLoading(false);});return()=>{disposed=true;};},[data.revision]);
  async function inspect(){setLoading(true);setError('');try{setReport(await api<RetentionReport>('/api/v1/platform/retention'));}catch(error){setReport(null);setError(error instanceof Error?error.message:'无法检查保留记录');}finally{setLoading(false);}}
  async function cleanup(){
    if(!report||busy)return;setBusy(true);setError('');
    try{const result=await run('retention.run',{checkedAt:report.checkedAt,fingerprint:report.fingerprint,reason});if(result!==null){setReason('');await inspect();}}
    catch(error){const message=error instanceof Error?error.message:'清理未完成';await inspect();setError(message);}
    finally{setBusy(false);}
  }
  const last=report?.lastRun;
  return <Panel title="通知、告警与会话保留" actions={<button onClick={()=>edit.retentionPolicy()}>调整保留策略</button>}>
    <p>已读通知与已恢复告警保留 <strong>{data.settings.retentionDays} 天</strong>；登录会话到期后可清理。{data.settings.retentionAutomatic===true?'自动清理已开启，每天首次后台维护时检查一次（北京时间）。':'自动清理未开启，可先检查影响，再按需执行。'}</p>
    <p className="secondary">账本、调用元数据、审批、开通记录和操作审计继续保留。提示词与输出正文不写入持久化记录。未读通知、未完成事项、活跃告警及仍被保留通知引用的告警不会清理。</p>
    <div className="inline-actions"><button disabled={busy||loading} onClick={()=>void inspect()}>{loading?'正在检查…':'重新检查可清理记录'}</button>{report&&<small>检查时间 {date(report.checkedAt)}</small>}</div>
    {error&&<p className="notice danger" role="alert">{error}</p>}
    {report&&<><h3>本次可清理 {retentionTotal(report.eligible)} 条</h3><p className="secondary">通知与告警截至 {date(report.cutoff)} 以前；过期会话截至本次检查时间。检查和预览均不会删除数据。</p><RetentionCountsView counts={report.eligible}/>
      <details className="disclosure"><summary>查看继续保留的运行记录</summary><p>未读通知 {report.protected.unreadNotifications} 条；已读但事项尚未结束的通知 {report.protected.unfinishedNotifications} 条；活跃告警 {report.protected.activeAlerts} 条；未到期或需核验的会话 {report.protected.activeSessions} 条。</p></details>
      {retentionTotal(report.eligible)>0?<form className="retention-form" onSubmit={e=>{e.preventDefault();void cleanup();}}><label>本次清理原因<textarea required maxLength={2000} disabled={busy} value={reason} onChange={e=>setReason(e.target.value)} rows={2}/></label><button className="primary" disabled={busy||loading||!reason.trim()} type="submit">{busy?'正在处理…':`预览清理 ${retentionTotal(report.eligible)} 条`}</button></form>:<p className="notice">当前没有可清理记录。无需执行清理，现有业务可以继续使用。</p>}
      <h3>最近一次清理检查</h3>{last?<p>{date(last.executedAt)} · {last.source==='automatic'?'自动任务':data.members.find(m=>m.id===last.actorId)?.name??'运营管理员'} · 已清理 {retentionTotal(last.removed)} 条（通知 {last.removed.notifications}、业务告警 {last.removed.alerts}、采集告警 {last.removed.collectionAlerts}、过期会话 {last.removed.sessions}）。完整处理依据保存在下方操作审计。</p>:<p className="secondary">尚未执行清理。重新检查只读取数量，不会生成清理成功记录。</p>}
    </>}
  </Panel>;
}
