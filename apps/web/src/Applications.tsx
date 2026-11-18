import {memberIdentity} from './person-identity';
import {hasPermission} from '@ai-gateway/contracts';
import { useEffect,useRef,useState } from 'react';
import {useCallDetail} from './CallExplorer';
import type { ApplicationActivity,ApplicationCall,ApplicationDetail,PlatformSnapshot } from '@ai-gateway/contracts';
import { api } from './client';
import { date,money,Panel,Status,Table } from './components';
import { KeyDetails } from './KeyManager';
import type { makeEditors } from './editors';
import type { PageProps } from './WorkspacePages';

type Props=Pick<PageProps,'data'|'edit'|'setPage'|'detail'|'isOps'|'targetId'|'active'>;
type Key=PlatformSnapshot['keys'][number];
const live=(batch:{closedAt?:string|null;expiresAt:string})=>!batch.closedAt&&Date.parse(batch.expiresAt)>Date.now();
const sum=(values:number[])=>Number(values.reduce((total,value)=>total+value,0).toFixed(6));

const keyValid=(k:Key)=>k.status==='active'&&Date.parse(k.expiresAt)>Date.now();
function keyState(k:Key){
  if(k.status==='revoked')return '已吊销';
  if(k.status==='disabled')return '已停用';
  return keyValid(k)?'有效':'已过期';
}
function inactiveKeys(keys:Key[]){
  if(!keys.length)return '从未签发';
  return ['已过期','已停用','已吊销'].map(label=>({label,count:keys.filter(k=>keyState(k)===label).length}))
    .filter(group=>group.count).map(group=>`${group.label} ${group.count} 把`).join(' · ');
}
function failureReason(call:ApplicationCall){
  const reason=({timeout:'请求超时',upstream_error:'上游服务报错',partial:'响应中断',rejected_before_upstream:'网关拒绝请求',
    client_cancelled:'客户端取消',completed:'完成'})[call.outcome];
  return call.errorCode?`${reason} · ${call.errorCode}`:reason;
}
function activityLabel(activity?:ApplicationActivity){
  if(activity?.lastCall?.outcome==='client_cancelled')return {value:'pending',label:'最近调用已取消'};
  if(activity?.lastFailure&&activity.lastFailure.requestId===activity.lastCall?.requestId)return {value:'failed',label:'最近调用失败'};
  if(activity?.lastSuccess)return {value:'completed',label:'已接通'};
  return {value:'pending',label:'等待首次成功调用'};
}

