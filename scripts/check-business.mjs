import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { checkMetered } from './check-metered.mjs';
import { checkOnboarding } from './check-onboarding.mjs';
import { checkOperations } from './check-operations.mjs';
import { checkProjectCloseout } from './check-project-closeout.mjs';
import { checkOrganizations } from './check-organizations.mjs';
import { checkCollection } from './check-collection.mjs';
import { checkCommandPermissions } from './check-command-permissions.mjs';
import {checkRetention} from './check-retention.mjs';
import {checkAudit} from './check-audit.mjs';

/** Real HTTP checks against an already isolated control plane and model stand-in. */
export async function checkBusiness({controlPlaneUrl:cp,gatewayUrl:gw,modelUrl:model,start,freePort,runtimeDirectory,expireReservation,inspectLedger,withCollectionFailure,updateWorkspaceForCheck}){
  let assertions=0;
  const check=(value,message)=>{assert.ok(value,message);assertions++;};
  const future=new Date(Date.now()+7*86400000).toISOString();
  async function request(path,body,cookie=''){
    const r=await fetch(`${cp}${path}`,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(cookie?{cookie}:{})},body:body?JSON.stringify(body):undefined});
    return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
  }
  async function login(directoryId,password){const r=await request('/api/v1/auth/login',{directoryId,password});check(r.status===200&&r.cookie,'password login establishes cookie');check(!r.body.token,'login JSON contains no raw session token');return r.cookie;}
  async function state(cookie){const r=await request('/api/v1/platform/state',null,cookie);check(r.status===200,'authenticated state request');return r.body;}
  async function command(cookie,type,payload,key=randomUUID()){
    const c={type,payload,idempotencyKey:key};
    const preview=await request('/api/v1/platform/preview',c,cookie);
    if(preview.status!==200)throw new Error(`preview ${type}: ${JSON.stringify(preview.body)}`);
    const result=await request('/api/v1/platform/commands',{...c,previewToken:preview.body.previewToken},cookie);
    if(result.status!==200)throw new Error(`command ${type}: ${JSON.stringify(result.body)}`);
    return result.body;
  }
  check((await request('/api/v1/platform/state')).status===401,'business resources require login');
  const adminPassword=`admin-${randomUUID()}`;
  check((await request('/api/v1/auth/setup',{directoryId:'test-admin',name:'测试运营',password:adminPassword})).status===200,'initial setup');
  check((await request('/api/v1/auth/setup',{directoryId:'again',name:'再次初始化',password:adminPassword})).status===400,'bootstrap only once');
  const admin=await login('test-admin',adminPassword);
  const initial=await state(admin),service=initial.services[0];
  await command(admin,'save.service',{...service,baseUrl:model});
  const verification=await request(`/api/v1/platform/services/${service.id}/verify`,{},admin);
  check(verification.status===200&&verification.body.verification==='passed','model service verified over actual local HTTP');
  const range={poolId:'pool-local-test',mode:'follow',definitionIds:[]};
  await command(admin,'save.pool',{id:range.poolId,name:'验收池',entries:[{definitionId:'definition-test-model',serviceId:service.id,open:true}]});
  const plan=(await command(admin,'save.plan',{name:'月度办公方案',range,amount:10,cadence:'monthly',quotaDays:30,entitlementDays:365})).result;
  const managerPassword=`manager-${randomUUID()}`,employeePassword=`employee-${randomUUID()}`;
  const manager=(await command(admin,'save.member',{name:'项目经理',directoryId:'check-manager',password:managerPassword,organizationId:'department-engineering',category:'employee',roles:['employee'],tags:[]})).result;
  const employee=(await command(admin,'save.member',{name:'新员工',directoryId:'check-member',password:employeePassword,organizationId:'department-engineering',category:'employee',roles:['employee'],tags:['AI 编码']})).result;
  const employeeCookie=await login('check-member',employeePassword),managerCookie=await login('check-manager',managerPassword);
  const denied=await request('/api/v1/platform/commands',{type:'save.plan',idempotencyKey:randomUUID(),payload:{name:'越权方案'}},employeeCookie);
  check(denied.status===403,'employees cannot create operating plans');
  const application=(await command(employeeCookie,'approval.submit',{kind:'personal_open',amount:30,expiresAt:future,scenario:'办公',reason:'业务使用'})).result;
  await command(admin,'approval.decide',{id:application.id,decision:'approve',amount:5.123456,expiresAt:future,planId:plan.id,reason:'按需批准'});
  check((await state(admin)).entitlements.every(e=>e.memberId!==employee.id),'approval does not preempt execution');
  await command(admin,'approval.execute',{id:application.id});
  const afterApproval=await state(admin),batch=afterApproval.quotaBatches.find(b=>b.sourceId===employee.id&&b.entitlementId);
  check(batch.totalAmount===5.123456&&batch.availableAmount===5.123456,'approved amount and exact money precision reaches ledger');
  const keyId=randomUUID(),issued=(await command(employeeCookie,'key.issue',{name:'编程接入',purpose:'personal'},keyId)).result;
  check(issued.secret?.startsWith('sa_'),'new key plaintext issued once');
  const replay=await command(employeeCookie,'key.issue',{name:'编程接入',purpose:'personal'},keyId);
  check(replay.replayed&&!replay.result.secret,'retry cannot expose key plaintext');
  const generatedId=`managed-${randomUUID()}`;
  const completion=await fetch(`${gw}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${issued.secret}`,'x-request-id':generatedId,'idempotency-key':generatedId},body:JSON.stringify({model:'test-model',messages:[{role:'user',content:'managed credential check'}]})});
  await completion.text();check(completion.status===200,'managed hash-only key reaches actual gateway');
  const afterCall=await state(employeeCookie);
  check(afterCall.callLogs.some(c=>c.requestId===generatedId&&c.subjectId===employee.id),'employee sees own managed-key request log');
  check(!afterCall.callLogs.some(c=>c.subjectId==='employee-demo-001'),'employee cannot read another employee request logs');
  check(!JSON.stringify(afterCall).includes(issued.secret)&&!JSON.stringify(afterCall).includes('keyHash')&&!JSON.stringify(afterCall).includes('passwordHash'),'state excludes credential material');
  check((await request('/api/v1/calls')).status===401,'legacy full call-log endpoint no longer exposes unauthenticated data');
  const online=await request('/api/v1/platform/online-credential',{purpose:'personal',projectId:null},employeeCookie);
  check(online.status===200&&online.body.token,'online use obtains a short-lived session identity without user key setup');
  check(!(await state(employeeCookie)).keys.some(k=>k.name==='在线会话临时身份'),'online credentials never appear as user-created keys');
  assertions+=await checkMetered({cp,gw,model,admin,employeeCookie,managerCookie,employee,manager,key:issued,request,state,command,start,freePort,runtimeDirectory,expireReservation,inspectLedger});
  assertions+=await checkOnboarding({admin,request,state,command});
  assertions+=await checkOperations({admin,employeeCookie,managerCookie,employee,manager,key:issued,request,state,command});
  assertions+=await checkProjectCloseout({cp,admin,employeeCookie,managerCookie,employee,manager,request,state,command,start,freePort,runtimeDirectory});
  assertions+=await checkOrganizations({admin,request,state,command});
  assertions+=await checkCollection({admin,employeeCookie,request,state,command,withCollectionFailure});
  assertions+=await checkCommandPermissions({admin,request,state,command,gw});
  assertions+=await checkRetention({admin,employeeCookie,request,state,command,updateWorkspaceForCheck});
  assertions+=await checkAudit({admin,employeeCookie,request,state,command,updateWorkspaceForCheck});

  const project=(await command(admin,'save.project',{name:'验收项目',managerId:manager.id,range})).result;
  const beforeFunding=await state(admin);check(!beforeFunding.projectBudgets.some(b=>b.projectId===project.id),'project creation creates no budget');
  await command(managerCookie,'project.members',{projectId:project.id,memberIds:[employee.id]});
  check(!(await state(admin)).quotaBatches.some(b=>b.projectId===project.id),'membership creates no member money');
  const budget=(await command(admin,'project.fund',{projectId:project.id,amount:20,expiresAt:future})).result;
  const allocationKey=randomUUID();
  const allocation={projectId:project.id,memberId:employee.id,sourceBatchId:budget.id,amount:8};
  const memberBatch=(await command(managerCookie,'project.allocate',allocation,allocationKey)).result;
  await command(managerCookie,'project.allocate',allocation,allocationKey);
  const afterAllocation=await state(admin);
  check(afterAllocation.projectBudgets.find(b=>b.id===budget.id).availableAmount===12,'allocation decrements project unallocated funds exactly once');
  check(memberBatch.totalAmount===8&&memberBatch.expiresAt===budget.expiresAt&&memberBatch.sourceBatchId===budget.id,'member allocation inherits budget source and expiry');
  const over={type:'project.allocate',idempotencyKey:randomUUID(),payload:{...allocation,amount:13}};
  const overPreview=await request('/api/v1/platform/preview',over,managerCookie);
  check((await request('/api/v1/platform/commands',{...over,previewToken:overPreview.body.previewToken},managerCookie)).status===409,'cannot overallocate project budget');
  check((await state(admin)).projectBudgets.find(b=>b.id===budget.id).availableAmount===12,'failed allocation rolls back');

  const app=(await command(admin,'save.application',{name:'独立应用',ownerId:employee.id,organizationId:'org-demo',range})).result;
  await command(admin,'application.fund',{applicationId:app.id,amount:50,expiresAt:future});
  const appKey=(await command(employeeCookie,'key.issue',{name:'应用接入',purpose:'application',applicationId:app.id})).result;
  await command(admin,'save.member',{id:employee.id,name:employee.name,directoryId:employee.directoryId,organizationId:employee.organizationId,category:'employee',roles:['employee'],tags:[],active:false});
  check((await request('/api/v1/platform/state',null,employeeCookie)).status===403,'disabled member session immediately loses access');
  const appRequest=`app-${randomUUID()}`;
  const appCompletion=await fetch(`${gw}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${appKey.secret}`,'x-request-id':appRequest,'idempotency-key':appRequest},body:JSON.stringify({model:'test-model',messages:[]})});
  await appCompletion.text();check(appCompletion.status===200,'independent application survives owner personal disablement');
  check((await state(admin)).applications.find(a=>a.id===app.id).active,'application remains available for handoff');
  console.log(`PASS ${assertions} business HTTP assertions (setup/login, scope, service validation, approval, key lifecycle, project budget, application isolation)`);
  return assertions;
}
