import {saveUpstreamCredential} from './upstream-credentials';
import {saveWebhookChannel,retryWebhook} from './webhook-notifications';
import {quotaExpiry} from './validation';
import {changeQuota} from './quota-changes';
import {resourceAction} from './resource-actions';
import {QUOTA_FOREVER,type Application} from '@ai-gateway/contracts';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Approval, AutoRule, BusinessQuotaBatch, Member, ProjectBudgetBatch, WorkspaceState } from '@ai-gateway/contracts';
import type { WorkspaceTransaction } from './workspace.repository';
import { activeMember, amount, availableModels, expiry, hash, limits, now, operator, pick, range, strings, text } from './validation';
import { alreadyFunded,allocate, canApprove, days,endProject, grantBatch, grantPlan, manager, matches, memberModels, newId, notify, owner, planWindow,publicKey, runPeriodic, topup, valid } from './domain';
import { monitoringState } from './monitoring.domain';
import { applyAutomatic } from './automatic-onboarding';
import { prepareKeyStatus } from './key-status';
import { applyRetention,requestedRetention,retentionPolicy } from './retention';
import { prepareEntitlementMigration } from './entitlement-migration';
import { applicationBillingMode,approvalKindLabels } from '@ai-gateway/contracts';

export function selectMembers(s:WorkspaceState,p:Record<string,unknown>){
  if(p.memberIds)return strings(p.memberIds,'memberIds').map(memberId=>pick(s.members,memberId,'member'));
  if(p.scope!=='all'&&p.scope!=='conditions'&&!p.organizationId&&!p.category&&!Array.isArray(p.tags))throw new BadRequestException('an explicit member list or distribution scope is required');
  if(p.organizationId)pick(s.organizations,p.organizationId,'organization');
  if(p.category&&!['employee','contractor'].includes(String(p.category)))throw new BadRequestException('invalid member category');
  const condition:AutoRule={id:'preview',name:'preview',planId:'',active:true,organizationId:p.organizationId?String(p.organizationId):null,includeChildren:p.includeChildren===true,category:(p.category??null) as AutoRule['category'],tags:strings(p.tags??[],'tags')};
  return s.members.filter(m=>matches(s,{...m,active:true,validUntil:null},condition));
}

export function prepareSettings(s:WorkspaceState,p:Record<string,unknown>){
  if('retentionDays'in p||'retentionAutomatic'in p)throw new BadRequestException('use settings.retention to preview the retention policy');
  const candidate={...s.settings};
  if('name'in p)candidate.name=text(p.name,'name',100);
  for(const field of ['personalDefaultPoolId','projectDefaultPoolId']as const)if(field in p){
    if(p[field]!==null&&typeof p[field]!=='string')throw new BadRequestException('default pool must be an identifier or null');
    candidate[field]=p[field]?pick(s.pools,p[field],'pool').id:null;
  }
  if('limits'in p){if(!p.limits||typeof p.limits!=='object'||Array.isArray(p.limits))throw new BadRequestException('usage limits are required');candidate.limits=limits(p.limits);}
  return candidate;
}

