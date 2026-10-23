import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

/** Only the isolated harness may supply a direct workspace fixture writer. */
export async function checkRetention({admin,employeeCookie,request,state,command,updateWorkspaceForCheck}){
  let assertions=0;const check=(value,message)=>{assert.ok(value,message);assertions++;};
  const policy={days:30,automatic:false,reason:'隔离回归：保留运行辅助记录'},raw=(cookie,type,payload,idempotencyKey=randomUUID(),preview=false)=>request('/api/v1/platform/'+(preview?'preview':'commands'),{type,payload,idempotencyKey},cookie);
  check((await request('/api/v1/platform/retention')).status===401,'retention counts require authentication');
  check((await request('/api/v1/platform/retention',null,employeeCookie)).status===403,'employees cannot inspect another user retention counts');
  check((await raw(employeeCookie,'settings.retention',policy,randomUUID(),true)).status===403,'employees cannot preview retention changes');
  check((await raw(admin,'settings.retention',{...policy,days:0},randomUUID(),true)).status===400,'invalid retention policy is rejected');
  check((await raw(admin,'settings.retention',policy)).status===409,'retention policy requires signed impact confirmation');
  await command(admin,'settings.retention',policy);const saved=await state(admin);
  check(saved.settings.retentionDays===30&&saved.settings.retentionAutomatic===false,'confirmed policy persists without enabling deletion');
  const initial=await request('/api/v1/platform/retention',null,admin);check(initial.status===200&&initial.body.days===30&&initial.body.protected.activeSessions>0,'report contains actual counts and preserves live sessions');
  if(updateWorkspaceForCheck){
    const prefix='retention-fixture-'+randomUUID(),old=new Date(Date.now()-200*86400000).toISOString();
    await updateWorkspaceForCheck(s=>{
      s.notifications.push({id:prefix+'-read',recipientId:saved.actor.id,title:'隔离保留检查',body:'private-retention-fixture-content',objectType:'retention-check',objectId:prefix,createdAt:old,readAt:old},{id:prefix+'-unread',recipientId:saved.actor.id,title:'未读保留检查',body:'private-retention-fixture-content',objectType:'retention-check',objectId:prefix,createdAt:old,readAt:null});
      s.sessions.push({tokenHash:prefix+'-expired-secret-hash',memberId:saved.actor.id,createdAt:old,expiresAt:old});
      s.monitoring.collectionEvents.push({id:prefix+'-closed',kind:'collection_failure',status:'recovered',openedAt:old,updatedAt:old,recoveredAt:old,acknowledgedAt:old,acknowledgedBy:saved.actor.id,occurrences:1,lastFailureBucket:1,failedStages:['call_totals'],lastSuccessAt:old,recoveries:2});
    });
    const before=await state(admin),callBefore=(await request('/api/v1/platform/calls/query',{limit:1},admin)).body.summary;
    const report=(await request('/api/v1/platform/retention',null,admin)).body;
    check(report.eligible.notifications===1&&report.eligible.collectionAlerts===1&&report.eligible.sessions===1,'database fixtures produce exact eligible auxiliary counts');
    check(!JSON.stringify(report).includes('private-retention-fixture-content')&&!JSON.stringify(report).includes('expired-secret-hash'),'counts expose neither other notice bodies nor session hashes');
    const payload={checkedAt:report.checkedAt,fingerprint:report.fingerprint,reason:'隔离回归：清理三条过期辅助记录'},key=randomUUID(),preview=await raw(admin,'retention.run',payload,key,true);
    check(preview.status===200&&preview.body.impact.retention.eligible.notifications===1,'manual cleanup previews actual category counts');
    check((await raw(admin,'retention.run',payload,key)).status===409,'cleanup cannot bypass impact confirmation');
    await updateWorkspaceForCheck(s=>{s.notifications.find(n=>n.id===prefix+'-read').readAt=new Date().toISOString();});
    const stale=await request('/api/v1/platform/commands',{type:'retention.run',payload,idempotencyKey:key,previewToken:preview.body.previewToken},admin);
    check(stale.status===409&&/retention preview changed/.test(stale.body.message),'changed auxiliary data invalidates the plan even without a business revision');
    await updateWorkspaceForCheck(s=>{s.notifications.find(n=>n.id===prefix+'-read').readAt=old;});
    const current=(await request('/api/v1/platform/retention',null,admin)).body,cleanup={checkedAt:current.checkedAt,fingerprint:current.fingerprint,reason:payload.reason},cleanupKey=randomUUID();
    const result=(await command(admin,'retention.run',cleanup,cleanupKey)).result;
    check(result.removed.notifications===1&&result.removed.collectionAlerts===1&&result.removed.sessions===1,'confirmed transaction removes exactly the three eligible records');
    const after=await state(admin),callAfter=(await request('/api/v1/platform/calls/query',{limit:1},admin)).body.summary;
    check(after.notifications.some(n=>n.id===prefix+'-unread')&&!after.notifications.some(n=>n.id===prefix+'-read'),'unread notice remains while expired read notice is removed');
    check(JSON.stringify(after.quotaBatches)===JSON.stringify(before.quotaBatches)&&JSON.stringify(after.projectBudgets)===JSON.stringify(before.projectBudgets)&&JSON.stringify(callAfter)===JSON.stringify(callBefore),'cleanup preserves original funds and complete call accounting totals');
    check((await raw(admin,'retention.run',cleanup,cleanupKey)).body.replayed,'cleanup retries return the original result');
    const history=(await state(admin)).audit.filter(a=>a.action==='retention.run'&&a.reason===payload.reason);check(history.length===1,'manual cleanup has one durable audit with its reason');
    const next=(await request('/api/v1/platform/retention',null,admin)).body;check(next.lastRun.id===result.id&&next.eligible.notifications===0,'report exposes the durable execution receipt and updated counts');
    await command(admin,'settings.retention',{...policy,automatic:true,reason:'隔离回归：验证每日任务'});
    check((await request('/api/v1/platform/maintenance/run',{},admin)).status===200,'background maintenance accepts enabled retention policy');
    // A manual run on the same day already satisfied the daily check.
    check((await request('/api/v1/platform/retention',null,admin)).body.lastRun.id===result.id,'same-day daily task does not repeat completed cleanup');
    await updateWorkspaceForCheck(s=>{s.retention.lastRun.executedAt=old;});
    await request('/api/v1/platform/maintenance/run',{},admin);const automatic=(await request('/api/v1/platform/retention',null,admin)).body.lastRun;
    check(automatic.source==='automatic'&&automatic.id!==result.id,'next due daily maintenance records an automatic check');
    await request('/api/v1/platform/maintenance/run',{},admin);check((await request('/api/v1/platform/retention',null,admin)).body.lastRun.id===automatic.id,'automatic check is deduplicated within Shanghai calendar day');
    await command(admin,'settings.retention',{...policy,reason:'隔离回归结束，恢复按需清理'});
  }
  console.log(`PASS ${assertions} retention HTTP assertions (policy, scope, protected data, confirmed cleanup and daily maintenance)`);return assertions;
}
