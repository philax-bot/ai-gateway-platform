import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function checkOnboarding({admin,request,state,command}){
  let assertions=0;const check=(value,message)=>{assert.ok(value,message);assertions++;};
  const range={poolId:'pool-local-test',mode:'follow',definitionIds:[]};
  const plan=(await command(admin,'save.plan',{name:'导入专用月度方案',range,amount:6,cadence:'monthly',quotaDays:30,entitlementDays:365})).result;
  const org=(await command(admin,'save.organization',{name:'导入子组织',parentId:'department-engineering'})).result;
  const rulePayload={name:'导入规则一',planId:plan.id,organizationId:'department-engineering',includeChildren:true,category:'employee',tags:['导入验证']};
  const first=(await command(admin,'save.rule',rulePayload)).result;await command(admin,'save.rule',{...rulePayload,name:'导入规则二'});
  check(!(await state(admin)).entitlements.some(e=>e.planId===plan.id),'saving a rule does not grant existing members');
  const rows=[{directoryId:'bulk-active',name:'批量有效',organizationId:org.id,tags:['导入验证']},{directoryId:'bulk-off',name:'批量停用',organizationId:org.id,tags:['导入验证'],active:false},{directoryId:'bulk-expired',name:'批量到期',organizationId:org.id,tags:['导入验证'],validUntil:new Date(Date.now()-86400000).toISOString()}];
  const c={type:'import.members',payload:{rows},idempotencyKey:randomUUID()};const p=await request('/api/v1/platform/preview',c,admin);
  check(p.status===200&&p.body.impact.totalAmount===6,'import preview groups same-plan matches and excludes inactive/expired rows');
  check(p.body.impact.automaticGrants.length===3,'preview keeps every matched row, including excluded members');
  const execute=()=>request('/api/v1/platform/commands',{...c,previewToken:p.body.previewToken},admin);
  const concurrent=await Promise.all([execute(),execute()]);check(concurrent.every(r=>r.status===200)&&concurrent.some(r=>r.body.replayed),'concurrent same-command import is replayed atomically');
  let s=await state(admin),person=s.members.find(m=>m.directoryId==='bulk-active');
  check(s.quotaBatches.filter(b=>b.sourceId===person.id).length===1,'same-plan duplicate rules produce one persisted funding batch');
  check(s.distributions.flatMap(d=>d.results).some(r=>r.memberId===s.members.find(m=>m.directoryId==='bulk-off').id&&r.status==='skipped'),'excluded automatic match has a per-person execution record');
  check(s.audit.some(a=>a.action==='automatic.match'&&a.objectId===person.id&&a.detail.trigger==='members.imported'&&a.detail.ruleIds.length===2),'automatic audit preserves trigger and both condition sources');
  await command(admin,'import.members',{rows});s=await state(admin);
  check(s.members.find(m=>m.directoryId==='bulk-active').id===person.id&&s.quotaBatches.filter(b=>b.sourceId===person.id).length===1,'repeat import preserves directory identity and funding');
  const invalid=await request('/api/v1/platform/preview',{type:'import.members',payload:{rows:[rows[0],rows[0]]},idempotencyKey:randomUUID()},admin);check(invalid.status===400,'duplicate directory IDs rejected before commit');
  const e=s.entitlements.find(e=>e.memberId===person.id&&e.planId===plan.id);
  await command(admin,'entitlement.revoke',{id:e.id,reason:'同月重开验收'});
  const reopen={type:'distribution.execute',payload:{planId:plan.id,memberIds:[person.id]},idempotencyKey:randomUUID()},rp=await request('/api/v1/platform/preview',reopen,admin);
  check(rp.status===200&&rp.body.impact.totalAmount===0,'reopening rights in same cycle previews no repeated funding');
  await command(admin,reopen.type,reopen.payload);s=await state(admin);check(s.quotaBatches.filter(b=>b.sourceId===person.id).length===1,'reopened entitlement does not repeat persisted monthly funding');
  const topup={operation:'topup',sourcePlanId:plan.id,scope:'conditions',organizationId:'department-engineering',includeChildren:true,tags:['导入验证'],amount:2,expiresAt:new Date(Date.now()+86400000).toISOString()};
  const tp=await request('/api/v1/platform/preview',{type:'distribution.execute',payload:topup,idempotencyKey:randomUUID()},admin);check(tp.status===200&&tp.body.impact.grantCount===1&&tp.body.impact.totalAmount===2,'scope top-up includes only effective existing rights');
  await command(admin,'distribution.execute',topup);s=await state(admin);check(s.quotaBatches.filter(b=>b.sourceId===person.id).reduce((n,b)=>n+b.totalAmount,0)===8,'scope top-up adds only requested money');
  await command(admin,'save.member',{...person,tags:[]});s=await state(admin);
  // Reopened rights were granted manually, and stay independent of automatic rule changes.
  check(s.entitlements.find(e=>e.memberId===person.id&&e.status==='active').futureGrantStatus==='scheduled','manual primary source survives lost automatic conditions');
  await command(admin,'save.rule',{...first,active:false});
  console.log(`PASS ${assertions} onboarding HTTP assertions (trusted import, hierarchy scope, deduplication, recovery and existing-rights top-up)`);
  return assertions;
}
