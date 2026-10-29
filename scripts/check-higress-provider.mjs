import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile,realpath,rm} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {openHigress,freePort} from './lib/higress-runtime.mjs';
import {connectionConfig} from './lib/backup.mjs';

const root=process.cwd(),id=randomUUID(),directory=resolve(root,'.runtime',`higress-provider-${id}`);
const require=createRequire(resolve(root,'apps/control-plane/package.json')),{Pool}=require('pg');
const {resourceId}=require(resolve(root,'apps/control-plane/dist/gateway/higress.resources.js'));
const schema=`agp_hg_${id.replaceAll('-','')}`,token=randomUUID(),password=randomUUID(),children=[],secrets=[token,password];
const report={success:false,createdAt:new Date().toISOString(),scope:{database:'isolated PostgreSQL schema',higress:'pinned real runtime',model:'local deterministic fixture',realModelRequests:0,defaultWorkspaceTouched:false},checks:[]};
const pause=ms=>new Promise(r=>setTimeout(r,ms)),output=resolve(root,process.env.HIGRESS_PROVIDER_REPORT_PATH??`.runtime/higress-provider-results/${id}.json`);
const check=(value,label)=>{assert.ok(value,label);report.checks.push(label);};
let hg,db,control,gateway,phase='preflight',cp,gw,cookie='',blockSettlement=false,shim;
const clean=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^UPSTREAM_|^HIGRESS_|^GATEWAY_|^DATABASE_|^PGOPTIONS$|^NODE_OPTIONS$/.test(key)));
let common;
function start(file,env){const child=spawn(process.execPath,[resolve(root,file)],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...clean,...common,...env}});let out='';child.stdout.on('data',v=>out=(out+v).slice(-6000));child.stderr.on('data',v=>out=(out+v).slice(-6000));child.output=()=>out;children.push(child);return child;}
async function stop(child){if(child&&child.exitCode===null&&child.signalCode===null){child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),pause(3000)]);}}
async function ready(base,child){for(let n=0;n<150;n++){if(child?.exitCode!==null)throw new Error('child_startup_failed: '+child.output());try{if((await fetch(base+'/health',{signal:AbortSignal.timeout(500)})).ok)return;}catch{}await pause(100);}throw new Error('child_readiness_timeout');}
async function api(path,body,{internal=false}={}){const response=await fetch(cp+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(internal?{authorization:`Bearer ${token}`}:{cookie})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(45000)});const value=await response.json();if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];return {response,value};}
async function ok(path,body){const result=await api(path,body);assert.equal(result.response.status,200,`API ${path}: ${result.response.status}`);return result.value;}
const state=()=>ok('/api/v1/platform/state');
async function command(type,payload){const input={type,payload,idempotencyKey:randomUUID()},preview=await ok('/api/v1/platform/preview',input);return (await ok('/api/v1/platform/commands',{...input,previewToken:preview.previewToken})).result;}
const sync=input=>api('/internal/v1/gateway-sync',input,{internal:true}).then(r=>r.value);
async function waitLog(id){for(let n=0;n<100;n++){const log=(await state()).callLogs.find(l=>l.requestId===id);if(log)return log;await pause(80);}throw new Error('missing_durable_call_log');}
let key;
function call({scenario='POC_BASIC',stream=false,tools,messages,requestId=randomUUID(),apiKey=key.secret,...rest}={}){return {requestId,promise:fetch(gw+'/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json','x-request-id':requestId,'idempotency-key':requestId},body:JSON.stringify({model:'test-model',messages:messages??[{role:'user',content:scenario}],max_tokens:32,stream,...(tools?{tools}:{}),...rest}),signal:AbortSignal.timeout(15000)})};}
try{
  await mkdir(directory,{recursive:true});await writeFile(resolve(directory,'empty.env'),'');
  const {connectionString}=await connectionConfig();db=new Pool({connectionString,connectionTimeoutMillis:5000});await db.query(`create schema "${schema}"`);
  hg=await openHigress({root,directory:resolve(directory,'runtime'),fixture:true});secrets.push(hg.state.apiToken,hg.state.proxyToken,hg.state.modelToken);
  const controlPort=await freePort(),gatewayPort=await freePort();cp=`http://127.0.0.1:${controlPort}`;gw=`http://127.0.0.1:${gatewayPort}`;
  common={PLATFORM_MODE:'development',HOST:'127.0.0.1',DOTENV_CONFIG_PATH:resolve(directory,'empty.env'),STORE_MODE:'postgres',DATABASE_URL:connectionString,DATABASE_SCHEMA:schema,PGOPTIONS:'',REDIS_URL:'',NODE_OPTIONS:'',BOOTSTRAP_TOKEN:'',SERVICE_TOKEN:token,ALLOW_UPSTREAM_REQUESTS:'true',ALLOW_UPSTREAM_VALIDATION:'true',MAINTENANCE_DISABLED:'true',...hg.environment,UPSTREAM_PROVIDER_FIXTURE:hg.state.modelToken};
  const startControl=async()=>{control=start('apps/control-plane/dist/main.js',{PORT:String(controlPort)});await ready(cp,control);};await startControl();
  const startGateway=async()=>{gateway=start('services/gateway-sim/dist/server.js',{PORT:String(gatewayPort),CONTROL_PLANE_URL:cp,GATEWAY_JOURNAL_DIR:resolve(directory,'journal'),UPSTREAM_TIMEOUT_MS:'6000',UPSTREAM_FIRST_BYTE_TIMEOUT_MS:'2000',UPSTREAM_IDLE_TIMEOUT_MS:'2000'});await ready(gw,gateway);};await startGateway();
  phase='workspace and formal configuration';
  await ok('/api/v1/auth/setup',{directoryId:'higress-provider-admin',name:'Higress Provider 验收',password});await ok('/api/v1/auth/login',{directoryId:'higress-provider-admin',password});
  let service=(await state()).services[0];
  service=await command('save.service',{...service,baseUrl:'http://model.poc.test:4010/v1',credentialRef:'UPSTREAM_PROVIDER_FIXTURE',active:true,limits:{mode:'custom',rpm:1000,concurrency:10,maxOutputTokens:128},mappings:[{...service.mappings[0],upstreamModel:'physical-model',inputPrice:2,outputPrice:8,cachedInputPrice:0.5}]});
  const rid=resourceId({serviceId:service.id,definitionId:service.mappings[0].definitionId}),input={provider:'higress',resourceType:'model_route',resourceId:rid,desiredVersion:'provider-v1',previousVersion:null,idempotencyKey:'provider-first',spec:{serviceId:service.id,definitionId:service.mappings[0].definitionId}};
  const first=await sync(input);report.firstPublication=first;check(first.status==='applied',`formal Provider confirms runtime: ${first.errorCode}`);
  check((await sync(input)).operationId===first.operationId,'identical idempotency key replays the original durable operation');
  check((await sync({...input,desiredVersion:'wrong'})).errorCode==='idempotency_conflict','changed idempotency payload is rejected');
  check((await sync({...input,idempotencyKey:'bad-cas',previousVersion:'wrong',desiredVersion:'v2'})).errorCode==='version_conflict','optimistic previousVersion conflict is rejected');
  check((await sync({...input,resourceType:'rate_limit'})).errorCode==='unsupported_resource_type','unsupported policy publication is explicit');
  check((await fetch(hg.api+'/apis/networking.k8s.io/v1/namespaces/higress-system/ingresses')).status===401,'management relay requires its separate service credential');
  const verified=await ok(`/api/v1/platform/services/${service.id}/verify`,{});report.verification=verified.verificationRun?.results?.map(r=>({outcome:r.outcome,usage:r.usage,cost:r.cost}));check(verified.verification==='passed','diagnostic verification uses the formal Higress route');
  await command('save.pool',{id:'pool-local-test',name:'Provider 验收池',entries:[{definitionId:service.mappings[0].definitionId,serviceId:service.id,open:true}]});
  const actor=(await state()).actor,plan=await command('save.plan',{name:'Provider 验收预算',range:{poolId:'pool-local-test',mode:'follow',definitionIds:[]},amount:1,cadence:'once',quotaDays:1,entitlementDays:1});await command('distribution.execute',{planId:plan.id,memberIds:[actor.id]});key=await command('key.issue',{name:'Provider 验收 Key',purpose:'personal'});secrets.push(key.secret);
  phase='protocol and PostgreSQL settlement';
  const requests=()=>fetch(hg.model+'/_poc/requests').then(r=>r.json());
  const basic=call(),response=await basic.promise,value=await response.json();check(response.status===200&&value.model==='test-model','logical model survives formal Provider non-stream dispatch');
  const normal=await waitLog(basic.requestId);check(normal.usageFinal&&normal.billableState==='confirmed'&&normal.inputTokens===13&&normal.outputTokens===14&&normal.cachedInputTokens===4,'PostgreSQL settles returned and cached usage');
  check(Math.abs(normal.actualAmount-0.000132)<1e-9,'original control-plane prices determine the charge');
  check(normal.admission.route.serviceId===service.id&&normal.admission.route.upstreamModel==='physical-model'&&!JSON.stringify(normal).includes('transport'),'public call evidence contains the original route and hides private transport');
  const seen=(await requests()).find(r=>r.requestId===basic.requestId);check(seen?.model==='physical-model'&&seen.maxOutput===32,'Higress performs the immutable physical-model mapping and output bound');
  const applied=(await db.query(`select payload from "${schema}".gateway_sync_state where resource_id=$1`,[rid])).rows[0].payload.active;
  for(const credential of ['',key.secret,'invalid']){const response=await fetch(hg.proxy+`/atlas/${applied.name}/_ready`,{headers:credential?{authorization:`Bearer ${credential}`}:{}});check([401,403].includes(response.status),'Higress rejects missing, managed or invalid hop credentials');}
  const stream=call({stream:true}),streamResponse=await stream.promise,raw=await streamResponse.text();check(streamResponse.ok&&raw.includes('data: [DONE]')&&raw.includes('"model":"test-model"'),'SSE model and terminal usage survive Higress');await waitLog(stream.requestId);
  const tool={type:'function',function:{name:'local_echo',description:'Echo',parameters:{type:'object',properties:{text:{type:'string'}},required:['text']}}};
  const toolCall=call({tools:[tool]}),toolValue=await(await toolCall.promise).json();check(toolValue.choices[0].message.tool_calls?.[0].function.name==='local_echo','tool arguments survive formal dispatch');await waitLog(toolCall.requestId);
  const toolResult=call({tools:[tool],messages:[{role:'user',content:'Echo'},{role:'assistant',content:null,tool_calls:toolValue.choices[0].message.tool_calls},{role:'tool',tool_call_id:'call-local',content:'上海'}]});check((await toolResult.promise).ok,'tool result round trip succeeds');await waitLog(toolResult.requestId);
  const cancel=call({stream:true,scenario:'POC_CANCEL'}),cancelResponse=await cancel.promise,reader=cancelResponse.body.getReader();await reader.read();await reader.cancel();const cancelled=await waitLog(cancel.requestId);check(cancelled.billableState==='pending_review'&&!cancelled.usageFinal,'cancelled unknown usage remains pending review in PostgreSQL');
  for(let n=0;n<30&&!(await requests()).find(r=>r.requestId===cancel.requestId)?.closed;n++)await pause(100);check((await requests()).find(r=>r.requestId===cancel.requestId)?.closed,'cancellation closes the downstream model connection');
  const before=(await requests()).length,invalid=call({apiKey:'invalid'});check((await invalid.promise).status===401,'invalid managed credential is rejected');check((await requests()).length===before,'invalid managed credential never reaches Higress inference');
  const error=call({scenario:'POC_ERROR'}),errorResponse=await error.promise;await errorResponse.text();const errorLog=await waitLog(error.requestId);report.errorSample={status:errorResponse.status,log:errorLog};check(errorLog.billableState==='pending_review',`5xx without usage keeps an unknown hold: ${errorResponse.status}/${errorLog.errorCode}/${errorLog.billableState}`);check((await requests()).filter(r=>r.requestId===error.requestId).length===1,'Higress retries and failover remain disabled');
  phase='personal, project and application scopes';
  const range={poolId:'pool-local-test',mode:'follow',definitionIds:[]},expiresAt=new Date(Date.now()+86400000).toISOString();
  const project=await command('save.project',{name:'Provider 项目',managerId:actor.id,range});await command('project.members',{projectId:project.id,memberIds:[actor.id]});
  const budget=await command('project.fund',{projectId:project.id,amount:.1,expiresAt});await command('project.allocate',{projectId:project.id,memberId:actor.id,sourceBatchId:budget.id,amount:.05});
  const projectKey=await command('key.issue',{name:'Provider project',purpose:'project',projectId:project.id});secrets.push(projectKey.secret);
  const beforeProject=(await state()).quotaBatches.filter(b=>b.purpose==='personal').reduce((s,b)=>s+b.availableAmount,0);
  const projectCall=call({apiKey:projectKey.secret});check((await projectCall.promise).ok,'project request passes through Higress');const projectLog=await waitLog(projectCall.requestId);check(projectLog.purpose==='project'&&projectLog.projectId===project.id,'PostgreSQL records the original project attribution');
  check(Math.abs((await state()).quotaBatches.filter(b=>b.purpose==='personal').reduce((s,b)=>s+b.availableAmount,0)-beforeProject)<1e-9,'project usage does not debit personal funds');
  const app=await command('save.application',{name:'Provider 应用',ownerId:actor.id,organizationId:'org-demo',range});await command('application.fund',{applicationId:app.id,amount:.05,expiresAt});
  const appKey=await command('key.issue',{name:'Provider application',purpose:'application',applicationId:app.id});secrets.push(appKey.secret);
  const appCall=call({apiKey:appKey.secret});check((await appCall.promise).ok,'application request passes through Higress');const appLog=await waitLog(appCall.requestId);check(appLog.purpose==='application'&&appLog.subjectId===app.id,'application usage stays in its own PostgreSQL scope');
  phase='PostgreSQL concurrent budget reservation';
  const tinyMember=await command('save.member',{name:'Provider 并发小额用户',directoryId:'provider-tiny',password:randomUUID(),organizationId:'department-engineering',category:'employee',roles:['employee'],tags:[]});
  const tinyPlan=await command('save.plan',{name:'Provider 并发小额预算',range,amount:.0004,cadence:'once',quotaDays:1,entitlementDays:1});await command('distribution.execute',{planId:tinyPlan.id,memberIds:[tinyMember.id]});
  const tinyKey=await command('key.issue',{name:'Provider race',purpose:'personal',memberId:tinyMember.id});secrets.push(tinyKey.secret);
  const contenders=Array.from({length:5},()=>call({apiKey:tinyKey.secret,stream:true,scenario:'POC_CANCEL'})),responses=await Promise.all(contenders.map(c=>c.promise));
  check(responses.filter(r=>r.status===200).length===1&&responses.filter(r=>r.status===403).length===4,'five concurrent PostgreSQL requests reserve the single affordable hold once');
  const admitted=responses.findIndex(r=>r.ok),raceReader=responses[admitted].body.getReader();await raceReader.read();await raceReader.cancel();await waitLog(contenders[admitted].requestId);
  check((await requests()).filter(r=>contenders.some(c=>c.requestId===r.requestId)).length===1,'losing budget contenders never reach the model');
  const tinyBatches=(await state()).quotaBatches.filter(b=>b.sourceId===tinyMember.id);check(tinyBatches.every(b=>b.availableAmount>=0),'concurrent reservation never overdraws the funded PostgreSQL batch');
  phase='configuration persistence and rollback';
  await stop(gateway);await stop(control);await startControl();await startGateway();
  check((await api('/internal/v1/gateway-sync/'+rid,undefined,{internal:true})).value.operationId===first.operationId,'configuration operation survives control-plane restart');
  check((await sync(input)).operationId===first.operationId,'idempotent replay survives PostgreSQL restart of the process');
  const repeat=call();check((await repeat.promise).ok,'applied route survives control-plane and gateway restart');await waitLog(repeat.requestId);
  const payload=(await db.query(`select payload from "${schema}".gateway_sync_state where resource_id=$1`,[rid])).rows[0].payload;check(!secrets.some(secret=>JSON.stringify(payload).includes(secret)),'configuration journal contains no plaintext credential');
  const v2=await sync({...input,idempotencyKey:'provider-second',previousVersion:'provider-v1',desiredVersion:'provider-v2'});check(v2.status==='applied'&&v2.appliedVersion==='provider-v2','a new desired version is runtime-confirmed');
  const rollback=await sync({...input,idempotencyKey:'provider-rollback',previousVersion:'provider-v2'});report.rollback=rollback;check(rollback.status==='applied'&&rollback.appliedVersion==='provider-v1',`explicit rollback restores the immutable prior version: ${rollback.errorCode}`);
  // Network failure must retain the last known working route in durable state.
  await hg.run(['stop','--time','1',hg.name+'-management']);
  const failed=await sync({...input,idempotencyKey:'provider-failed',previousVersion:'provider-v1',desiredVersion:'provider-v3'});check(failed.status==='rejected'&&failed.appliedVersion==='provider-v1','failed publication retains last applied version');
  await hg.run(['start',hg.name+'-management']);
  const final=await state(),batches=final.quotaBatches.filter(b=>b.sourceId===actor.id),logs=final.callLogs.filter(l=>l.subjectId===actor.id);
  const total=batches.reduce((s,b)=>s+b.totalAmount,0),available=batches.reduce((s,b)=>s+b.availableAmount,0),confirmed=logs.filter(l=>l.billableState==='confirmed').reduce((s,l)=>s+l.actualAmount,0),held=logs.filter(l=>l.billableState==='pending_review').reduce((s,l)=>s+(l.admission?.reservedAmount??0),0);
  check(Math.abs(total-available-confirmed-held)<1e-7,'original funds equal remaining balance, confirmed usage and unknown holds');
  report.accounting={total,available,confirmed,held,calls:logs.length,fixtureRequests:(await requests()).length};
  const health=await fetch(gw+'/health').then(r=>r.json());report.outbox=health.outbox;check(health.outbox.queued===0&&health.outbox.blocked===0&&health.outbox.writePending===0,'gateway durable outbox is drained');
  report.success=true;
}catch(error){report.error={phase,message:secrets.reduce((s,key)=>s.replaceAll(key,'[redacted]'),error.message)};console.error(report.error);process.exitCode=1;}
finally{
  for(const child of children.toReversed())await stop(child);await hg?.close();
  if(db){if(/^agp_hg_[a-f0-9]{32}$/.test(schema))await db.query(`drop schema "${schema}" cascade`);await db.end();}
  report.completedAt=new Date().toISOString();await mkdir(resolve(root,'.runtime/higress-provider-results'),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
  if(report.success){assert.equal(await realpath(directory),resolve(await realpath(resolve(root,'.runtime')),`higress-provider-${id}`));await rm(directory,{recursive:true,force:true});}
  console.log(JSON.stringify({success:report.success,checks:report.checks.length,output}));
}