export function prepareDistribution(s:WorkspaceState,p:Record<string,unknown>){
  const selected=selectMembers(s,p),operation=p.operation??(p.planId?'open_plan':'topup');
  if(!['open_plan','topup'].includes(String(operation)))throw new BadRequestException('invalid distribution operation');
  const explicit=p.entitlementId?pick(s.entitlements,p.entitlementId,'entitlement'):null;
  if(explicit&&(selected.length!==1||selected[0].id!==explicit.memberId))throw new BadRequestException('top-up source must belong to the selected member');
  const plan=pick(s.plans,operation==='open_plan'?p.planId:p.sourcePlanId??explicit?.planId,'plan');
  if(operation==='open_plan'&&!plan.active)throw new ConflictException('plan is disabled');
  const perPerson=operation==='open_plan'?plan.amount:amount(p.amount),requestedExpiry=operation==='topup'?expiry(p.expiresAt):null;
  const members=selected.map(member=>{
    let reason='';try{activeMember(s,member.id);}catch{reason='成员或组织停用 / 到期';}
    const e=explicit??s.entitlements.find(e=>e.planId===plan.id&&e.memberId===member.id&&e.status==='active'&&valid(e.expiresAt));
    if(!reason&&operation==='open_plan'&&e)reason='已有有效方案权益，不重复发放';
    if(!reason&&operation==='topup'&&(!e||e.status!=='active'||!valid(e.expiresAt)))reason='没有该方案的有效权益，追加不会隐式开通';
    if(!reason&&requestedExpiry&&e&&Date.parse(requestedExpiry)>Date.parse(e.expiresAt))reason='追加期限超出当前权益期限';
    const funded=operation==='open_plan'&&alreadyFunded(s,member.id,plan);
    return {id:member.id,name:member.name,included:!reason,reason:reason||(funded?'该方案本周期已发放，本次仅恢复权益':''),amount:reason||funded?0:perPerson,entitlementId:e?.id??null,expiresAt:requestedExpiry??planWindow(plan,member).quotaExpiresAt};
  });
  const scopeDescription=p.memberIds?`手动名单 ${selected.length} 人`:p.scope==='all'?'全体有效成员':[p.organizationId?`${pick(s.organizations,p.organizationId,'organization').name}${p.includeChildren?'及下级':'（仅本级）'}`:'全部组织',p.category==='contractor'?'外部协作':p.category==='employee'?'员工':'全部类别',Array.isArray(p.tags)&&p.tags.length?`标签同时满足：${p.tags.join('、')}`:'不限标签'].join(' · ');
  return {operation,plan,members,scopeDescription,amountPerMember:perPerson,totalAmount:Number(members.reduce((n,m)=>n+m.amount,0).toFixed(6)),matchedCount:members.length,grantCount:members.filter(m=>m.included).length,excludedCount:members.filter(m=>!m.included).length};
}

export function prepareApprovalRepair(s:WorkspaceState,actor:Member,a:Approval,p:Record<string,unknown>,budgets:ProjectBudgetBatch[]){
  if(!canApprove(s,actor,a))throw new ForbiddenException('not responsible for this approval, or self approval');
  if(!['approved','failed'].includes(a.status))throw new ConflictException('only an approved or failed execution may be repaired');
  const next=structuredClone(a);next.decisionReason=text(p.reason,'reason',2000);
  next.approvedAmount=noGrant(a)?0:amount(p.amount??a.approvedAmount);
  next.approvedExpiresAt=quotaExpiry({...p,expiresAt:p.expiresAt??a.approvedExpiresAt});
  const previous=a.execution??{};
  if(a.kind==='project_create')next.execution={managerId:activeMember(s,text(p.managerId??previous.managerId??a.proposedManagerId,'managerId')).id,range:range(s,p.range??previous.range)};
  else if(a.kind==='application_create')next.execution={range:range(s,p.range??previous.range)};
  else if(a.kind==='personal_open'){const plan=pick(s.plans,p.planId??previous.planId,'plan');if(!plan.active)throw new ConflictException('plan is disabled');next.execution={planId:plan.id,planVersion:plan.version};}
  else if(a.kind==='project_member_quota'){
    const budget=pick(budgets,p.sourceBatchId??previous.sourceBatchId,'source budget');
    if(budget.projectId!==a.objectId||!valid(budget.expiresAt))throw new ConflictException('active source budget must belong to the requested project');
    if(Date.parse(next.approvedExpiresAt!)!==Date.parse(budget.expiresAt))throw new ConflictException('member quota must inherit the selected budget expiry');next.execution={sourceBatchId:budget.id};
  }else next.execution={};
  if(a.kind==='personal_topup'){const e=pick(s.entitlements,a.objectId,'entitlement');if(e.status!=='active'||!valid(e.expiresAt)||Date.parse(next.approvedExpiresAt!)>Date.parse(e.expiresAt))throw new ConflictException('top-up must not outlive its active entitlement');}
  const scopeObject=s.projects.find(x=>x.id===a.objectId)??s.applications.find(x=>x.id===a.objectId);if(scopeObject)next.execution={...next.execution,approvedRange:structuredClone(scopeObject.range)};
  next.approverId=actor.id;next.status='approved';next.failure=null;next.effectiveAt=null;
  return next;
}

function noGrant(a:Pick<Approval,'kind'|'proposedApplication'>){return a.kind.endsWith('_extend')||a.kind==='application_create'&&a.proposedApplication?.billingMode==='accounting';}

