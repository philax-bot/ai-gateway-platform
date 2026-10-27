import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Approval, AutoRule, Member, ProjectBudgetBatch, WorkspaceState } from '@ai-gateway/contracts';
import type { WorkspaceTransaction } from './workspace.repository';
import { activeMember, amount, availableModels, expiry, hash, limits, now, operator, pick, range, strings, text } from './validation';
import { alreadyFunded,allocate, canApprove, days,endProject, grantBatch, grantPlan, manager, matches, memberModels, newId, notify, owner, planWindow,publicKey, runPeriodic, topup, valid } from './domain';
import { monitoringState } from './monitoring.domain';
import { applyAutomatic } from './automatic-onboarding';
import { prepareKeyStatus } from './key-status';
import { applyRetention,requestedRetention,retentionPolicy } from './retention';
import { prepareEntitlementMigration } from './entitlement-migration';

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
  next.approvedAmount=a.kind==='project_create'?0:amount(p.amount??a.approvedAmount);
  next.approvedExpiresAt=expiry(p.expiresAt??a.approvedExpiresAt);
  const previous=a.execution??{};
  if(a.kind==='project_create')next.execution={managerId:activeMember(s,text(p.managerId??previous.managerId??a.proposedManagerId,'managerId')).id,range:range(s,p.range??previous.range)};
  else if(a.kind==='personal_open'){const plan=pick(s.plans,p.planId??previous.planId,'plan');if(!plan.active)throw new ConflictException('plan is disabled');next.execution={planId:plan.id};}
  else if(a.kind==='project_member_quota'){
    const budget=pick(budgets,p.sourceBatchId??previous.sourceBatchId,'source budget');
    if(budget.projectId!==a.objectId||!valid(budget.expiresAt))throw new ConflictException('active source budget must belong to the requested project');
    if(Date.parse(next.approvedExpiresAt)!==Date.parse(budget.expiresAt))throw new ConflictException('member quota must inherit the selected budget expiry');next.execution={sourceBatchId:budget.id};
  }else next.execution={};
  if(a.kind==='personal_topup'){const e=pick(s.entitlements,a.objectId,'entitlement');if(e.status!=='active'||!valid(e.expiresAt)||Date.parse(next.approvedExpiresAt)>Date.parse(e.expiresAt))throw new ConflictException('top-up must not outlive its active entitlement');}
  next.approverId=actor.id;next.status='approved';next.failure=null;next.effectiveAt=null;
  return next;
}

function submitApproval(tx:WorkspaceTransaction,actor:Member,p:Record<string,unknown>){
  const s=tx.state,kind=String(p.kind) as Approval['kind'];
  if(!['project_create','project_budget','project_member_quota','personal_open','personal_topup','application_quota'].includes(kind))throw new BadRequestException('invalid approval kind');
  const objectId=p.objectId?String(p.objectId):null;
  if(kind==='project_budget'){const project=manager(s,actor,objectId);if(project.managerId!==actor.id)throw new ForbiddenException('budget requests must come from project manager');}
  if(kind==='project_member_quota'){const project=pick(s.projects,objectId,'project');if(project.status!=='active'||!project.memberIds.includes(actor.id))throw new ForbiddenException('project membership required');}
  if(kind==='personal_topup'){const e=pick(s.entitlements,objectId,'entitlement');if(e.memberId!==actor.id||e.status!=='active'||!valid(e.expiresAt))throw new ForbiddenException('active personal entitlement required');}
  if(kind==='application_quota'){const app=owner(s,actor,objectId);if(app.ownerId!==actor.id)throw new ForbiddenException('request must come from application owner');}
  if(s.approvals.some(a=>a.applicantId===actor.id&&a.kind===kind&&a.objectId===objectId&&['pending','approved'].includes(a.status)))throw new ConflictException('an application for this purpose is already pending');
  const approval:Approval={id:newId('approval'),kind,applicantId:actor.id,objectId,amount:kind==='project_create'?0:amount(p.amount),requestedExpiresAt:expiry(p.expiresAt),scenario:text(p.scenario,'scenario',200),reason:text(p.reason,'reason',2000),proposedManagerId:p.managerId?activeMember(s,String(p.managerId)).id:null,proposedName:kind==='project_create'?text(p.name,'name',100):'',status:'pending',approverId:null,decisionReason:'',approvedAmount:null,approvedExpiresAt:null,execution:null,createdAt:now(),decidedAt:null,effectiveAt:null,failure:null};
  const approvers=s.members.filter(member=>{try{return !!activeMember(s,member.id)&&canApprove(s,member,approval);}catch{return false;}});
  if(!approvers.length)throw new ConflictException('no active responsible approver is configured');
  s.approvals.push(approval);
  for(const member of approvers)notify(s,member.id,'待审批申请',`${actor.name} · ${kind}`,'approval',approval.id);
  return approval;
}

