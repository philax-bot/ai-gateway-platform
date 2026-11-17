import {memberLabel,personLabel} from './person-identity';
import {approvalKindLabels,type Approval,type ApprovalKind,type PlatformSnapshot} from '@ai-gateway/contracts';
import {ChangeSummary,ProcessPath,date,endOfDay,money,type FormValues,type ProcessStep} from './components';
import {availablePlanModels,entryReadiness} from './model-readiness';

export const approvalLabels:Record<string,string>=approvalKindLabels;
export const approvalActionable=(a:Approval)=>['pending','approved','failed'].includes(a.status);
export const approvalObjectName=(d:PlatformSnapshot,a:Approval)=>d.projects.find(p=>p.id===a.objectId)?.name??d.applications.find(app=>app.id===a.objectId)?.name??d.entitlements.find(e=>e.id===a.objectId)?.planSnapshot.name??a.proposedName;
export function approvalEffect(kind:ApprovalKind){
  return ({
    project_create:{result:'建立项目并发放初始预算',boundary:'初始预算待分配 · 成员不自动获额度',next:'分配给项目成员'},
    application_create:{result:'建立应用',boundary:'额度模式同时发放初始额度 · 记账模式从 0 开始',next:'查看应用并签发密钥'},
    project_extend:{result:'延长项目额度期限',boundary:'关联成员批次同步延期 · 不增加金额',next:'查看项目预算'},
    application_extend:{result:'延长应用额度期限',boundary:'仅调整所选批次期限 · 不增加金额',next:'查看应用额度'},
    project_budget:{result:'增加项目待分配预算',boundary:'成员余额保持不变',next:'分配给项目成员'},
    project_member_quota:{result:'增加本人的项目额度',boundary:'从项目预算扣减 · 继承来源期限',next:'查看我的项目额度'},
    personal_open:{result:'开通个人模型与额度',boundary:'模型范围由运营确认',next:'查看个人模型与额度'},
    personal_topup:{result:'追加已有个人额度',boundary:'沿用原权益的模型范围',next:'查看个人额度'},
    application_quota:{result:'增加应用独立额度',boundary:'个人与项目余额保持不变',next:'查看应用接入'},
    application_billing:{result:'切换额度模式并发放额度',boundary:'原 Key 沿用 · 旧账保留 · 新额度单独使用',next:'查看应用接入'},
  } satisfies Record<ApprovalKind,{result:string;boundary:string;next:string}>)[kind];
}
export function approvalReviewer(d:PlatformSnapshot,kind:ApprovalKind,objectId?:string|null,applicantId=d.actor.id){
  const project=d.projects.find(p=>p.id===objectId);
  if(kind==='project_member_quota'&&project?.memberApprovalReviewers){
    const reviewers=project.memberApprovalReviewers;
    if(!reviewers.length)return '暂无有效审批人';
    const isManager=reviewers.some(m=>m.id===project.managerId);
    return `${isManager?'项目经理':'企业运营'} · ${reviewers.map(m=>personLabel(d.members.find(person=>person.id===m.id)??m)).join('、')}`;
  }
  if(kind==='project_member_quota'&&project&&project.managerId!==applicantId){
    const manager=d.members.find(m=>m.id===project.managerId);
    return manager?.active?`项目经理 · ${memberLabel(d,manager.id)}`:'企业运营 · 经理不可用时接管';
  }
  return kind==='project_member_quota'?'企业运营 · 本人申请转运营':'企业运营';
}
export function approvalProgress(a:Approval,applicant:string,reviewer:string):ProcessStep[]{
  const stopped=['rejected','withdrawn','closed'].includes(a.status),decided=!!a.decidedAt;
  return [
    {label:a.status==='withdrawn'?'申请已撤回':'已提交申请',detail:applicant,state:a.status==='withdrawn'?'stopped':'done'},
    {label:a.status==='rejected'?'审批已驳回':decided?'审批已批准':'等待审批',detail:reviewer,state:a.status==='rejected'?'error':decided?'done':stopped?'stopped':'current'},
    {label:a.status==='effective'?'结果已生效':a.status==='failed'?'生效失败':a.status==='closed'?'已关闭 · 未生效':stopped?'流程已结束':'等待生效',detail:a.status==='effective'?date(a.effectiveAt):a.status==='failed'?'需处理后重试':a.status==='approved'?'由批准人执行':undefined,state:a.status==='effective'?'done':a.status==='failed'?'error':stopped?'stopped':a.status==='approved'?'current':'waiting'},
  ];
}

