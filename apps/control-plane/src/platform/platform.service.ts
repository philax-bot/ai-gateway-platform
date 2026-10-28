import { BadRequestException, ConflictException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { ApplicationDetail, ApprovalDetail, AuthorizeRequest, CallQuery, ModelRange, PlatformCommand, ProjectDetail, PurposeView, ReasonCode, ReconciliationRequest, RequestLimitDiagnostic, UsageLimits, VerificationMappingResult, VerificationRun, WorkspaceState } from '@ai-gateway/contracts';
import { chatCompletionsUrl,estimateChatInput,extractUpstreamUsage,isRequestReference,readUpstreamRequestId,summarizeVerification } from '@ai-gateway/contracts';
import { admissionForBatch, admissionDenialMessage } from '../store/admission';
import { reconciliationCalculation } from '../store/accounting';
import { DemoStore } from '../store/demo.store';
import { WorkspaceRepository } from './workspace.repository';
import { activeMember, availableModels, hash, now, operator, pick } from './validation';
import { businessDenial, canApprove, futureGrantStatus,manager, memberModels, newId, owner, publicMember, publicKey, syncResources, valid } from './domain';
import { memberCandidate,memberImportRows,resourceAction,ruleCandidate } from './resource-actions';
import { prepareApprovalRepair,prepareDistribution,prepareSettings,workflowAction } from './workflow-actions';
import { automaticMatches } from './automatic-onboarding';
import { prepareOrganizationChange } from './organization-changes';
import type { CallScope } from '../store/call-query';
import {authorizeCommand} from './command-authorization';
import {prepareKeyStatus} from './key-status';
import {prepareRetention,requestedRetention,retentionPolicy} from './retention';
import {auditObjectId,describeAudit,queryAudit} from './audit-query';
import { prepareEntitlementMigration } from './entitlement-migration';
import { fetchVerifiedUpstream, verificationCost, verificationFailure, verificationMappingSnapshots, verificationPrice, verificationTimeoutMs } from './verification';

type SafeJson=string|number|boolean|null|SafeJson[]|{[key:string]:SafeJson};
const safeResult=(value:unknown):SafeJson=>Array.isArray(value)?value.map(safeResult):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>!['secret','password','passwordHash','keyHash'].includes(key)).map(([key,v])=>[key,safeResult(v)])):typeof value==='string'||typeof value==='number'||typeof value==='boolean'||value===null?value:null;

@Injectable()
export class PlatformService {
  private readonly previewSecret=randomBytes(32);
  constructor(private readonly repository:WorkspaceRepository,private readonly store:DemoStore){
    this.store.businessState=()=>this.repository.read();
  }

  async snapshot(actorId:string){
    const {state:s,batches,budgets}=await this.repository.view(),actor=activeMember(s,actorId),admin=actor.roles.includes('operator');
    const projects=s.projects.filter(p=>admin||p.memberIds.includes(actor.id)||p.managerId===actor.id||p.applicantId===actor.id);
    const applications=s.applications.filter(a=>admin||a.ownerId===actor.id);
    const peers=new Set([actor.id,...projects.flatMap(p=>p.memberIds),...projects.map(p=>p.managerId)]);
    const purposes:PurposeView[]=[{id:'personal',name:'个人 · 日常办公',purpose:'personal',projectId:null,status:'not_open',availableAmount:0,models:[]},...projects.filter(p=>p.memberIds.includes(actor.id)).map(p=>({id:p.id,name:`项目 · ${p.name}`,purpose:'project' as const,projectId:p.id,status:'not_open' as const,availableAmount:0,models:[]}))];
    for(const view of purposes){
      const applicable=batches.filter(b=>b.sourceId===actor.id&&b.purpose===view.purpose&&b.projectId===view.projectId&&Date.parse(b.expiresAt)>Date.now()&&(view.projectId||s.entitlements.some(e=>e.id===b.entitlementId&&e.memberId===actor.id&&e.status==='active'&&valid(e.expiresAt))));
      const modelIds=memberModels(s,actor.id,view.projectId);
      view.models=modelIds.map(modelId=>{
        const usable=applicable.filter(b=>b.modelIds.includes(modelId)),availableAmount=Number(usable.reduce((sum,b)=>sum+b.availableAmount,0).toFixed(6)),largestBatchAmount=Math.max(0,...usable.map(b=>b.availableAmount));
        const quotes=usable.map(batch=>({batch,quote:admissionForBatch(s,{requestId:'view',idempotencyKey:'view-only',identity:{credentialId:'view-only',subjectType:'employee',subjectId:actor.id,organizationId:s.tenantId,projectId:view.projectId},purpose:view.purpose,modelId,mode:'chat',estimatedInputTokens:0,maxOutputTokens:1,policyVersion:'view'},batch,true)}));
        const status:PurposeView['models'][number]['status']=!usable.length?'no_quota':quotes.some(q=>q.quote.admission&&q.batch.availableAmount>=q.quote.admission.reservedAmount)?'ready':quotes.some(q=>q.quote.admission)?'quota_insufficient':quotes.some(q=>q.quote.reason==='price_unconfigured')?'price_unconfigured':'model_unavailable';
        return {modelId,name:s.definitions.find(d=>d.modelId===modelId)?.name??modelId,availableAmount,largestBatchAmount,status};
      });
      view.availableAmount=Number(applicable.filter(b=>b.modelIds.some(model=>modelIds.includes(model))).reduce((sum,b)=>sum+b.availableAmount,0).toFixed(6));
      const hasEntitlement=view.projectId?true:s.entitlements.some(e=>e.memberId===actor.id&&e.status==='active'&&valid(e.expiresAt));
      view.status=!hasEntitlement?'not_open':!view.models.length?'model_unavailable':view.models.some(m=>m.status==='ready')?'ready':view.models.some(m=>m.status==='quota_insufficient')?'quota_insufficient':view.models.some(m=>m.status==='price_unconfigured')?'price_unconfigured':view.models.every(m=>m.status==='model_unavailable')?'model_unavailable':'no_quota';
    }
    // Statistics may fail independently of identity and the authoritative quota ledgers.
    // Keep the workspace reachable for recovery, while explicitly marking all call data unknown.
    let calls:Awaited<ReturnType<DemoStore['queryCalls']>>|null=null;
    try{calls=await this.store.queryCalls({limit:200},this.callScope(s,actorId));}catch{/* no database details in the public snapshot */}
    return {revision:s.revision,actor:publicMember(actor),settings:s.settings,pendingReviewCount:calls?.summary.pendingReview??null,callDataQuality:calls?'collected' as const:'collection_failed' as const,
      organizations:s.organizations,members:s.members.filter(m=>admin||peers.has(m.id)).map(m=>admin||m.id===actor.id?publicMember(m):{id:m.id,name:m.name,organizationId:m.organizationId,active:m.active,roles:m.roles}),
      definitions:admin?s.definitions:s.definitions.filter(d=>purposes.some(p=>p.models.some(m=>m.modelId===d.modelId))),
      services:admin?s.services:[],pools:admin?s.pools:[],plans:admin?s.plans:[],rules:admin?s.rules:[],
      entitlements:s.entitlements.filter(e=>admin||e.memberId===actor.id).map(e=>({...e,futureGrantStatus:futureGrantStatus(s,e)})),projects,applications,
      approvals:s.approvals.filter(a=>admin||a.applicantId===actor.id||canApprove(s,actor,a)),
      keys:s.keys.filter(k=>!k.internal&&(admin||k.ownerId===actor.id)).map(publicKey),distributions:admin?s.distributions:[],audit:admin?s.audit.slice(-500):[],
      notifications:s.notifications.filter(n=>n.recipientId===actor.id),
      purposes,
      quotaBatches:batches.filter(b=>admin||b.sourceId===actor.id||applications.some(a=>a.id===b.sourceId)),
      projectBudgets:budgets.filter(b=>admin||projects.some(p=>p.id===b.projectId&&p.managerId===actor.id)),
      callLogs:calls?.items??[],
    };
  }

