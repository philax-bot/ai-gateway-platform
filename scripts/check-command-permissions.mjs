import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

/** Invoked only within the existing isolated HTTP harness; never targets the human review workspace. */
export async function checkCommandPermissions({admin,request,state,command,gw}){
  let assertions=0;const check=(condition,message)=>{assert.ok(condition,message);assertions++;};
  const range={poolId:'pool-local-test',mode:'follow',definitionIds:[]},expiresAt=new Date(Date.now()+86400000).toISOString();
  async function member(name,roles=['employee']){
    const directoryId=`scope-${randomUUID()}`,password=`Scope-${randomUUID()}`;
    const value=(await command(admin,'save.member',{name,directoryId,password,organizationId:'org-demo',roles})).result;
    const login=await request('/api/v1/auth/login',{directoryId,password});assert.equal(login.status,200);return {value,cookie:login.cookie};
  }
  const first=await member('旧责任人'),next=await member('新责任人'),delegate=await member('临时运营',['employee','operator']);
  const raw=(cookie,type,payload,idempotencyKey=randomUUID(),preview=false)=>request('/api/v1/platform/'+(preview?'preview':'commands'),{type,payload,idempotencyKey},cookie);
  for(const type of ['save.plan','save.definition','save.alert-rule','settings.update','periodic.run'])check((await raw(first.cookie,type,{name:'拒绝越权预览'},randomUUID(),true)).status===403,`${type} preview requires current operator role`);
  check((await raw(admin,'unknown.command',{},randomUUID(),true)).status===400,'unknown preview commands fail closed');
  const app=(await command(admin,'save.application',{billingMode:'quota',name:'权限交接验证应用',ownerId:first.value.id,organizationId:'org-demo',range})).result;
  await command(admin,'application.fund',{applicationId:app.id,amount:3,expiresAt});
  const issueKey=randomUUID(),issue={name:'交接验证密钥',purpose:'application',applicationId:app.id};const issued=(await command(first.cookie,'key.issue',issue,issueKey)).result;
  const replay=await raw(first.cookie,'key.issue',issue,issueKey);check(replay.status===200&&replay.body.replayed&&!replay.body.result.secret,'valid key retry remains successful without plaintext');
  await command(admin,'save.application',{...app,ownerId:next.value.id});
  check((await request(`/api/v1/platform/applications/${app.id}`,null,first.cookie)).status===403,'application detail follows handoff');
  check((await raw(first.cookie,'key.issue',issue,issueKey)).status===403,'old application key result is inaccessible after handoff');
  check((await raw(first.cookie,'key.status',{id:issued.key.id,status:'disabled',reason:'越权操作'},randomUUID(),true)).status===403,'old key owner cannot obtain a change preview');
  check((await request(`/api/v1/platform/keys/${issued.key.id}`,null,next.cookie)).status===200,'new application owner can read the transferred key metadata');
  const project=(await command(admin,'save.project',{name:'权限交接验证项目',managerId:first.value.id,range})).result;
  const membersKey=randomUUID(),members={projectId:project.id,memberIds:[next.value.id]};await command(first.cookie,'project.members',members,membersKey);
  const approval=(await command(next.cookie,'approval.submit',{kind:'project_member_quota',objectId:project.id,amount:1,expiresAt,scenario:'项目工作',reason:'测试职责路由'})).result;
  const decisionKey=randomUUID(),decision={id:approval.id,decision:'approve',reason:'测试批准'};await command(first.cookie,'approval.decide',decision,decisionKey);
  await command(admin,'save.project',{...project,managerId:next.value.id});
  check((await raw(first.cookie,'project.members',members,membersKey)).status===403,'former project manager cannot retrieve old member-change result');
  check((await raw(first.cookie,'approval.decide',decision,decisionKey)).status===403,'former approver cannot retrieve decision through old idempotency key');
  const fundingKey=randomUUID(),funding={applicationId:app.id,amount:4,expiresAt};await command(delegate.cookie,'application.fund',funding,fundingKey);
  await command(admin,'save.member',{...delegate.value,roles:['employee']});
  check((await raw(delegate.cookie,'application.fund',funding,fundingKey)).status===403,'existing session observes operator demotion before replay');
  check((await raw(delegate.cookie,'application.fund',funding,randomUUID(),true)).status===403,'demoted operator cannot preview a new grant');
  const final=(await request(`/api/v1/platform/applications/${app.id}`,null,next.cookie)).body;
  check(final.availableAmount===7&&final.batches.length===2&&final.keys.length===1,'denied retries neither add funds nor create keys');
  check(!JSON.stringify(await state(admin)).includes(issued.secret),'admin snapshot cannot recover original key plaintext');
  const second=(await command(next.cookie,'key.issue',{name:'第二把批量验证密钥',purpose:'application',applicationId:app.id})).result;
  const targets=[issued.key.id,second.key.id],bulk={ids:targets,status:'disabled',reason:'批量停止旧工具'},bulkKey=randomUUID();
  const preview=await raw(next.cookie,'keys.status',bulk,bulkKey,true);
  check(preview.status===200&&preview.body.impact.changedCount===2&&preview.body.impact.keyChanges.every(k=>k.ownerName==='新责任人'&&k.masked),'bulk preview contains named, masked targets and exact change count');
  check(!JSON.stringify(preview.body).includes(second.secret)&&!JSON.stringify(preview.body).includes('keyHash'),'bulk impact never exposes credentials');
  const other=(await command(admin,'save.application',{billingMode:'quota',name:'不可混入的应用',ownerId:first.value.id,organizationId:'org-demo',range})).result;
  const foreign=(await command(first.cookie,'key.issue',{name:'其他人的密钥',purpose:'application',applicationId:other.id})).result;
  check((await raw(next.cookie,'keys.status',{...bulk,ids:[targets[0],foreign.key.id]},randomUUID(),true)).status===403,'one inaccessible target rejects the complete bulk preview');
  check((await raw(next.cookie,'keys.status',{...bulk,ids:[targets[0],'missing-key']},randomUUID(),true)).status===404,'one missing target rejects the complete bulk preview');
  check((await raw(next.cookie,'keys.status',{...bulk,previewToken:undefined},randomUUID())).status===409,'bulk command requires signed impact confirmation');
  const stale=await request('/api/v1/platform/commands',{type:'keys.status',payload:bulk,idempotencyKey:bulkKey,previewToken:preview.body.previewToken},next.cookie);
  check(stale.status===409,'unrelated configuration change invalidates old bulk preview');
  check((await request(`/api/v1/platform/applications/${app.id}`,null,next.cookie)).body.keys.every(k=>k.status==='active'),'rejected bulk requests preserve all target states');
  const revoked=(await command(next.cookie,'keys.status',bulk,bulkKey)).result;
  check(revoked.changedCount===2&&revoked.skippedCount===0,'valid batch disables every selected key');
  const detail=(await request(`/api/v1/platform/keys/${targets[0]}`,null,next.cookie)).body;
  check(detail.history.filter(h=>h.action==='key.status'&&h.detail.batchId===revoked.batchId).length===1,'bulk change is traceable from individual key detail');
  check((await raw(next.cookie,'keys.status',bulk,bulkKey)).body.replayed,'valid bulk retry is idempotent');
  const blocked=await fetch(gw+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${second.secret}`},body:JSON.stringify({model:'test-model',messages:[{role:'user',content:'must not reach local model'}],max_tokens:1})});await blocked.text();
  check(blocked.status===401,'disabled batch key is immediately rejected by the data plane');
  const skip=(await command(next.cookie,'keys.status',bulk)).result;check(skip.changedCount===0&&skip.skippedCount===2,'already disabled targets are explicitly skipped');
  const terminal=(await command(next.cookie,'keys.status',{...bulk,status:'revoked'})).result;check(terminal.changedCount===2,'batch revocation also covers disabled keys');
  const neverRestore=(await command(next.cookie,'keys.status',bulk)).result;check(neverRestore.changedCount===0&&neverRestore.keys.every(k=>k.after==='revoked'),'bulk disable cannot restore a revoked key');
  await command(admin,'save.application',{...app,ownerId:first.value.id});
  check((await raw(next.cookie,'keys.status',bulk,bulkKey)).status===403,'old bulk result is inaccessible after application handoff');
  const preserved=(await request(`/api/v1/platform/applications/${app.id}`,null,first.cookie)).body;
  check(preserved.availableAmount===7&&preserved.batches.length===2,'key operations neither issue nor refund application funds');
  console.log(`PASS ${assertions} current-role HTTP permission assertions (preview, handoff, demotion and safe retries)`);return assertions;
}
