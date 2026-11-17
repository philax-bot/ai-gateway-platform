import {PersonPicker} from './PersonPicker';
import {memberIdentity} from './person-identity';
import { useEffect, useState } from 'react';
import {hasPermission} from '@ai-gateway/contracts';
import type { PlatformSnapshot } from '@ai-gateway/contracts';
import { date, money, Panel, Status } from './components';
import type { PageProps } from './WorkspacePages';
import { responsible } from './ApprovalCenter';
import { availablePlanModels as availableModels,entryReadiness,planReadiness } from './model-readiness';

function eligible(d:PlatformSnapshot,member:PlatformSnapshot['members'][number]){
  if(!member.active||(member.validUntil&&Date.parse(member.validUntil)<=Date.now()))return false;
  let id:string|null=member.organizationId;const seen=new Set<string>();
  while(id){if(seen.has(id))return false;seen.add(id);const org=d.organizations.find(o=>o.id===id);if(!org?.active)return false;id=org.parentId;}
  return true;
}

export function OperationsHome({data:d,setPage}:Pick<PageProps,'data'|'setPage'>){
  const usablePlans=d.plans.filter(p=>p.active&&availableModels(d,p).length),hasService=d.services.some(s=>s.active&&s.verification==='passed'&&s.mappings.some(m=>d.definitions.some(def=>def.active&&def.id===m.definitionId)&&[m.inputPrice,m.outputPrice,m.cachedInputPrice].every(p=>p!==null))),hasOpenPool=d.pools.some(p=>p.entries.some(e=>!entryReadiness(d,e)));
  const pending=d.approvals.filter(a=>a.status==='pending'&&responsible(d,a)).length,failed=d.approvals.filter(a=>['failed','approved'].includes(a.status)&&responsible(d,a)).length;
  /* hero 的主数值是合计，分项仍在下方的统计条；两者相加不重复。 */
  const attention=pending+failed+(d.pendingReviewCount??0);
  /* 口径：只统计本人有权处理的审批；待核对数量来自费用采集，采集失败时为未知，不显示为 0。 */
  const entitled=new Set(d.entitlements.filter(e=>e.status==='active'&&Date.parse(e.expiresAt)>Date.now()).map(e=>e.memberId)).size;
  const blocked=!hasService?{title:'先接通一个可用模型',body:'验证模型连接并确认价格后，才能开放给同事使用。',label:'配置并验证模型',page:'models'}:!hasOpenPool?{title:'模型已接通，下一步开放使用范围',body:'选择允许同事使用的模型，保存到模型池。',label:'开放模型',page:'pools'}:!usablePlans.length?{title:'还需要一份人员开通方案',body:'把可用模型和每人额度保存为方案，开通时直接选用。',label:'设置开通方案',page:'plans'}:null;
  return <>
    <Panel title="需要你处理"><div className="task-inbox">{[
      {count:pending,title:'申请待审批',body:'查看申请人的用途，决定是否批准。',page:'approvals'},
      {count:failed,title:'批准后尚未生效',body:'检查执行结果，处理失败或继续执行。',page:'approvals'},
      {count:d.pendingReviewCount,title:'调用费用待核对',body:'确认实际用量后，处理保留的预占。',page:'reviews'},
    ].filter(t=>t.count!==null&&t.count>0).map(t=><button key={t.title} className="task-row" onClick={()=>setPage(t.page)}><span><strong>{t.title}</strong><small>{t.body}</small></span><b>{t.count} 项 →</b></button>)}{d.pendingReviewCount===null&&<button className="task-row" onClick={()=>setPage('monitoring')}><span><strong>调用费用统计待核验</strong><small>统计暂不可用，请先检查采集，再处理费用核对。</small></span><b>检查采集 →</b></button>}{!pending&&!failed&&d.pendingReviewCount===0&&<p className="secondary">当前没有待处理的审批或费用核对。</p>}</div></Panel>
    <section className="panel task-hero"><span className="eyebrow">{blocked?'准备开始':'日常运营'}</span><h2>{blocked?.title??'让同事开始使用 AI'}</h2><p>{blocked?.body??'选择人员和现有方案，确认后开通。开通结果会告诉你接下来该做什么。'}</p><div className="task-hero-num"><span className="task-hero-val">{attention}</span><span className="task-hero-unit">项待处理</span></div><p className="task-hero-note">{blocked?'完成左侧这一步后即可为同事开通。':'含待审批、批准未生效与费用待核对；按你的审批职责统计。'}</p><button className="primary" onClick={()=>setPage(blocked?.page??'onboarding')}>{blocked?.label??'为同事开通'}</button><div className="task-hero-side"><span className="task-hero-side-title">当前运营口径</span><div className="task-hero-kv"><span>企业</span><b>{d.settings.name}</b></div><div className="task-hero-kv"><span>个人默认池</span><b>{d.pools.find(p=>p.id===d.settings.personalDefaultPoolId)?.name??'未设置'}</b></div><div className="task-hero-kv"><span>已开放模型</span><b>{d.definitions.filter(def=>def.active).length} 个</b></div></div></section>
    <div className="metric-grid">{[['申请待审批',pending,pending>0?'is-alert':'','按你的审批职责'],['费用待核对',d.pendingReviewCount===null?'未知':d.pendingReviewCount,d.pendingReviewCount?'is-alert':'','需人工确认后结算'],['可用开通方案',usablePlans.length,'','包含可用模型'],['已开通人员',entitled,'','权益有效且未到期']].map(([label,value,tone,hint])=><article className={`metric ${tone}`} key={String(label)}><span>{label}</span><strong>{value}</strong><small>{hint}</small></article>)}</div>
    <p className="secondary">需要排查服务或查看调用记录时，可从导航中的“配置与排查”进入。</p>
  </>;
}

