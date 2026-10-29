import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Approval, AuthorizeRequest, AutoRule, BusinessQuotaBatch, Entitlement, Member, Plan,ReasonCode, WorkspaceState } from '@ai-gateway/contracts';
import type { WorkspaceTransaction } from './workspace.repository';
import { activeMember, availableModels, now, pick } from './validation';
import type {AdmissionWorkspace} from '../store/admission-policy-lock';

export const newId=(prefix:string)=>`${prefix}-${randomUUID()}`;
export const valid=(date:string|null)=>date===null||Date.parse(date)>Date.now();
export const days=(count:number)=>new Date(Date.now()+count*86400000).toISOString();
export function publicMember(member:Member){const {passwordHash,...value}=member;return value;}
export function publicKey(key:WorkspaceState['keys'][number]){const {keyHash,onlineSessionHash,...value}=key;return value;}
export function manager(s:WorkspaceState,actor:Member,projectId:unknown){
  const p=pick(s.projects,projectId,'project');
  if(!actor.roles.includes('operator')&&p.managerId!==actor.id)throw new ForbiddenException('project manager responsibility required');return p;
}
export function owner(s:WorkspaceState,actor:Member,applicationId:unknown){
  const app=pick(s.applications,applicationId,'application');
  if(!actor.roles.includes('operator')&&app.ownerId!==actor.id)throw new ForbiddenException('application owner responsibility required');return app;
}
export async function endProject(tx:WorkspaceTransaction,actor:Member,projectId:unknown,reason:unknown){
  const project=manager(tx.state,actor,projectId),why=typeof reason==='string'?reason.trim():'';
  if(!why||why.length>2000)throw new BadRequestException('project close reason is required (up to 2000 characters)');
  if(project.status==='ended')return {project,memberAmount:0,budgetAmount:0};
  const amounts=await tx.closeProjectBalances(project.id);project.status='ended';project.closedAt=now();project.closedBy=actor.id;project.closeReason=why;
  for(const key of tx.state.keys)if(key.projectId===project.id&&key.status!=='revoked')key.status='disabled';
  tx.state.audit.push({id:newId('audit'),actorId:actor.id,action:'project.closed',objectId:project.id,reason:why,createdAt:now(),detail:{...amounts,closedAt:project.closedAt,policy:'unused_to_closed_record; original_holds_settle_to_original_source'}});
  for(const memberId of project.memberIds)notify(tx.state,memberId,'项目已结束',`${project.name}：${why}`,'project',project.id);
  return {project,...amounts};
}
export function canApprove(s:WorkspaceState,actor:Member,a:Approval):boolean {
  if(a.applicantId===actor.id)return false;
  if(a.kind==='project_member_quota'){
    const p=s.projects.find(p=>p.id===a.objectId);
    if(p&&p.managerId!==a.applicantId)return p.managerId===actor.id;
  }
  return actor.roles.includes('operator');
}
export function memberModels(s:Pick<WorkspaceState,'projects'|'entitlements'|'pools'|'services'|'definitions'>,memberId:string,projectId:string|null=null):string[]{
  if(projectId){const p=s.projects.find(p=>p.id===projectId&&p.status==='active'&&p.memberIds.includes(memberId));return p?availableModels(s,p.range):[];}
  return [...new Set(s.entitlements.filter(e=>e.memberId===memberId&&e.status==='active'&&valid(e.expiresAt)).flatMap(e=>availableModels(s,e.range)))];
}
export function businessDenial(s:AdmissionWorkspace,input:AuthorizeRequest):ReasonCode|null {
  const key=s.keys.find(k=>k.credentialId===input.identity.credentialId);
  if(!key){
    if(process.env.ENABLE_DEMO_CREDENTIALS==='false'||input.identity.organizationId!==s.tenantId||!['credential-demo-001','credential-project-demo-001'].includes(input.identity.credentialId))return 'credential_invalid';
    try{activeMember(s,input.identity.subjectId);}catch{return 'subject_disabled';}
    return null;
  }
  if(key.status!=='active'||!valid(key.expiresAt))return 'credential_invalid';
  if(key.internal&&!key.onlineSessionHash)return 'credential_invalid';
  if(key.subjectType==='employee'){try{activeMember(s,key.subjectId);}catch{return 'subject_disabled';}}
  else if(!s.applications.some(a=>a.id===key.subjectId&&a.active))return 'subject_disabled';
  if(key.projectId&&!s.projects.some(p=>p.id===key.projectId&&p.status==='active'&&p.memberIds.includes(key.subjectId)))return 'credential_invalid';
  const models=key.subjectType==='employee'?memberModels(s,key.subjectId,key.projectId):availableModels(s,pick(s.applications,key.subjectId,'application').range);
  return models.includes(input.modelId)?null:'model_not_open';
}
export function matches(s:WorkspaceState,member:Member,rule:AutoRule){
  if(!rule.active||!member.active||!valid(member.validUntil)||(rule.category&&rule.category!==member.category)||rule.tags.some(tag=>!member.tags.includes(tag)))return false;
  if(!rule.organizationId)return true;if(member.organizationId===rule.organizationId)return true;if(!rule.includeChildren)return false;
  let org=s.organizations.find(o=>o.id===member.organizationId);const visited=new Set<string>();
  while(org?.parentId&&!visited.has(org.id)){visited.add(org.id);if(org.parentId===rule.organizationId)return true;const parentId=org.parentId;org=s.organizations.find(o=>o.id===parentId);}return false;
}
export function notify(s:WorkspaceState,recipientId:string,title:string,body:string,objectType:string,objectId:string){
  s.notifications.push({id:newId('notification'),recipientId,title,body,objectType,objectId,createdAt:now(),readAt:null});
}
export async function grantBatch(tx:WorkspaceTransaction,subjectId:string,purpose:BusinessQuotaBatch['purpose'],value:number,expiresAt:string,modelIds:string[],entitlementId:string|null,sourceBatchId:string|null,projectId:string|null=null){
  const batch:BusinessQuotaBatch={id:newId('quota'),sourceType:purpose==='personal'?'personal_batch':purpose==='project'?'project_member_batch':'application_wallet',sourceId:subjectId,organizationId:tx.state.tenantId,projectId,purpose,totalAmount:value,availableAmount:value,modelIds,expiresAt,entitlementId,sourceBatchId};
  await tx.grant(batch);return batch;
}
function currentMonth(){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit'}).formatToParts(new Date());
  const year=Number(parts.find(p=>p.type==='year')!.value),month=Number(parts.find(p=>p.type==='month')!.value);
  return {key:`${year}-${String(month).padStart(2,'0')}`,end:Date.UTC(year,month,1)-8*3600000-1};
}
export function planWindow(plan:Plan,member:Member){
  const entitlementExpiresAt=new Date(Math.min(Date.parse(days(plan.entitlementDays)),member.validUntil?Date.parse(member.validUntil):Infinity)).toISOString();
  const quotaExpiresAt=new Date(Math.min(plan.cadence==='monthly'?currentMonth().end:Date.parse(days(plan.quotaDays)),Date.parse(entitlementExpiresAt))).toISOString();
  return {entitlementExpiresAt,quotaExpiresAt};
}
export function alreadyFunded(s:WorkspaceState,memberId:string,plan:Plan){
  const cycle=plan.cadence==='monthly'?currentMonth().key:'once';
  return s.entitlements.some(e=>e.memberId===memberId&&e.planId===plan.id&&e.periods.includes(cycle));
}
export function futureGrantStatus(s:WorkspaceState,e:Entitlement):'scheduled'|'manually_stopped'|'rule_not_matching'|'inactive'{
  if(e.status!=='active'||!valid(e.expiresAt))return 'inactive';try{activeMember(s,e.memberId);}catch{return 'inactive';}
  if(!e.futureGrants)return 'manually_stopped';
  if(e.source==='automatic'&&!e.ruleIds.some(id=>{const r=s.rules.find(r=>r.id===id);return r&&r.planId===e.planId&&matches(s,pick(s.members,e.memberId,'member'),r);}))return 'rule_not_matching';
  return 'scheduled';
}
export async function issuePeriod(tx:WorkspaceTransaction,e:Entitlement,override?:{amount:number;expiresAt:string}){
  const monthly=currentMonth(),cycle=e.planSnapshot.cadence==='monthly'?monthly.key:'once';if(alreadyFunded(tx.state,e.memberId,e.planSnapshot))return null;
  const end=override?Date.parse(override.expiresAt):e.planSnapshot.cadence==='monthly'?monthly.end:Date.parse(days(e.planSnapshot.quotaDays));
  const expiresAt=new Date(Math.min(end,Date.parse(e.expiresAt))).toISOString();
  if(Date.parse(expiresAt)<=Date.now())throw new ConflictException('entitlement has expired');
  const batch=await grantBatch(tx,e.memberId,'personal',override?.amount??e.planSnapshot.amount,expiresAt,availableModels(tx.state,e.range),e.id,null);e.periods.push(cycle);return batch;
}
export async function grantPlan(tx:WorkspaceTransaction,memberId:string,planId:string,source:Entitlement['source'],ruleIds:string[],override?:{amount:number;expiresAt:string}){
  const s=tx.state,member=activeMember(s,memberId),plan=pick(s.plans,planId,'plan');if(!plan.active)throw new ConflictException('plan is disabled');
  const existing=s.entitlements.find(e=>e.memberId===member.id&&e.planId===plan.id&&e.status==='active'&&valid(e.expiresAt));
  if(existing){existing.ruleIds=[...new Set([...existing.ruleIds,...ruleIds])];return {entitlementId:existing.id,granted:false,batchId:null};}
  const entitlement:Entitlement={id:newId('entitlement'),memberId,planId,planVersion:plan.version,planSnapshot:structuredClone(plan),range:structuredClone(plan.range),grantedAt:now(),expiresAt:new Date(Math.min(Date.parse(days(plan.entitlementDays)),member.validUntil?Date.parse(member.validUntil):Infinity)).toISOString(),status:'active',futureGrants:true,source,ruleIds,periods:[]};
  if(override&&Date.parse(override.expiresAt)>Date.parse(entitlement.expiresAt))throw new ConflictException('quota cannot outlive the approved model entitlement');
  s.entitlements.push(entitlement);const batch=await issuePeriod(tx,entitlement,override);
  notify(s,memberId,'AI 使用权益已开通',plan.name,'entitlement',entitlement.id);
  s.audit.push({id:newId('audit'),actorId:'system',action:'entitlement.grant',objectId:entitlement.id,reason:source,createdAt:now(),detail:{memberId,planId,planVersion:plan.version,ruleIds,batchId:batch?.id}});
  return {entitlementId:entitlement.id,granted:true,batchId:batch?.id??null};
}
export async function topup(tx:WorkspaceTransaction,e:Entitlement,value:number,expiresAt:string){
  if(e.status!=='active'||!valid(e.expiresAt)||Date.parse(expiresAt)>Date.parse(e.expiresAt))throw new ConflictException('top-up must not outlive its active entitlement');
  activeMember(tx.state,e.memberId);return grantBatch(tx,e.memberId,'personal',value,expiresAt,availableModels(tx.state,e.range),e.id,null);
}
export async function allocate(tx:WorkspaceTransaction,projectId:string,memberId:string,sourceBatchId:string,value:number){
  const project=pick(tx.state.projects,projectId,'project');activeMember(tx.state,memberId);
  if(project.status!=='active'||!project.memberIds.includes(memberId))throw new ConflictException('active project membership required');
  const budget=pick(await tx.budgetBatches(),sourceBatchId,'source budget');if(budget.projectId!==projectId)throw new ForbiddenException('budget belongs to another project');
  await tx.allocateBudget(sourceBatchId,value);
  return grantBatch(tx,memberId,'project',value,budget.expiresAt,availableModels(tx.state,project.range),null,budget.id,projectId);
}
export async function syncResources(tx:WorkspaceTransaction){
  const s=tx.state;
  for(const batch of await tx.batches()){
    let models:string[]|null=null;
    if(batch.entitlementId){const e=s.entitlements.find(e=>e.id===batch.entitlementId);models=e&&e.status==='active'&&valid(e.expiresAt)?availableModels(s,e.range):[];}
    if(batch.projectId&&s.projects.some(p=>p.id===batch.projectId)){const p=s.projects.find(p=>p.id===batch.projectId)!;models=p.status==='active'?availableModels(s,p.range):[];}
    if(batch.purpose==='application'){const app=s.applications.find(a=>a.id===batch.sourceId);if(app)models=app.active?availableModels(s,app.range):[];}
    if(models)await tx.updateBatchModels(batch.id,models);
  }
  for(const key of s.keys){
    let active=key.status==='active'&&valid(key.expiresAt),models:string[]=[];
    if(key.internal)active=active&&!!key.onlineSessionHash;
    if(key.subjectType==='employee'){try{activeMember(s,key.subjectId);}catch{active=false;}models=memberModels(s,key.subjectId,key.projectId);}
    else {const app=s.applications.find(a=>a.id===key.subjectId);active=active&&!!app?.active;models=app?availableModels(s,app.range):[];}
    await tx.saveCredential({credentialId:key.credentialId,apiKey:`sha256:${key.keyHash}`,identity:{credentialId:key.credentialId,subjectType:key.subjectType,subjectId:key.subjectId,organizationId:s.tenantId,projectId:key.projectId},purpose:key.purpose,active,modelIds:models});
  }
  for(const member of s.members){try{activeMember(s,member.id);}catch{await tx.disableCredentials(member.id);}}
}
export function hasPeriodicWork(s:WorkspaceState){
  return s.entitlements.some(e=>e.planSnapshot.cadence==='monthly'&&futureGrantStatus(s,e)==='scheduled'&&!alreadyFunded(s,e.memberId,e.planSnapshot));
}
export async function runPeriodic(tx:WorkspaceTransaction){
  const s=tx.state,issued=[];
  for(const e of s.entitlements){
    if(e.planSnapshot.cadence!=='monthly'||futureGrantStatus(s,e)!=='scheduled')continue;
    const batch=await issuePeriod(tx,e);if(batch){
      issued.push(batch.id);
      s.distributions.push({id:newId('distribution'),actorId:'system:monthly',kind:'plan',planId:e.planId,planSnapshot:structuredClone(e.planSnapshot),scopeDescription:'月度定期发放',entitlementId:e.id,amount:batch.totalAmount,memberIds:[e.memberId],expiresAt:batch.expiresAt,createdAt:new Date().toISOString(),results:[{memberId:e.memberId,status:'granted',reason:'按月定期发放',batchId:batch.id,expiresAt:batch.expiresAt,amount:batch.totalAmount,entitlementId:e.id,planVersion:e.planVersion}]});
      s.audit.push({id:newId('audit'),actorId:'system:monthly',action:'quota.monthly_grant',objectId:e.id,reason:'月度方案当前周期发放',createdAt:new Date().toISOString(),detail:{planId:e.planId,planVersion:e.planVersion,batchId:batch.id,amount:batch.totalAmount}});
      notify(s,e.memberId,'本月额度已发放',e.planSnapshot.name,'entitlement',e.id);
    }
  }
  return {issuedBatchIds:issued};
}
