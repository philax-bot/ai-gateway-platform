import {memberLabel} from './person-identity';
import { useEffect,useState } from 'react';
import type { Approval,ApprovalDetail,PlatformSnapshot } from '@ai-gateway/contracts';
import { api,approvalFailureMessage } from './client';
import { ChangeSummary,ProcessPath,date,money,Panel,Status,Table } from './components';
import {approvalActionable,approvalEffect,approvalLabels,approvalObjectName,approvalProgress} from './approval-presentation';
import type { makeEditors,RunCommand } from './editors';
export {approvalLabels} from './approval-presentation';
type Editors=ReturnType<typeof makeEditors>;
const actionable=approvalActionable,objectName=approvalObjectName;
export function responsible(d:PlatformSnapshot,a:Approval & {responsibleIds?:string[]}){if(a.responsibleIds)return a.responsibleIds.includes(d.actor.id);const p=d.projects.find(p=>p.id===a.objectId);return a.applicantId!==d.actor.id&&(a.kind==='project_member_quota'&&p&&p.managerId!==a.applicantId?p.managerId===d.actor.id:d.actor.roles.includes('operator'));}

export function ApprovalCenter({data:d,edit,run,setPage,targetId}:{data:PlatformSnapshot;edit:Editors;run:RunCommand;setPage:(value:string,id?:string)=>void;targetId?:string|null}){
  const [section,setSection]=useState(()=>d.actor.roles.includes('operator')||d.approvals.some(a=>actionable(a)&&responsible(d,a))?'todo':'initiated'),[query,setQuery]=useState(''),[selected,setSelected]=useState<string|null>(null);
  useEffect(()=>{if(targetId){setSelected(targetId);setSection('all');}},[targetId]);
  const memberName=(id:string)=>memberLabel(d,id);
  const inSection=(a:Approval,value:string)=>value==='todo'?actionable(a)&&responsible(d,a):value==='initiated'?a.applicantId===d.actor.id:value==='processed'?!actionable(a):true;
  const rows=d.approvals.filter(a=>inSection(a,section)).filter(a=>!query.trim()||[a.id,approvalLabels[a.kind],memberName(a.applicantId),objectName(d,a)].some(value=>value?.toLowerCase().includes(query.trim().toLowerCase()))).slice().sort((a,b)=>Number(b.status==='failed')-Number(a.status==='failed')||b.createdAt.localeCompare(a.createdAt));
  useEffect(()=>{if(!selected&&rows[0])setSelected(rows[0].id);},[selected,rows[0]?.id]);
  const selectedId=selected&&d.approvals.some(a=>a.id===selected)&&(rows.some(a=>a.id===selected)||section==='todo'&&!query.trim())?selected:rows[0]?.id;
  return <><div className="section-tabs" aria-label="申请分区">{[['todo','待我处理'],['initiated','我发起的'],['processed','已结束'],['all','权限内全部']].map(([value,label])=><button key={value} className={section===value?'selected':''} aria-pressed={section===value} onClick={()=>{setSection(value);setSelected(null);}}>{label} <span>{d.approvals.filter(a=>inSection(a,value)).length}</span></button>)}</div>
    <div className="review-workspace"><aside className="panel review-queue" aria-label="申请列表"><label>搜索申请人或事项<input value={query} onChange={e=>setQuery(e.target.value)} placeholder="姓名、事项或申请编号"/></label><div className="review-items">{rows.map(a=><button key={a.id} className={`review-item ${selectedId===a.id?'selected':''}`} aria-pressed={selectedId===a.id} onClick={()=>setSelected(a.id)}><span className="section-head"><strong>{approvalLabels[a.kind]}</strong><Status value={a.status}/></span><span>{memberName(a.applicantId)}{` · ${money(a.amount)}`}</span><small>{objectName(d,a)||a.scenario}</small><small>{date(a.createdAt)}</small></button>)}{!rows.length&&<p className="empty">{query?'没有匹配的申请':section==='todo'?'当前没有需要你处理的申请':'暂无申请'}</p>}</div></aside>
    <div>{selectedId?<ApprovalTask key={selectedId} id={selectedId} data={d} edit={edit} run={run} setPage={setPage} onSubmitted={id=>{setQuery('');setSection('initiated');setSelected(id);}}/>:<Panel title="申请与处理"><p className="secondary">{section==='todo'?'待审批、批准后待生效及执行失败的事项会显示在这里。':'从列表选择申请，查看当前状态、处理人和意见。'}</p></Panel>}</div></div>
    <details className="disclosure"><summary>哪些操作需要审批？</summary><Table headers={['申请事项','审批职责','生效结果']} rows={Object.entries(approvalLabels).map(([kind,label])=>[label,kind==='project_member_quota'?'项目经理；经理本人申请或经理不可用时转运营':'企业运营 · 不可自审',approvalEffect(kind as Approval['kind']).result])}/><h3>授权范围内直接执行</h3><Table headers={['操作人','操作','执行方式']} rows={[
      ['企业运营','直接开通、发放额度、创建项目或应用','按权限执行；批量发放等变更先确认影响'],
      ['项目经理 / 运营','管理成员、从已有预算分配（含经理本人）','先确认来源、金额和影响'],
      ['本人 / 应用负责人','签发已有用途的密钥','沿用用途权限与额度'],
    ]}/></details>
  </>;
}