export function EnableColleague({data:d,run,setPage,edit}:Pick<PageProps,'data'|'run'|'setPage'|'edit'>){
  const [step,setStep]=useState(0),[selected,setSelected]=useState<string[]>([]),[planId,setPlanId]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [receipt,setReceipt]=useState<{names:string[];planName:string;granted:number;skipped:number;failed:number}|null>(null);
  const [restored,setRestored]=useState(false);
  const [createdPlanId,setCreatedPlanId]=useState('');
  const draftKey='signal-atlas.onboarding-draft';
  const people=d.members.filter(m=>eligible(d,m)),plans=[...d.plans].sort((a,b)=>Number(!!planReadiness(d,a))-Number(!!planReadiness(d,b))),plan=plans.find(p=>p.id===planId),blockedReason=plan?planReadiness(d,plan):null;
  const canManage=hasPermission(d.actor,'administration.manage');
  const invalidSelected=selected.some(id=>!people.some(m=>m.id===id));
  useEffect(()=>{
    try{
      const raw=window.sessionStorage.getItem(draftKey);if(!raw)return;
      const draft=JSON.parse(raw) as {step?:number;selected?:string[];planId?:string;query?:string};
      const kept=(draft.selected??[]).filter(id=>typeof id==='string').slice(0,1000);
      if(kept.length){setSelected(kept);setStep(draft.step===1?1:0);setPlanId(plans.some(p=>p.id===draft.planId)?draft.planId??'':'');setRestored(true);}
    }catch{/* A corrupt or unavailable draft only means starting fresh. */}
  },[]);
  useEffect(()=>{
    try{
      if(receipt||!selected.length)window.sessionStorage.removeItem(draftKey);
      else window.sessionStorage.setItem(draftKey,JSON.stringify({step,selected,planId}));
    }catch{/* Private browsing can reject storage; the in-memory draft still works. */}
  },[step,selected,planId,receipt]);
  function restart(){setSelected([]);setPlanId('');setStep(0);setRestored(false);setCreatedPlanId('');}
  function createPlan(){edit.plan(undefined,created=>{setPlanId(created.id);setCreatedPlanId(created.id);setError('');});}
  async function open(){
    if(!plan||blockedReason)return;setBusy(true);setError('');
    try{const result=await run('distribution.execute',{operation:'open_plan',planId:plan.id,memberIds:selected}) as {results:{memberId:string;status:string}[]}|null;
      if(result)setReceipt({names:selected.map(id=>memberIdentity(d,id)),planName:plan.name,granted:result.results.filter(r=>r.status==='granted').length,skipped:result.results.filter(r=>r.status==='skipped').length,failed:result.results.filter(r=>r.status==='failed').length});
    }catch(e){setError(e instanceof Error?e.message:'开通失败，请重试');}finally{setBusy(false);}
  }
  if(receipt)return <Panel title={receipt.granted?'开通已完成':'本次开通结果'}>
    <p className="secondary">本次提交 {receipt.names.length} 人：{receipt.names.join('、')}</p>
    <div className="metric-grid">
      <article className="metric"><span>成功开通</span><strong>{receipt.granted}</strong><small>已生成额度</small></article>
      <article className={`metric ${receipt.skipped?'is-alert':''}`}><span>跳过</span><strong>{receipt.skipped}</strong><small>已有权益等不重复开通</small></article>
      <article className={`metric ${receipt.failed?'is-danger':''}`}><span>失败</span><strong>{receipt.failed}</strong><small>需查看逐人原因</small></article>
      <article className="metric"><span>本次方案</span><strong className="is-text">{receipt.planName}</strong><small>金额与到期日以服务端为准</small></article>
    </div>
    {receipt.granted>0&&<div className="next-step"><h3>下一步：让同事登录后选择“在线使用”</h3><p>同事使用自己的登录账号即可开始，无需先创建项目或密钥。登录账号和密码由企业管理员提供。</p></div>}{(receipt.skipped>0||receipt.failed>0)&&<p className="notice warning">部分人员未新增额度，请展开下方“开通设置与记录”查看本次逐人结果和原因。</p>}<button className="primary" onClick={()=>{setReceipt(null);restart();}}>继续为其他人开通</button></Panel>;
  return <Panel title="让同事开始使用 AI"><ol className="journey-steps" aria-label="开通进度"><li aria-current={step===0?'step':undefined}>1 选择人员</li><li aria-current={step===1?'step':undefined}>2 选择方案</li><li>3 确认并开通</li></ol>
    {restored&&<div className="notice" role="status">已恢复上次未完成的进度：{selected.length} 人{step===1&&plan?` · 方案「${plan.name}」`:''}。离开本页或切换页面不会清空草稿。<button type="button" className="link-button" onClick={restart}>重新开始</button></div>}
    {(selected.length>0||plan)&&<div className="choice-summary"><span><b>人员</b>{selected.length?`已选 ${selected.length} 人`:'未选择'}</span><span><b>方案</b>{plan?plan.name:'未选择'}</span>{plan&&<span><b>每人额度</b>{money(plan.amount)}</span>}</div>}
    {step===0?<><h3>这次为谁开通？</h3><p className="secondary">可选择一人或多人。已停用、到期或组织无效的人员会标明原因，不能选入名单。</p><PersonPicker label="选择开通人员" value={selected} multiple required source={{scope:'onboarding'}} onChange={ids=>setSelected(ids)}/>{invalidSelected&&<p className="notice warning" role="alert">名单中有人员已失效或不可见，请重新打开选择器核对并移除。</p>}<div className="actions"><button className="primary" disabled={!selected.length||invalidSelected} onClick={()=>setStep(1)}>下一步：选择方案（{selected.length} 人）</button><button className="ghost" onClick={()=>setPage('members')}>前往组织与成员</button></div></>:<><h3>给 {selected.length} 人开放什么能力？</h3><p className="secondary">已选：{selected.map(id=>memberIdentity(d,id)).join('；')}</p><div className="actions"><button type="button" className="ghost" disabled={busy||!canManage} title={!canManage?'需要开通管理权限':undefined} onClick={createPlan}>新建方案</button><button type="button" className="link-button" disabled={busy} onClick={()=>setPage('plans')}>管理开通方案</button></div>
      <p className="secondary">选择包含所需模型池和额度的方案；新建方案后会返回这里，保留已选人员。</p>
      {createdPlanId&&<div className="notice" role="status">{!d.plans.some(p=>p.id===createdPlanId)?'方案已保存，列表暂未更新，请点击页面上方“刷新数据”重试。':`方案「${d.plans.find(p=>p.id===createdPlanId)!.name}」已保存，尚未为人员发放额度。`}</div>}
      <fieldset className="choice-list"><legend>选择开通方案</legend>{plans.map(p=>{const reason=planReadiness(d,p),models=availableModels(d,p);return <label key={p.id} className={`plan-choice ${planId===p.id?'selected':''}`}><input type="radio" name="onboarding-plan" checked={planId===p.id} disabled={busy||!!reason} onChange={()=>{setPlanId(p.id);setCreatedPlanId('');}}/><span><strong>{p.name}</strong><small>模型池：{d.pools.find(pool=>pool.id===p.range.poolId)?.name??'已不存在'} · {p.range.mode==='follow'?'跟随模型池':'仅指定模型'}</small><small>可用模型：{models.join('、')||'暂无可用模型'}</small><small>{p.cadence==='monthly'?'每月':'一次性'}每人 {money(p.amount)} · {p.cadence==='monthly'?'当月额度月底到期':`额度 ${p.quotaDays} 天`} · 权益最长 {p.entitlementDays} 天</small>{reason&&<small><Status value={p.active?'pending':'disabled'} label={p.active?'暂不可用':'已停用'}/> {reason}</small>}</span></label>;})}</fieldset>
      {!plans.length&&<div className="notice warning">还没有开通方案。点击“新建方案”，选择模型池并设置每人额度。</div>}
      {blockedReason&&<div className="notice warning" role="alert">当前方案暂不可开通：{blockedReason}。<button className="link-button" onClick={()=>edit.plan(plan)}>修改方案</button><button className="link-button" onClick={()=>setPage('pools')}>检查模型池</button></div>}
      {plan&&<p className="secondary">确认页会列出每人的发放金额、到期日和跳过原因；已有该方案有效权益的人员不会重复开通。</p>}{error&&<p className="notice danger" role="alert">{error}</p>}<div className="actions"><button className="primary" disabled={busy||!plan||!!blockedReason||!selected.length||invalidSelected} onClick={()=>void open()}>{busy?'处理中…':'预览名单与金额'}</button><button className="ghost" disabled={busy} onClick={()=>setStep(0)}>返回选人</button></div></>}
  </Panel>;
}

