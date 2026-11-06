import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function checkAudit({admin,employeeCookie,request,state,command,updateWorkspaceForCheck}){
  let assertions=0;const check=(value,message)=>{assert.ok(value,message);assertions++;};
  const query=(body={},cookie=admin)=>request('/api/v1/platform/audit/query',body,cookie);
  check((await query({},'')).status===401,'audit query requires authentication');
  check((await query({},employeeCookie)).status===403,'employees cannot retrieve operations audit even with a custom query');
  for(const body of [{limit:101},{from:'invalid'},{cursor:'invalid-cursor'},{search:42}])check((await query(body)).status===400,'malformed audit query is rejected');
  const before=await state(admin),prefix='audit-check-'+randomUUID();
  check((await request('/api/v1/platform/preview',{type:'settings.update',payload:{name:'   '},idempotencyKey:randomUUID()},admin)).status===400,'blank enterprise names are rejected before confirmation');
  const settingsCommand={type:'settings.update',payload:{name:before.settings.name},idempotencyKey:randomUUID()};
  check((await request('/api/v1/platform/commands',settingsCommand,admin)).status===409,'enterprise settings cannot bypass impact confirmation');
  const settingsPreview=await request('/api/v1/platform/preview',settingsCommand,admin);assert.equal(settingsPreview.status,200);
  check(settingsPreview.body.impact.settingsChanges.some(change=>change.before===before.settings.name&&change.after===before.settings.name),'settings preview describes current server values');
  const application=(await command(admin,'save.application',{billingMode:'quota',name:prefix+' 初始名称',ownerId:before.actor.id,organizationId:'org-demo',range:{poolId:'pool-local-test',mode:'follow',definitionIds:[]}})).result;
  check((await request('/api/v1/platform/commands',{...settingsCommand,previewToken:settingsPreview.body.previewToken},admin)).status===409,'concurrent business changes invalidate an older settings preview');
  await command(admin,'save.application',{...application,name:prefix+' 调整后名称'});
  const page=(await query({search:prefix,action:'save.application'})).body;
  check(page.total===2&&page.items.every(e=>e.actionName==='保存应用'&&e.objectId===application.id),'query returns human action labels and actual application identity');
  check(page.items.some(e=>e.objectName===prefix+' 初始名称'&&e.objectNameSource==='recorded')&&page.items.some(e=>e.objectName===prefix+' 调整后名称'),'object rename keeps historical name snapshots');
  check(page.actions.some(a=>a.id==='save.application'&&a.name==='保存应用')&&page.actors.some(a=>a.id===before.actor.id),'query supplies real actor and action choices');
  const readBefore=await state(admin);await query({actorId:before.actor.id,action:'save.application'});const readAfter=await state(admin);
  check(readBefore.revision===readAfter.revision&&JSON.stringify(readBefore.quotaBatches)===JSON.stringify(readAfter.quotaBatches)&&JSON.stringify(readBefore.projectBudgets)===JSON.stringify(readAfter.projectBudgets),'audit searches neither write business state nor change funds');
  if(updateWorkspaceForCheck){
    const marker='historical-'+randomUUID(),at='2020-01-01T00:00:00.000Z';
    await updateWorkspaceForCheck(s=>{
      const fixtures=Array.from({length:615},(_,i)=>({id:`${marker}-${String(i).padStart(4,'0')}`,actorId:before.actor.id,actorName:'历史运营',action:'save.application',objectId:null,createdAt:at,reason:marker,detail:{id:`${marker}-object-${i}`,name:`历史应用 ${i}`,secret:'audit-fixture-private-secret',passwordHash:'audit-fixture-password-hash',nested:{body:'audit-fixture-private-body'}}}));
      s.audit.unshift(...fixtures);
    });
    const first=(await query({search:marker,limit:100})).body;
    check(first.total===615&&first.items.length===100&&!!first.nextCursor,'complete database audit query sees more than the 500-entry snapshot');
    check(!JSON.stringify(first).includes('audit-fixture-private-secret')&&!JSON.stringify(first).includes('audit-fixture-password-hash')&&!JSON.stringify(first).includes('audit-fixture-private-body'),'audit response curates metadata without returning arbitrary result data');
    check((await query({search:marker+' changed',limit:100,cursor:first.nextCursor})).status===400,'cursor cannot silently be reused with changed filters');
    await updateWorkspaceForCheck(s=>s.audit.push({id:marker+'-new',actorId:before.actor.id,action:'save.application',objectId:null,createdAt:at,reason:marker,detail:{name:'翻页期间新增的记录'}}));
    let current=first,ids=first.items.map(e=>e.id);
    while(current.nextCursor){const result=await query({search:marker,limit:100,cursor:current.nextCursor});assert.equal(result.status,200);current=result.body;ids.push(...current.items.map(e=>e.id));assert.equal(current.total,615);}
    check(ids.length===615&&new Set(ids).size===615&&ids.includes(marker+'-0000')&&!ids.includes(marker+'-new'),'equal-time pages cover every original row once, including the oldest history');
    check((await query({search:marker,limit:100})).body.total===616,'refresh includes the record appended during pagination');
    check((await query({search:marker,from:at,to:'2020-01-02T00:00:00.000Z'})).body.total===616,'date range includes exact start boundary');
    check((await query({search:marker,to:at})).body.total===0,'date range excludes exact end boundary');
  }
  console.log(`PASS ${assertions} audit HTTP assertions (scope, metadata, historical names, complete search and stable pagination)`);return assertions;
}
