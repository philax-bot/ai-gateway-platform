import {useEffect,useState} from 'react';
import type {MediaTask,MediaTaskPage,PlatformSnapshot} from '@ai-gateway/contracts';
import {api,gatewayBaseUrl,gatewayFailureMessage} from './client';
import {date,Panel,Status,Table,Modal} from './components';
import {ModelIdentity} from './model-surface';
import {downloadBlob,safeMediaUrl} from './media-result';
const statuses:Record<MediaTask['status'],string>={submitting:'提交中',queued:'排队中',in_progress:'生成中',completed:'已完成',failed:'失败',cancelled:'已取消'};
const statusValue:Record<MediaTask['status'],string>={submitting:'pending',queued:'pending',in_progress:'pending',completed:'completed',failed:'failed',cancelled:'disabled'};

export function MediaTasks({data,active,targetId,setPage}:{data:PlatformSnapshot;active:boolean;targetId?:string|null;setPage:(page:string,id?:string)=>void}){
  const [cancelling,setCancelling]=useState<MediaTask|null>(null),[cancelBusy,setCancelBusy]=useState(false),[notice,setNotice]=useState('');
  const [page,setResults]=useState<MediaTaskPage|null>(null),[cursor,setCursor]=useState<string>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[paused,setPaused]=useState(false),[tick,setTick]=useState(0),[downloading,setDownloading]=useState('');
  useEffect(()=>{
    if(!active||paused)return;
    const timer=setInterval(()=>setTick(value=>value+1),5000);return()=>clearInterval(timer);
  },[active,paused]);
  useEffect(()=>{
    if(!active)return;let disposed=false;setBusy(true);
    void api<MediaTaskPage>('/api/v1/platform/media/tasks/query',{limit:50,cursor}).then(result=>{if(!disposed){setResults(result);setError('');}}).catch(cause=>{if(!disposed)setError(cause instanceof Error?cause.message:'任务读取失败');}).finally(()=>{if(!disposed)setBusy(false);});
    return()=>{disposed=true;};
  },[active,cursor,tick,data.revision]);
  async function download(task:MediaTask){
    if(downloading)return;setDownloading(task.id);setError('');
    try{
      const purpose=data.purposes.find(item=>item.id===task.purposeId);
      if(!purpose)throw new Error('当前用途已不可用，请核对权限，或使用该应用的有效 Key 获取结果。');
      const credential=await api<{token:string}>('/api/v1/platform/online-credential',{purpose:purpose.purpose,projectId:purpose.projectId});
      const response=await fetch(`${gatewayBaseUrl}/v1/videos/${encodeURIComponent(task.id)}/content`,{headers:{authorization:`Bearer ${credential.token}`}});
      if(!response.ok)throw new Error(gatewayFailureMessage(await response.text()));
      downloadBlob(await response.blob(),`${task.id}.mp4`);
    }catch(cause){setError(cause instanceof Error?cause.message:'视频下载失败');}finally{setDownloading('');}
  }
  async function cancel(){
    if(!cancelling||cancelBusy)return;setCancelBusy(true);setError('');
    try{
      const purpose=data.purposes.find(item=>item.id===cancelling.purposeId);
      if(!purpose)throw new Error('当前用途已不可用，不能取消该任务。');
      const credential=await api<{token:string}>('/api/v1/platform/online-credential',{purpose:purpose.purpose,projectId:purpose.projectId});
      const response=await fetch(`${gatewayBaseUrl}/v1/videos/${encodeURIComponent(cancelling.id)}/cancel`,{method:'POST',headers:{authorization:`Bearer ${credential.token}`}});
      if(!response.ok)throw new Error(gatewayFailureMessage(await response.text()));
      setNotice('已向供应商请求取消，最终状态以后台查询为准。费用未知时进入待核对。');setCancelling(null);setTick(value=>value+1);
    }catch(cause){setError(cause instanceof Error?cause.message:'取消结果未知，请核对任务状态。');setCancelling(null);}finally{setCancelBusy(false);}
  }
  return <><Panel title="视频任务中心" actions={<><button className="ghost" onClick={()=>setPage('multimodal')}>发起多模态调用</button><button className="ghost" onClick={()=>setPaused(value=>!value)}>{paused?'恢复自动刷新':'暂停刷新'}</button><button className="ghost" disabled={busy} onClick={()=>setTick(value=>value+1)}>{busy?'读取中…':'刷新任务'}</button></>}>
    <p className="secondary">个人与项目用途按自己的调用显示。应用负责人可查看所属应用任务，运营按职责查看运行记录。关闭页面后，后台仍持续查询视频结果。</p>
    {notice&&<p className="notice" role="status">{notice}</p>}
    {error&&<p className="notice danger" role="alert">{error}{page?' 下方保留上次读取结果。':''}</p>}
    {!page&&busy&&<p role="status">正在读取任务…</p>}
    {page&&<><p className="secondary">读取于 {date(page.collectedAt)}{targetId?` · 本次提交 ${targetId}`:''}</p>
      <Table headers={['任务 / 模型','状态 / 进度','用途 / 服务','费用状态','提交 / 结束','结果与操作']} empty={<div className="empty-state"><strong>还没有视频任务</strong><p>视频是异步任务：提交后由后台持续查询，关闭页面不会停止。先在多模态工作台选择视频模型并提交。</p><div className="actions"><button type="button" className="ghost" onClick={()=>setPage('multimodal')}>去多模态工作台</button></div></div>} rows={page.items.map(task=>{
        const url=task.canDownload&&task.externalDownload?safeMediaUrl(task.result?.url):null,definition=data.definitions.find(model=>model.modelId===task.modelId);
        const cancellationUnknown=task.result?.cancel_requested===true&&task.result.cancel_uncertain!==false;
        return [<div key={`${task.id}-identity`}><ModelIdentity name={definition?.name??task.modelId} modelId={task.modelId} kind="video"/><small className="cell-help">任务 {task.id}</small><small className="cell-help">请求 {task.requestId}</small></div>,<><Status value={statusValue[task.status]} label={statuses[task.status]}/><small className="cell-help">{typeof task.result?.progress==='number'?`进度 ${task.result.progress}%`:'进度未知'}{task.errorCode?` · ${task.errorCode}`:''}{task.result?.cancel_requested===true?cancellationUnknown?' · 取消结果待确认，可刷新后重试':' · 已请求取消':''}</small></>,<>{data.purposes.find(purpose=>purpose.id===task.purposeId)?.name??(task.purpose==='application'?'应用任务':'其他授权范围')}<small className="cell-help">{task.serviceName??'来源未采集'}</small><small className="cell-help">{task.poolName??''}</small></>,task.reservationStatus==='pending_review'?<Status value="pending_review"/>:task.settled?<Status value="confirmed"/>:<span className="quiet-state">预占中</span>,<>{date(task.createdAt)}<small className="cell-help">{task.finishedAt?date(task.finishedAt):'尚未结束'}</small></>,
          <div className="inline-actions">{task.canCancel&&<button className="danger-button" disabled={task.result?.cancel_requested===true&&!cancellationUnknown} onClick={()=>setCancelling(task)}>{cancellationUnknown?'重新请求取消':'取消任务'}</button>}{task.status==='completed'&&task.canDownload&&(url?<a href={url} target="_blank" rel="noopener noreferrer">打开供应商结果</a>:task.purpose!=='application'?<button className="link-button" disabled={!!downloading} onClick={()=>void download(task)}>{downloading===task.id?'下载中…':'下载视频'}</button>:<span>使用应用 Key 下载</span>)}<button className="link-button" onClick={()=>setPage('calls')}>查看调用记录</button></div>];
      })}/>
      <div className="actions">{cursor&&<button className="ghost" onClick={()=>setCursor(undefined)}>返回最新</button>}{page.nextCursor&&<button className="ghost" onClick={()=>setCursor(page.nextCursor!)}>更早任务</button>}</div>
    </>}
  </Panel>{cancelling&&<Modal title="请求供应商取消视频任务" onClose={()=>{if(!cancelBusy)setCancelling(null);}} footer={<button className="danger-button" disabled={cancelBusy} onClick={()=>void cancel()}>{cancelBusy?'请求中…':'确认请求取消'}</button>}>
    <p>将请求供应商停止任务 {cancelling.id}。取消是否成功以供应商确认与后台查询为准，已经产生的费用仍需结算，用量未知时保留待核对。</p>
  </Modal>}</>;
}
