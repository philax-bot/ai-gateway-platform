import {callErrorFilter,describeCallError,hasPermission} from '@ai-gateway/contracts';
import type {CallErrorBreakdown as Breakdown,CallLog,CallQuery,PlatformSnapshot} from '@ai-gateway/contracts';
import { useEffect,useState,type ReactNode } from 'react';
import { api } from './client';
import { date,Panel,Status,Table } from './components';
import { CallExplorer } from './CallExplorer';

type Props={
  data:PlatformSnapshot;
  /* The monitoring snapshot window. The breakdown and its drill-down both use
     these exact bounds, so a row and the list it opens count the same calls. */
  window:{from:string;to:string}|null;
  readable:boolean;
  active:boolean;
  detail:(title:string,content:ReactNode)=>void;
  reconcile:(c:CallLog)=>void;
};
export function CallErrorBreakdown({data,window,readable,active,detail,reconcile}:Props){
  const [report,setReport]=useState<(Breakdown & {from:string;to:string})|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
  const from=window?.from,to=window?.to;
  useEffect(()=>{
    if(!active||!from||!to||!readable){setReport(null);setError('');setBusy(false);return;}
    let live=true;
    setBusy(true);setError('');
    void api<Breakdown>('/api/v1/platform/calls/errors',{from,to,limit:50})
      .then(value=>{if(live)setReport({...value,from:value.from??from,to:value.to??to});})
      .catch(()=>{if(live)setError('异常原因分布读取失败，请刷新重试。');})
      .finally(()=>{if(live)setBusy(false);});
    return()=>{live=false;};
  },[active,from,to,readable,refresh]);
  const service=(id:string|null)=>id?data.services.find(s=>s.id===id)?.name??id:'未记录服务';
  const model=(id:string)=>data.definitions.find(d=>d.modelId===id)?.name??id;
  const openCalls=(title:string,query:CallQuery)=>detail(title,<CallExplorer key={JSON.stringify(query)} data={data} kind="calls" initialQuery={{...query,limit:50}} reconcile={reconcile} detail={detail}/>);
  const rows=report?.buckets.map(bucket=>{
    const described=describeCallError(bucket.errorCode),denominator=bucket.group==='cancelled'?report.cancelled:report.errors;
    return [
      <>{service(bucket.serviceId)}<small className="cell-help">{model(bucket.modelId)}</small></>,
      <Status value={bucket.outcome}/>,
      <>{described.label}{described.known&&<small className="cell-help">{bucket.errorCode}</small>}</>,
      bucket.calls,
      denominator?`${(100*bucket.calls/denominator).toFixed(1)}%`:'—',
      <button type="button" className="link-button" aria-label={`查看${service(bucket.serviceId)}的${described.label}调用`} onClick={()=>openCalls('异常原因明细',callErrorFilter(bucket,report))}>查看调用</button>,
    ] as ReactNode[];
  })??[];
  const truncated=!!report&&report.bucketCount>report.buckets.length;
  return <Panel title="异常原因分布" actions={<button className="ghost" disabled={busy||!readable||!window} onClick={()=>setRefresh(n=>n+1)}>{busy?'正在读取…':'刷新分布'}</button>}>
    {readable&&error&&<p className="notice danger" role="alert">{error}{report&&'下方保留上一次读取的窗口。'}</p>}
    {!readable?<p className="notice warning" role="status">当前运行指标不可用，请先检查采集状态。</p>
      :!report?(!error&&<p className="secondary" role="status">正在读取异常原因…</p>)
      :<>
        <p className="secondary">窗口 {date(report.from)} 至 {date(report.to)} · 客户端取消单列，各行占比按异常或取消分别计算。</p>
        <div className="project-summary">
          <div>已结束请求<strong>{report.ended}</strong></div>
          <div>异常<strong>{report.errors}</strong></div>
          <div>客户端取消<strong>{report.cancelled}</strong></div>
          <div>异常中缺少错误码<strong>{report.unknownCode}</strong></div>
        </div>
        {report.ended?<Table headers={['服务 / 模型','结果','错误原因','笔数','占同类','操作']} empty="本窗口内已结束的调用均无异常或取消。" rows={rows}/>
          :<p className="notice" role="status">本窗口没有已结束的调用，样本不足。</p>}
        <div className="inline-actions">
          {truncated&&<span className="secondary">显示前 {report.buckets.length} 类，共 {report.bucketCount} 类。</span>}
          <button type="button" className="ghost" disabled={!report.errors} onClick={()=>openCalls('窗口内的异常调用',{from:report.from,to:report.to,resultGroup:'errors'})}>查看全部异常调用</button>
        </div>
        <small className="secondary">分布读取于 {date(report.collectedAt)}</small>
      </>}
    {!hasPermission(data.actor,'calls.read.all')&&<p className="secondary">统计范围包括你和本人应用的调用。</p>}
  </Panel>;
}