async function submitApproval(tx:WorkspaceTransaction,actor:Member,p:Record<string,unknown>){
  const s=tx.state,kind=String(p.kind) as Approval['kind'];
  if(!Object.prototype.hasOwnProperty.call(approvalKindLabels,kind))throw new BadRequestException('invalid approval kind');
  const objectId=p.objectId?String(p.objectId):null;
  if(kind==='project_budget'||kind==='project_extend'){const project=manager(s,actor,objectId);if(project.managerId!==actor.id)throw new ForbiddenException('budget requests must come from project manager');}
  if(kind==='project_member_quota'){const project=pick(s.projects,objectId,'project');if(project.status!=='active'||!project.memberIds.includes(actor.id))throw new ForbiddenException('project membership required');}
  if(kind==='personal_topup'){const e=pick(s.entitlements,objectId,'entitlement');if(e.memberId!==actor.id||e.status!=='active'||!valid(e.expiresAt))throw new ForbiddenException('active personal entitlement required');}
  if(kind==='application_quota'||kind==='application_billing'||kind==='application_extend'){
    const app=owner(s,actor,objectId);if(app.ownerId!==actor.id)throw new ForbiddenException('request must come from application owner');
    if(!app.active)throw new ConflictException('application disabled');
    if((kind==='application_billing')!==(applicationBillingMode(app)==='accounting'))throw new ConflictException('application billing mode does not match request kind');
  }
  const proposedApplication=kind==='application_create'?{ownerId:activeMember(s,String(p.ownerId??actor.id)).id,organizationId:pick(s.organizations,p.organizationId,'organization').id,billingMode:(p.billingMode??'accounting') as Application['billingMode']}:undefined;
  if(proposedApplication&&!['accounting','quota'].includes(proposedApplication.billingMode!))throw new BadRequestException('invalid application billing mode');
  const requestedBatchId=kind.endsWith('_extend')?text(p.batchId,'额度批次'):undefined;
  if(requestedBatchId){const batch=kind==='project_extend'?pick(await tx.budgetBatches(),requestedBatchId,'来源预算'):pick(await tx.batches(),requestedBatchId,'额度批次');if(kind==='project_extend'?batch.projectId!==objectId:!('sourceId'in batch)||batch.sourceId!==objectId)throw new ConflictException('额度批次不属于当前对象');if(batch.closedAt||Date.parse(batch.expiresAt)<=Date.now()||Date.parse(quotaExpiry(p))<=Date.parse(batch.expiresAt))throw new ConflictException('仅可延长未关闭且未过期的额度');}
  if(s.approvals.some(a=>a.applicantId===actor.id&&a.kind===kind&&a.objectId===objectId&&a.requestedBatchId===requestedBatchId&&['pending','approved','failed'].includes(a.status)))throw new ConflictException('an application for this purpose is already pending');
  const approval:Approval={id:newId('approval'),kind,applicantId:actor.id,objectId,amount:noGrant({kind,proposedApplication:proposedApplication as Approval['proposedApplication']})?0:amount(p.amount),requestedExpiresAt:kind==='application_create'&&proposedApplication?.billingMode==='accounting'?QUOTA_FOREVER:quotaExpiry(p),requestedBatchId,proposedApplication:proposedApplication as Approval['proposedApplication'],scenario:text(p.scenario,'scenario',200),reason:text(p.reason,'reason',2000),proposedManagerId:p.managerId?activeMember(s,String(p.managerId)).id:null,proposedName:kind==='project_create'||kind==='application_create'?text(p.name,'name',100):'',status:'pending',approverId:null,decisionReason:'',approvedAmount:null,approvedExpiresAt:null,execution:null,createdAt:now(),decidedAt:null,effectiveAt:null,failure:null};
  const approvers=s.members.filter(member=>{try{return !!activeMember(s,member.id)&&canApprove(s,member,approval);}catch{return false;}});
  if(!approvers.length)throw new ConflictException('no active responsible approver is configured');
  s.approvals.push(approval);
  for(const member of approvers)notify(s,member.id,'待审批申请',`${actor.name} · ${approvalKindLabels[kind]}`,'approval',approval.id);
  return approval;
}

