import { useEffect,useState } from 'react';
import type { ApplicationDetail,PlatformSnapshot } from '@ai-gateway/contracts';
import { api } from './client';
import { date,money,Panel,Status,Table } from './components';
import { KeyDetails } from './KeyManager';
import type { PageProps } from './WorkspacePages';

type Props=Pick<PageProps,'data'|'edit'|'setPage'|'detail'|'isOps'>;
export function Applications(props:Props){
  const {data:d,edit,isOps}=props,[selected,setSelected]=useState<string|null>(null);
  const app=d.applications.find(a=>a.id===selected)??(d.applications.length===1?d.applications[0]:null);
  return <>
    <div className="section-head"><p className="secondary">为工作流或业务系统配置独立接入，使用应用自己的模型范围和额度。</p>{isOps&&<button className="ghost" onClick={()=>edit.application()}>创建应用</button>}</div>
    {app?<>{d.applications.length>1&&<button className="link-button" onClick={()=>setSelected(null)}>← 返回应用列表</button>}<ApplicationTask key={app.id} id={app.id} {...props}/></>:<Panel title="选择要接入的应用">{d.applications.length?d.applications.map(a=><article className="resource-card" key={a.id}><div className="section-head"><h3>{a.name}</h3><Status value={a.active?'active':'disabled'}/></div><p className="secondary">负责人：{d.members.find(m=>m.id===a.ownerId)?.name??a.ownerId}</p>{a.description&&<p>{a.description}</p>}<button className="primary" onClick={()=>setSelected(a.id)}>查看接入步骤</button></article>):<><p className="secondary">尚无你负责的应用。个人日常使用可直接前往“在线使用”；业务系统接入由运营创建应用并指定负责人。</p>{isOps?<button className="primary" onClick={()=>edit.application()}>创建第一个应用</button>:<button className="primary" onClick={()=>props.setPage('online')}>在线使用</button>}</>}</Panel>}
  </>;
}