async function executeApproval(tx:WorkspaceTransaction,actor:Member,a:Approval){
  const s=tx.state;activeMember(s,a.applicantId);const p=a.execution??{};
  switch(a.kind){
    case 'project_create':{
      const projectManager=activeMember(s,text(p.managerId??a.proposedManagerId,'managerId'));
      const project={id:newId('project'),name:a.proposedName,description:a.reason,managerId:projectManager.id,applicantId:a.applicantId,memberIds:[...new Set([projectManager.id,a.applicantId])],status:'active' as const,range:range(s,p.range),limits:limits(undefined)};
      s.projects.push(project);a.objectId=project.id;break;
    }
    case 'project_budget':{
      const project=pick(s.projects,a.objectId,'project');if(project.status!=='active'||project.managerId!==a.applicantId)throw new ConflictException('project approval scope changed');
      await tx.fundBudget({id:newId('project-budget'),projectId:project.id,totalAmount:a.approvedAmount!,availableAmount:a.approvedAmount!,expiresAt:expiry(a.approvedExpiresAt),createdAt:now()});break;
    }
    case 'project_member_quota':{
      const budget=pick(await tx.budgetBatches(),p.sourceBatchId,'source budget');
      if(Date.parse(a.approvedExpiresAt!)!==Date.parse(budget.expiresAt))throw new ConflictException('member quota must inherit the selected budget expiry');
      await allocate(tx,a.objectId!,a.applicantId,budget.id,a.approvedAmount!);break;
    }
    case 'personal_open':{
      const plan=pick(s.plans,p.planId,'plan');
      const result=await grantPlan(tx,a.applicantId,plan.id,'approval',[],{amount:a.approvedAmount!,expiresAt:expiry(a.approvedExpiresAt)});
      if(!result.granted)throw new ConflictException('member already has this plan; request a top-up instead');break;
    }
    case 'personal_topup':await topup(tx,pick(s.entitlements,a.objectId,'entitlement'),a.approvedAmount!,expiry(a.approvedExpiresAt));break;
    case 'application_quota':{
      const app=pick(s.applications,a.objectId,'application');if(!app.active||app.ownerId!==a.applicantId)throw new ConflictException('application owner or state changed');
      await grantBatch(tx,app.id,'application',a.approvedAmount!,expiry(a.approvedExpiresAt),availableModels(s,app.range),null,null);break;
    }
  }
}

