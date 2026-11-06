import { useEffect,useState } from 'react';
import type { ApplicationDetail,PlatformSnapshot } from '@ai-gateway/contracts';
import { api } from './client';
import { date,money,Panel,Status,Table } from './components';
import { KeyDetails } from './KeyManager';
import type { makeEditors } from './editors';
import type { PageProps } from './WorkspacePages';

type Props=Pick<PageProps,'data'|'edit'|'setPage'|'detail'|'isOps'|'targetId'>;
type Key=PlatformSnapshot['keys'][number];
const live=(batch:{closedAt?:string|null;expiresAt:string})=>!batch.closedAt&&Date.parse(batch.expiresAt)>Date.now();
const sum=(values:number[])=>Number(values.reduce((total,value)=>total+value,0).toFixed(6));

/* 应用列表：与项目列表同一套骨架（统计条 + 即时筛选 + 表格），不再有“只有一个应用就直接进详情”的隐式跳转。 */
function ApplicationList({data:d,edit,isOps,setPage,staleId}:Omit<Props,'detail'> & {staleId:string|null}){
  const admin=d.actor.roles.includes('operator'),[query,setQuery]=useState(''),[state,setState]=useState(''),[scope,setScope]=useState('');
  const owner=(id:string)=>d.members.find(m=>m.id===id)?.name??id;
  const appKeys=(id:string)=>d.keys.filter(k=>k.subjectType==='application'&&k.subjectId===id);
  const activeKeys=(id:string)=>appKeys(id).filter(k=>k.status==='active'&&Date.parse(k.expiresAt)>Date.now());
  /* 余额取应用钱包里仍然有效的批次合计；可用模型与准入价格以详情页为准。 */
  const balance=(id:string)=>sum(d.quotaBatches.filter(b=>b.purpose==='application'&&b.sourceId===id&&live(b)&&!!b.accounting===(d.applications.find(a=>a.id===id)?.billingMode==='accounting')).map(b=>b.availableAmount));
  const lastCall=(id:string)=>{const rows=d.callLogs.filter(c=>c.subjectType==='application'&&c.subjectId===id);return rows.length?Math.max(...rows.map(c=>Date.parse(c.completedAt))):null;};
  const compact=(value:number)=>new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
  const day=(value:string)=>new Date(value).toLocaleDateString('zh-CN');
  const pendingOf=(id:string)=>d.approvals.find(a=>a.kind.startsWith('application_')&&a.objectId===id&&['pending','approved','failed'].includes(a.status));
  const pending=d.approvals.filter(a=>a.kind.startsWith('application_')&&['pending','approved','failed'].includes(a.status)&&(admin||d.applications.some(app=>app.id===a.objectId))).length;
  const paused=d.applications.filter(a=>!a.active).length,noKey=d.applications.filter(a=>!activeKeys(a.id).length).length;
  const activeCount=[query,state,scope].filter(Boolean).length;
  const rows=d.applications.filter(a=>{
    if(state==='active'&&!a.active)return false;
    if(state==='paused'&&a.active)return false;
    if(state==='nokey'&&activeKeys(a.id).length)return false;
    if(state==='nobalance'&&(a.billingMode==='accounting'||balance(a.id)>0))return false;
    if(scope==='owned'&&a.ownerId!==d.actor.id)return false;
    return !query.trim()||`${a.name} ${a.description??''} ${owner(a.ownerId)}`.toLowerCase().includes(query.trim().toLowerCase());
  }).slice().sort((a,b)=>Number(b.active)-Number(a.active)||a.name.localeCompare(b.name,'zh-CN'));
  const clear=()=>{setQuery('');setState('');setScope('');};
  const emptyState=d.applications.length?<div className="empty-state"><strong>没有符合当前条件的应用</strong><p>已设置 {activeCount} 项筛选条件。可以清除筛选，或换一个状态再查。</p><div className="actions"><button className="ghost" onClick={clear}>清除筛选</button></div></div>:<div className="empty-state"><strong>还没有独立应用</strong><p>{isOps?'应用为工作流或业务系统分配独立的模型范围、额度和密钥。创建后指定负责人，由负责人在工具中完成接入。':'你名下的独立应用会显示在这里。个人日常使用无需应用，可直接在线使用；业务系统接入由运营创建应用并指定你为负责人。'}</p><div className="actions">{isOps?<button className="ghost" onClick={()=>edit.application()}>创建应用</button>:<button className="ghost" onClick={()=>setPage('online')}>在线使用</button>}</div></div>;
  return <>
    {staleId&&<p className="notice warning">该应用已不在你的权限范围内，已返回应用列表。</p>}
    <Panel title={isOps?'应用接入':'我的应用'} actions={isOps?<button className="primary" onClick={()=>edit.application()}>创建应用</button>:undefined}>
      <p className="secondary">记账模式从 0 元开始，费用扣为负余额，不因余额不足停用；额度模式按有效批次余额控制调用。两种模式均使用独立 Key，不借用个人或项目额度。最近调用取自本次读取的调用记录（最多 200 条）。</p>
      <div className="metric-grid">{[['应用总数',d.applications.length,'','权限内可见'],['已暂停',paused,paused?'is-alert':'','暂停期间不接受新调用'],['未签发密钥',noKey,noKey?'is-alert':'','没有密钥无法接入'],['应用申请中',pending,pending?'is-alert':'','查看额度或模式切换进度']].map(([label,value,tone,hint])=><article className={`metric ${tone}`} key={String(label)}><span>{label}</span><strong>{value}</strong><small>{hint}</small></article>)}</div>
      <form className="call-filters call-filter-form" onSubmit={event=>event.preventDefault()}>
        <div className="filter-primary">
          <label>搜索名称 / 接入用途 / 负责人<input value={query} onChange={e=>setQuery(e.target.value)} placeholder="例如：报销助手、李四"/></label>
          <label>状态<select value={state} onChange={e=>setState(e.target.value)}><option value="">全部状态</option><option value="active">已启用</option><option value="paused">已暂停</option><option value="nokey">未签发密钥</option><option value="nobalance">额度模式余额不足</option></select></label>
          <label>负责人<select value={scope} onChange={e=>setScope(e.target.value)}><option value="">全部负责人</option><option value="owned">我负责的</option></select></label>
        </div>
        <div className="filter-actions">
          <span className="filter-state" role="status">即时筛选 · 显示 {rows.length} / {d.applications.length} 个应用{activeCount?` · 已设置 ${activeCount} 项条件`:''}</span>
          <button type="button" className="ghost" disabled={!activeCount} onClick={clear}>清除筛选</button>
        </div>
      </form>
      <Table headers={['应用','状态','负责人','模式 / 余额','有效密钥','最近调用','操作']} empty={emptyState} rows={rows.map(a=>{
        const keys=activeKeys(a.id),amount=balance(a.id),pendingApproval=pendingOf(a.id),called=lastCall(a.id),batchCount=d.quotaBatches.filter(b=>b.purpose==='application'&&b.sourceId===a.id&&live(b)).length;
        const hints=[!keys.length?'无密钥':'',a.billingMode!=='accounting'&&amount<=0?'无额度':''].filter(Boolean).join(' · ');
        return [
          <>{a.name}<small className="cell-help">{a.description||'无说明'}</small></>,
          <><Status value={a.active?'active':'disabled'}/>{hints&&<small className="cell-help">{hints}</small>}</>,
          <>{owner(a.ownerId)}{a.ownerId===d.actor.id&&<small className="cell-help">我负责</small>}</>,
          <>{a.billingMode==='accounting'?'记账模式':'额度模式'}<small className="cell-help">{money(amount)} · {a.billingMode==='accounting'?'允许负余额':batchCount?`批次 ${batchCount}`:'待发放额度'}</small></>,
          <>{keys.length} 把<small className="cell-help">{keys.length?`最早到期 ${day(keys.map(k=>k.expiresAt).sort()[0])}`:appKeys(a.id).length?`${appKeys(a.id).length} 把已失效`:'—'}</small></>,
          called===null?<span className="secondary">无调用</span>:compact(called),
          <div className="inline-actions"><button onClick={()=>setPage('applications',a.id)}>进入接入</button>{a.active&&(admin||a.ownerId===d.actor.id)&&<button onClick={()=>edit.key('application',a.id)}>签发密钥</button>}{a.active&&a.billingMode!=='accounting'&&(admin?<button onClick={()=>edit.fund('application',a)}>追加额度</button>:a.ownerId===d.actor.id?<button onClick={()=>pendingApproval?setPage('approvals',pendingApproval.id):edit.request('application_quota',a.id)}>{pendingApproval?'查看额度申请':'申请额度'}</button>:null)}</div>,
        ];
      })}/>
    </Panel>
  </>;
}