/* 应用列表：与项目列表同一套骨架（统计条 + 即时筛选 + 表格），不再有“只有一个应用就直接进详情”的隐式跳转。 */
function ApplicationList({data:d,edit,isOps,setPage,staleId,active=true}:Omit<Props,'detail'> & {staleId:string|null}){
  const admin=d.actor.roles.includes('operator'),canFund=hasPermission(d.actor,'finance.write'),[query,setQuery]=useState(''),[state,setState]=useState(''),[scope,setScope]=useState('');
  const [activity,setActivity]=useState<Record<string,ApplicationActivity>|null>(null),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  useEffect(()=>{
    if(!active||!d.applications.length)return;
    let current=true;
    setError('');setActivity(null);
    void api<Record<string,ApplicationActivity>>('/api/v1/platform/application-activity').then(result=>{if(current)setActivity(result);})
      .catch(e=>{if(current)setError(e instanceof Error?e.message:'读取调用记录失败');});
    return ()=>{current=false;};
  },[active,d,retry]);
  const owner=(id:string)=>d.members.find(m=>m.id===id)?.name??id;
  const appKeys=(id:string)=>d.keys.filter(k=>k.subjectType==='application'&&k.subjectId===id);
  const activeKeys=(id:string)=>appKeys(id).filter(keyValid);
  /* 余额取应用钱包里仍然有效的批次合计；可用模型与准入价格以详情页为准。 */
  const balance=(id:string)=>sum(d.quotaBatches.filter(b=>b.purpose==='application'&&b.sourceId===id&&live(b)&&!!b.accounting===(d.applications.find(a=>a.id===id)?.billingMode==='accounting')).map(b=>b.availableAmount));
  const seesKeys=(a:PlatformSnapshot['applications'][number])=>hasPermission(d.actor,'audit.read')||a.ownerId===d.actor.id;
  const seesFunds=(a:PlatformSnapshot['applications'][number])=>hasPermission(d.actor,'finance.read')||a.ownerId===d.actor.id;
  const compact=(value:number)=>new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
  const day=(value:string)=>new Date(value).toLocaleDateString('zh-CN');
  const pendingOf=(id:string)=>d.approvals.find(a=>a.kind==='application_quota'&&a.objectId===id&&['pending','approved','failed'].includes(a.status));
  const pending=d.approvals.filter(a=>a.kind.startsWith('application_')&&['pending','approved','failed'].includes(a.status)&&(admin||a.applicantId===d.actor.id||d.applications.some(app=>app.id===a.objectId))).length;
  const paused=d.applications.filter(a=>!a.active).length,noKey=d.applications.filter(a=>seesKeys(a)&&!activeKeys(a.id).length).length;
  const activeCount=[query,state,scope].filter(Boolean).length;
  const rows=d.applications.filter(a=>{
    if(state==='active'&&!a.active)return false;
    if(state==='paused'&&a.active)return false;
    if(state==='nokey'&&(!seesKeys(a)||activeKeys(a.id).length))return false;
    if(state==='nobalance'&&(!seesFunds(a)||a.billingMode==='accounting'||balance(a.id)>0))return false;
    if(scope==='owned'&&a.ownerId!==d.actor.id)return false;
    return !query.trim()||`${a.name} ${a.description??''} ${owner(a.ownerId)}`.toLowerCase().includes(query.trim().toLowerCase());
  }).slice().sort((a,b)=>Number(b.active)-Number(a.active)||a.name.localeCompare(b.name,'zh-CN'));
  const clear=()=>{setQuery('');setState('');setScope('');};
  const emptyState=d.applications.length?<div className="empty-state"><strong>没有符合当前条件的应用</strong><p>已设置 {activeCount} 项筛选条件。可以清除筛选，或换一个状态再查。</p><div className="actions"><button className="ghost" onClick={clear}>清除筛选</button></div></div>:<div className="empty-state"><strong>还没有独立应用</strong><p>{isOps?'应用为工作流或业务系统分配独立的模型范围、额度和密钥。创建后指定负责人，由负责人在工具中完成接入。':'你名下的独立应用会显示在这里。个人日常使用无需应用，可直接在线使用；业务系统接入可申请创建应用，由运营确认后生效。'}</p><div className="actions">{isOps&&admin?<button className="ghost" onClick={()=>edit.application()}>创建应用</button>:!isOps&&<button className="ghost" onClick={()=>setPage('online')}>在线使用</button>}</div></div>;
  return <>
    {staleId&&<p className="notice warning">该应用已不在你的权限范围内，已返回应用列表。</p>}
    <Panel title={isOps?'应用接入':'我的应用'} actions={isOps&&admin?<button className="primary" onClick={()=>edit.application()}>创建应用</button>:!isOps&&<button className="primary" onClick={()=>edit.request('application_create',undefined,undefined,id=>setPage('approvals',id))}>申请创建应用</button>}>
      <p className="secondary">记账模式从 0 元开始，费用扣为负余额，不因余额不足停用；额度模式按有效批次余额控制调用。两种模式均使用独立 Key，不借用个人或项目额度。接入状态按该应用留存的全部调用记录判断。</p>
      <div className="metric-grid">{[['应用总数',d.applications.length,'','权限内可见'],['已暂停',paused,paused?'is-alert':'','暂停期间不接受新调用'],['无有效密钥',noKey,noKey?'is-alert':'','在可查看密钥的应用中统计'],['应用申请中',pending,pending?'is-alert':'','查看额度或模式切换进度']].map(([label,value,tone,hint])=><article className={`metric ${tone}`} key={String(label)}><span>{label}</span><strong>{value}</strong><small>{hint}</small></article>)}</div>
      <form className="call-filters call-filter-form" onSubmit={event=>event.preventDefault()}>
        <div className="filter-primary">
          <label>搜索名称 / 接入用途 / 负责人<input value={query} onChange={e=>setQuery(e.target.value)} placeholder="例如：报销助手、李四"/></label>
          <label>状态<select value={state} onChange={e=>setState(e.target.value)}><option value="">全部状态</option><option value="active">已启用</option><option value="paused">已暂停</option><option value="nokey">无有效密钥</option><option value="nobalance">额度模式余额不足</option></select></label>
          <label>负责人<select value={scope} onChange={e=>setScope(e.target.value)}><option value="">全部负责人</option><option value="owned">我负责的</option></select></label>
        </div>
        <div className="filter-actions">
          <span className="filter-state" role="status">即时筛选 · 显示 {rows.length} / {d.applications.length} 个应用{activeCount?` · 已设置 ${activeCount} 项条件`:''}</span>
          <button type="button" className="ghost" disabled={!activeCount} onClick={clear}>清除筛选</button>
        </div>
      </form>
      {error&&<p className="notice warning" role="alert">调用状态读取失败 · {error} <button className="link-button" onClick={()=>setRetry(n=>n+1)}>重新读取</button></p>}
      <Table headers={['应用','状态','负责人','模式 / 余额','有效密钥','最近调用','操作']} empty={emptyState} rows={rows.map(a=>{
        const keys=activeKeys(a.id),amount=balance(a.id),pendingApproval=pendingOf(a.id),history=activity?.[a.id],called=history?.lastCall,batchCount=d.quotaBatches.filter(b=>b.purpose==='application'&&b.sourceId===a.id&&live(b)).length;
        const noKey=seesKeys(a)&&!keys.length,noFunds=seesFunds(a)&&a.billingMode!=='accounting'&&amount<=0;
        const state=!a.active?{value:'disabled',label:'已暂停'}:noKey?{value:'pending',label:'无有效密钥'}:noFunds?{value:'failed',label:'调用受阻 · 无额度'}:activity?activityLabel(history):null;
        return [
          <>{a.name}<small className="cell-help">{a.description||'无说明'}</small></>,
          <>{state?<Status {...state}/>:<span className="secondary">{error?'调用状态未知':'正在读取…'}</span>}{a.active&&<small className="cell-help">已启用{state?.label!=='已接通'&&history?.firstSuccess?' · 曾成功接通':''}</small>}</>,
          <>{owner(a.ownerId)}{a.ownerId===d.actor.id&&<small className="cell-help">我负责</small>}</>,
          <>{a.billingMode==='accounting'?'记账模式':'额度模式'}<small className="cell-help">{seesFunds(a)?<>{money(amount)} · {a.billingMode==='accounting'?'允许负余额':batchCount?`批次 ${batchCount}`:'待发放额度'}</>:'余额不可见'}</small></>,
          seesKeys(a)?<>{keys.length} 把<small className="cell-help">{keys.length?`最早到期 ${day(keys.map(k=>k.expiresAt).sort()[0])}`:inactiveKeys(appKeys(a.id))}</small></>:<span className="secondary">无查看权限</span>,
          called?compact(Date.parse(called.completedAt)):<span className="secondary">{activity?'无调用':error?'未知':'读取中…'}</span>,
          <div className="inline-actions"><button onClick={()=>setPage('applications',a.id)}>进入接入</button>{a.active&&(admin||a.ownerId===d.actor.id)&&<button onClick={()=>edit.key('application',a.id)}>签发密钥</button>}{a.active&&a.billingMode!=='accounting'&&(canFund?<button onClick={()=>edit.fund('application',a)}>追加额度</button>:a.ownerId===d.actor.id?<button onClick={()=>pendingApproval?setPage('approvals',pendingApproval.id):edit.request('application_quota',a.id)}>{pendingApproval?'查看额度申请':'申请额度'}</button>:null)}</div>,
        ];
      })}/>
    </Panel>
  </>;
}