async function executeApproval(tx:WorkspaceTransaction,actor:Member,a:Approval){
  const s=tx.state;activeMember(s,a.applicantId);const p=a.execution??{};
  const scopeObject=s.projects.find(x=>x.id===a.objectId)??s.applications.find(x=>x.id===a.objectId);
  if(p.approvedRange&&scopeObject&&JSON.stringify(p.approvedRange)!==JSON.stringify(scopeObject.range))throw new ConflictException('模型范围已变化，请重新核对批准内容后执行');
  const applicant=pick(s.members,a.applicantId,'applicant').name;
  const modelNames=(ids:string[])=>ids.map(id=>s.definitions.find(d=>d.modelId===id)?.name??id);
  const receipt=(batch:BusinessQuotaBatch,sourceName:string,destinationName:string)=>{
    a.receipt={objectId:a.objectId,batchId:batch.id,entitlementId:batch.entitlementId,amount:batch.totalAmount,expiresAt:batch.expiresAt,sourceName,destinationName,modelNames:modelNames(batch.modelIds)};
  };
  switch(a.kind){
    case 'application_create':{
      if(!a.proposedApplication)throw new ConflictException('应用申请信息不完整，请重新申请');
      const app=await resourceAction(tx,actor,'save.application',{...a.proposedApplication,name:a.proposedName,description:a.reason,range:p.range,initialAmount:a.approvedAmount,expiresAt:a.approvedExpiresAt}) as Application;
      a.objectId=app.id;const batch=(await tx.batches()).find(b=>b.sourceId===app.id)!;receipt(batch,'企业运营',app.name);break;
    }
    case 'project_extend':case 'application_extend':{
      if(a.kind==='project_extend'){const project=pick(s.projects,a.objectId,'project');if(project.status!=='active'||project.managerId!==a.applicantId)throw new ConflictException('project approval scope changed');}
      else {const app=pick(s.applications,a.objectId,'application');if(!app.active||app.ownerId!==a.applicantId)throw new ConflictException('application owner or state changed');}
      const result=await changeQuota(tx,actor,a.kind==='project_extend'?'project.extend':'application.extend',{projectId:a.objectId,applicationId:a.objectId,batchId:a.requestedBatchId,expiresAt:a.approvedExpiresAt,reason:a.decisionReason});
      a.receipt={objectId:a.objectId,batchId:result.batchId,entitlementId:null,amount:0,expiresAt:result.expiresAt,sourceName:'原额度批次',destinationName:result.objectName,modelNames:[]};break;
    }
    case 'project_create':{
      const projectManager=activeMember(s,text(p.managerId??a.proposedManagerId,'managerId'));
      const project={id:newId('project'),name:a.proposedName,description:a.reason,managerId:projectManager.id,applicantId:a.applicantId,memberIds:[...new Set([projectManager.id,a.applicantId])],status:'active' as const,range:range(s,p.range),limits:limits(undefined)};
      s.projects.push(project);a.objectId=project.id;
      const budget={id:newId('project-budget'),projectId:project.id,totalAmount:amount(a.approvedAmount),availableAmount:amount(a.approvedAmount),expiresAt:expiry(a.approvedExpiresAt),createdAt:now()};await tx.fundBudget(budget);
      a.receipt={objectId:project.id,batchId:budget.id,entitlementId:null,amount:budget.totalAmount,expiresAt:budget.expiresAt,sourceName:'企业运营',destinationName:`${project.name} · 待分配预算`,modelNames:modelNames(availableModels(s,project.range))};break;
    }
    case 'project_budget':{
      const project=pick(s.projects,a.objectId,'project');if(project.status!=='active'||project.managerId!==a.applicantId)throw new ConflictException('project approval scope changed');
      const batch={id:newId('project-budget'),projectId:project.id,totalAmount:a.approvedAmount!,availableAmount:a.approvedAmount!,expiresAt:expiry(a.approvedExpiresAt),createdAt:now()};
      await tx.fundBudget(batch);
      a.receipt={objectId:project.id,batchId:batch.id,entitlementId:null,amount:batch.totalAmount,expiresAt:batch.expiresAt,sourceName:'企业运营',destinationName:`${project.name} · 待分配预算`,modelNames:modelNames(availableModels(s,project.range))};break;
    }
    case 'project_member_quota':{
      const budget=pick(await tx.budgetBatches(),p.sourceBatchId,'source budget');
      if(Date.parse(a.approvedExpiresAt!)!==Date.parse(budget.expiresAt))throw new ConflictException('member quota must inherit the selected budget expiry');
      const batch=await allocate(tx,a.objectId!,a.applicantId,budget.id,a.approvedAmount!);
      receipt(batch,`${pick(s.projects,a.objectId,'project').name} · 来源预算`,`${applicant} · 项目额度`);break;
    }
    case 'personal_open':{
      const plan=pick(s.plans,p.planId,'plan');
      if(p.planVersion!==plan.version)throw new ConflictException('方案版本已变化或旧审批未固定版本，请修复审批并重新核对批准内容');
      const result=await grantPlan(tx,a.applicantId,plan.id,'approval',[],{amount:a.approvedAmount!,expiresAt:expiry(a.approvedExpiresAt)});
      if(!result.granted)throw new ConflictException('member already has this plan; request a top-up instead');
      const batch=(await tx.batches()).find(b=>b.id===result.batchId);
      if(batch)receipt(batch,plan.name,`${applicant} · 个人额度`);
      else a.receipt={objectId:a.objectId,batchId:null,entitlementId:result.entitlementId,amount:0,expiresAt:null,sourceName:plan.name,destinationName:`${applicant} · 个人权益`,modelNames:modelNames(availableModels(s,plan.range))};
      break;
    }
    case 'personal_topup':{
      const entitlement=pick(s.entitlements,a.objectId,'entitlement'),batch=await topup(tx,entitlement,a.approvedAmount!,expiry(a.approvedExpiresAt));
      receipt(batch,entitlement.planSnapshot.name,`${applicant} · 个人额度`);break;
    }
    case 'application_quota':{
      const app=pick(s.applications,a.objectId,'application');if(!app.active||app.ownerId!==a.applicantId)throw new ConflictException('application owner or state changed');
      if(applicationBillingMode(app)!=='quota')throw new ConflictException('application must use quota mode');
      const batch=await grantBatch(tx,app.id,'application',a.approvedAmount!,expiry(a.approvedExpiresAt),availableModels(s,app.range),null,null);
      receipt(batch,'企业运营',`${app.name} · 应用额度`);break;
    }
    case 'application_billing':{
      const app=pick(s.applications,a.objectId,'application');
      if(!app.active||app.ownerId!==a.applicantId||applicationBillingMode(app)!=='accounting')throw new ConflictException('application owner, state or billing mode changed');
      const batch=await grantBatch(tx,app.id,'application',a.approvedAmount!,expiry(a.approvedExpiresAt),availableModels(s,app.range),null,null);
      receipt(batch,'企业运营',`${app.name} · 应用额度`);
      app.billingMode='quota';
      s.audit.push({id:newId('audit'),actorId:actor.id,action:'application.billing_changed',objectId:app.id,reason:a.decisionReason,createdAt:now(),detail:{before:'accounting',after:'quota',approvalId:a.id,policy:'historical_accounting_preserved; new_quota_separate'}});break;
    }
  }
}

