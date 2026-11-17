import {useEffect,useState,type ReactNode} from 'react';
import type {CapacityMetric,CapacityRow,CapacitySnapshot,PlatformSnapshot} from '@ai-gateway/contracts';
import {api} from './client';
import {date,Field,Panel,Status,Table} from './components';
import {ShareBar} from './components-charts';
import {RequestTraces} from './RequestTraces';

const kindNames={service:'模型服务',service_model:'服务下模型',pool:'模型池',shared:'共享容量'};
const ratio=(n:number)=>n===0?'0%':n<0.1?'<0.1%':n<100&&n>99.9?'>99.9%':`${Number(n.toFixed(1))}%`;
function reading(metric:CapacityMetric){
  const p=metric.percent;
  return <><strong>{metric.used.toLocaleString('zh-CN')} / {metric.limit===null?'未设上限':metric.limit.toLocaleString('zh-CN')}</strong>{p!==null&&<ShareBar ratio={p/100} label={ratio(p)} tone={p>=100?'danger':p>=80?'warn':'action'}/>}</>;
}
export function CapacityMonitoring({data,active,detail}:{data:PlatformSnapshot;active:boolean;detail:(title:string,content:ReactNode)=>void}){
  const [snapshot,setSnapshot]=useState<CapacitySnapshot|null>(null),[error,setError]=useState(''),[paused,setPaused]=useState(false),[kind,setKind]=useState(''),[refresh,setRefresh]=useState(0),[clock,setClock]=useState(Date.now());
  useEffect(()=>{if(!active||paused)return;let live=true,loading=false;
    const load=async()=>{if(loading)return;loading=true;try{const r=await api<CapacitySnapshot>('/api/v1/platform/monitoring/capacity');if(live){setSnapshot(r);setError(r.quality==='collected'?'':'容量采集失败，请刷新；当前占用未知。');}}catch{if(live)setError('暂时无法读取容量，请刷新；旧读数不能代表当前压力。');}finally{loading=false;}};
    void load();const timer=setInterval(()=>void load(),5000),tick=setInterval(()=>setClock(Date.now()),1000);return()=>{live=false;clearInterval(timer);clearInterval(tick);};
  },[active,paused,refresh]);
  const stale=!!snapshot&&clock-Date.parse(snapshot.collectedAt)>15000,readable=snapshot?.quality==='collected'&&!error&&!stale;
  const all=snapshot?.rows??[],peak=(r:CapacityRow)=>Math.max(-1,...[r.rpm.percent,r.tpm.percent,r.concurrency.percent].filter((n):n is number=>n!==null));
  const rows=all.filter(r=>!kind||r.kind===kind).sort((a,b)=>peak(b)-peak(a)||a.name.localeCompare(b.name));
  const inspect=(row:CapacityRow)=>detail('资源访问链路',<RequestTraces data={data} active={true} detail={detail} initialQuery={row.kind==='pool'?{poolId:row.resourceId}:row.kind==='service'?{serviceId:row.resourceId}:row.kind==='service_model'?{serviceId:row.resourceId.split(':')[0]}:{}}/>);
  return <Panel title="实时容量与压力" actions={<><button className="ghost" onClick={()=>setPaused(v=>!v)}>{paused?'恢复容量刷新':'暂停容量刷新'}</button><button className="ghost" onClick={()=>{setPaused(false);setRefresh(v=>v+1);}}>刷新容量</button></>}>
    <div className="metric-grid">{[['模型服务',all.filter(r=>r.kind==='service').length],['模型池',all.filter(r=>r.kind==='pool').length],['服务 / 池达到 80%',all.filter(r=>['service','pool'].includes(r.kind)&&peak(r)>=80).length],['服务 / 池达到 100%',all.filter(r=>['service','pool'].includes(r.kind)&&peak(r)>=100).length]].map(([label,value])=><article className="metric" key={label}><span>{label}</span><strong>{readable?value:'未知'}</strong></article>)}</div>
    <p className="secondary">每 5 秒读取一次 · 容量占用 / 当前有效上限 · RPM、TPM 按当前固定分钟，Token 含预估预占及结算调整，并发为有效预占槽位。</p>
    {snapshot&&<p className="secondary">窗口 {date(snapshot.windowStart)} 至 {date(snapshot.windowEnd)} · 采集于 {date(snapshot.collectedAt)}{paused?' · 刷新已暂停':''}</p>}
    <div className="filter-bar"><Field spec={{key:'capacity-kind',label:'资源范围',type:'select',options:[{value:'',label:'全部层级'},...Object.entries(kindNames).map(([value,label])=>({value,label}))]}} value={kind} onChange={v=>setKind(String(v))}/></div>
    {error||stale?<p role="alert" className="notice warning">{error||'容量读数已超过 15 秒，当前占用未知；请刷新。'}</p>:!snapshot?<p role="status">正在读取实时容量…</p>:null}
    {readable&&<Table headers={['资源 / 层级','RPM 当前 / 上限','TPM 当前 / 上限','并发当前 / 上限','压力 / 配置来源','调用追溯']} empty="尚未配置模型服务或模型池；接入资源后可在这里查看容量。" rows={rows.map(row=>[<>{row.name}<small className="cell-help">{kindNames[row.kind]}{row.enabled?'':' · 未启用 / 未开放'}</small></>,reading(row.rpm),reading(row.tpm),reading(row.concurrency),<><Status value={peak(row)>=100?'failed':peak(row)>=80?'pending':'active'} label={peak(row)<0?'未设上限':peak(row)>=100?'已满载':peak(row)>=90?'高占用':peak(row)>=80?'接近上限':'未达预警线'}/><small className="cell-help">{row.inherited?'继承企业默认':'本级配置'}</small></>,row.kind==='shared'?'跨服务共同计数':<button className="link-button" onClick={()=>inspect(row)}>查看访问链路</button>])}/ >}
    <details className="disclosure"><summary>容量口径与瓶颈</summary><p className="secondary">服务、服务下模型、池、共享组分别执行各自限制，同一请求不能跨层相加。任一适用上限达到 100% 都可能阻止新准入；人员、项目和应用限制另外生效。未设上限不表示无限物理算力，未达预警线不代表服务健康。此处反映本网关容量占用，不包含供应商其他客户或 GPU 利用率。</p></details>
  </Panel>;
}
