import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile,realpath,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {openHigress,freePort} from './lib/higress-runtime.mjs';
import {connectionConfig} from './lib/backup.mjs';
import {captureDefaultState} from './higress/business-checks.mjs';


// Isolated guardrail acceptance. Real Higress, local fixture, no vendor calls.
const root=process.cwd(),id=randomUUID(),directory=resolve(root,'.runtime',`guardrail-${id}`);
const schema=`agp_hg_${id.replaceAll('-','')}`,token=randomUUID(),password=randomUUID();
const require=createRequire(resolve(root,'apps/control-plane/package.json')),{Pool}=require('pg');
const {resourceId}=require(resolve(root,'apps/control-plane/dist/gateway/higress.resources.js'));
const children=[],secrets=[token,password],pause=ms=>new Promise(r=>setTimeout(r,ms));
const report={success:false,id,createdAt:new Date().toISOString(),scope:{database:'isolated PostgreSQL',dataPlane:'real Higress',model:'local deterministic fixture',realModelRequests:0},checks:[]};
const clean=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^UPSTREAM_|^HIGRESS_|^GATEWAY_|^DATABASE_|^VITE_|^PGOPTIONS$|^NODE_OPTIONS$/.test(key)));
let db,hg,common,cp,cookie='',before,stopping=false;
process.on('SIGINT',()=>{stopping=true;});process.on('SIGTERM',()=>{stopping=true;});
function start(file,args,env={},cwd=root){const child=spawn(process.execPath,[resolve(root,file),...args],{cwd,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...clean,...common,...env}});let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',data=>output=(output+data).slice(-8000));child.output=()=>output;children.push(child);return child;}
async function ready(url,child){for(let n=0;n<200;n++){if(child.exitCode!==null)throw Error(child.output());try{if((await fetch(url,{signal:AbortSignal.timeout(500)})).ok)return;}catch{}await pause(100);}throw Error('readiness timeout '+url);}
async function api(path,body){const response=await fetch(cp+path,{method:body===undefined?'GET':'POST',headers:{cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(45000)});const value=await response.json();if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];assert.equal(response.status,200,`${path}: ${response.status} ${JSON.stringify(value)}`);return value;}
const state=()=>api('/api/v1/platform/state');
async function command(type,payload){const input={type,payload,idempotencyKey:randomUUID()},preview=await api('/api/v1/platform/preview',input);return (await api('/api/v1/platform/commands',{...input,previewToken:preview.previewToken})).result;}
try{
  await mkdir(directory,{recursive:true});await writeFile(resolve(directory,'empty.env'),'');
  const {connectionString}=await connectionConfig();db=new Pool({connectionString,connectionTimeoutMillis:5000});db.on('error',()=>{});before=await captureDefaultState({root,db});await writeFile(resolve(directory,'before.json'),JSON.stringify(before,null,2));await db.query(`create schema "${schema}"`);
  hg=await openHigress({root,directory:resolve(directory,'runtime'),fixture:true});secrets.push(hg.state.apiToken,hg.state.proxyToken,hg.state.modelToken);
  const [controlPort,gatewayPort,webPort]=await Promise.all([freePort(),freePort(),freePort()]);cp=`http://127.0.0.1:${controlPort}`;const gateway=`http://127.0.0.1:${gatewayPort}`,web=`http://127.0.0.1:${webPort}`;
  common={PLATFORM_MODE:'development',HOST:'127.0.0.1',WEB_ORIGIN:web,DOTENV_CONFIG_PATH:resolve(directory,'empty.env'),STORE_MODE:'postgres',DATABASE_URL:connectionString,DATABASE_SCHEMA:schema,PGOPTIONS:'',PGAPPNAME:schema,REDIS_URL:'',NODE_OPTIONS:'',BOOTSTRAP_TOKEN:'',SERVICE_TOKEN:token,COOKIE_SECURE:'false',ALLOW_UPSTREAM_REQUESTS:'true',ALLOW_UPSTREAM_VALIDATION:'true',MAINTENANCE_DISABLED:'true',...hg.environment,UPSTREAM_PROVIDER_FIXTURE:hg.state.modelToken,HIGRESS_REQUIRE_RUNTIME_READY:'true'};
  const control=start('apps/control-plane/dist/main.js',[],{PORT:String(controlPort)});await ready(cp+'/health',control);
  const gw=start('services/gateway-sim/dist/server.js',[],{PORT:String(gatewayPort),CONTROL_PLANE_URL:cp,GATEWAY_JOURNAL_DIR:resolve(directory,'journal'),UPSTREAM_TIMEOUT_MS:'10000',UPSTREAM_FIRST_BYTE_TIMEOUT_MS:'3000',UPSTREAM_IDLE_TIMEOUT_MS:'3000'});await ready(gateway+'/health',gw);
  const admin={directoryId:'web-operator',name:'审核运营',password};await api('/api/v1/auth/setup',admin);await api('/api/v1/auth/login',admin);
  const original=(await state()).services[0];const service=await command('save.service',{...original,name:'浏览器验收本地服务',baseUrl:'http://model.poc.test:4010/v1',credentialRef:'UPSTREAM_PROVIDER_FIXTURE',active:true,limits:{mode:'custom',rpm:1000,concurrency:10,maxOutputTokens:128},mappings:[{...original.mappings[0],upstreamModel:'physical-model',inputPrice:2,outputPrice:8,cachedInputPrice:.5}]});
  const route={provider:'higress',resourceType:'model_route',resourceId:resourceId({serviceId:service.id,definitionId:service.mappings[0].definitionId}),desiredVersion:'guardrail-v1',previousVersion:null,idempotencyKey:randomUUID(),spec:{serviceId:service.id,definitionId:service.mappings[0].definitionId}};
  const published=await fetch(cp+'/internal/v1/gateway-sync',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(route)}).then(r=>r.json());assert.equal(published.status,'applied');
  assert.equal((await api(`/api/v1/platform/services/${service.id}/verify`,{})).verification,'passed');
  const pool=await command('save.pool',{id:'pool-local-test',name:'浏览器验收模型池',entries:[{definitionId:service.mappings[0].definitionId,serviceId:service.id,open:true}]});
  const range={poolId:pool.id,mode:'follow',definitionIds:[]};const plan=await command('save.plan',{name:'浏览器办公方案',range,amount:.2,cadence:'monthly',quotaDays:30,entitlementDays:365});
  const accounts={operator:admin};for(const [role,name]of [['employee','审核新员工'],['manager','审核项目经理'],['owner','审核应用负责人']]){const member=await command('save.member',{name,directoryId:'web-'+role,password,organizationId:'department-engineering',category:'employee',roles:['employee'],tags:[]});accounts[role]={directoryId:'web-'+role,password,name,id:member.id};}
  const project=await command('save.project',{initialAmount:1,validity:'permanent',name:'浏览器验收项目',managerId:accounts.manager.id,range});await command('project.members',{projectId:project.id,memberIds:[accounts.employee.id]});
  const application=await command('save.application',{initialAmount:1,validity:'permanent',billingMode:'quota',name:'浏览器验收应用',ownerId:accounts.owner.id,organizationId:'org-demo',range});
  const session={id,directory,schema,web,control:cp,gateway,accounts,planId:plan.id,projectId:project.id,applicationId:application.id};
  await writeFile(resolve(directory,'session.json'),JSON.stringify(session,null,2));
  const check=(condition,label)=>{assert.ok(condition,label);report.checks.push(label);};
  await command('distribution.execute',{planId:plan.id,memberIds:[accounts.employee.id]});
  const budget=await command('project.fund',{projectId:project.id,amount:.5,expiresAt:new Date(Date.now()+86400000*7).toISOString()});
  await command('project.allocate',{projectId:project.id,memberId:accounts.employee.id,sourceBatchId:budget.id,amount:.1});
  await command('application.fund',{applicationId:application.id,amount:.25,expiresAt:budget.expiresAt});
  const keys={};for(const purpose of ['personal','project','application']){const key=await command('key.issue',{name:'围栏隔离验收',purpose,memberId:accounts.employee.id,...(purpose==='project'?{projectId:project.id}:{}),...(purpose==='application'?{applicationId:application.id}:{})});keys[purpose]=key.secret;secrets.push(key.secret);}
  const setPolicy=async(mode,extra={})=>{const policy=(await api('/api/v1/platform/safety/query',{})).policy;return command('guardrail.update',{expectedVersion:policy.version,mode,modelIds:null,presets:['phone','identity_card','api_key'],words:['内部验收代号'],reason:'隔离围栏验收',...extra});};
  const money=async()=>(await db.query(`select id,available_amount from "${schema}".quota_batches order by id`)).rows;
  const fixtureRequests=()=>fetch(hg.model+'/_poc/requests').then(r=>r.json());
  const call=async(purpose,body,expected=200,{requestId='guardrail-'+randomUUID(),idempotencyKey=requestId,target=gateway}={})=>{
    const beforeFunds=await money(),response=await fetch(target+'/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${keys[purpose]}`,'content-type':'application/json','x-request-id':requestId,'idempotency-key':idempotencyKey},body:JSON.stringify({model:'test-model',max_tokens:32,messages:[{role:'user',content:'POC_BASIC'}],...body}),signal:AbortSignal.timeout(15000)});
    const raw=await response.text();check(response.status===expected,`${purpose} ${body.stream?'stream':'json'} returns ${expected}`);
    if(expected===403){const value=JSON.parse(raw);check(response.headers.get('content-type').includes('application/json')&&value.error.type==='safety_policy_violation','input block is structured JSON, including stream requests');assert.deepEqual(await money(),beforeFunds);check(!(await fixtureRequests()).some(r=>r.requestId===requestId),'blocked input never reaches fixture');check((await db.query(`select count(*)::int n from "${schema}".reservations where request_id=$1`,[requestId])).rows[0].n===0,'blocked input creates no reservation');check((await db.query(`select count(*)::int n from "${schema}".usage_ledger_entries where request_id=$1`,[requestId])).rows[0].n===0,'blocked input creates no consumption');}
    if(expected===200){let log;for(let n=0;n<60;n++){log=(await db.query(`select * from "${schema}".call_logs where request_id=$1`,[requestId])).rows[0];if(log)break;await pause(50);}check(log?.billable_state==='confirmed'&&Math.round(Number(log.actual_amount)*1e6)===132,'allowed call retains trusted settlement');check((await fixtureRequests()).filter(r=>r.requestId===requestId).length===1,'allowed request reaches Higress fixture once');}
    report.requests??=[];report.requests.push({purpose,requestId,httpStatus:response.status});return {requestId,raw};
  };
  const sensitive={messages:[{role:'user',content:'合成号码 13800138000'}]};
  await call('personal',sensitive);check((await api('/api/v1/platform/safety/query',{})).items.length===0,'initial off mode creates no safety events');
  await setPolicy('observe');await call('personal',sensitive);check((await api('/api/v1/platform/safety/query',{})).counts.observe===1,'observe records and allows generation');
  await setPolicy('block');const blocked=await call('personal',{...sensitive,stream:true},403);
  await call('project',sensitive,403);await call('application',sensitive,403);
  await call('personal',{messages:[{role:'system',content:'内部验收代号'},{role:'user',content:'普通任务'}]},403);
  await call('personal',{messages:[{role:'assistant',content:null,tool_calls:[{id:'call-test',type:'function',function:{name:'echo',arguments:'{"value":"\\u0031\\u0033\\u0038\\u0030\\u0030\\u0031\\u0033\\u0038\\u0030\\u0030\\u0030"}'}}]},{role:'tool',tool_call_id:'call-test',content:'普通结果'}]},403);
  await call('personal',{tools:[{type:'function',function:{name:'echo',description:'内部验收代号',parameters:{type:'object'}}}]},403);
  await call('personal',{},200);await call('project',{stream:true},200);await call('application',{},200);
  const beforeReplay=(await api('/api/v1/platform/safety/query',{})).counts;
  await setPolicy('off');await call('personal',{...sensitive,stream:true},403,{requestId:blocked.requestId,idempotencyKey:blocked.requestId});assert.deepEqual((await api('/api/v1/platform/safety/query',{})).counts,beforeReplay);check(true,'deny replay remains denied after policy change with no duplicate event');
  await setPolicy('block',{modelIds:['test-model']});
  await command('save.definition',{name:'非保护范围验收模型',modelId:'unprotected-fixture',contextTokens:128,description:'scope control',active:true});
  await setPolicy('block',{modelIds:['unprotected-fixture']});await call('personal',sensitive,200);check(true,'unselected model bypasses content check only, normal permission and billing remain');
  await setPolicy('block');
  const directCpPort=await freePort(),directGwPort=await freePort(),directCp='http://127.0.0.1:'+directCpPort,directGw='http://127.0.0.1:'+directGwPort;
  const dc=start('apps/control-plane/dist/main.js',[],{PORT:String(directCpPort),GATEWAY_DATA_PLANE:'direct'});await ready(directCp+'/health',dc);
  const dg=start('services/gateway-sim/dist/server.js',[],{PORT:String(directGwPort),CONTROL_PLANE_URL:directCp,GATEWAY_DATA_PLANE:'direct',GATEWAY_JOURNAL_DIR:resolve(directory,'direct-journal')});await ready(directGw+'/health',dg);await call('application',sensitive,403,{target:directGw});check(true,'controlled direct mode also blocks before upstream');
  let deep='synthetic';for(let n=0;n<40;n++)deep={child:deep};const limited=await call('personal',{metadata:deep},503);check(JSON.parse(limited.raw).error.type==='guardrail_unavailable','scan limit returns explicit dependency failure');check((await fetch(gateway+'/health').then(r=>r.json())).outbox.queued===0,'known scan failure leaves no authorization recovery queue');
  const resolved=await fetch(cp+'/internal/v1/policy/credentials/resolve',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({apiKey:keys.personal})}).then(r=>r.json());
  const internal=async assessment=>{const requestId='guardrail-'+randomUUID(),r=await fetch(cp+'/internal/v1/policy/authorize',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({requestId,idempotencyKey:requestId,identity:resolved.identity,purpose:'personal',modelId:'test-model',mode:'chat',policyVersion:'guardrail-test',...(assessment?{guardrail:assessment}:{})})});check([409,503].includes(r.status),'stale or missing assessment is fail closed');check((await db.query(`select count(*)::int n from "${schema}".reservations where request_id=$1`,[requestId])).rows[0].n===0,'assessment failure has no reservation');};
  await internal();await internal({version:0,matches:[]});await internal({version:resolved.guardrailPolicy.version,matches:[],error:'scan_limit'});
  const trialBefore=(await api('/api/v1/platform/safety/query',{})).counts,fixtureBefore=(await fixtureRequests()).length;
  check((await api('/api/v1/platform/safety/trial',{modelId:'test-model',text:'13800138000'})).result.matches.length===1,'operator trial identifies synthetic input');assert.deepEqual((await api('/api/v1/platform/safety/query',{})).counts,trialBefore);check((await fixtureRequests()).length===fixtureBefore,'trial never calls a model');
  const events=(await api('/api/v1/platform/safety/query',{limit:2}));check(events.items.length===2&&!!events.nextCursor,'safety events are paginated');const next=await api('/api/v1/platform/safety/query',{before:events.nextCursor,limit:2});check(next.items.every(e=>!events.items.some(first=>first.id===e.id)),'cursor pages do not repeat events');
  const adminCookie=cookie;await api('/api/v1/auth/login',accounts.employee);for(const path of ['/safety/query','/safety/trial']){const r=await fetch(cp+'/api/v1/platform'+path,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(path.endsWith('trial')?{modelId:'test-model',text:'synthetic'}:{})});check(r.status===403,'employee cannot access '+path);}cookie=adminCookie;
  const protectedConfig=await api('/api/v1/platform/safety/query',{});report.events=(await db.query(`select request_id,action,matches from "${schema}".safety_events order by created_at`)).rows;
  check(!JSON.stringify(report.events).includes('13800138000')&&!JSON.stringify(report.events).includes('内部验收代号'),'events contain metadata without matched text');
  await setPolicy('off');await call('application',sensitive,200);
  report.calls=(await db.query(`select request_id,purpose,billable_state,actual_amount,error_code,forwarded,safety from "${schema}".call_logs order by completed_at`)).rows;
  check(report.calls.filter(c=>c.error_code==='safety_policy_violation').every(c=>c.billable_state==='not_billable'&&Number(c.actual_amount)===0&&c.forwarded===false),'all blocked call logs show zero fee and no forwarding');
  check((await db.query(`select count(*)::int n from "${schema}".reservations where not finalized`)).rows[0].n===0,'no unfinished reservations');
  const after=await captureDefaultState({root,db});report.defaultPreservation={before,after};assert.deepEqual(after,before);check(true,'default workspace and live-model budget unchanged');
  report.fixtureRequests=await fixtureRequests();report.success=true;
  if(process.env.GUARDRAIL_BROWSER_HOLD==='true'||process.argv.includes('--browser')){
    const webProcess=start('apps/web/node_modules/vite/bin/vite.js',['--host','127.0.0.1','--port',String(webPort),'--strictPort'],{VITE_CONTROL_PLANE_URL:cp,VITE_GATEWAY_URL:gateway,VITE_REVIEW_MODE:'true',VITE_REVIEW_STORAGE:'postgres'},resolve(root,'apps/web'));await ready(web,webProcess);console.log(JSON.stringify({ready:true,directory,web:web+'/?ui=beacon'}));
    const browserChild=process.argv.includes('--browser')?start('scripts/check-guardrail-web.mjs',[directory]):null;
    while(!stopping){if(browserChild?.exitCode!==undefined&&browserChild.exitCode!==null&&browserChild.exitCode!==0)throw Error('browser acceptance failed; inspect docs/validation/guardrail-2026-10-30/browser.json');try{report.browser=JSON.parse(await readFile(resolve(directory,'finish.json'),'utf8'));assert.ok(report.browser.success);break;}catch(error){if(error.code!=='ENOENT')throw error;}await pause(500);}
    assert.ok(report.browser?.success,'browser checks not completed');
    report.finalCalls=(await db.query(`select request_id,purpose,billable_state,actual_amount,error_code,forwarded,safety from "${schema}".call_logs order by completed_at`)).rows;
    report.finalFixtureRequests=await fixtureRequests();
    const final=await captureDefaultState({root,db});assert.deepEqual(final,before);
  }
}catch(error){report.success=false;report.error=secrets.reduce((s,key)=>s.replaceAll(key,'[redacted]'),error.stack??String(error));process.exitCode=1;}
finally{
  for(const child of children.toReversed())if(child.exitCode===null){child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),pause(2000)]);}
  await hg?.close();if(db){assert.match(schema,/^agp_hg_[a-f0-9]{32}$/);await db.query(`drop schema if exists "${schema}" cascade`);await db.end();}
  report.completedAt=new Date().toISOString();const output=resolve(root,'.runtime/guardrail-results',id+'.json');await mkdir(resolve(root,'.runtime/guardrail-results'),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
  if(report.success){assert.equal(await realpath(directory),resolve(await realpath(resolve(root,'.runtime')),`guardrail-${id}`));await rm(directory,{recursive:true,force:true});}
  console.log(JSON.stringify({success:report.success,checks:report.checks.length,output,error:report.error}));
}