export async function workflowAction(tx:WorkspaceTransaction,actor:Member,type:string,p:Record<string,unknown>):Promise<unknown>{
  const s=tx.state;
  switch(type){
    case 'project.reclaim':case 'project.return':case 'project.extend':case 'application.reclaim':case 'application.extend':return changeQuota(tx,actor,type,p);
    case 'credential.save':operator(actor,'credentials.write');return saveUpstreamCredential(s,p);
    case 'notification.channel.save':operator(actor,'monitoring.write');return saveWebhookChannel(s,p);
    case 'notification.delivery.retry':operator(actor,'monitoring.write');return retryWebhook(s,p.id);
    case 'alert.silence':{
      operator(actor,'monitoring.write');
      const rule=pick(monitoringState(s).rules,p.id,'alert rule');
      const until=p.until===null?null:typeof p.until==='string'?Date.parse(p.until):NaN;
      if(until!==null&&(!Number.isFinite(until)||until<=Date.now()||until>Date.now()+7*86400000))throw new BadRequestException('silence expiry must be within the next seven days');
      rule.silencedUntil=until===null?null:new Date(until).toISOString();
      rule.silencedBy=actor.id;return rule;
    }
    case 'alert.ack':{
      operator(actor,'monitoring.write');const m=monitoringState(s),event=pick([...m.events,...m.collectionEvents],p.id,'alert event');
      if(!event.acknowledgedAt){event.acknowledgedAt=now();event.acknowledgedBy=actor.id;}return event;
    }
    case 'auto.apply':{
      operator(actor);const rule=pick(s.rules,p.id,'rule');if(!rule.active)throw new ConflictException('rule is disabled');
      return applyAutomatic(tx,s.members.map(m=>m.id),actor.id,'rule.applied_to_existing',rule.id);
    }
    case 'distribution.execute':{
      operator(actor);const prepared=prepareDistribution(s,p),results=[];
      for(const member of prepared.members){
        if(!member.included){results.push({memberId:member.id,status:'skipped' as const,reason:member.reason,batchId:null,expiresAt:null,amount:0,entitlementId:member.entitlementId});continue;}
        let batchId:string|null=null,entitlementId=member.entitlementId;
        if(prepared.operation==='open_plan'){const granted=await grantPlan(tx,member.id,prepared.plan.id,'manual',[]);batchId=granted.batchId;entitlementId=granted.entitlementId;}
        else batchId=(await topup(tx,pick(s.entitlements,member.entitlementId,'entitlement'),prepared.amountPerMember,member.expiresAt)).id;
        const batch=(await tx.batches()).find(b=>b.id===batchId),entitlement=s.entitlements.find(e=>e.id===entitlementId);results.push({memberId:member.id,status:'granted' as const,reason:member.reason,batchId,expiresAt:batch?.expiresAt??null,amount:batch?.totalAmount??0,entitlementId,planVersion:entitlement?.planVersion});
      }
      const distribution={id:newId('distribution'),actorId:actor.id,kind:prepared.operation==='open_plan'?'plan' as const:'topup' as const,planId:prepared.plan.id,planSnapshot:structuredClone(prepared.plan),scopeDescription:prepared.scopeDescription,entitlementId:p.entitlementId?String(p.entitlementId):null,amount:prepared.amountPerMember,memberIds:prepared.members.map(m=>m.id),expiresAt:results.map(r=>r.expiresAt).filter((v):v is string=>!!v).sort()[0]??now(),createdAt:now(),results};
      s.distributions.push(distribution);return distribution;
    }
    case 'entitlement.stop':case 'entitlement.revoke':{
      operator(actor);const e=pick(s.entitlements,p.id,'entitlement');e.futureGrants=false;if(type==='entitlement.revoke'){text(p.reason,'reason');e.status='revoked';}return e;
    }
    case 'entitlements.migrate':{
      operator(actor);const prepared=prepareEntitlementMigration(s,p);
      // Never silently shrink a confirmed list: inapplicable objects require a new preview.
      if(prepared.rows.some(row=>row.status==='inapplicable'))throw new ConflictException('some selected entitlements are no longer applicable; preview again');
      const migratedIds:string[]=[],skippedIds:string[]=[],auditIds:string[]=[];
      for(const row of prepared.rows){
        if(row.status!=='change'){skippedIds.push(row.entitlementId);continue;}
        const e=pick(s.entitlements,row.entitlementId,'entitlement');
        const before={planId:e.planId,planVersion:e.planVersion,planName:e.planSnapshot.name,range:structuredClone(e.range),amount:e.planSnapshot.amount,expiresAt:e.expiresAt,periods:[...e.periods],status:e.status,futureGrants:e.futureGrants};
        e.planVersion=prepared.plan.version;
        e.planSnapshot=structuredClone(prepared.plan);
        e.range=structuredClone(prepared.plan.range);
        const auditId=newId('audit');
        s.audit.push({id:auditId,actorId:actor.id,action:'entitlement.migrated',objectId:e.id,reason:prepared.preview.reason,createdAt:now(),detail:{before,after:{planId:e.planId,planVersion:e.planVersion,planName:e.planSnapshot.name,range:structuredClone(e.range),amount:e.planSnapshot.amount,expiresAt:e.expiresAt,periods:[...e.periods]},noBackfill:true,preserve:{grantedAt:e.grantedAt,expiresAt:e.expiresAt,periods:[...e.periods],source:e.source,ruleIds:[...e.ruleIds],futureGrants:e.futureGrants,status:e.status}}});
        auditIds.push(auditId);migratedIds.push(e.id);
      }
      return {planId:prepared.plan.id,planName:prepared.plan.name,planVersion:prepared.plan.version,migratedIds,skippedIds,auditIds,noBackfill:true};
    }
    case 'project.members':{
      const project=manager(s,actor,p.projectId);if(project.status!=='active')throw new ConflictException('project is not active');
      const memberIds=strings(p.memberIds??[],'memberIds'),removeIds=strings(p.removeMemberIds??[],'removeMemberIds');
      memberIds.forEach(memberId=>activeMember(s,memberId));if(removeIds.includes(project.managerId))throw new BadRequestException('cannot remove project manager');
      for(const memberId of removeIds){await tx.closeMemberBalances(project.id,memberId);for(const key of s.keys)if(key.projectId===project.id&&key.subjectId===memberId&&key.status==='active')key.status='disabled';}
      project.memberIds=[...new Set([...project.memberIds,...memberIds])].filter(memberId=>!removeIds.includes(memberId));return project;
    }
    case 'project.fund':{
      operator(actor,'finance.write');const project=pick(s.projects,p.projectId,'project');if(project.status!=='active')throw new ConflictException('project is not active');
      const value=amount(p.amount),batch={id:newId('project-budget'),projectId:project.id,totalAmount:value,availableAmount:value,expiresAt:quotaExpiry(p),createdAt:now()};
      await tx.fundBudget(batch);return batch;
    }
    case 'project.allocate':{
      const project=manager(s,actor,p.projectId);return allocate(tx,project.id,text(p.memberId,'memberId'),text(p.sourceBatchId,'sourceBatchId'),amount(p.amount));
    }
    case 'project.end':return endProject(tx,actor,p.projectId,p.reason);
    case 'application.fund':{
      operator(actor,'finance.write');const app=pick(s.applications,p.applicationId,'application');if(!app.active)throw new ConflictException('application disabled');
      if(applicationBillingMode(app)!=='quota')throw new ConflictException('accounting application must switch to quota mode through approval before funding');
      return grantBatch(tx,app.id,'application',amount(p.amount),quotaExpiry(p),availableModels(s,app.range),null,null);
    }
    case 'approval.submit':return submitApproval(tx,actor,p);
    case 'approval.withdraw':{
      const a=pick(s.approvals,p.id,'approval');if(a.applicantId!==actor.id||a.status!=='pending')throw new ForbiddenException('only applicant may withdraw a pending request');a.status='withdrawn';return a;
    }
    case 'approval.close':{
      const a=pick(s.approvals,p.id,'approval');
      if(!canApprove(s,actor,a))throw new ForbiddenException('not responsible for this approval, or self approval');
      if(!['approved','failed'].includes(a.status))throw new ConflictException('only an approved or failed execution may be closed');
      a.closeReason=text(p.reason,'reason',2000);a.closedBy=actor.id;a.closedAt=now();a.status='closed';
      notify(s,a.applicantId,'申请已关闭',a.closeReason,'approval',a.id);return a;
    }
    case 'approval.decide':{
      const a=pick(s.approvals,p.id,'approval');if(a.status!=='pending')throw new ConflictException('approval already handled');if(!canApprove(s,actor,a))throw new ForbiddenException('not responsible for this approval, or self approval');
      a.approverId=actor.id;a.decisionReason=text(p.reason,'reason');a.decidedAt=now();
      if(p.decision==='reject'){a.status='rejected';notify(s,a.applicantId,'申请已驳回',a.decisionReason,'approval',a.id);return a;}
      if(p.decision!=='approve')throw new BadRequestException('invalid approval decision');
      a.approvedAmount=noGrant(a)?0:amount(p.amount??a.amount);a.approvedExpiresAt=quotaExpiry({...p,expiresAt:p.expiresAt??a.requestedExpiresAt});
      // Keep only business execution fields, never arbitrary caller data or credential values.
      a.execution={managerId:p.managerId?text(p.managerId,'managerId'):undefined,range:p.range?range(s,p.range):undefined,planId:p.planId?text(p.planId,'planId'):undefined,sourceBatchId:p.sourceBatchId?text(p.sourceBatchId,'sourceBatchId'):undefined};const scopeObject=s.projects.find(x=>x.id===a.objectId)??s.applications.find(x=>x.id===a.objectId);if(scopeObject)a.execution.approvedRange=structuredClone(scopeObject.range);if(a.kind==='personal_open'){const plan=s.plans.find(plan=>plan.id===a.execution!.planId);if(plan)a.execution.planVersion=plan.version;}a.status='approved';return a;
    }
    case 'approval.execute':{
      const a=pick(s.approvals,p.id,'approval');
      if(!canApprove(s,actor,a)||a.approverId!==actor.id)throw new ForbiddenException('approval responsibility changed');
      if(a.status==='effective')return a;
      if(!['approved','failed'].includes(a.status))throw new ConflictException('approval is not approved');
      await executeApproval(tx,actor,a);a.status='effective';a.effectiveAt=now();a.failure=null;
      notify(s,a.applicantId,'申请已生效',a.decisionReason,'approval',a.id);return a;
    }
    case 'approval.repair':{
      const a=pick(s.approvals,p.id,'approval'),before=structuredClone(a),repaired=prepareApprovalRepair(s,actor,a,p,await tx.budgetBatches());Object.assign(a,repaired);
      s.audit.push({id:newId('audit'),actorId:actor.id,action:'approval.execution_repaired',objectId:a.id,reason:a.decisionReason,createdAt:now(),detail:{before,after:structuredClone(a)}});
      notify(s,a.applicantId,'申请执行参数已修正',a.decisionReason,'approval',a.id);return a;
    }
    case 'key.issue':{
      const purpose=String(p.purpose);if(!['personal','project','application'].includes(purpose))throw new BadRequestException('key purpose required');
      const entitlementIds=p.entitlementIds===undefined?undefined:strings(p.entitlementIds,'entitlementIds');
      if(entitlementIds!==undefined&&(purpose!=='personal'||!entitlementIds.length))throw new BadRequestException('指定套餐仅适用于个人密钥，且必须选择至少一个套餐。');
      let ownerId=actor.id,subjectId=actor.id,subjectType:'employee'|'application'='employee',projectId:string|null=null,models:string[]=[];
      if(purpose==='application'){const app=owner(s,actor,p.applicationId);if(!app.active)throw new ConflictException('application disabled');ownerId=app.ownerId;subjectId=app.id;subjectType='application';models=availableModels(s,app.range);}
      else {
        if(p.memberId&&p.memberId!==actor.id){operator(actor);subjectId=activeMember(s,String(p.memberId)).id;ownerId=subjectId;}
        if(entitlementIds)for(const id of entitlementIds){const e=s.entitlements.find(item=>item.id===id&&item.memberId===subjectId&&item.status==='active'&&valid(item.expiresAt));if(!e)throw new BadRequestException('所选套餐不属于该密钥使用者，或已停用、到期；请重新选择。');}
        projectId=purpose==='project'?text(p.projectId,'projectId'):null;models=memberModels(s,subjectId,projectId,entitlementIds);
      }
      if(!models.length)throw new ConflictException('当前账号在所选用途或套餐中没有已授权且开放的模型，请核对套餐归属及模型池开放状态。');
      const requested=p.expiresAt?expiry(p.expiresAt):days(90),member=s.members.find(m=>m.id===subjectId);
      const expiresAt=member?.validUntil?new Date(Math.min(Date.parse(member.validUntil),Date.parse(requested))).toISOString():requested;
      const secret=`sa_${randomBytes(32).toString('base64url')}`,keyHash=hash(secret),credentialId=newId('credential');
      const key={id:newId('key'),credentialId,name:text(p.name,'name',100),ownerId,subjectType,subjectId,purpose:purpose as 'personal'|'project'|'application',projectId,...(entitlementIds?{entitlementIds}:{}),masked:`${secret.slice(0,7)}…${secret.slice(-4)}`,keyHash,status:'active' as const,createdAt:now(),expiresAt,lastUsedAt:null};
      s.keys.push(key);return {key:publicKey(key),secret};
    }
    case 'key.status':case 'keys.status':{
      const bulk=type==='keys.status',prepared=prepareKeyStatus(s,actor,p,bulk),batchId=bulk?newId('key-change'):null;
      for(const key of prepared.keys){
        const row=prepared.rows.find(row=>row.id===key.id)!;
        if(!row.changed)continue;
        key.status=prepared.status;
        if(bulk)s.audit.push({id:newId('audit'),actorId:actor.id,action:'key.status',objectId:key.id,reason:prepared.reason,createdAt:now(),detail:{batchId,before:row.before,after:key.status}});
      }
      return bulk?{batchId,changedCount:prepared.changedCount,skippedCount:prepared.skippedCount,keys:prepared.rows}:publicKey(prepared.keys[0]);
    }
    case 'settings.retention':{
      operator(actor);const policy=retentionPolicy(p);s.settings.retentionDays=policy.days;s.settings.retentionAutomatic=policy.automatic;return {days:policy.days,automatic:policy.automatic};
    }
    case 'retention.run':operator(actor);return applyRetention(s,requestedRetention(s,p),actor.id,'manual');
    case 'settings.update':{
      operator(actor);s.settings=prepareSettings(s,p);return s.settings;
    }
    case 'notification.read':{
      const n=pick(s.notifications,p.id,'notification');if(n.recipientId!==actor.id)throw new ForbiddenException();n.readAt=now();return n;
    }
    case 'periodic.run':operator(actor);return runPeriodic(tx);
    default:throw new BadRequestException('unknown workflow command');
  }
}