function ApprovalTask({id,data:d,edit,run,setPage,onSubmitted}:{id:string;data:PlatformSnapshot;edit:Editors;run:RunCommand;setPage:(value:string,id?:string)=>void;onSubmitted:(id:string)=>void}){
  const [report,setReport]=useState<ApprovalDetail|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[retry,setRetry]=useState(0);
  useEffect(()=>{let disposed=false;setLoading(true);setError('');void api<ApprovalDetail>(`/api/v1/platform/approvals/${encodeURIComponent(id)}`).then(r=>{if(!disposed)setReport(r);}).catch(e=>{if(!disposed){setReport(null);setError(e instanceof Error?e.message:'申请读取失败');}}).finally(()=>{if(!disposed)setLoading(false);});return()=>{disposed=true;};},[id,d.revision,retry]);
  if(!report)return <Panel title="申请详情"><p role={error?'alert':'status'}>{error||'正在读取申请…'}</p>{error&&<button className="ghost" onClick={()=>setRetry(n=>n+1)}>重新读取</button>}</Panel>;
  const {approval:a,permissions:p}=report,effect=approvalEffect(a.kind),isApplicant=a.applicantId===d.actor.id,execution=a.execution??{},receipt=a.receipt;
  const name=(id:string|null)=>d.members.find(m=>m.id===id)?.name??report.responsible.find(m=>m.id===id)?.name??id??'未指定';
  const assigned=report.responsible.map(m=>m.name).join('、')||'暂无有效责任人';
  const reviewer=a.decidedAt?name(a.approverId):assigned;
  const manager=d.projects.find(project=>project.id===a.objectId)?.managerId;
  const fallback=a.kind==='project_member_quota'&&manager!==a.applicantId&&!report.responsible.some(m=>m.id===manager);
  const noNewQuota=a.kind==='personal_open'&&receipt&&!receipt.batchId;
  const title=a.status==='pending'?(p.decide?'核对申请并决定':'等待审批'):a.status==='failed'?'尚未生效，需要处理':a.status==='approved'?'已批准，等待执行':a.status==='effective'?(noNewQuota?'模型权益已开通 · 未新增额度':effect.result):a.status==='closed'?'申请已关闭':a.status==='rejected'?'申请已驳回':'申请已撤回';
  async function execute(){setBusy(true);setError('');try{await run('approval.execute',{id:a.id},false);}catch(e){setError(e instanceof Error?e.message:'执行未完成');}finally{setBusy(false);setRetry(n=>n+1);}}
  const canAct=!loading&&!busy;
  const returnToResult=()=>a.kind.startsWith('personal')?setPage('quota','personal'):a.kind==='project_member_quota'&&isApplicant?setPage('quota',a.objectId??undefined):setPage(a.kind.startsWith('application_')?'applications':'projects',receipt?.objectId??a.objectId??undefined);
  const sourceName=receipt?.sourceName??(a.kind==='project_member_quota'?'项目来源预算':a.kind==='personal_open'?d.plans.find(plan=>plan.id===execution.planId)?.name??'待确认开通方案':a.kind==='personal_topup'?objectName(d,a)??'原个人权益':'企业运营');
  const destination=receipt?.destinationName??(a.kind==='project_create'?a.proposedName:a.kind==='project_budget'?`${objectName(d,a)} · 待分配预算`:a.kind.startsWith('application_')?`${objectName(d,a)} · 应用额度`:`${report.applicantName} · ${a.kind==='project_member_quota'?'项目':'个人'}额度`);
  const ended=['rejected','withdrawn','closed'].includes(a.status);
  return <Panel title={approvalLabels[a.kind]} actions={<Status value={a.status}/>}>
    <div className="workflow-facts"><span>用途 <strong>{a.scenario}</strong></span><span>申请人 <strong>{report.applicantName}</strong></span>{objectName(d,a)&&<span>对象 <strong>{objectName(d,a)}</strong></span>}{actionable(a)&&<span>当前责任人 <strong>{assigned}</strong></span>}{fallback&&actionable(a)&&<span><strong>经理不可用，转运营处理</strong></span>}</div>
    <ProcessPath label="申请进度" steps={approvalProgress(a,report.applicantName,reviewer)}/>
    <section className={`workflow-summary ${a.status==='failed'?'workflow-error':a.status==='effective'?'workflow-result':''}`} aria-label="当前处理与下一步" aria-busy={loading||busy}>
      <h3>{title}</h3>
      {a.status==='failed'?<p role="alert">{approvalFailureMessage(a.failure??'')}</p>:<p className="secondary">{ended?(a.closeReason||a.decisionReason||'未创建对象或发放额度'):a.status==='effective'&&!receipt?'历史申请未采集生效回执，请到业务对象核对。':noNewQuota?'本周期已发放过，未重复发放额度。':effect.boundary}</p>}
      {a.status==='approved'&&!p.execute&&p.repair&&<p className="secondary">原批准人：{name(a.approverId)} · 接手后可执行。</p>}
      <div className="actions">
        {p.decide&&<><button className="primary" disabled={!canAct} onClick={()=>edit.approve(a)}>核对并批准</button><button className="ghost" disabled={!canAct} onClick={()=>edit.reject(a.id)}>驳回申请</button></>}
        {p.repair&&<button className={a.status==='failed'||!p.execute?'primary':'ghost'} disabled={!canAct} onClick={()=>edit.repairApproval(a)}>{p.execute?'修正执行内容':'接手并核对'}</button>}
        {p.execute&&<button className={a.status==='failed'?'ghost':'primary'} disabled={!canAct} onClick={()=>void execute()}>{busy?'正在执行…':a.status==='failed'?'重试原批准内容':'执行生效'}</button>}
        {p.withdraw&&<button className="ghost" disabled={!canAct} onClick={()=>{setBusy(true);void run('approval.withdraw',{id:a.id}).catch(e=>setError(e instanceof Error?e.message:'撤回失败')).finally(()=>setBusy(false));}}>撤回申请</button>}
        {a.status==='effective'&&(isApplicant||!a.kind.startsWith('personal'))&&<button className="primary" onClick={returnToResult}>{isApplicant?effect.next:'查看业务结果'}</button>}
        {ended&&isApplicant&&<button className="primary" onClick={()=>edit.request(a.kind,a.objectId??undefined,a,onSubmitted)}>修改后重新申请</button>}
      </div>
      {p.close&&<button className="danger-button" disabled={!canAct} onClick={()=>edit.closeApproval(a)}>关闭未生效申请</button>}
    </section>
    {error&&<p className="notice danger" role="alert">{error}</p>}
    {a.proposedApplication&&<p>申请模式：{a.proposedApplication.billingMode==='accounting'?'记账模式':'额度模式'} · 负责人：{name(a.proposedApplication.ownerId)} · 组织：{d.organizations.find(o=>o.id===a.proposedApplication?.organizationId)?.name??'历史组织'}</p>}
    {a.requestedBatchId&&<p>延期批次：{a.requestedBatchId} · 仅调整期限，不增加金额。</p>}
    <ChangeSummary label="申请与批准对比" items={a.kind==='project_create'?[
      {label:'初始预算',before:money(a.amount),after:a.approvedAmount!==null?money(a.approvedAmount):'待审批'},
      {label:'有效至',before:date(a.requestedExpiresAt),after:a.approvedExpiresAt?date(a.approvedExpiresAt):'待审批'},
      {label:'项目经理',before:name(a.proposedManagerId),after:a.decidedAt&&a.status!=='rejected'?name(String(execution.managerId??a.proposedManagerId)):ended?'未确认':'待运营确认'},
      {label:'模型范围',before:'由运营确认',after:receipt?.modelNames.join('、')||d.pools.find(pool=>pool.id===(execution.range as {poolId?:string}|undefined)?.poolId)?.name||'待确认'},
    ]:[
      ...(a.kind==='application_billing'?[{label:'计费模式',before:'记账模式',after:a.status==='effective'?'额度模式':ended?'本次未切换':'执行后切换为额度模式'}]:[]),
      {label:'金额',before:money(a.amount),after:a.approvedAmount!==null?money(a.approvedAmount):ended?'未批准':'待审批'},
      {label:'有效至',before:date(a.requestedExpiresAt),after:a.approvedExpiresAt?date(a.approvedExpiresAt):ended?'未批准':'待审批'},
    ]}/>
    {!ended&&<section className="workflow-summary" aria-label={receipt?'实际生效结果':'生效去向'}><h3>{receipt?'实际生效结果':'生效去向'}</h3><ProcessPath label="来源与去向" steps={[
      {label:sourceName,detail:'来源',state:receipt?'done':'waiting'},
      {label:receipt?(a.kind==='project_create'?`已创建项目 · 初始预算 ${money(receipt.amount)}`:a.kind.endsWith('_extend')?'有效期已延长':money(receipt.amount)):a.kind==='project_create'?'建立项目':a.approvedAmount!==null?money(a.approvedAmount):'金额待批准',detail:receipt?'实际新增':'批准并执行后',state:receipt?'done':'waiting'},
      {label:destination,detail:receipt?.expiresAt?`有效至 ${date(receipt.expiresAt)}`:effect.boundary,state:receipt?'done':'waiting'},
    ]}/></section>}
    <details className="disclosure"><summary>申请说明、凭证与处理记录</summary>
      <section className="detail-group"><h3>{a.scenario}</h3><p className="request-reason">{a.reason}</p>{a.decisionReason&&<p className="request-reason">审批意见：{a.decisionReason}</p>}<dl className="detail-list">
        <div><dt>申请编号</dt><dd>{a.id}</dd></div><div><dt>提交时间</dt><dd>{date(a.createdAt)}</dd></div>
        {a.decidedAt&&<div><dt>批准 / 驳回时间</dt><dd>{date(a.decidedAt)}</dd></div>}{a.effectiveAt&&<div><dt>生效时间</dt><dd>{date(a.effectiveAt)}</dd></div>}
        {a.closedAt&&<div><dt>关闭记录</dt><dd>{name(a.closedBy??null)} · {date(a.closedAt)} · {a.closeReason}</dd></div>}
        {receipt&&<><div><dt>业务对象</dt><dd>{receipt.objectId??'个人用途'}</dd></div><div><dt>实际来源批次</dt><dd>{receipt.batchId??'本次未新增资金批次'}</dd></div>{receipt.entitlementId&&<div><dt>个人权益</dt><dd>{receipt.entitlementId}</dd></div>}<div><dt>生效时可用模型</dt><dd>{receipt.modelNames.join('、')||'暂无可用模型'}</dd></div></>}
        {a.failure&&<div><dt>原始失败记录</dt><dd className="request-reason">{a.failure}</dd></div>}
      </dl></section>
      <Table headers={['时间','操作人','动作','意见 / 变化']} rows={report.history.map(h=>[date(h.createdAt),name(h.actorId),({'approval.submit':'提交申请','approval.decide':'审批决定','approval.execute':'执行生效','approval.execution_failed':'执行失败','approval.execution_repaired':'执行内容修正','approval.repair':'修正已保存','approval.withdraw':'申请撤回','approval.close':'关闭申请'} as Record<string,string>)[h.action]??h.action,<>{(h.action==='approval.execution_failed'?approvalFailureMessage(h.reason):h.reason)||'—'}{h.action==='approval.execution_repaired'&&<small className="cell-help">批准金额 {money(Number((h.detail.before as Approval)?.approvedAmount??0))} → {money(Number((h.detail.after as Approval)?.approvedAmount??0))}；期限 {date((h.detail.before as Approval)?.approvedExpiresAt)} → {date((h.detail.after as Approval)?.approvedExpiresAt)}</small>}</>])}/>
    </details>
  </Panel>;
}