/** The same compact business context is used by requests, approval forms and impact previews. */
export function approvalFormContext(d:PlatformSnapshot,kind:ApprovalKind,objectId:string|undefined,values:FormValues,approval?:Approval,repair=false,preview=false){
  const effect=approvalEffect(kind),plan=d.plans.find(p=>p.id===values.planId),project=d.projects.find(p=>p.id===objectId),app=d.applications.find(a=>a.id===objectId);
  const accountingCreation=kind==='application_create'&&(approval?.proposedApplication?.billingMode??values.billingMode)==='accounting',noAmount=accountingCreation||kind.endsWith('_extend');
  const source=d.projectBudgets.find(b=>b.id===values.sourceBatchId),amount=Number(values.amount);
  const pool=d.pools.find(p=>p.id===values.poolId),specific=Array.isArray(values.definitionIds)?values.definitionIds:[];
  const modelNames=[...new Set(pool?.entries.filter(e=>!entryReadiness(d,e)&&(values.rangeMode!=='specific'||specific.includes(e.definitionId))).map(e=>d.definitions.find(m=>m.id===e.definitionId)?.name??e.definitionId)??[])];
  const expiry=values.validity==='permanent'?'长期有效':source?date(source.expiresAt):/^\d{4}-\d{2}-\d{2}$/.test(String(values.expiresAt))?date(endOfDay(values.expiresAt)):String(values.expiresAt||'待填写');
  return <section className="workflow-summary" aria-label={approval?'本次审批影响':'申请处理路径'}>
    {approval?<><h3>{effect.result}</h3><div className="workflow-facts"><strong>{effect.boundary}</strong></div></>:<ProcessPath label="申请处理路径" steps={[
      {label:'填写申请',detail:project?.name??app?.name??approvalKindLabels[kind],state:'current'},
      {label:approvalReviewer(d,kind,objectId),detail:'不可审批本人申请',state:'waiting'},
      {label:effect.result,detail:effect.boundary,state:'waiting'},
    ]}/>}
    {kind==='application_create'&&<div className="workflow-facts"><span>模式 <strong>{(approval?.proposedApplication?.billingMode??values.billingMode)==='accounting'?'记账模式 · 无初始授额':'额度模式 · 同时发放初始额度'}</strong></span><span>负责人 <strong>{d.members.find(m=>m.id===(approval?.proposedApplication?.ownerId??values.ownerId))?.name??'待选择'}</strong></span><span>组织 <strong>{d.organizations.find(o=>o.id===(approval?.proposedApplication?.organizationId??values.organizationId))?.name??'待选择'}</strong></span></div>}
    {approval?.requestedBatchId&&<p className="secondary">延期批次：{approval.requestedBatchId}。保留原授额，不增加金额。</p>}
    {approval&&<details className="disclosure"><summary>申请用途 · {approval.scenario}</summary><p className="request-reason">{approval.reason}</p></details>}
    {approval&&<ChangeSummary label="本次批准对比" afterLabel={repair?'修正后':'本次批准'} beforeLabel={repair?'原批准':'原申请'} items={kind==='project_create'?[
      {label:'项目经理',before:d.members.find(m=>m.id===(repair?approval.execution?.managerId:approval.proposedManagerId))?.name??'由运营确认',after:d.members.find(m=>m.id===values.managerId)?.name??'待选择'},
      {label:'初始预算',before:money(repair?approval.approvedAmount??approval.amount:approval.amount),after:amount>0?money(amount):'待填写'},
      {label:'期限',before:date(repair?approval.approvedExpiresAt:approval.requestedExpiresAt),after:expiry},
    ]:[
      ...(noAmount?[{label:'新增金额',before:'不新增额度',after:'不新增额度'}]:[{label:'金额',before:money(repair?approval.approvedAmount??approval.amount:approval.amount),after:Number.isFinite(amount)&&amount>0?money(amount):'待填写'}]),
      ...((preview||kind.endsWith('_extend'))&&!accountingCreation?[{label:'期限',before:date(repair?approval.approvedExpiresAt:approval.requestedExpiresAt),after:expiry,detail:source?'随来源预算到期':undefined}]:[]),
    ]}/>}
    {plan&&<div className="workflow-facts"><span>方案 <strong>{plan.name}</strong></span><span>当前可用模型 <strong>{availablePlanModels(d,plan).join('、')||'暂无可用模型'}</strong></span></div>}
    {['project_create','application_create'].includes(kind)&&pool&&<div className="workflow-facts" aria-label="确认的项目模型范围"><span>模型池 <strong>{pool.name}</strong></span><span>范围 <strong>{values.rangeMode==='specific'?'仅指定模型':'跟随模型池'}</strong></span><span>当前可用模型 <strong>{modelNames.join('、')||'暂无可用模型'}</strong></span></div>}
  </section>;
}