export function Applications(props:Props){
  const {data:d,targetId,isOps,setPage}=props,app=targetId?d.applications.find(a=>a.id===targetId):undefined;
  if(app)return <ApplicationTask key={app.id} id={app.id} {...props} onBack={()=>setPage('applications')}/>;
  return <ApplicationList active={props.active} data={d} edit={props.edit} setPage={setPage} isOps={isOps} staleId={targetId??null}/>;
}

function ApplicationTask({id,data:d,edit,setPage,detail,isOps,onBack}:Omit<Props,'targetId'> & {id:string;onBack:()=>void}){
  const [value,setValue]=useState<ApplicationDetail|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[retry,setRetry]=useState(0),[guide,setGuide]=useState(false);
  useEffect(()=>{let disposed=false;setLoading(true);setError('');void api<ApplicationDetail>(`/api/v1/platform/applications/${encodeURIComponent(id)}`).then(r=>{if(!disposed)setValue(r);}).catch(e=>{if(!disposed){setValue(null);setError(e instanceof Error?e.message:'读取应用失败');}}).finally(()=>{if(!disposed)setLoading(false);});return()=>{disposed=true;};},[id,d,retry]);
  const showCall=useCallDetail(d,detail),keySettings=useRef<HTMLDetailsElement>(null);
  function openKeys(){if(keySettings.current){keySettings.current.open=true;keySettings.current.querySelector('summary')?.focus();}}
  const back=<button type="button" className="link-button" onClick={onBack}>← 返回应用列表</button>;
  if(!value)return <>{back}<Panel title="应用接入"><p role="status">{error||'正在读取应用模型、额度和接入进度…'}</p>{error&&<button className="ghost" onClick={()=>setRetry(n=>n+1)}>重新读取</button>}</Panel></>;
  const {application:a,status}=value,accounting=a.billingMode==='accounting',ready=status==='ready',modelBlocked=['model_unavailable','price_unconfigured'].includes(status),quotaBlocked=['no_quota','quota_insufficient'].includes(status);
  const admin=hasPermission(d.actor,'administration.manage'),canFund=hasPermission(d.actor,'finance.write'),ownsApp=a.ownerId===d.actor.id;
  const canManageKeys=admin||ownsApp,canReadKeys=canManageKeys||hasPermission(d.actor,'audit.read');
  const issuedKeys=value.keys,keys=issuedKeys.filter(keyValid),key=keys[0];
  const {firstSuccess,lastSuccess,lastFailure,lastCall}=value.activity;
  const expiring=keys.filter(k=>Date.parse(k.expiresAt)<=Date.now()+7*86400000).sort((a,b)=>Date.parse(a.expiresAt)-Date.parse(b.expiresAt));
  const modelName=(id:string)=>value.models.find(m=>m.modelId===id)?.name??id;
  const running=!!lastSuccess&&ready&&!!key;
  const callStatus=activityLabel(value.activity);
  const failureIsLatest=!!lastFailure&&lastFailure.requestId===lastCall?.requestId;
  const forApplication=d.approvals.filter(p=>p.objectId===a.id&&['pending','approved','failed'].includes(p.status));
  const pending=forApplication.find(p=>p.kind===(accounting?'application_billing':'application_quota'));
  function nextStep(){
    if(status==='disabled')return {title:'应用已暂停',description:'恢复应用后可继续调用。',label:'检查并恢复应用',action:admin?()=>edit.application(a):null};
    if(modelBlocked)return {title:'调用受阻',description:status==='price_unconfigured'?'模型价格尚未确认，请由运营检查模型服务价格。':'当前范围没有可用模型，请检查模型池、服务连接和开放状态。',label:'检查模型配置',
      action:hasPermission(d.actor,'models.read')?()=>setPage(status==='price_unconfigured'?'models':'pools'):null};
    if(quotaBlocked){
      if(pending)return {title:'额度申请正在处理中',description:'申请生效后可继续接入。',label:'查看申请进度',action:()=>setPage('approvals',pending.id)};
      return {title:'调用受阻',description:'应用独立额度不足。',label:canFund?'发放应用额度':'申请应用额度',
        action:canFund?()=>edit.fund('application',a):ownsApp?()=>edit.request('application_quota',a.id):null};
    }
    if(!key)return {title:'无有效密钥',description:inactiveKeys(issuedKeys),label:'签发应用接入密钥',action:canManageKeys?()=>edit.key('application',a.id):null};
    const title=failureIsLatest?(firstSuccess?'最近一次调用失败':'首次接入尚未成功'):running?'应用已接通':'等待首次成功调用';
    const description=failureIsLatest?'根据失败原因调整配置后，在业务系统中重试。':running?'':'在业务系统中使用应用密钥发起请求，完成后刷新调用状态。';
    return {title,description,label:'查看接入配置',action:canReadKeys?()=>setGuide(true):null};
  }
  const next=nextStep();
  return <>{back}
    <Panel title={a.name} eyebrow="应用" actions={<Status value={a.active?'active':'disabled'}/>}>
      <p className="secondary">负责人：{memberIdentity(d,a.ownerId)} · {value.organizationName} · {accounting?'记账模式':'额度模式'}</p>{accounting&&!running&&<p className="notice">初始 0 元，按实际费用记为负余额，不因余额不足拦截调用。模型范围、价格、安全策略和调用保护继续生效。</p>}{a.description&&<p>{a.description}</p>}
      {!running&&<ol className="journey-steps" aria-label="应用接入进度"><li aria-current={modelBlocked||status==='disabled'?'step':undefined}>1 模型可用</li><li aria-current={quotaBlocked?'step':undefined}>{accounting?'2 记账已就绪':'2 准备额度'}</li><li aria-current={ready&&!key?'step':undefined}>3 签发密钥</li><li aria-current={ready&&key?'step':undefined}>{firstSuccess?'4 已有成功记录':'4 在工具中验证'}</li></ol>}
      <div className="next-step"><h3>{next.title}</h3>{next.description&&<p>{next.description}</p>}
        {modelBlocked||quotaBlocked?<Status value="failed" label="调用受阻"/>:ready&&key&&<Status {...callStatus}/>}
        {firstSuccess&&firstSuccess.requestId!==lastSuccess?.requestId&&<p className="secondary">首次接通 · {modelName(firstSuccess.modelId)} · {date(firstSuccess.completedAt)}</p>}
        {lastSuccess&&<p>最近成功调用 · {modelName(lastSuccess.modelId)} · {date(lastSuccess.completedAt)}{firstSuccess?.requestId===lastSuccess.requestId?'（首次接通）':''}</p>}
        {lastFailure&&<p className={failureIsLatest?'notice danger':'secondary'}>最近失败 · {date(lastFailure.completedAt)} · {failureReason(lastFailure)} {value.lastFailedCall&&<button className="link-button" onClick={()=>showCall(value.lastFailedCall!)}>查看失败请求详情</button>}</p>}
        {expiring.length>0&&<p className="notice warning">{expiring.length} 把密钥将在 7 天内到期 · 最早 {date(expiring[0].expiresAt)} <button className="link-button" onClick={openKeys}>查看临期密钥</button></p>}
        {next.action&&<button className={running?'ghost':'primary'} disabled={loading} onClick={next.action}>{next.label}</button>} <button className="ghost" disabled={loading} onClick={()=>setRetry(n=>n+1)}>{loading?'正在读取…':'刷新调用状态'}</button>{ready&&key&&(!running||guide)&&<p className="secondary">使用已有密钥 <code>{key.masked}</code>。完整值只在签发时显示过一次。{canManageKeys&&<button className="link-button" disabled={loading} onClick={()=>edit.key('application',a.id)}>需要一把新密钥</button>}</p>}</div>
      {ready&&<p className="secondary">当前可用模型：{value.models.filter(m=>m.status==='ready').map(m=>m.name).join('、')} · {accounting?'记账余额':'应用适用余额'} {money(value.availableAmount)}</p>}
      {guide&&ready&&key&&<section className="integration-guide"><KeyDetails keyId={key.id} data={d} guideOnly/></section>}
      {!isOps&&(status==='disabled'||modelBlocked)&&<p className="notice warning">请联系企业运营处理以上问题，模型或应用恢复后再继续接入。</p>}
    </Panel>
    <details className="disclosure"><summary>账目、额度与调用结果</summary><p>{accounting?'记账余额':'应用独立额度'} {money(accounting?value.accountingBalance:value.availableAmount)} · 历史已结束调用 {value.calls.summary.ended} 次 · 已确认费用 {money(value.calls.summary.confirmedAmount)}{value.calls.summary.pendingReview?` · ${value.calls.summary.pendingReview} 次待核对`:''}</p>
      {!accounting&&(canFund?<button className="ghost" onClick={()=>edit.fund('application',a)}>追加应用额度</button>:a.active&&ownsApp&&<button className="ghost" onClick={()=>pending?setPage('approvals',pending.id):edit.request('application_quota',a.id)}>{pending?'查看额度申请':'申请追加额度'}</button>)}
      {accounting&&<><p>切换为额度模式需由负责人提交申请，企业运营审批并执行后生效；原 Key 继续使用，历史账目保留，新额度单独使用。</p>{pending?<button className="ghost" onClick={()=>setPage('approvals',pending.id)}>查看模式切换申请</button>:a.active&&a.ownerId===d.actor.id?<button className="ghost" onClick={()=>edit.request('application_billing',a.id)}>申请切换为额度模式</button>:<p className="secondary">{a.active?'请由应用负责人发起模式切换申请。':'应用已暂停，恢复后可申请切换模式。'}</p>}</>}{!accounting&&value.batches.some(b=>b.accounting)&&<p className="notice">历史记账余额 {money(value.accountingBalance)}，单独保留，不抵扣当前可用额度。</p>}<h3>{accounting?'记账账户':'额度来源'}</h3><Table headers={['原始金额','账面余额','已消费','预占 / 待核对','已回收','有效期 / 状态','操作']} rows={value.batches.filter(b=>!!b.accounting===accounting).map(b=>[money(b.totalAmount),money(b.availableAmount),money(value.consumedByBatch[b.id]??0),money(Math.max(0,b.totalAmount-b.availableAmount-(b.closedAmount??0)-(value.consumedByBatch[b.id]??0))),money(b.closedAmount??0),<>{b.accounting?'长期记账':date(b.expiresAt)}<small className="cell-help">{!live(b)?'已过期或关闭，余额不可用':''}</small></>,!accounting&&live(b)?<div className="inline-actions">{canFund&&b.availableAmount>0&&<button className="danger-button" onClick={()=>edit.quotaChange('application',a,b.id,'reclaim')}>回收额度</button>}{(canFund||ownsApp)&&!b.expiresAt.startsWith('9999')&&<button onClick={()=>edit.quotaChange('application',a,b.id,'extend')}>{canFund?'延长有效期':'申请延期'}</button>}</div>:'—'])} empty="还没有应用额度。发放或申请额度后才能调用。"/>
      <h3>最近调用</h3><Table headers={['请求编号','模型','结果','计费','时间']} rows={value.calls.items.map(c=>[<button className="link-button" onClick={()=>showCall(c)}>{c.requestId}</button>,c.modelId,<Status value={c.outcome}/>,c.billableState==='confirmed'?money(c.actualAmount):<Status value={c.billableState}/>,date(c.completedAt)])} empty="尚无调用。请在工具或系统中发一条简短请求后刷新查看。"/>
    </details>
    <details className="disclosure" ref={keySettings}><summary>密钥管理与应用设置</summary><p>范围：{value.poolName} · {a.range.mode==='follow'?'跟随模型池':'仅指定模型'}</p>
      <Table headers={['密钥','状态','到期','操作']} rows={value.keys.slice().sort((a,b)=>Number(keyValid(b))-Number(keyValid(a))||Date.parse(a.expiresAt)-Date.parse(b.expiresAt)).map(k=>[<>{k.name}<small className="cell-help">{k.masked}</small></>,<Status value={keyState(k)==='已过期'?'expired':k.status} label={keyState(k)}/>,<>{date(k.expiresAt)}{expiring.some(e=>e.id===k.id)&&<small className="cell-help"><Status value="pending" label="7 天内到期"/></small>}</>,<div className="inline-actions"><button disabled={!canReadKeys} onClick={()=>detail('密钥详情与接入',(current:PlatformSnapshot)=><KeyDetails keyId={k.id} data={current}/>)}>查看接入与记录</button>{canManageKeys&&k.status!=='revoked'&&<><button onClick={()=>edit.keyStatus(k.id,k.status==='active'?'disabled':'active')}>{k.status==='active'?'停用':'启用'}</button><button onClick={()=>edit.keyStatus(k.id,'revoked')}>吊销</button></>}</div>])} empty="还没有密钥。签发后完整值只显示一次。"/>
      {admin&&<div className="actions"><button className="ghost" onClick={()=>edit.application(a)}>修改应用或交接负责人</button></div>}
      {accounting&&<p className="secondary">当前为记账模式；请在“账目、额度与调用结果”中申请切换额度模式。</p>}<h3>应用管理记录</h3><Table headers={['时间','操作人','动作','说明']} rows={value.history.map(h=>[date(h.createdAt),d.members.find(m=>m.id===h.actorId)?.name??h.actorId,({'application.reclaim':'回收应用额度','application.extend':'延长应用额度','application.initial_grant':'应用初始授额','application.changed':'应用配置与交接','save.application':'应用创建 / 修改 / 交接','application.fund':'发放额度','application.billing_changed':'记账转额度（审批生效）','key.issue':'签发密钥','key.status':'密钥状态变更'} as Record<string,string>)[h.action]??h.action,h.reason||'—'])} empty="还没有应用管理记录。额度、密钥与负责人变更会记录在这里。"/>
    </details>
  </>;
}