export function Applications(props:Props){
  const {data:d,targetId,isOps,setPage}=props,app=targetId?d.applications.find(a=>a.id===targetId):undefined;
  if(app)return <ApplicationTask key={app.id} id={app.id} {...props} onBack={()=>setPage('applications')}/>;
  return <ApplicationList data={d} edit={props.edit} setPage={setPage} isOps={isOps} staleId={targetId??null}/>;
}

function ApplicationTask({id,data:d,edit,setPage,detail,isOps,onBack}:Omit<Props,'targetId'> & {id:string;onBack:()=>void}){
  const [value,setValue]=useState<ApplicationDetail|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[retry,setRetry]=useState(0),[guide,setGuide]=useState(false);
  useEffect(()=>{let disposed=false;setLoading(true);setError('');void api<ApplicationDetail>(`/api/v1/platform/applications/${encodeURIComponent(id)}`).then(r=>{if(!disposed)setValue(r);}).catch(e=>{if(!disposed){setValue(null);setError(e instanceof Error?e.message:'读取应用失败');}}).finally(()=>{if(!disposed)setLoading(false);});return()=>{disposed=true;};},[id,d,retry]);
  const back=<button type="button" className="link-button" onClick={onBack}>← 返回应用列表</button>;
  if(!value)return <>{back}<Panel title="应用接入"><p role="status">{error||'正在读取应用模型、额度和接入进度…'}</p>{error&&<button className="ghost" onClick={()=>setRetry(n=>n+1)}>重新读取</button>}</Panel></>;
  const {application:a,status}=value,accounting=a.billingMode==='accounting',ready=status==='ready',modelBlocked=['model_unavailable','price_unconfigured'].includes(status),quotaBlocked=['no_quota','quota_insufficient'].includes(status);
  const keys=value.keys.filter((k:Key)=>k.status==='active'&&Date.parse(k.expiresAt)>Date.now()),key=keys[0];
  const pending=d.approvals.find(p=>p.kind.startsWith('application_')&&p.objectId===a.id&&['pending','approved','failed'].includes(p.status));
  const title=status==='disabled'?'应用已暂停':modelBlocked?'先处理模型配置':quotaBlocked?(pending?'额度申请正在处理中':'先准备应用额度'):!key?accounting?'记账模式已就绪，签发 Key 即可接入':'模型和额度已准备好，下一步签发密钥':'下一步：把应用接入工具或系统';
  const description=status==='disabled'?'暂停期间不接受新调用，原密钥、额度和历史保留。':status==='price_unconfigured'?'当前模型尚未确认完整价格，追加额度无法解决。请由运营确认模型服务价格。':status==='model_unavailable'?'当前范围没有可用模型。请由运营检查应用范围、服务连接和开放状态。':quotaBlocked?(pending?'查看申请当前节点和处理意见，生效后即可继续接入。':'应用使用独立额度，不能使用负责人的个人余额或项目额度。'):'使用支持 OpenAI Chat Completions 的工具，填写服务地址、已保存的完整密钥和模型标识，先发一条简短请求。';
  const primary=()=>status==='disabled'?isOps&&edit.application(a):modelBlocked?isOps&&setPage('models'):quotaBlocked?pending?setPage('approvals',pending.id):isOps?edit.fund('application',a):edit.request('application_quota',a.id):!key?edit.key('application',a.id):setGuide(true);
  return <>{back}
    <Panel title={a.name} eyebrow="应用" actions={<Status value={a.active?'active':'disabled'}/>}>
      <p className="secondary">负责人：{value.ownerName} · {value.organizationName} · {accounting?'记账模式':'额度模式'}</p>{accounting&&<p className="notice">初始 0 元，按实际费用记为负余额，不因余额不足拦截调用。模型范围、价格、安全策略和调用保护继续生效。</p>}{a.description&&<p>{a.description}</p>}
      <ol className="journey-steps" aria-label="应用接入进度"><li aria-current={modelBlocked||status==='disabled'?'step':undefined}>1 模型可用</li><li aria-current={quotaBlocked?'step':undefined}>{accounting?'2 记账已就绪':'2 准备额度'}</li><li aria-current={ready&&!key?'step':undefined}>3 签发密钥</li><li aria-current={ready&&key?'step':undefined}>4 在工具中验证</li></ol>
      <div className="next-step"><h3>{title}</h3><p>{description}</p>{(!(status==='disabled'||modelBlocked)||isOps)&&<button className="primary" disabled={loading} onClick={primary}>{status==='disabled'?'检查并恢复应用':modelBlocked?'检查模型配置':quotaBlocked?pending?'查看申请进度':isOps?'发放应用额度':'申请应用额度':!key?'签发应用接入密钥':'查看接入配置'}</button>}{ready&&key&&<p className="secondary">使用已有密钥 <code>{key.masked}</code>。完整值只在签发时显示过一次。<button className="link-button" disabled={loading} onClick={()=>edit.key('application',a.id)}>需要一把新密钥</button></p>}</div>
      {ready&&<p className="secondary">当前可用模型：{value.models.filter(m=>m.status==='ready').map(m=>m.name).join('、')} · {accounting?'记账余额':'应用适用余额'} {money(value.availableAmount)}</p>}
      {guide&&ready&&key&&<section className="integration-guide"><KeyDetails keyId={key.id} data={d} guideOnly/></section>}
      {!isOps&&(status==='disabled'||modelBlocked)&&<p className="notice warning">请联系企业运营处理以上问题，模型或应用恢复后再继续接入。</p>}
    </Panel>
    <details className="disclosure"><summary>账目、额度与调用结果</summary><p>{accounting?'记账余额':'应用独立额度'} {money(accounting?value.accountingBalance:value.availableAmount)} · 历史已结束调用 {value.calls.summary.ended} 次 · 已确认费用 {money(value.calls.summary.confirmedAmount)}{value.calls.summary.pendingReview?` · ${value.calls.summary.pendingReview} 次待核对`:''}</p>
      {!accounting&&(isOps?<button className="ghost" onClick={()=>edit.fund('application',a)}>追加应用额度</button>:a.active&&<button className="ghost" onClick={()=>pending?setPage('approvals',pending.id):edit.request('application_quota',a.id)}>{pending?'查看额度申请':'申请追加额度'}</button>)}
      {accounting&&<><p>切换为额度模式需由负责人提交申请，企业运营审批并执行后生效；原 Key 继续使用，历史账目保留，新额度单独使用。</p>{pending?<button className="ghost" onClick={()=>setPage('approvals',pending.id)}>查看模式切换申请</button>:a.active&&a.ownerId===d.actor.id?<button className="ghost" onClick={()=>edit.request('application_billing',a.id)}>申请切换为额度模式</button>:<p className="secondary">{a.active?'请由应用负责人发起模式切换申请。':'应用已暂停，恢复后可申请切换模式。'}</p>}</>}{!accounting&&value.batches.some(b=>b.accounting)&&<p className="notice">历史记账余额 {money(value.accountingBalance)}，单独保留，不抵扣当前可用额度。</p>}<h3>{accounting?'记账账户':'额度来源'}</h3><Table headers={['原始金额','剩余金额','到期时间']} rows={value.batches.filter(b=>!!b.accounting===accounting).map(b=>[money(b.totalAmount),money(b.availableAmount),b.accounting?'长期记账':date(b.expiresAt)])} empty="还没有应用额度。发放或申请额度后才能调用。"/>
      <h3>最近调用</h3><Table headers={['请求编号','模型','结果','计费','时间']} rows={value.calls.items.map(c=>[c.requestId,c.modelId,<Status value={c.outcome}/>,c.billableState==='confirmed'?money(c.actualAmount):<Status value={c.billableState}/>,date(c.completedAt)])} empty="尚无调用。请在工具或系统中发一条简短请求后刷新查看。"/>
    </details>
    <details className="disclosure"><summary>密钥管理与应用设置</summary><p>范围：{value.poolName} · {a.range.mode==='follow'?'跟随模型池':'仅指定模型'}</p>
      <Table headers={['密钥','状态','到期','操作']} rows={value.keys.map(k=>[<>{k.name}<small className="cell-help">{k.masked}</small></>,<Status value={Date.parse(k.expiresAt)<=Date.now()?'expired':k.status}/>,date(k.expiresAt),<div className="inline-actions"><button onClick={()=>detail('密钥详情与接入',(current:PlatformSnapshot)=><KeyDetails keyId={k.id} data={current}/>)}>查看接入与记录</button>{k.status!=='revoked'&&<><button onClick={()=>edit.keyStatus(k.id,k.status==='active'?'disabled':'active')}>{k.status==='active'?'停用':'启用'}</button><button onClick={()=>edit.keyStatus(k.id,'revoked')}>吊销</button></>}</div>])} empty="还没有密钥。签发后完整值只显示一次。"/>
      {isOps&&<div className="actions"><button className="ghost" onClick={()=>edit.application(a)}>修改应用或交接负责人</button></div>}
      {accounting&&<p className="secondary">当前为记账模式；请在“账目、额度与调用结果”中申请切换额度模式。</p>}<h3>应用管理记录</h3><Table headers={['时间','操作人','动作','说明']} rows={value.history.map(h=>[date(h.createdAt),d.members.find(m=>m.id===h.actorId)?.name??h.actorId,({'save.application':'应用创建 / 修改 / 交接','application.fund':'发放额度','application.billing_changed':'记账转额度（审批生效）','key.issue':'签发密钥','key.status':'密钥状态变更'} as Record<string,string>)[h.action]??h.action,h.reason||'—'])} empty="还没有应用管理记录。额度、密钥与负责人变更会记录在这里。"/>
    </details>
  </>;
}