  private callScope(s:WorkspaceState,actorId:string):CallScope{
    const actor=activeMember(s,actorId);return actor.roles.includes('operator')?null:{employeeId:actorId,applicationIds:s.applications.filter(a=>a.ownerId===actorId).map(a=>a.id)};
  }
  async queryCalls(actorId:string,query:CallQuery){const s=await this.repository.read();return this.store.queryCalls(query,this.callScope(s,actorId));}
  async approvalDetail(actorId:string,id:string):Promise<ApprovalDetail>{
    const s=await this.repository.read(),actor=activeMember(s,actorId),approval=pick(s.approvals,id,'approval');
    if(!actor.roles.includes('operator')&&approval.applicantId!==actorId&&!canApprove(s,actor,approval))throw new ForbiddenException('approval is outside actor scope');
    const responsible=s.members.filter(m=>{try{return !!activeMember(s,m.id)&&canApprove(s,m,approval);}catch{return false;}}).map(m=>({id:m.id,name:m.name}));
    const canHandle=canApprove(s,actor,approval),awaitingExecution=['approved','failed'].includes(approval.status);
    return {approval,responsible,history:s.audit.filter(a=>a.objectId===id),applicantName:s.members.find(m=>m.id===approval.applicantId)?.name??approval.applicantId,permissions:{decide:canHandle&&approval.status==='pending',repair:canHandle&&awaitingExecution,execute:canHandle&&awaitingExecution&&approval.approverId===actorId,withdraw:approval.applicantId===actorId&&approval.status==='pending'}};
  }
  async keyDetail(actorId:string,id:string){
    const {state:s,batches}=await this.repository.view(),actor=activeMember(s,actorId),key=pick(s.keys,id,'key');
    if(key.internal||!actor.roles.includes('operator')&&key.ownerId!==actorId)throw new ForbiddenException('key is outside actor scope');
    const sources:{name:string;poolName:string;range:ModelRange;limits:UsageLimits;expiresAt:string|null;planVersion:number|null;balance:number}[]=[];
    const balance=(rows:typeof batches)=>Number(rows.filter(b=>valid(b.expiresAt)).reduce((n,b)=>n+b.availableAmount,0).toFixed(6));
    const append=(name:string,r:ModelRange,l:UsageLimits,expiresAt:string|null,planVersion:number|null,rows:typeof batches)=>sources.push({name,poolName:s.pools.find(p=>p.id===r.poolId)?.name??r.poolId,range:r,limits:l,expiresAt,planVersion,balance:balance(rows)});
    let models:string[]=[],sourceActive=true;
    const protections:{name:string;limits:UsageLimits}[]=[{name:'企业默认',limits:s.settings.limits}];
    if(key.purpose==='application'){
      const app=pick(s.applications,key.subjectId,'application');sourceActive=app.active;models=sourceActive?availableModels(s,app.range):[];
      append(app.name,app.range,app.limits,null,null,batches.filter(b=>b.purpose==='application'&&b.sourceId===app.id));protections.push({name:'应用整体',limits:app.limits});
    }else{
      const member=pick(s.members,key.subjectId,'member');try{activeMember(s,member.id);}catch{sourceActive=false;}
      protections.push({name:'人员总保护',limits:member.limits??{mode:'inherit'}});models=memberModels(s,member.id,key.projectId);
      if(key.projectId){const project=pick(s.projects,key.projectId,'project');sourceActive=sourceActive&&project.status==='active'&&project.memberIds.includes(member.id);append(project.name,project.range,project.limits,null,null,batches.filter(b=>b.sourceId===member.id&&b.projectId===project.id));protections.push({name:'项目整体',limits:project.limits});}
      else for(const e of s.entitlements.filter(e=>e.memberId===member.id&&e.status==='active'&&valid(e.expiresAt)))append(e.planSnapshot.name,e.range,e.planSnapshot.limits,e.expiresAt,e.planVersion,batches.filter(b=>b.entitlementId===e.id));
    }
    const calls=await this.store.queryCalls({credentialId:key.credentialId,limit:10},this.callScope(s,actorId));
    return {key:publicKey(key),ownerName:s.members.find(m=>m.id===key.ownerId)?.name??key.ownerId,sourceActive,models:(sourceActive?models:[]).map(modelId=>({modelId,name:s.definitions.find(d=>d.modelId===modelId)?.name??modelId})),sources,protections,calls,history:s.audit.filter(a=>a.objectId===key.id||a.action==='save.application'&&a.objectId===key.subjectId)};
  }
  async projectDetail(actorId:string,id:string):Promise<ProjectDetail>{
    const {state:s,batches,budgets,consumedByBatch}=await this.repository.view(id),actor=activeMember(s,actorId),project=pick(s.projects,id,'project'),canManage=actor.roles.includes('operator')||project.managerId===actorId;
    if(!canManage&&!project.memberIds.includes(actorId)&&project.applicantId!==actorId)throw new ForbiddenException('project is outside actor scope');
    const projectBatches=batches.filter(b=>b.projectId===id),ids=canManage?[...new Set([...project.memberIds,...projectBatches.map(b=>b.sourceId)])]:[actorId];
    const visibleBatches=projectBatches.filter(b=>ids.includes(b.sourceId)),batchIds=new Set(visibleBatches.map(b=>b.id));
    return {project,canManage,managerName:s.members.find(m=>m.id===project.managerId)?.name??project.managerId,poolName:s.pools.find(p=>p.id===project.range.poolId)?.name??project.range.poolId,models:availableModels(s,project.range).map(modelId=>({modelId,name:s.definitions.find(d=>d.modelId===modelId)?.name??modelId})),budgets:canManage?budgets.filter(b=>b.projectId===id):[],consumedByBatch:Object.fromEntries(Object.entries(consumedByBatch).filter(([batchId])=>batchIds.has(batchId))),members:ids.map(id=>{const m=pick(s.members,id,'member');let active=true;try{activeMember(s,id);}catch{active=false;}return {id,name:m.name,active,isMember:project.memberIds.includes(id),batches:visibleBatches.filter(b=>b.sourceId===id)};}),history:canManage?s.audit.filter(a=>a.objectId===id):[]};
  }
  async projectMemberCandidates(actorId:string,id:string){
    const s=await this.repository.read(),actor=activeMember(s,actorId),project=manager(s,actor,id);if(project.status!=='active')throw new ConflictException('project is not active');
    return s.members.filter(m=>{if(project.memberIds.includes(m.id))return false;try{return !!activeMember(s,m.id);}catch{return false;}}).map(m=>({id:m.id,name:m.name,organizationId:m.organizationId,organizationName:s.organizations.find(o=>o.id===m.organizationId)?.name??m.organizationId}));
  }