export function EmployeeHome({data:d,purposeId,setPurpose,setPage,edit}:Pick<PageProps,'data'|'purposeId'|'setPurpose'|'setPage'|'edit'>){
  const purpose=d.purposes.find(p=>p.id===purposeId)??d.purposes[0],ready=purpose.status==='ready',blockedByModel=['model_unavailable','price_unconfigured'].includes(purpose.status);
  const waiting=d.approvals.find(a=>a.applicantId===d.actor.id&&['pending','approved','failed'].includes(a.status)&&((purpose.projectId&&a.objectId===purpose.projectId)||(!purpose.projectId&&['personal_open','personal_topup'].includes(a.kind))));
  const incoming=d.approvals.filter(a=>['pending','approved','failed'].includes(a.status)&&responsible(d,a)),ownedApp=d.applications.find(a=>a.ownerId===d.actor.id&&a.active);
  const roleTask=incoming.length>0?<Panel title={`有 ${incoming.length} 项申请需要你处理`} actions={<button className="primary" onClick={()=>setPage('approvals',incoming[0].id)}>处理申请</button>}><p className="secondary">按当前审批职责处理申请。个人是否开通 AI 使用不影响审批。</p></Panel>:ownedApp?<Panel title="继续应用接入" actions={<button className="primary" onClick={()=>setPage('applications',ownedApp.id)}>进入应用</button>}><p className="secondary">{ownedApp.name} · 使用应用独立的模型、额度和密钥。个人办公开通可按需申请。</p></Panel>:null;
  const title=ready?'今天想用 AI 做什么？':blockedByModel?'当前模型暂时无法使用':waiting?'你的申请正在处理中':purpose.status==='not_open'?'先开通，就能开始使用':'这个用途需要补充额度';
  const request=()=>purpose.projectId?edit.request('project_member_quota',purpose.projectId):purpose.status==='not_open'?edit.request('personal_open'):setPage('quota');
  /* hero 的数值块只负责“此刻可用什么”：余额、上限与本人申请数；具体来源批次在额度页。 */
  const readyModels=purpose.models.filter(m=>m.status==='ready').length,limit=Math.max(0,...purpose.models.map(m=>m.largestBatchAmount)),openRequests=d.approvals.filter(a=>a.applicantId===d.actor.id&&['pending','approved','failed'].includes(a.status)).length;
  const personal=<section className="panel task-hero"><span className="eyebrow">{d.actor.name}，你好</span><h2>{title}</h2>{d.purposes.length>1&&<label className="purpose-select">本次使用用途<select value={purpose.id} onChange={e=>setPurpose(e.target.value)}>{d.purposes.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
    <p>{ready?`可使用 ${purpose.models.filter(m=>m.status==='ready').map(m=>m.name).join('、')}。直接输入任务即可，无需配置密钥。`:blockedByModel?'请联系企业运营检查模型连接或价格配置，当前无需追加额度。':waiting?'处理结果会通过站内通知告知你，可在“我的申请”中查看进度和处理意见。':purpose.status==='not_open'?'提交你的使用需求，由企业运营开通模型和额度。':'已有的使用范围保留，补充对应来源的额度后可继续使用。'}</p>
    {ready&&<div className="task-hero-num"><span className="task-hero-cur" aria-hidden="true">¥</span><span className="task-hero-val">{purpose.availableAmount.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:6})}</span><span className="task-hero-unit">可用余额</span></div>}
    <p className="task-hero-note">{ready?`${purpose.name} · 单次调用上限 ${money(limit)}`:'开通后可在这里看到可用余额与上限。'}</p>
    <button className={roleTask?'ghost':'primary'} onClick={()=>ready?setPage('online'):blockedByModel?setPage('quota'):waiting?setPage('approvals',waiting.id):request()}>{ready?'在线使用':blockedByModel?'查看模型与额度':waiting?'查看申请进度':purpose.status==='not_open'?'申请开通':'查看并申请额度'}</button>
    {ready&&<p className="secondary"><span className="task-hero-balance">{purpose.name} · 用途余额 {money(purpose.availableAmount)}</span> <button className="link-button" onClick={()=>setPage('quota')}>查看额度</button></p>}
    {ready&&<div className="task-hero-side"><span className="task-hero-side-title">当前用途</span><div className="task-hero-kv"><span>可用模型</span><b>{readyModels} 个</b></div><div className="task-hero-kv"><span>单次调用上限</span><b>{money(limit)}</b></div><div className="task-hero-kv"><span>我的申请</span><b>{openRequests} 项</b></div></div>}
  </section>;
  return <>{roleTask}{roleTask&&!ready?<details className="disclosure"><summary>个人日常使用（按需开通）</summary>{personal}</details>:personal}{ready&&<div className="secondary-path"><strong>想在编程工具中使用？</strong><p>需要一把绑定当前用途的密钥，以及工具接入地址。</p><button className="link-button" onClick={()=>setPage('keys')}>查看密钥与接入指引 →</button></div>}
    {d.approvals.some(a=>a.applicantId===d.actor.id)&&<details className="disclosure"><summary>最近申请与处理结果</summary>{d.approvals.filter(a=>a.applicantId===d.actor.id).slice(-3).reverse().map(a=><div className="task-row" key={a.id}><span><strong>{a.scenario||'额度与开通申请'}</strong><small>{a.decisionReason||'等待处理'} · {date(a.createdAt)}</small></span><Status value={a.status}/></div>)}<button className="link-button" onClick={()=>setPage('approvals')}>查看我的申请</button></details>}
  </>;
}