function ApplicationTask({id,data:d,edit,setPage,detail,isOps}:Props&{id:string}){
  const [value,setValue]=useState<ApplicationDetail|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[retry,setRetry]=useState(0),[guide,setGuide]=useState(false);
  useEffect(()=>{let disposed=false;setLoading(true);setError('');void api<ApplicationDetail>(`/api/v1/platform/applications/${encodeURIComponent(id)}`).then(r=>{if(!disposed)setValue(r);}).catch(e=>{if(!disposed){setValue(null);setError(e instanceof Error?e.message:'读取应用失败');}}).finally(()=>{if(!disposed)setLoading(false);});return()=>{disposed=true;};},[id,d,retry]);
  if(!value)return <Panel title="应用接入"><p role="status">{error||'正在读取应用模型、额度和接入进度…'}</p>{error&&<button className="ghost" onClick={()=>setRetry(n=>n+1)}>重新读取</button>}</Panel>;
  const {application:a,status}=value,ready=status==='ready',modelBlocked=['model_unavailable','price_unconfigured'].includes(status),quotaBlocked=['no_quota','quota_insufficient'].includes(status);
  const keys=value.keys.filter(k=>k.status==='active'&&Date.parse(k.expiresAt)>Date.now()),key=keys[0];
  const pending=d.approvals.find(p=>p.kind==='application_quota'&&p.objectId===a.id&&['pending','approved','failed'].includes(p.status));
  const title=status==='disabled'?'应用已暂停':modelBlocked?'先处理模型配置':quotaBlocked?(pending?'额度申请正在处理中':'先准备应用额度'):!key?'模型和额度已准备好，下一步签发密钥':'下一步：把应用接入工具或系统';
  const description=status==='disabled'?'暂停期间不接受新调用，原密钥、额度和历史保留。':status==='price_unconfigured'?'当前模型尚未确认完整价格，追加额度无法解决。请由运营确认模型服务价格。':status==='model_unavailable'?'当前范围没有可用模型。请由运营检查应用范围、服务连接和开放状态。':quotaBlocked?(pending?'查看申请当前节点和处理意见，生效后即可继续接入。':'应用使用独立额度，不能使用负责人的个人余额或项目额度。'):'使用支持 OpenAI Chat Completions 的工具，填写服务地址、已保存的完整密钥和模型标识，先发一条简短请求。';
  const primary=()=>status==='disabled'?isOps&&edit.application(a):modelBlocked?isOps&&setPage('models'):quotaBlocked?pending?setPage('approvals',pending.id):isOps?edit.fund('application',a):edit.request('application_quota',a.id):!key?edit.key('application',a.id):setGuide(true);
  return <>
    <Panel title={a.name} actions={<Status value={a.active?'active':'disabled'}/>}>
      <p className="secondary">负责人：{value.ownerName} · {value.organizationName}</p>{a.description&&<p>{a.description}</p>}
      <ol className="journey-steps" aria-label="应用接入进度"><li aria-current={modelBlocked||status==='disabled'?'step':undefined}>1 模型可用</li><li aria-current={quotaBlocked?'step':undefined}>2 准备额度</li><li aria-current={ready&&!key?'step':undefined}>3 签发密钥</li><li aria-current={ready&&key?'step':undefined}>4 在工具中验证</li></ol>
      <div className="next-step"><h3>{title}</h3><p>{description}</p>{(!(status==='disabled'||modelBlocked)||isOps)&&<button className="primary" disabled={loading} onClick={primary}>{status==='disabled'?'检查并恢复应用':modelBlocked?'检查模型配置':quotaBlocked?pending?'查看申请进度':isOps?'发放应用额度':'申请应用额度':!key?'签发应用接入密钥':'查看接入配置'}</button>}{ready&&key&&<p className="secondary">使用已有密钥 <code>{key.masked}</code>。完整值只在签发时显示过一次。<button className="link-button" disabled={loading} onClick={()=>edit.key('application',a.id)}>需要一把新密钥</button></p>}</div>
      {ready&&<p className="secondary">当前可用模型：{value.models.filter(m=>m.status==='ready').map(m=>m.name).join('、')} · 应用适用余额 {money(value.availableAmount)}</p>}
      {guide&&ready&&key&&<section className="integration-guide"><KeyDetails keyId={key.id} data={d} guideOnly/></section>}
      {!isOps&&(status==='disabled'||modelBlocked)&&<p className="notice warning">请联系企业运营处理以上问题，模型或应用恢复后再继续接入。</p>}
    </Panel>
    <details className="disclosure"><summary>额度与调用结果</summary><p>应用独立余额 {money(value.availableAmount)} · 历史已结束调用 {value.calls.summary.ended} 次 · 已确认费用 {money(value.calls.summary.confirmedAmount)}{value.calls.summary.pendingReview?` · ${value.calls.summary.pendingReview} 次待核对`:''}</p>
      {isOps?<button className="ghost" onClick={()=>edit.fund('application',a)}>追加应用额度</button>:a.active&&<button className="ghost" onClick={()=>pending?setPage('approvals',pending.id):edit.request('application_quota',a.id)}>{pending?'查看额度申请':'申请追加额度'}</button>}
      <h3>额度来源</h3><Table headers={['原始金额','剩余金额','到期时间']} rows={value.batches.map(b=>[money(b.totalAmount),money(b.availableAmount),date(b.expiresAt)])}/>
      <h3>最近调用</h3><Table headers={['请求编号','模型','结果','计费','时间']} rows={value.calls.items.map(c=>[c.requestId,c.modelId,<Status value={c.outcome}/>,c.billableState==='confirmed'?money(c.actualAmount):<Status value={c.billableState}/>,date(c.completedAt)])} empty="尚无调用。请在工具或系统中发一条简短请求后刷新查看。"/>
    </details>
    <details className="disclosure"><summary>密钥管理与应用设置</summary><p>范围：{value.poolName} · {a.range.mode==='follow'?'跟随模型池':'仅指定模型'}</p>
      <Table headers={['密钥','状态','到期','操作']} rows={value.keys.map(k=>[<>{k.name}<small className="cell-help">{k.masked}</small></>,<Status value={Date.parse(k.expiresAt)<=Date.now()?'expired':k.status}/>,date(k.expiresAt),<div className="inline-actions"><button onClick={()=>detail('密钥详情与接入',(current)=><KeyDetails keyId={k.id} data={current}/>)}>查看接入与记录</button>{k.status!=='revoked'&&<><button onClick={()=>edit.keyStatus(k.id,k.status==='active'?'disabled':'active')}>{k.status==='active'?'停用':'启用'}</button><button onClick={()=>edit.keyStatus(k.id,'revoked')}>吊销</button></>}</div>])}/>
      {isOps&&<div className="actions"><button className="ghost" onClick={()=>edit.application(a)}>修改应用或交接负责人</button></div>}
      <h3>应用管理记录</h3><Table headers={['时间','操作人','动作','说明']} rows={value.history.map(h=>[date(h.createdAt),d.members.find(m=>m.id===h.actorId)?.name??h.actorId,({'save.application':'应用创建 / 修改 / 交接','application.fund':'发放额度','key.issue':'签发密钥','key.status':'密钥状态变更'} as Record<string,string>)[h.action]??h.action,h.reason||'—'])}/>
    </details>
  </>;
}