export async function workflowAction(tx:WorkspaceTransaction,actor:Member,type:string,p:Record<string,unknown>):Promise<unknown>{
  const s=tx.state;
  switch(type){
    case 'alert.ack':{
      operator(actor);const m=monitoringState(s),event=pick([...m.events,...m.collectionEvents],p.id,'alert event');
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
      project.memberIds=[...new Set([...project.memberIds,...memberIds])].filter(memberId=>!removeIds.includes(memberId));return project;
    }
    case 'project.fund':{
      operator(actor);const project=pick(s.projects,p.projectId,'project');if(project.status!=='active')throw new ConflictException('project is not active');
      const value=amount(p.amount),batch={id:newId('project-budget'),projectId:project.id,totalAmount:value,availableAmount:value,expiresAt:expiry(p.expiresAt),createdAt:now()};
      await tx.fundBudget(batch);return batch;
    }
    case 'project.allocate':{
      const project=manager(s,actor,p.projectId);return allocate(tx,project.id,text(p.memberId,'memberId'),text(p.sourceBatchId,'sourceBatchId'),amount(p.amount));
    }
    case 'project.end':return endProject(tx,actor,p.projectId,p.reason);
    case 'application.fund':{
      operator(actor);const app=pick(s.applications,p.applicationId,'application');if(!app.active)throw new ConflictException('application disabled');
      return grantBatch(tx,app.id,'application',amount(p.amount),expiry(p.expiresAt),availableModels(s,app.range),null,null);
    }
    case 'approval.submit':return submitApproval(tx,actor,p);
    case 'approval.withdraw':{
      const a=pick(s.approvals,p.id,'approval');if(a.applicantId!==actor.id||a.status!=='pending')throw new ForbiddenException('only applicant may withdraw a pending request');a.status='withdrawn';return a;
    }
    case 'approval.decide':{
      const a=pick(s.approvals,p.id,'approval');if(a.status!=='pending')throw new ConflictException('approval already handled');if(!canApprove(s,actor,a))throw new ForbiddenException('not responsible for this approval, or self approval');
      a.approverId=actor.id;a.decisionReason=text(p.reason,'reason');a.decidedAt=now();
      if(p.decision==='reject'){a.status='rejected';notify(s,a.applicantId,'申请已驳回',a.decisionReason,'approval',a.id);return a;}
      if(p.decision!=='approve')throw new BadRequestException('invalid approval decision');
      a.approvedAmount=a.kind==='project_create'?0:amount(p.amount??a.amount);a.approvedExpiresAt=expiry(p.expiresAt??a.requestedExpiresAt);
      // Keep only business execution fields, never arbitrary caller data or credential values.
      a.execution={managerId:p.managerId?text(p.managerId,'managerId'):undefined,range:p.range?range(s,p.range):undefined,planId:p.planId?text(p.planId,'planId'):undefined,sourceBatchId:p.sourceBatchId?text(p.sourceBatchId,'sourceBatchId'):undefined};a.status='approved';return a;
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
      let ownerId=actor.id,subjectId=actor.id,subjectType:'employee'|'application'='employee',projectId:string|null=null,models:string[]=[];
      if(purpose==='application'){const app=owner(s,actor,p.applicationId);if(!app.active)throw new ConflictException('application disabled');ownerId=app.ownerId;subjectId=app.id;subjectType='application';models=availableModels(s,app.range);}
      else {if(p.memberId&&p.memberId!==actor.id){operator(actor);subjectId=activeMember(s,String(p.memberId)).id;ownerId=subjectId;}projectId=purpose==='project'?text(p.projectId,'projectId'):null;models=memberModels(s,subjectId,projectId);}
      if(!models.length)throw new ConflictException('no open authorized model for this purpose');
      const requested=p.expiresAt?expiry(p.expiresAt):days(90),member=s.members.find(m=>m.id===subjectId);
      const expiresAt=member?.validUntil?new Date(Math.min(Date.parse(member.validUntil),Date.parse(requested))).toISOString():requested;
      const secret=`sa_${randomBytes(32).toString('base64url')}`,keyHash=hash(secret),credentialId=newId('credential');
      const key={id:newId('key'),credentialId,name:text(p.name,'name',100),ownerId,subjectType,subjectId,purpose:purpose as 'personal'|'project'|'application',projectId,masked:`${secret.slice(0,7)}…${secret.slice(-4)}`,keyHash,status:'active' as const,createdAt:now(),expiresAt,lastUsedAt:null};
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