  async applicationDetail(actorId:string,id:string):Promise<ApplicationDetail>{
    const {state:s,batches}=await this.repository.view(),actor=activeMember(s,actorId),application=owner(s,actor,id);
    const appBatches=batches.filter(b=>b.sourceId===id&&b.purpose==='application'),effective=appBatches.filter(b=>valid(b.expiresAt)&&!b.closedAt),keys=s.keys.filter(k=>!k.internal&&k.purpose==='application'&&k.subjectId===id);
    const models=availableModels(s,application.range).map(modelId=>{
      const usable=effective.filter(b=>b.modelIds.includes(modelId)),availableAmount=Number(usable.reduce((sum,b)=>sum+b.availableAmount,0).toFixed(6));
      const quote=admissionForBatch(s,{requestId:'view',idempotencyKey:'view-only',identity:{credentialId:'view-only',subjectType:'application',subjectId:id,organizationId:s.tenantId,projectId:null},purpose:'application',modelId,mode:'chat',estimatedInputTokens:0,maxOutputTokens:1,policyVersion:'view'},{sourceId:id,purpose:'application',projectId:null},true);
      const status:PurposeView['models'][number]['status']=!quote.admission?quote.reason==='price_unconfigured'?'price_unconfigured':'model_unavailable':!usable.length?'no_quota':usable.some(b=>b.availableAmount>=quote.admission!.reservedAmount)?'ready':'quota_insufficient';
      return {modelId,name:s.definitions.find(d=>d.modelId===modelId)?.name??modelId,availableAmount,largestBatchAmount:Math.max(0,...usable.map(b=>b.availableAmount)),status};
    });
    const status:ApplicationDetail['status']=!application.active?'disabled':!models.length?'model_unavailable':models.some(m=>m.status==='ready')?'ready':models.some(m=>m.status==='quota_insufficient')?'quota_insufficient':models.some(m=>m.status==='price_unconfigured')?'price_unconfigured':models.every(m=>m.status==='model_unavailable')?'model_unavailable':'no_quota';
    const ids=new Set([id,...keys.map(k=>k.id)]),calls=await this.store.queryCalls({subjectId:id,purpose:'application',limit:10},this.callScope(s,actorId));
    return {application,ownerName:s.members.find(m=>m.id===application.ownerId)?.name??application.ownerId,organizationName:s.organizations.find(o=>o.id===application.organizationId)?.name??application.organizationId,poolName:s.pools.find(p=>p.id===application.range.poolId)?.name??application.range.poolId,status,models,availableAmount:Number(effective.filter(b=>b.modelIds.some(id=>models.some(m=>m.modelId===id))).reduce((sum,b)=>sum+b.availableAmount,0).toFixed(6)),batches:appBatches,keys:keys.map(publicKey),calls,history:s.audit.filter(a=>a.objectId&&ids.has(a.objectId))};
  }

