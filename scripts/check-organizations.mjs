import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function checkOrganizations({admin,request,state,command}){
  let assertions=0;const check=(value,message)=>{assert.ok(value,message);assertions++;};
  const save=async(type,payload,key)=> (await command(admin,type,payload,key)).result;
  const source=await save('save.organization',{name:'调动原部门',parentId:'org-demo'}),target=await save('save.organization',{name:'调动新部门',parentId:'org-demo'});
  const child=await save('save.organization',{name:'调动团队',parentId:source.id}),leaf=await save('save.organization',{name:'调动三级小组',parentId:child.id});
  const range={poolId:'pool-local-test',mode:'follow',definitionIds:[]};
  const old=await save('save.plan',{name:'调动原月度',range,amount:4,cadence:'monthly',quotaDays:30,entitlementDays:365}),next=await save('save.plan',{name:'调动新月度',range,amount:7,cadence:'monthly',quotaDays:30,entitlementDays:365});
  for(const [name,planId,organizationId] of [['原规则',old.id,source.id],['新规则一',next.id,target.id],['新规则二',next.id,target.id]])await save('save.rule',{name,planId,organizationId,includeChildren:true,tags:[]});
  const password=`org-test-${randomUUID()}`,one=await save('save.member',{name:'调动直属成员',directoryId:'org-move-direct',organizationId:child.id,password}),two=await save('save.member',{name:'调动下级成员',directoryId:'org-move-descendant',organizationId:leaf.id});
  const login=await request('/api/v1/auth/login',{directoryId:one.directoryId,password});check(login.status===200&&login.cookie,'subtree member can sign in before change');
  const before=await state(admin),payload={...child,parentId:target.id},c={type:'save.organization',payload,idempotencyKey:randomUUID()},p=await request('/api/v1/platform/preview',c,admin);
  check(p.status===200&&p.body.impact.organizationChange.members.length===2&&p.body.impact.organizationChange.organizations.length===2,'move preview includes entire descendant tree');
  check(p.body.impact.totalAmount===14&&p.body.impact.stoppedFutureGrants.length===2,'move preview shows new grants and old future periods stopping');
  check((await state(admin)).quotaBatches.length===before.quotaBatches.length,'impact preview does not issue funds');
  const execute=()=>request('/api/v1/platform/commands',{...c,previewToken:p.body.previewToken},admin),results=await Promise.all([execute(),execute()]);
  check(results.every(r=>r.status===200)&&results.some(r=>r.body.replayed),'concurrent move replay commits only once');
  let s=await state(admin);const people=[one.id,two.id];
  check(s.entitlements.filter(e=>people.includes(e.memberId)&&e.planId===next.id).length===2,'duplicate matching rules create one new entitlement per person');
  check(s.quotaBatches.filter(b=>people.includes(b.sourceId)).reduce((n,b)=>n+b.totalAmount,0)===22,'move pays exact new amount without repeating prior funds');
  check(s.entitlements.filter(e=>people.includes(e.memberId)&&e.planId===old.id).every(e=>e.futureGrantStatus==='rule_not_matching'),'old monthly schedule no longer matches moved branch');
  for(const batch of before.quotaBatches.filter(b=>people.includes(b.sourceId))){const after=s.quotaBatches.find(b=>b.id===batch.id);check(after.availableAmount===batch.availableAmount&&after.expiresAt===batch.expiresAt,'issued original batches retain money and expiry');}
  const stop=await request('/api/v1/platform/preview',{type:'save.organization',payload:{...target,active:false},idempotencyKey:randomUUID()},admin);
  check(stop.status===200&&stop.body.impact.organizationChange.members.filter(m=>m.beforeAccess&&!m.afterAccess).length===2,'disable preview lists descendants losing access');
  await save('save.organization',{...target,active:false});check((await request('/api/v1/platform/state',null,login.cookie)).status===403,'already signed-in session immediately loses access');
  const restore=await request('/api/v1/platform/preview',{type:'save.organization',payload:{...target,active:true},idempotencyKey:randomUUID()},admin);
  check(restore.status===200&&restore.body.impact.totalAmount===0&&restore.body.impact.resumedFutureGrants.length===2,'restore previews schedules without a second cycle grant');
  await save('save.organization',{...target,active:true});check((await request('/api/v1/platform/state',null,login.cookie)).status===200,'restored organization permits valid existing session');
  s=await state(admin);check(s.quotaBatches.filter(b=>people.includes(b.sourceId)).reduce((n,b)=>n+b.totalAmount,0)===22,'restore preserves exact funding');
  const invalid=await request('/api/v1/platform/preview',{type:'save.organization',payload:{...target,parentId:leaf.id},idempotencyKey:randomUUID()},admin);check(invalid.status===400,'cycle through a deep descendant is rejected before confirmation');
  const renamed=await request('/api/v1/platform/preview',{type:'save.organization',payload:{...target,name:'调动新部门更名'},idempotencyKey:randomUUID()},admin);check(renamed.status===200&&!renamed.body.impact.organizationChange.rematches&&renamed.body.impact.totalAmount===0,'name-only edit does not rerun automatic grants');
  check(s.audit.some(a=>a.action==='organization.impact'&&a.objectId===child.id&&a.detail.organizationChange.members.length===2),'persisted audit includes complete affected member scope');
  console.log(`PASS ${assertions} organization HTTP assertions (subtree moves, atomic deduplication, access revocation, schedule recovery and original funds)`);return assertions;
}
