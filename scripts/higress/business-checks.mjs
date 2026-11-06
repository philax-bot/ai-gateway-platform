import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export async function captureDefaultState({root,db}){
  const optional=async path=>{try{return await readFile(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
  const hash=value=>createHash('sha256').update(value).digest('hex'),reviewBytes=await optional(resolve(root,'.runtime/review-postgres.json')),budget=await optional(resolve(root,'.runtime/higress-live-budget-2026-10-29.json'));
  const value={defaultWorkspacePresent:!!reviewBytes,liveBudgetHash:budget?hash(budget):null};if(!reviewBytes)return value;
  const review=JSON.parse(reviewBytes);assert.match(review.schema,/^agp_review_[a-f0-9]{32}$/);
  const configuration=(await db.query(`select (select jsonb_object_agg(key,value) from jsonb_each(payload) where key=any($1::text[])) as configuration from "${review.schema}".platform_workspace where id='org-demo'`,[['guardrail','settings','members','services','definitions','pools','plans','keys','entitlements','projects','applications']])).rows[0];
  const funds=(await db.query(`select id,total_amount,available_amount,closed_amount from "${review.schema}".quota_batches order by id`)).rows;
  return {...value,workspaceId:review.id,stateFileHash:hash(reviewBytes),businessConfigurationHash:hash(JSON.stringify(configuration)),fundsHash:hash(JSON.stringify(funds)),fundedBatches:funds.length};
}

/** Role-separated HTTP acceptance. Every generation stays on the owned fixture network. */
export async function runBusinessChecks({id,schema,db,hg,cp,gw,adminCookie,service,report,check,state,call,waitLog,pause,secrets}){
  const result=report.business={phase:'setup',scope:'authenticated HTTP business flows; real Higress and isolated PostgreSQL; deterministic model; no browser acceptance',requests:[],denials:[],actors:[],approvals:[]};
  const subjects=[],successes=[],denied=[],future=new Date(Date.now()+7*86400000).toISOString();
  const verify=(condition,label)=>check(condition,'business: '+label);
  const step=phase=>{result.phase=phase;console.log('BUSINESS '+phase);};
  const models=secret=>fetch(gw+'/v1/models',{headers:{authorization:`Bearer ${secret}`}});
  async function request(cookie,path,body){
    const response=await fetch(cp+path,{method:body===undefined?'GET':'POST',headers:{cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
    const value=await response.json();return {status:response.status,value,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  async function command(cookie,type,payload,idempotencyKey=randomUUID()){
    const input={type,payload,idempotencyKey},preview=await request(cookie,'/api/v1/platform/preview',input);assert.equal(preview.status,200,'business preview '+type);
    const response=await request(cookie,'/api/v1/platform/commands',{...input,previewToken:preview.value.previewToken});assert.equal(response.status,200,'business command '+type);return response.value;
  }
  const admin=(type,payload,key)=>command(adminCookie,type,payload,key);
  async function refused(cookie,type,payload,status,label){
    const input={type,payload,idempotencyKey:randomUUID()},preview=await request(cookie,'/api/v1/platform/preview',input);
    const response=preview.status===200?await request(cookie,'/api/v1/platform/commands',{...input,previewToken:preview.value.previewToken}):preview;
    verify(response.status===status,label);result.denials.push({kind:'command',type,httpStatus:response.status,code:response.value.code??response.value.message});
  }
  async function person(name){
    const password=randomUUID(),directoryId='business-'+name+'-'+id;secrets.push(password);
    const member=(await admin('save.member',{name:'Business '+name,directoryId,password,organizationId:'department-engineering',category:'employee',roles:['employee'],tags:[]})).result;
    const login=await request('','/api/v1/auth/login',{directoryId,password});assert.equal(login.status,200);assert.ok(login.cookie);secrets.push(login.cookie);subjects.push(member.id);result.actors.push({id:member.id,role:name});return {member,cookie:login.cookie,login:()=>request('','/api/v1/auth/login',{directoryId,password})};
  }
  async function money(){return (await db.query(`select id,source_id,purpose,project_id,total_amount,available_amount,closed_amount from "${schema}".quota_batches where source_id=any($1::text[]) order by id`,[subjects])).rows;}
  const fixtures=()=>fetch(hg.model+'/_poc/requests').then(r=>r.json());
  async function invoke(secret,label,{allow=true,purpose,subjectId,projectId=null}={}){
    const requestId=`business-${randomUUID()}`,before=await money(),attempt=call({apiKey:secret,requestId}),response=await attempt.promise;
    const body=await response.text(),entry={label,requestId,httpStatus:response.status};result.requests.push(entry);
    if(!allow){
      denied.push(requestId);verify([401,403].includes(response.status),label+' is refused before generation');
      verify(!(await fixtures()).some(r=>r.requestId===requestId),label+' never reaches the model');
      assert.deepEqual(await money(),before,label+' must not move funds');check(true,'business: '+label+' leaves all scoped funds unchanged');
      const reserved=await db.query(`select count(*)::int as count from "${schema}".reservations where request_id=$1`,[requestId]);verify(reserved.rows[0].count===0,label+' creates no reservation');
      try{entry.reason=JSON.parse(body).error?.code??JSON.parse(body).error?.type;}catch{}
      return entry;
    }
    verify(response.status===200,label+' completes through the gateway');const log=await waitLog(requestId);successes.push(requestId);
    verify(log.usageFinal&&log.billableState==='confirmed'&&Math.round(log.actualAmount*1e6)===132,label+' settles fixture usage at the original configured price');
    verify(log.purpose===purpose&&log.subjectId===subjectId&&log.projectId===projectId,label+' retains the correct business owner and purpose');
    const after=await money(),source=before.find(b=>b.id===log.admission.batchId)??before.find(b=>b.source_id===subjectId&&b.purpose===purpose&&b.project_id===projectId);
    assert.ok(source,label+' must have a matching original funding batch');
    verify(after.every(b=>Math.round((Number(before.find(old=>old.id===b.id).available_amount)-Number(b.available_amount))*1e6)===(b.id===source.id?132:0)),label+' spends only its original scoped batch');
    Object.assign(entry,{purpose:log.purpose,subjectId:log.subjectId,projectId:log.projectId,batchId:source.id,amount:log.actualAmount,billableState:log.billableState});return entry;
  }
  async function issue(cookie,payload){const issued=(await command(cookie,'key.issue',payload)).result;secrets.push(issued.secret);assert.ok(issued.secret);return issued;}
  try{
    step('operator onboarding and first online use');
    const employee=await person('employee'),manager=await person('manager'),appOwner=await person('application-owner'),peer=await person('peer');
    const range={poolId:(await admin('save.pool',{name:'Business 验收模型池',entries:[{definitionId:service.mappings[0].definitionId,serviceId:service.id,open:true}]})).result.id,mode:'follow',definitionIds:[]};
    const plan=(await admin('save.plan',{name:'Business 月度办公方案',range,amount:.2,cadence:'monthly',quotaDays:30,entitlementDays:365})).result;
    await refused(employee.cookie,'key.issue',{name:'未开通',purpose:'personal'},409,'unopened employee cannot issue an authorized personal Key');
    await refused(employee.cookie,'save.plan',{name:'unauthorized'},403,'employee cannot operate enterprise plans');
    const opening=(await command(employee.cookie,'approval.submit',{kind:'personal_open',amount:.3,expiresAt:future,scenario:'首次使用',reason:'业务闭环验收'})).result;
    await refused(employee.cookie,'approval.decide',{id:opening.id,decision:'approve',reason:'self approval'},403,'applicant cannot approve their own personal application');
    await admin('approval.decide',{id:opening.id,decision:'approve',amount:.2,expiresAt:future,planId:plan.id,reason:'批准办公额度'});
    verify(!(await state()).quotaBatches.some(b=>b.sourceId===employee.member.id),'approval alone does not create personal funds');
    const execution=randomUUID();await admin('approval.execute',{id:opening.id},execution);verify((await admin('approval.execute',{id:opening.id},execution)).replayed,'personal opening execution replays without issuing money again');
    const opened=await state(),entitlement=opened.entitlements.find(e=>e.memberId===employee.member.id&&e.planId===plan.id),personalBatch=opened.quotaBatches.find(b=>b.entitlementId===entitlement?.id);
    verify(!!entitlement&&personalBatch?.totalAmount===.2&&opened.quotaBatches.filter(b=>b.entitlementId===entitlement.id).length===1,'approved amount reaches exactly one original personal funding batch');
    const detail=await request(employee.cookie,'/api/v1/platform/approvals/'+opening.id);verify(detail.status===200&&detail.value.approval.status==='effective'&&detail.value.approval.amount===.3&&detail.value.approval.approvedAmount===.2,'applicant sees the original request, approved amount and effective result');result.approvals.push({id:opening.id,kind:'personal_open',status:'effective',requested:.3,approved:.2});
    const keyCount=(await state()).keys.length,online=await request(employee.cookie,'/api/v1/platform/online-credential',{purpose:'personal',projectId:null});assert.equal(online.status,200);assert.ok(online.value.token);secrets.push(online.value.token);
    await invoke(online.value.token,'employee first online request',{purpose:'personal',subjectId:employee.member.id});verify((await state()).keys.length===keyCount,'first online use does not require a user-created API Key');
    const keyRequest=randomUUID(),personal=await command(employee.cookie,'key.issue',{name:'Business 个人接入',purpose:'personal'},keyRequest);secrets.push(personal.result.secret);const personalKey=personal.result;
    const keyReplay=await command(employee.cookie,'key.issue',{name:'Business 个人接入',purpose:'personal'},keyRequest);verify(keyReplay.replayed&&!keyReplay.result.secret,'idempotent Key replay never reveals plaintext again');
    verify(!JSON.stringify((await request(employee.cookie,'/api/v1/platform/state')).value).includes(personalKey.secret),'employee workspace does not expose stored credential material');
    await invoke(personalKey.secret,'personal API request',{purpose:'personal',subjectId:employee.member.id});

    step('manager approval and project funding isolation');
    const project=(await admin('save.project',{name:'Business 项目',managerId:manager.member.id,range})).result;
    await command(manager.cookie,'project.members',{projectId:project.id,memberIds:[employee.member.id,peer.member.id]});
    const projectBudget=(await admin('project.fund',{projectId:project.id,amount:.5,expiresAt:future})).result;
    const peerKey=await issue(peer.cookie,{name:'Business 未分配项目成员',purpose:'project',projectId:project.id});await invoke(peerKey.secret,'membership without allocation',{allow:false});
    const quota=(await command(employee.cookie,'approval.submit',{kind:'project_member_quota',objectId:project.id,amount:.2,expiresAt:future,scenario:'项目使用',reason:'从原项目预算分配'})).result;
    await refused(peer.cookie,'approval.decide',{id:quota.id,decision:'approve',reason:'non manager'},403,'ordinary project member cannot approve another member quota');
    await command(manager.cookie,'approval.decide',{id:quota.id,decision:'approve',amount:.1,expiresAt:projectBudget.expiresAt,sourceBatchId:projectBudget.id,reason:'经理批准项目额度'});
    verify((await state()).projectBudgets.find(b=>b.id===projectBudget.id).availableAmount===.5,'project approval does not allocate money before execution');
    const allocation=randomUUID();await command(manager.cookie,'approval.execute',{id:quota.id},allocation);verify((await command(manager.cookie,'approval.execute',{id:quota.id},allocation)).replayed,'manager execution is idempotent');
    const allocated=await state(),projectBatch=allocated.quotaBatches.find(b=>b.projectId===project.id&&b.sourceId===employee.member.id);
    verify(projectBatch?.totalAmount===.1&&projectBatch.sourceBatchId===projectBudget.id&&projectBatch.expiresAt===projectBudget.expiresAt&&allocated.projectBudgets.find(b=>b.id===projectBudget.id).availableAmount===.4,'project allocation retains original budget, expiry and unallocated funds');result.approvals.push({id:quota.id,kind:'project_member_quota',status:'effective',requested:.2,approved:.1});
    const projectKey=await issue(employee.cookie,{name:'Business 项目 Key',purpose:'project',projectId:project.id});
    await invoke(projectKey.secret,'project member request',{purpose:'project',subjectId:employee.member.id,projectId:project.id});
    await command(manager.cookie,'project.members',{projectId:project.id,removeMemberIds:[employee.member.id]});await invoke(projectKey.secret,'removed project member old Key',{allow:false});
    await command(manager.cookie,'project.members',{projectId:project.id,memberIds:[employee.member.id]});await invoke(projectKey.secret,'restored project membership',{purpose:'project',subjectId:employee.member.id,projectId:project.id});

    step('application owner without personal entitlement');
    const application=(await admin('save.application',{billingMode:'quota',name:'Business 独立应用',ownerId:appOwner.member.id,organizationId:'org-demo',range})).result;subjects.push(application.id);
    await refused(appOwner.cookie,'key.issue',{name:'owner personal',purpose:'personal'},409,'application ownership does not grant personal access');
    const appApproval=(await command(appOwner.cookie,'approval.submit',{kind:'application_quota',objectId:application.id,amount:.3,expiresAt:future,scenario:'应用接入',reason:'独立应用预算'})).result;
    await admin('approval.decide',{id:appApproval.id,decision:'approve',amount:.25,expiresAt:future,reason:'批准应用额度'});const appExecution=randomUUID();await admin('approval.execute',{id:appApproval.id},appExecution);await admin('approval.execute',{id:appApproval.id},appExecution);
    verify((await state()).quotaBatches.filter(b=>b.sourceId===application.id).length===1,'repeated application approval execution funds the application only once');
    await refused(employee.cookie,'key.issue',{name:'foreign application',purpose:'application',applicationId:application.id},403,'another employee cannot issue an application Key');
    const appKey=await issue(appOwner.cookie,{name:'Business 应用 Key',purpose:'application',applicationId:application.id});
    const appCall=await invoke(appKey.secret,'application request',{purpose:'application',subjectId:application.id});
    const ownCall=await request(appOwner.cookie,'/api/v1/platform/calls/'+appCall.requestId),foreignCall=await request(employee.cookie,'/api/v1/platform/calls/'+appCall.requestId);
    verify(ownCall.status===200&&ownCall.value.original?.requestId===appCall.requestId,'application owner reads their own application call');
    verify(foreignCall.status===200&&foreignCall.value.original===null&&Array.isArray(foreignCall.value.retries)&&foreignCall.value.retries.length===0,'employee receives the contracted empty result for another application call');
    result.callVisibility={ownerHasOriginal:true,foreignOriginal:foreignCall.value.original,foreignRetries:foreignCall.value.retries.length};result.approvals.push({id:appApproval.id,kind:'application_quota',status:'effective',requested:.3,approved:.25});

    step('Key disable, reactivation and permanent revocation');
    await refused(peer.cookie,'key.status',{id:personalKey.key.id,status:'disabled',reason:'foreign Key'},403,'peer cannot disable another employee Key');
    const discovery=await models(personalKey.secret),catalog=await discovery.json();verify(discovery.status===200&&catalog.data?.some(model=>model.id==='test-model'),'active personal Key discovers its authorized model');
    await command(employee.cookie,'key.status',{id:personalKey.key.id,status:'disabled',reason:'临时停用'});verify((await models(personalKey.secret)).status===401,'disabled Key cannot discover models');await invoke(personalKey.secret,'disabled personal Key',{allow:false});
    await command(employee.cookie,'key.status',{id:personalKey.key.id,status:'active',reason:'恢复使用'});await invoke(personalKey.secret,'reactivated personal Key',{purpose:'personal',subjectId:employee.member.id});
    await command(employee.cookie,'key.status',{id:personalKey.key.id,status:'revoked',reason:'永久吊销'});await refused(employee.cookie,'key.status',{id:personalKey.key.id,status:'active',reason:'invalid restore'},409,'revoked Key cannot be reactivated');await invoke(personalKey.secret,'revoked personal Key',{allow:false});
    const replacement=await issue(employee.cookie,{name:'Business 新个人 Key',purpose:'personal'});await invoke(replacement.secret,'new Key after revocation',{purpose:'personal',subjectId:employee.member.id});

    step('entitlement and independent application lifecycle');
    await admin('entitlement.stop',{id:entitlement.id});verify((await state()).entitlements.find(e=>e.id===entitlement.id).futureGrants===false,'stopping future grants is recorded without revoking current entitlement');await invoke(replacement.secret,'remaining personal balance after stopping future grants',{purpose:'personal',subjectId:employee.member.id});
    await admin('entitlement.revoke',{id:entitlement.id,reason:'撤销个人授权'});await invoke(replacement.secret,'revoked entitlement with an active Key',{allow:false});await invoke(projectKey.secret,'project access after personal entitlement revocation',{purpose:'project',subjectId:employee.member.id,projectId:project.id});
    await admin('save.member',{...appOwner.member,active:false});verify((await request(appOwner.cookie,'/api/v1/platform/state')).status===403,'disabled person immediately loses session access');await invoke(appKey.secret,'independent application after owner disablement',{purpose:'application',subjectId:application.id});
    await admin('key.status',{id:appKey.key.id,status:'disabled',reason:'停用应用接入'});await invoke(appKey.secret,'disabled application Key',{allow:false});await admin('key.status',{id:appKey.key.id,status:'active',reason:'恢复应用接入'});await invoke(appKey.secret,'application Key restored by operator',{purpose:'application',subjectId:application.id});
    const projectOnline=await request(employee.cookie,'/api/v1/platform/online-credential',{purpose:'project',projectId:project.id});assert.equal(projectOnline.status,200);assert.ok(projectOnline.value.token);secrets.push(projectOnline.value.token);
    await invoke(projectOnline.value.token,'active project online identity before logout',{purpose:'project',subjectId:employee.member.id,projectId:project.id});
    const parallelLogin=await employee.login();assert.equal(parallelLogin.status,200);assert.ok(parallelLogin.cookie);secrets.push(parallelLogin.cookie);
    const parallelOnline=await request(parallelLogin.cookie,'/api/v1/platform/online-credential',{purpose:'project',projectId:project.id});assert.equal(parallelOnline.status,200);assert.ok(parallelOnline.value.token);secrets.push(parallelOnline.value.token);
    await invoke(parallelOnline.value.token,'another login online identity before logout',{purpose:'project',subjectId:employee.member.id,projectId:project.id});
    const logout=await request(employee.cookie,'/api/v1/auth/logout',{});assert.equal(logout.status,200);await invoke(projectOnline.value.token,'previously active project online identity after logout',{allow:false});
    await invoke(parallelOnline.value.token,'other login online identity after first session logout',{purpose:'project',subjectId:employee.member.id,projectId:project.id});
    await invoke(projectKey.secret,'ordinary project API Key after web logout',{purpose:'project',subjectId:employee.member.id,projectId:project.id});
    const final=await state();verify(final.audit.some(a=>a.action==='approval.execute'&&a.objectId===opening.id)&&final.audit.some(a=>a.action==='key.status'&&a.objectId===personalKey.key.id),'onboarding execution and Key changes leave scoped audit records');
    result.workflowCompleted=true;
  }finally{
    result.successfulRequests=successes;result.deniedRequests=denied;
    result.batches=await money();result.calls=(await db.query(`select request_id,subject_id,purpose,project_id,billable_state,actual_amount,usage_final from "${schema}".call_logs where subject_id=any($1::text[]) order by request_id`,[subjects])).rows;
    result.ledger=(await db.query(`select request_id,count(*)::int as entries from "${schema}".usage_ledger_entries where request_id=any($1::text[]) and kind='settlement' group by request_id`,[result.requests.map(r=>r.requestId)])).rows;
  }
  step('full PostgreSQL accounting and observed model dispatch');
  const seen=(await fixtures()).filter(r=>result.requests.some(call=>call.requestId===r.requestId));result.fixtureRequests=seen;
  verify(successes.every(id=>seen.filter(r=>r.requestId===id).length===1)&&denied.every(id=>!seen.some(r=>r.requestId===id)),'only permitted business calls reach the model and each generation occurs once');
  verify(seen.every(r=>r.model==='physical-model'&&r.hopCredentialPresent===false),'actual physical-model mapping and private-hop credential removal hold for all business roles');
  verify(result.ledger.length===successes.length&&result.ledger.every(row=>row.entries===1&&successes.includes(row.request_id)),'permitted calls have exactly one settlement and denied calls have none');
  const initialMicros=result.batches.reduce((s,b)=>s+Math.round(Number(b.total_amount)*1e6),0),availableMicros=result.batches.reduce((s,b)=>s+Math.round(Number(b.available_amount)*1e6),0),confirmedMicros=result.calls.filter(c=>c.billable_state==='confirmed').reduce((s,c)=>s+Math.round(Number(c.actual_amount)*1e6),0);
  result.accounting={initialMicros,availableMicros,confirmedMicros,expectedConfirmedMicros:successes.length*132};verify(initialMicros-availableMicros===confirmedMicros&&confirmedMicros===successes.length*132,'all business subjects conserve their original funds with exact fixture prices');
  const counters=(await db.query(`select (select count(*) from "${schema}".reservations where request_id=any($1::text[]) and finalized=false) as unfinished,(select count(*) from "${schema}".reservation_limit_scopes s join "${schema}".reservations r on r.reservation_id=s.reservation_id where r.request_id=any($1::text[]) and s.active=true) as active`,[result.requests.map(r=>r.requestId)])).rows[0];result.counters=counters;verify(Number(counters.unfinished)===0&&Number(counters.active)===0,'business flows leave no unfinished reservations or concurrency slots');
  let access='';for(let attempt=0;attempt<10;attempt++){access=(await hg.run(['exec',hg.name+'-gateway','tail','-c','200000','/var/log/higress/gateway.log'])).out;if(successes.every(id=>access.includes(id)))break;await pause(300);}
  verify(successes.every(id=>access.includes(id))&&denied.every(id=>!access.includes(id)),'actual Higress logs contain allowed calls and no admission-denied business calls');result.phase='complete';result.completed=true;
}