  async retentionReport(actorId:string){const state=await this.repository.read();operator(activeMember(state,actorId));return prepareRetention(state).report;}
  async queryAudit(actorId:string,query:import('@ai-gateway/contracts').AuditQuery){const state=await this.repository.read();operator(activeMember(state,actorId));return queryAudit(state,query);}

  private checkCommand(c:PlatformCommand){
    if(!c||typeof c.type!=='string'||!c.payload||typeof c.payload!=='object'||Array.isArray(c.payload)||typeof c.idempotencyKey!=='string'||c.idempotencyKey.length<8||c.idempotencyKey.length>160)throw new BadRequestException('invalid command');
  }
  private needsPreview(c:PlatformCommand){
    return ['save.pool','save.member','save.rule','import.members','project.fund','project.allocate','project.members','project.end','application.fund','distribution.execute','key.status','keys.status','settings.update','settings.retention','retention.run','entitlement.revoke','entitlements.migrate','auto.apply','usage.reconcile','approval.repair'].includes(c.type)
      ||(['save.member','save.organization','save.project','save.application','save.service'].includes(c.type)&&!!c.payload.id);
  }
  async preview(actorId:string,c:PlatformCommand){
    this.checkCommand(c);const s=await this.repository.read();const actor=activeMember(s,actorId),p=c.payload;
    authorizeCommand(s,actor,c);
    let impact:Record<string,unknown>={title:c.type,objectId:p.id??p.projectId??p.applicationId??null,amount:p.amount??null,expiresAt:p.expiresAt??null,proposed:safeResult(p),preserves:['历史调用和审计','现有批次金额和到期时间']};
    if(c.type==='retention.run')impact.retention=requestedRetention(s,p).report;
    if(c.type==='settings.update'){
      const after=prepareSettings(s,p),changes:{label:string;before:string;after:string}[]=[];
      const pool=(id:string|null)=>id?s.pools.find(pool=>pool.id===id)?.name??'历史模型池':'未设置';
      const describe=(value:UsageLimits)=>value.mode==='none'?'本级不额外限制':value.mode==='inherit'?'继承默认保护':[['每分钟请求',value.rpm],['每分钟 Token',value.tpm],['并发',value.concurrency],['单次输出',value.maxOutputTokens]].filter(([,value])=>value!==undefined).map(([label,value])=>`${label} ${value}`).join(' · ')||'未设置数值';
      if('name'in p)changes.push({label:'企业显示名称',before:s.settings.name,after:after.name});
      for(const [field,label]of [['personalDefaultPoolId','新个人方案默认池'],['projectDefaultPoolId','新项目默认池']]as const)if(field in p)changes.push({label,before:pool(s.settings[field]),after:pool(after[field])});
      if('limits'in p)changes.push({label:'默认使用保护',before:describe(s.settings.limits),after:describe(after.limits)});
      impact.settingsChanges=changes;
    }
    if(c.type==='settings.retention'){
      const policy=retentionPolicy(p),draft=structuredClone(s);draft.settings.retentionDays=policy.days;draft.settings.retentionAutomatic=policy.automatic;
      impact.retentionPolicy={before:{days:s.settings.retentionDays,automatic:s.settings.retentionAutomatic===true},after:policy,eligible:prepareRetention(draft).report.eligible};
    }
    if(c.type==='key.status'||c.type==='keys.status'){
      const prepared=prepareKeyStatus(s,actor,p,c.type==='keys.status');
      impact={...impact,keyChanges:prepared.rows,changedCount:prepared.changedCount,skippedCount:prepared.skippedCount};
    }
    if(c.type==='usage.reconcile'){
      const log=await this.store.getCall(String(p.requestId));if(!log||log.billableState!=='pending_review')throw new ConflictException('only a pending-review request may be reconciled');
      const reservation=await this.store.getReservationSummary(log.requestId);if(!reservation)throw new ConflictException('reservation is missing');
      const reserved=reservation.amount;
      // SAFETY: the preview payload is validated by reconciliationCalculation before any use.
      const amount=reconciliationCalculation({...p,idempotencyKey:c.idempotencyKey,actorId} as unknown as ReconciliationRequest,reserved,reservation.admission).amount;
      impact={...impact,title:'核对预占与实际费用',objectId:log.requestId,amount,originalHold:reserved,balanceChange:Number((reserved-amount).toFixed(6)),modelId:log.modelId,preserves:['原请求结果和模型来源','预占时价格依据','原资金批次，不借用其他用途额度']};
    }
    if(c.type==='entitlements.migrate'){
      const prepared=prepareEntitlementMigration(s,p);
      impact={...impact,title:'迁移存量权益到当前方案版本',objectId:prepared.plan.id,entitlementMigration:prepared.preview,
        preserves:['权益 ID、授予时间、到期日、来源、规则关联与已发周期','已发批次余额、累计发放与来源','历史调用与预占'],
        noBackfill:'本次不补差、不发新额度、不重复发本月额度；月度后续周期按目标快照发放。'};
    }
    if(c.type==='distribution.execute'){
      const prepared=prepareDistribution(s,p);impact={...impact,...prepared,title:prepared.operation==='open_plan'?'开通个人方案':'临时追加个人额度',planName:prepared.plan.name};
    }
    if(c.type==='approval.repair'){
      const approval=pick(s.approvals,p.id,'approval'),view=await this.repository.view(),after=prepareApprovalRepair(s,actor,approval,p,view.budgets);
      impact.approvalBefore=approval;impact.approvalAfter=after;impact.title='修正已批准事项的执行参数';impact.preserves=['原申请内容','历次批准、失败及修正审计','关联业务对象和申请人'];
    }
    if(c.type==='project.end'||c.type==='save.project'&&p.status==='ended'){
      const id=c.type==='project.end'?p.projectId:p.id,project=manager(s,actor,id),view=await this.repository.view(String(id));
      if(typeof p.reason!=='string'||!p.reason.trim()||p.reason.length>2000)throw new BadRequestException('project close reason is required (up to 2000 characters)');
      const memberAmount=Number(view.batches.filter(b=>b.projectId===id).reduce((n,b)=>n+b.availableAmount,0).toFixed(6)),budgetAmount=Number(view.budgets.filter(b=>b.projectId===id).reduce((n,b)=>n+b.availableAmount,0).toFixed(6));
      impact.projectClosing={name:project.name,memberCount:project.memberIds.length,keyCount:s.keys.filter(k=>k.projectId===id&&k.status!=='revoked').length,memberAmount,budgetAmount,totalAmount:Number((memberAmount+budgetAmount).toFixed(6))};impact.preserves=['原始额度批次、到期日及历史消费','已准入请求的原预占与后续核对','结束回收记录，不转入其他用途'];
    }
    if(c.type==='project.members'){
      const project=manager(s,actor,p.projectId),removed=Array.isArray(p.removeMemberIds)?p.removeMemberIds as string[]:[],added=Array.isArray(p.memberIds)?p.memberIds as string[]:[];
      impact.projectMemberChanges={projectName:project.name,added:added.map(id=>pick(s.members,id,'member').name),removed:removed.map(id=>pick(s.members,id,'member').name)};
    }
    if(c.type==='save.member'||c.type==='import.members'){
      const draft=structuredClone(s),rows=c.type==='save.member'?[p]:memberImportRows(draft,p.rows),changes=[];
      for(const row of rows){const candidate=memberCandidate(draft,row,false),before=draft.members.find(m=>m.id===candidate.id);draft.members=draft.members.filter(m=>m.id!==candidate.id);draft.members.push(candidate);
        changes.push({id:candidate.id,name:candidate.name,directoryId:candidate.directoryId,kind:before?'更新':'新建',organizationId:candidate.organizationId,active:candidate.active,automatic:automaticMatches(draft,candidate)});
      }
      impact.memberChanges=changes;impact.automaticGrants=changes.flatMap(m=>m.automatic);impact.totalAmount=Number(changes.flatMap(m=>m.automatic).reduce((n,m)=>n+m.amount,0).toFixed(6));
      impact.stoppedFutureGrants=draft.entitlements.filter(e=>futureGrantStatus(s,e)==='scheduled'&&futureGrantStatus(draft,e)!=='scheduled').map(e=>({memberId:e.memberId,planName:e.planSnapshot.name}));
    }
    if(c.type==='auto.apply'||c.type==='save.rule'){
      const rule=c.type==='auto.apply'?pick(s.rules,p.id,'rule'):ruleCandidate(s,p);if(c.type==='auto.apply'&&!rule.active)throw new ConflictException('rule is disabled');
      const draft={...s,rules:[...s.rules.filter(r=>r.id!==rule.id),rule]},results=draft.members.flatMap(m=>automaticMatches(draft,m,rule.id));
      impact.ruleAudience=results.length;impact.automaticGrants=results;impact.totalAmount=c.type==='auto.apply'?Number(results.reduce((n,m)=>n+m.amount,0).toFixed(6)):0;impact.ruleApplication=c.type==='save.rule'?'仅保存规则，后续新增或属性变更时匹配；存量须另行预览应用':'本次应用于现有匹配成员';
      impact.stoppedFutureGrants=s.entitlements.filter(e=>futureGrantStatus(s,e)==='scheduled'&&futureGrantStatus(draft,e)!=='scheduled').map(e=>({memberId:e.memberId,planName:e.planSnapshot.name}));
    }
    if(c.type==='save.pool'){
      impact.related={plans:s.plans.filter(plan=>plan.range.poolId===p.id).map(plan=>plan.id),entitlements:s.entitlements.filter(e=>e.range.poolId===p.id).map(e=>e.memberId),projects:s.projects.filter(project=>project.range.poolId===p.id).map(project=>project.id),applications:s.applications.filter(app=>app.range.poolId===p.id).map(app=>app.id)};
      const before=s.pools.find(pool=>pool.id===p.id)?.entries??[],after=Array.isArray(p.entries)?p.entries as {definitionId:string;serviceId:string;open:boolean}[]:[];
      impact.modelChanges=[...new Set([...before.map(e=>e.definitionId),...after.map(e=>e.definitionId)])].map(definitionId=>{
        const previous=before.find(e=>e.definitionId===definitionId),next=after.find(e=>e.definitionId===definitionId);
        const describe=(entry:typeof previous)=>!entry?'未加入':`${entry.open?'已开放':'未开放'} · ${s.services.find(service=>service.id===entry.serviceId)?.name??entry.serviceId}`;
        return {name:s.definitions.find(d=>d.id===definitionId)?.name??definitionId,before:describe(previous),after:describe(next)};
      });
    }
    if(c.type==='save.organization')impact={...impact,...prepareOrganizationChange(s,p).impact};
    const payload=Buffer.from(JSON.stringify({actorId,revision:s.revision,fingerprint:hash(JSON.stringify([c.type,c.payload])),expires:Date.now()+600000})).toString('base64url');
    const signature=createHmac('sha256',this.previewSecret).update(payload).digest('hex');
    return {impact,revision:s.revision,previewToken:`${payload}.${signature}`};
  }
  private verifyPreview(c:PlatformCommand,actorId:string,revision:number){
    const [payload,signature]=String(c.previewToken??'').split('.');
    if(!payload||signature!==createHmac('sha256',this.previewSecret).update(payload).digest('hex'))throw new ConflictException('impact preview required');
    let data;try{data=JSON.parse(Buffer.from(payload,'base64url').toString());}catch{throw new ConflictException('invalid impact preview');}
    if(data.actorId!==actorId||data.revision!==revision||data.expires<Date.now()||data.fingerprint!==hash(JSON.stringify([c.type,c.payload])))throw new ConflictException('preview is stale; preview the current state again');
  }

