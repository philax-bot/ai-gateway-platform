import type { Member,WorkspaceState } from '@ai-gateway/contracts';
import type { WorkspaceTransaction } from './workspace.repository';
import { alreadyFunded,grantPlan,matches,newId,planWindow,valid } from './domain';
import { activeMember,now,pick } from './validation';

export function automaticMatches(s:WorkspaceState,member:Member,onlyRuleId?:string){
  const selected=s.rules.filter(r=>(!onlyRuleId||r.id===onlyRuleId)&&matches(s,{...member,active:true,validUntil:null},r));
  return [...new Set(selected.map(r=>r.planId))].map(planId=>{
    const rules=selected.filter(r=>r.planId===planId),plan=pick(s.plans,planId,'plan');
    let reason='',active=true;try{activeMember(s,member.id);}catch{reason='成员或组织停用 / 到期';active=false;}
    const existing=s.entitlements.find(e=>e.memberId===member.id&&e.planId===plan.id&&e.status==='active'&&valid(e.expiresAt));
    const status=reason?'skipped':!plan.active?'failed':existing?'skipped':'granted';
    const funded=alreadyFunded(s,member.id,plan);
    if(!reason)reason=!plan.active?'方案已停用':existing?'已有有效方案权益，不重复发放':funded?'该方案本周期已发放，本次仅恢复权益':'';
    return {memberId:member.id,memberName:member.name,planId:plan.id,planName:plan.name,planVersion:plan.version,ruleIds:rules.map(r=>r.id),conditions:rules.map(r=>({id:r.id,name:r.name,organizationId:r.organizationId,includeChildren:r.includeChildren,category:r.category,tags:r.tags})),status:status as 'granted'|'skipped'|'failed',reason,fundingEligible:active&&plan.active,amount:status==='granted'&&!funded?plan.amount:0,expiresAt:planWindow(plan,member).quotaExpiresAt,entitlementId:existing?.id??null};
  });
}
export async function applyAutomatic(tx:WorkspaceTransaction,memberIds:string[],actorId:string,trigger:string,onlyRuleId?:string){
  const s=tx.state,results=[];
  for(const memberId of memberIds)for(const match of automaticMatches(s,pick(s.members,memberId,'member'),onlyRuleId)){
    let batchId:string|null=null,entitlementId=match.entitlementId;
    // Business-ineligible rows are recorded independently. Unexpected persistence errors still roll the transaction back.
    if(match.fundingEligible&&(match.status==='granted'||entitlementId)){
      const result=await grantPlan(tx,memberId,match.planId,'automatic',match.ruleIds);batchId=result.batchId;entitlementId=result.entitlementId;
    }
    const batch=batchId?(await tx.batches()).find(b=>b.id===batchId):null;
    const entitlement=s.entitlements.find(e=>e.id===entitlementId);
    const result={...match,batchId,entitlementId,planVersion:entitlement?.planVersion??match.planVersion,expiresAt:batch?.expiresAt??null,amount:batch?.totalAmount??0};results.push(result);
    s.audit.push({id:newId('audit'),actorId,action:'automatic.match',objectId:memberId,reason:match.reason||'命中规则并授予',createdAt:now(),detail:{trigger,...result}});
  }
  for(const planId of new Set(results.map(r=>r.planId))){const plan=pick(s.plans,planId,'plan'),rows=results.filter(r=>r.planId===planId);
    s.distributions.push({id:newId('distribution'),actorId,kind:'plan',planId,planSnapshot:structuredClone(plan),scopeDescription:({'member.saved':'成员新增或属性更新','members.imported':'批量导入成员','rule.applied_to_existing':'规则应用于现有成员','organization.changed':'组织归属或状态变更，含所有下级成员'} as Record<string,string>)[trigger]??trigger,entitlementId:null,amount:plan.amount,memberIds:rows.map(r=>r.memberId),expiresAt:rows.map(r=>r.expiresAt).filter((v):v is string=>!!v).sort()[0]??now(),createdAt:now(),results:rows.map(r=>({memberId:r.memberId,status:r.status,reason:r.reason,batchId:r.batchId,expiresAt:r.expiresAt,amount:r.amount,entitlementId:r.entitlementId,planVersion:r.planVersion}))});
  }
  return {results};
}