  async execute(actorId:string,c:PlatformCommand){
    this.checkCommand(c);
    try {
      return await this.repository.transact(async tx=>{
        const s=tx.state,actor=activeMember(s,actorId),fingerprint=hash(JSON.stringify([actorId,c.type,c.payload]));
        const prior=s.operations[c.idempotencyKey];
        if(prior&&prior.fingerprint!==fingerprint)throw new ConflictException('command key reused with different input');
        authorizeCommand(s,actor,c);
        if(prior)return {result:prior.result,replayed:true,revision:s.revision};
        if(c.expectedRevision!==undefined&&c.expectedRevision!==s.revision)throw new ConflictException('workspace changed; reload before saving');
        if(this.needsPreview(c))this.verifyPreview(c,actorId,s.revision);
        const actorName=actor.name;
        let result:unknown;
        if(c.type==='usage.reconcile'){operator(actor);
          // SAFETY: execute() has already verified the signed preview; reconcile revalidates the payload shape.
          result=await tx.reconcile({...c.payload,idempotencyKey:c.idempotencyKey,actorId} as unknown as ReconciliationRequest);}
        else result=c.type.startsWith('save.')||c.type==='import.members'?await resourceAction(tx,actor,c.type,c.payload):await workflowAction(tx,actor,c.type,c.payload);
        await syncResources(tx);
        const detail=safeResult(result);
        const audit={id:newId('audit'),actorId,actorName,action:c.type,objectId:auditObjectId(c,result),reason:String(c.payload.reason??''),createdAt:now(),detail:detail&&typeof detail==='object'&&!Array.isArray(detail)?detail:{}};
        s.audit.push({...audit,objectName:describeAudit(s,audit).objectName});
        s.operations[c.idempotencyKey]={fingerprint,result:safeResult(result)};
        return {result,revision:s.revision+1,replayed:false};
      },{diagnosticContext:'business_command'});
    } catch(error){
      if(c.type==='approval.execute')await this.repository.transact(async tx=>{
        const actor=activeMember(tx.state,actorId),a=tx.state.approvals.find(a=>a.id===c.payload.id);
        if(a&&['approved','failed'].includes(a.status)&&a.approverId===actorId&&canApprove(tx.state,actor,a)){
          a.status='failed';a.failure=error instanceof Error?error.message:'execution failed';
          tx.state.audit.push({id:newId('audit'),actorId,action:'approval.execution_failed',objectId:a.id,reason:a.failure,createdAt:now(),detail:{}});
        }
      },{diagnosticContext:'approval_failure'});
      throw error;
    }
  }

  async checkAuthorization(input:AuthorizeRequest):Promise<ReasonCode|null>{
    return businessDenial(await this.repository.read(),input);
  }

  private verificationKey(value:unknown):string{
    if(value===undefined||value===null)return `verification-${randomUUID()}`;
    if(!isRequestReference(value)||value.length<8)throw new BadRequestException('verification idempotency key must contain 8 to 160 characters');
    return value;
  }
  private verificationMessage(run:VerificationRun):string{
    const summary=summarizeVerification(run);
    if(run.state==='running')return '验证仍在进行中；完成后才能写入当前配置状态';
    if(run.state==='interrupted')return '验证进程中断；已发出的请求用量待确认，未标记为通过';
    if(summary.failed>0){
      const detail=run.results.filter(result=>result.outcome==='failed'&&result.message).map(result=>result.message);
      return `${summary.mappings} 个映射中 ${summary.passed} 个通过，${summary.failed} 个未通过${detail.length?`（${detail.join('；')}）`:''}；失败模型不会标记为验证通过`;
    }
    if(summary.usageUnknown>0)return '连接已通过；上游未返回完整用量，内部成本无法估算';
    if(summary.costUnknown>0||summary.internalCost===null)return '连接已通过，成本未知（价格未配置）';
    return `实际 HTTP 验证通过；内部诊断成本 ${summary.internalCost} 元已记录，不代表容量或全部协议能力已验证`;
  }
  /**
   * Platform diagnostic traffic: evidence is stored as a verification run, and no
   * employee, project or application quota is reserved or charged.
   */
  async verifyService(actorId:string,serviceId:string,body:Record<string,unknown>={}){
    const before=await this.repository.read();operator(activeMember(before,actorId));const service=pick(before.services,serviceId,'service');
    let endpoint:URL;
    try{endpoint=new URL(service.baseUrl);}catch{throw new BadRequestException('invalid service URL');}
    if(!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)&&process.env.ALLOW_UPSTREAM_VALIDATION!=='true')throw new ForbiddenException('external model requests require explicit environment enablement');
    // A missing credential reference is a configuration error, not an executable diagnostic run.
    const credential=service.credentialRef?process.env[service.credentialRef]:null;
    if(service.credentialRef&&!credential)throw new ConflictException('controlled credential reference is not configured');
    const idempotencyKey=this.verificationKey(body.idempotencyKey);
    const {run,replayed}=await this.store.startVerification({serviceId,serviceName:service.name,operatorId:actorId,configVersion:service.configVersion,mappings:verificationMappingSnapshots(service.mappings),idempotencyKey});
    let finished:VerificationRun;
    if(replayed)finished=run;
    else{
      let state:'completed'|'interrupted'='completed';
      try{
        for(const mapping of service.mappings){
          // Persist the attempt before calling out so an interrupted run still has evidence.
          await this.store.markVerificationAttempt(run.id,mapping.definitionId);
          const price=verificationPrice(service.id,service.configVersion,mapping);
          let result:VerificationMappingResult;
          try{
            // One bounded connect-phase retry inside the helper; never retried after a partial response.
            const response=await fetchVerifiedUpstream(chatCompletionsUrl(service.baseUrl),{method:'POST',redirect:'error',signal:AbortSignal.timeout(verificationTimeoutMs()),headers:{'content-type':'application/json',...(credential?{authorization:`Bearer ${credential}`}:{})},body:JSON.stringify({model:mapping.upstreamModel,messages:[{role:'user',content:'Connection validation'}],max_tokens:1})});
            const upstreamRequestId=readUpstreamRequestId(response.headers);
            const raw=await response.text();
            if(!response.ok){
              const failure=verificationFailure(response.status,null);
              result={definitionId:mapping.definitionId,upstreamModel:mapping.upstreamModel,outcome:'failed',httpStatus:response.status,errorCode:failure.errorCode,message:failure.message,upstreamRequestId,usage:{inputTokens:null,outputTokens:null,cachedInputTokens:null,complete:false},cost:verificationCost(price,null),completedAt:now()};
            }else{
              let value:unknown;try{value=JSON.parse(raw);}catch{value=null;}
              if(!value||typeof value!=='object'||Array.isArray(value)||!Array.isArray((value as {choices?:unknown}).choices))throw new Error('响应不符合文本对话格式');
              const usage=extractUpstreamUsage(raw);
              result={definitionId:mapping.definitionId,upstreamModel:mapping.upstreamModel,outcome:'passed',httpStatus:response.status,errorCode:null,message:usage?'连接通过，已返回用量':'连接通过，上游未返回用量',upstreamRequestId,usage:usage?{inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,cachedInputTokens:usage.cachedInputTokens,complete:true}:{inputTokens:null,outputTokens:null,cachedInputTokens:null,complete:false},cost:verificationCost(price,usage),completedAt:now()};
            }
          }catch(error){
            const failure=verificationFailure(null,error);
            result={definitionId:mapping.definitionId,upstreamModel:mapping.upstreamModel,outcome:'failed',httpStatus:null,errorCode:failure.errorCode,message:failure.message,upstreamRequestId:null,usage:{inputTokens:null,outputTokens:null,cachedInputTokens:null,complete:false},cost:verificationCost(price,null),completedAt:now()};
          }
          await this.store.appendVerificationResult(run.id,result);
        }
      }catch{state='interrupted';}
      try{finished=await this.store.finishVerification(run.id,state);}catch{throw new ServiceUnavailableException('验证已执行，但计量记录未能保存；请先检查运行记录，再决定是否重试');}
    }
    const applied=await this.repository.transact(async tx=>{
      operator(activeMember(tx.state,actorId));const current=pick(tx.state.services,serviceId,'service');
      // A configuration change mid-run keeps the old run and its usage evidence,
      // but never writes the old result as the current configuration passing.
      if(finished.state!=='completed'||current.configVersion!==run.configVersion)return false;
      const summary=summarizeVerification(finished);
      const passed=finished.state==='completed'&&summary.failed===0&&finished.results.length===finished.mappings.length;
      current.verification=passed?'passed':'failed';current.verificationMessage=this.verificationMessage(finished);current.verifiedAt=now();await syncResources(tx);
      tx.state.audit.push({id:newId('audit'),actorId,action:'service.verify',objectId:serviceId,reason:current.verificationMessage,createdAt:now(),detail:{passed,runId:finished.id,configVersion:service.configVersion,costState:summary.internalCost===null?'unknown':'priced',internalCost:summary.internalCost}});
      return true;
    },{diagnosticContext:'service_verification'});
    const currentService=pick((await this.repository.read()).services,serviceId,'service');
    return {...currentService,verificationRun:finished,verificationApplied:applied,replayed};
  }
  async verificationHistory(actorId:string,serviceId:string,query:{limit?:unknown;before?:unknown}={}){
    const state=await this.repository.read();operator(activeMember(state,actorId));pick(state.services,serviceId,'service');
    const limit=query.limit===undefined||query.limit===''?20:Number(query.limit);
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new BadRequestException('verification page size must be between 1 and 100');
    let before:string|null=null;
    if(query.before!==undefined&&query.before!==''){
      if(typeof query.before!=='string'||!Number.isFinite(Date.parse(query.before)))throw new BadRequestException('invalid verification cursor');
      before=new Date(query.before).toISOString();
    }
    return this.store.listVerifications(serviceId,{limit,before});
  }
  async callRelations(actorId:string,requestId:string){
    if(!isRequestReference(requestId))throw new BadRequestException('invalid request ID');
    const state=await this.repository.read();
    return this.store.relatedCalls(requestId,this.callScope(state,actorId));
  }

  async onlineCredential(actorId:string,payload:Record<string,unknown>){
    if(payload.purpose!=='personal'&&payload.purpose!=='project')throw new BadRequestException('online use requires a personal or project purpose');
    return this.repository.transact(async tx=>{
      const actor=activeMember(tx.state,actorId);
      const result=await workflowAction(tx,actor,'key.issue',{name:'在线会话临时身份',purpose:payload.purpose,projectId:payload.projectId,expiresAt:new Date(Date.now()+5*60000).toISOString()}) as {key:{id:string;expiresAt:string};secret:string};
      pick(tx.state.keys,result.key.id,'key').internal=true;
      await syncResources(tx);
      return {token:result.secret,expiresAt:result.key.expiresAt};
    },{diagnosticContext:'online_credential'});
  }
  async quote(actorId:string,payload:Record<string,unknown>){
    const {state:s,batches}=await this.repository.view();activeMember(s,actorId);
    if(payload.purpose!=='personal'&&payload.purpose!=='project')throw new BadRequestException('invalid online purpose');
    if(typeof payload.model!=='string'||!Array.isArray(payload.messages))throw new BadRequestException('model and messages are required');
    const requestedOutput=payload.max_completion_tokens??payload.max_tokens;
    if(requestedOutput!==undefined&&(typeof requestedOutput!=='number'||!Number.isSafeInteger(requestedOutput)||requestedOutput<1))throw new BadRequestException('output token limit must be a positive integer');
    const request:AuthorizeRequest={requestId:'quote',idempotencyKey:'quote-only',identity:{subjectType:'employee',subjectId:actorId,credentialId:'quote-only',organizationId:s.tenantId,projectId:payload.purpose==='project'?String(payload.projectId):null},purpose:payload.purpose,modelId:payload.model,mode:'chat',policyVersion:'quote',estimatedInputTokens:estimateChatInput(payload),maxOutputTokens:requestedOutput as number|undefined};
    const candidates=batches.filter(b=>b.sourceId===actorId&&b.purpose===request.purpose&&b.projectId===request.identity.projectId&&Date.parse(b.expiresAt)>Date.now()&&b.modelIds.includes(request.modelId));
    let reason:ReasonCode='no_quota',eligible=0;
    let requestLimits:RequestLimitDiagnostic|undefined;
    for(const batch of candidates){const quote=admissionForBatch(s,request,batch,true);if(quote.reason){reason=quote.reason;requestLimits=quote.requestLimits;continue;}
      eligible++;
      if(batch.availableAmount<quote.admission.reservedAmount){reason='quota_insufficient';requestLimits=undefined;continue;}
      const e=s.entitlements.find(e=>e.id===batch.entitlementId);
      return {decision:'allow',reasonCode:'none',batchId:batch.id,sourceName:e?.planSnapshot.name??s.projects.find(p=>p.id===batch.projectId)?.name??'来源批次',estimatedInputTokens:request.estimatedInputTokens,maxOutputTokens:quote.admission.route!.maxOutputTokens,reservedAmount:quote.admission.reservedAmount,price:quote.admission.price,availableAmount:batch.availableAmount};
    }
    if(eligible){reason='quota_insufficient';requestLimits=undefined;}
    return {decision:'deny',reasonCode:reason,reasonMessage:admissionDenialMessage(reason,requestLimits),...(requestLimits?{requestLimits}:{})};
  }
}
