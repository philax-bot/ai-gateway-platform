import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile,realpath,rm,rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import {openHigress,freePort} from './lib/higress-runtime.mjs';
import {connectionConfig} from './lib/backup.mjs';
import {captureDefaultState} from './higress/business-checks.mjs';
import {runProtocolSdkChecks} from './lib/protocol-sdk.mjs';


// Isolated three-protocol acceptance. Real Higress, local fixture, no vendor calls.
const root=process.cwd(),id=randomUUID(),directory=resolve(root,'.runtime',`protocol-${id}`);
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
  const {connectionString}=await connectionConfig();db=new Pool({connectionString,connectionTimeoutMillis:15000});db.on('error',()=>{});before=await captureDefaultState({root,db});await writeFile(resolve(directory,'before.json'),JSON.stringify(before,null,2));await db.query(`create schema "${schema}"`);
  hg=await openHigress({root,directory:resolve(directory,'runtime'),fixture:true});secrets.push(hg.state.apiToken,hg.state.proxyToken,hg.state.modelToken);
  const [controlPort,gatewayPort,webPort]=await Promise.all([freePort(),freePort(),freePort()]);cp=`http://127.0.0.1:${controlPort}`;const gateway=`http://127.0.0.1:${gatewayPort}`,web=`http://127.0.0.1:${webPort}`;
  common={PLATFORM_MODE:'development',HOST:'127.0.0.1',WEB_ORIGIN:web,DOTENV_CONFIG_PATH:resolve(directory,'empty.env'),STORE_MODE:'postgres',DATABASE_URL:connectionString,DATABASE_SCHEMA:schema,PGOPTIONS:'',PGAPPNAME:schema,REDIS_URL:'',NODE_OPTIONS:'',BOOTSTRAP_TOKEN:'',SERVICE_TOKEN:token,COOKIE_SECURE:'false',ALLOW_UPSTREAM_REQUESTS:'true',ALLOW_UPSTREAM_VALIDATION:'true',MAINTENANCE_DISABLED:'true',CONTROL_PLANE_RPC_TIMEOUT_MS:'15000',CONTROL_PLANE_DIAGNOSTICS:'true',...hg.environment,UPSTREAM_PROVIDER_FIXTURE:hg.state.modelToken,HIGRESS_REQUIRE_RUNTIME_READY:'true'};
  const control=start('apps/control-plane/dist/main.js',[],{PORT:String(controlPort)});await ready(cp+'/health',control);
  const gw=start('services/gateway-sim/dist/server.js',[],{PORT:String(gatewayPort),CONTROL_PLANE_URL:cp,GATEWAY_JOURNAL_DIR:resolve(directory,'journal'),UPSTREAM_TIMEOUT_MS:'10000',UPSTREAM_FIRST_BYTE_TIMEOUT_MS:'3000',UPSTREAM_IDLE_TIMEOUT_MS:'3000'});await ready(gateway+'/health',gw);
  const admin={directoryId:'web-operator',name:'审核运营',password};await api('/api/v1/auth/setup',admin);await api('/api/v1/auth/login',admin);
  const original=(await state()).services[0];const service=await command('save.service',{...original,name:'浏览器验收本地服务',baseUrl:'http://model.poc.test:4010/native/v1',credentialRef:'UPSTREAM_PROVIDER_FIXTURE',active:true,limits:{mode:'custom',rpm:1000,concurrency:10,maxOutputTokens:128},mappings:[{...original.mappings[0],upstreamModel:'physical-model',inputPrice:2,outputPrice:8,cachedInputPrice:.5}]});
  const route={provider:'higress',resourceType:'model_route',resourceId:resourceId({serviceId:service.id,definitionId:service.mappings[0].definitionId}),desiredVersion:'guardrail-v1',previousVersion:null,idempotencyKey:randomUUID(),spec:{serviceId:service.id,definitionId:service.mappings[0].definitionId}};
  const published=await fetch(cp+'/internal/v1/gateway-sync',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(route)}).then(r=>r.json());assert.equal(published.status,'applied');
  assert.equal((await api(`/api/v1/platform/services/${service.id}/verify`,{})).verification,'passed');
  const pool=await command('save.pool',{id:'pool-local-test',name:'浏览器验收模型池',entries:[{definitionId:service.mappings[0].definitionId,serviceId:service.id,open:true}]});
  const range={poolId:pool.id,mode:'follow',definitionIds:[]};const plan=await command('save.plan',{name:'浏览器办公方案',range,amount:.2,cadence:'monthly',quotaDays:30,entitlementDays:365});
  const accounts={operator:admin};for(const [role,name]of [['employee','审核新员工'],['manager','审核项目经理'],['owner','审核应用负责人']]){const member=await command('save.member',{name,directoryId:'web-'+role,password,organizationId:'department-engineering',category:'employee',roles:['employee'],tags:[]});accounts[role]={directoryId:'web-'+role,password,name,id:member.id};}
  const project=await command('save.project',{initialAmount:1,validity:'permanent',name:'浏览器验收项目',managerId:accounts.manager.id,range});await command('project.members',{projectId:project.id,memberIds:[accounts.employee.id]});
  const application=await command('save.application',{initialAmount:1,validity:'permanent',billingMode:'quota',name:'浏览器验收应用',ownerId:accounts.owner.id,organizationId:'org-demo',range});
  const check=(condition,label)=>{assert.ok(condition,label);report.checks.push(label);};
  check(service.verification!=='failed','configured service created');
  const verified=(await state()).services.find(s=>s.id===service.id);
  report.nativeProbes=verified.protocolCapabilities;
  for(const p of ['chat','responses','messages'])check(verified.protocolCapabilities.mappings[service.mappings[0].definitionId][p].status==='supported','native '+p+' basic probe passes through real Higress');
  await command('distribution.execute',{planId:plan.id,memberIds:[accounts.employee.id]});
  const budget=await command('project.fund',{projectId:project.id,amount:.5,expiresAt:new Date(Date.now()+86400000*7).toISOString()});
  await command('project.allocate',{projectId:project.id,memberId:accounts.employee.id,sourceBatchId:budget.id,amount:.1});
  await command('application.fund',{applicationId:application.id,amount:.25,expiresAt:budget.expiresAt});
  const keys={};for(const purpose of ['personal','project','application']){const key=await command('key.issue',{name:'三协议隔离验收',purpose,memberId:accounts.employee.id,...(purpose==='project'?{projectId:project.id}:{}),...(purpose==='application'?{applicationId:application.id}:{})});keys[purpose]=key.secret;secrets.push(key.secret);}
  const sdkIndex=process.argv.indexOf('--sdk-root'),sdkRoot=sdkIndex>=0?process.argv[sdkIndex+1]:null;
  if(sdkRoot){report.sdk={native:await runProtocolSdkChecks({gateway,key:keys.personal,model:'test-model',mode:'native',sdkRoot})};}
  const money=async()=>(await db.query(`select id,available_amount from "${schema}".quota_batches order by id`)).rows;
  const fixtureRequests=()=>fetch(hg.model+'/_poc/requests').then(r=>r.json());
  const events=raw=>raw.split(/\r?\n\r?\n/).flatMap(e=>{const line=e.split(/\r?\n/).find(l=>l.startsWith('data:'));return line?[JSON.parse(line.slice(5))]:[];});
  async function log(id){for(let n=0;n<100;n++){const row=(await db.query(`select * from "${schema}".call_logs where request_id=$1`,[id])).rows[0];if(row)return row;await pause(50);}throw Error('missing call log');}
  const body=(p,prompt='POC_BASIC')=>p==='responses'?{model:'test-model',input:prompt,store:false,max_output_tokens:32}:{model:'test-model',messages:[{role:'user',content:prompt}],max_tokens:32};
  async function call(p,{purpose='personal',prompt,extra={},expected=200,mode='native',retryOf}={}){
    const requestId='protocol-'+randomUUID(),response=await fetch(gateway+'/v1/'+p,{method:'POST',headers:{'content-type':'application/json','x-request-id':requestId,...(retryOf?{'x-retry-of-request-id':retryOf}:{}),...(p==='messages'?{'x-api-key':keys[purpose],'anthropic-version':'2023-06-01'}:{authorization:'Bearer '+keys[purpose]})},body:JSON.stringify({...body(p,prompt),...extra}),signal:AbortSignal.timeout(20000)});
    const raw=await response.text();check(response.status===expected,p+' '+purpose+' '+(extra.stream?'stream':'json')+' returns '+expected);
    if(expected===200){check(response.headers.get('x-atlas-protocol-mode')===mode,p+' uses '+mode+' selected from saved probe');const saved=await log(requestId);check(saved.billable_state==='confirmed'&&Math.round(Number(saved.actual_amount)*1e6)===132,p+' authoritative usage settles 0.000132 CNY');check(saved.admission.route.serviceId===service.id&&saved.purpose===purpose,p+' retains selected source and purpose');const requests=(await fixtureRequests()).filter(r=>r.requestId===requestId);check(requests.length===1&&requests[0].protocol===(mode==='native'?p:'chat'),p+' dispatches exactly one correct protocol');check(!requests[0].hopCredentialPresent,p+' strips internal hop credential');
      if(extra.stream){const parsed=events(raw);check(parsed.at(-1).type===(p==='responses'?'response.completed':'message_stop'),p+' has proper terminal event, not DONE');check(!raw.includes('physical-model')&&!raw.includes('[DONE]'),p+' preserves logical identity');}else{const value=JSON.parse(raw);check(value.model==='test-model',p+' JSON uses logical identity');if(mode==='native')check(value.native_marker==='preserved',p+' retains provider extension');}
    }
    report.requests??=[];report.requests.push({requestId,protocol:p,purpose,httpStatus:response.status,mode});return {requestId,raw};
  }
  for(const p of ['responses','messages']){
    for(const purpose of ['personal','project','application'])await call(p,{purpose});
    const tools=p==='responses'?[{type:'function',name:'local_echo',parameters:{type:'object',properties:{text:{type:'string'}}}}]:[{name:'local_echo',input_schema:{type:'object',properties:{text:{type:'string'}}}}];
    const first=await call(p,{extra:{stream:true,tools}}),parsed=events(first.raw);
    const tool=p==='responses'?parsed.find(e=>e.type==='response.completed').response.output.find(i=>i.type==='function_call'):parsed.find(e=>e.type==='content_block_start'&&e.content_block.type==='tool_use').content_block;
    check(!!tool,p+' native streamed tool call present');
    const extra=p==='responses'?{stream:true,tools,input:[{role:'user',content:'POC_BASIC'},tool,{type:'function_call_output',call_id:tool.call_id,output:'上海'}]}:{stream:true,tools,messages:[{role:'user',content:'POC_BASIC'},{role:'assistant',content:[{type:'tool_use',id:tool.id,name:tool.name,input:{text:'上海'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:tool.id,content:'上海'}]}]};
    await call(p,{extra});
    const controller=new AbortController(),requestId='protocol-cancel-'+randomUUID();const response=await fetch(gateway+'/v1/'+p,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+keys.personal,'anthropic-version':'2023-06-01','x-request-id':requestId},body:JSON.stringify({...body(p,'POC_CANCEL'),stream:true}),signal:controller.signal});const reader=response.body.getReader();await reader.read();controller.abort();await reader.cancel().catch(()=>{});const cancelled=await log(requestId);check(cancelled.usage_final===false&&cancelled.billable_state==='pending_review',p+' cancellation preserves unknown usage and original hold');await call(p,{retryOf:requestId});
  }
  const policy=(await api('/api/v1/platform/safety/query',{})).policy;await command('guardrail.update',{expectedVersion:policy.version,mode:'block',modelIds:null,presets:['phone'],words:[],reason:'三协议隔离安全验收'});
  for(const p of ['responses','messages'])for(const purpose of ['personal','project','application']){const beforeFunds=await money(),result=await call(p,{purpose,prompt:'合成号码 13800138000',extra:{stream:true},expected:403});assert.deepEqual(await money(),beforeFunds);check(!(await fixtureRequests()).some(r=>r.requestId===result.requestId),p+' blocked '+purpose+' never forwarded');const row=await log(result.requestId);check(row.billable_state==='not_billable'&&Number(row.actual_amount)===0,p+' blocked input is zero-fee');const value=JSON.parse(result.raw);check(value.error.type==='safety_policy_violation'&&(p!=='messages'||value.type==='error'),p+' input denial uses protocol JSON envelope');}
  const current=(await api('/api/v1/platform/safety/query',{})).policy;await command('guardrail.update',{expectedVersion:current.version,mode:'off',modelIds:null,presets:[],words:[],reason:'切换回退来源验收'});
  const prior=(await state()).services.find(s=>s.id===service.id);
  await command('save.service',{...prior,baseUrl:'http://model.poc.test:4010/v1'});
  const changed=(await state()).services.find(s=>s.id===service.id);check(!changed.protocolCapabilities&&changed.verification==='unverified','connection change invalidates all saved protocol capabilities');
  const fallback=await api('/api/v1/platform/services/'+service.id+'/verify',{});check(fallback.verification==='passed','Chat-only upstream remains openable');report.fallbackProbes=fallback.protocolCapabilities;
  for(const p of ['responses','messages']){check(fallback.protocolCapabilities.mappings[service.mappings[0].definitionId][p].status==='unsupported',p+' unsupported endpoint recorded independently');await call(p,{mode:'adapted'});await call(p,{mode:'adapted',extra:{stream:true}});}
  if(sdkRoot)report.sdk.adapted=await runProtocolSdkChecks({gateway,key:keys.personal,model:'test-model',mode:'adapted',sdkRoot});
  const after=await captureDefaultState({root,db});assert.deepEqual(after,before);report.defaultPreservation={before,after};check(true,'default workspace, funds, state file and live budget unchanged');
  report.calls=(await db.query(`select request_id,purpose,billable_state,actual_amount,error_code,usage_final from "${schema}".call_logs order by completed_at`)).rows;report.success=true;
  if(process.argv.includes('--browser')){
    const webProcess=start('apps/web/node_modules/vite/bin/vite.js',['--host','127.0.0.1','--port',String(webPort),'--strictPort'],{VITE_CONTROL_PLANE_URL:cp,VITE_GATEWAY_URL:gateway,VITE_REVIEW_MODE:'true',VITE_REVIEW_STORAGE:'postgres'},resolve(root,'apps/web'));await ready(web,webProcess);
    await writeFile(resolve(directory,'session.json'),JSON.stringify({directory,schema,web,control:cp,gateway,accounts}));
    console.log(JSON.stringify({ready:true,directory,web:web+'/?ui=beacon'}));
    const expires=Date.now()+600000;
    while(!stopping&&Date.now()<expires){try{const result=JSON.parse(await readFile(resolve(directory,'finish.json'),'utf8'));if(result.success){report.browser=result;break;}report.failedBrowserAttempts??=[];report.failedBrowserAttempts.push(result);await rename(resolve(directory,'finish.json'),resolve(directory,'finish-failed-'+Date.now()+'.json'));}catch(error){if(error.code!=='ENOENT')throw error;}await pause(500);}assert.ok(report.browser?.success);
  }
}catch(error){report.success=false;report.error=secrets.reduce((s,key)=>s.replaceAll(key,'[redacted]'),error.stack??String(error));process.exitCode=1;}
finally{
  for(const child of children.toReversed())if(child.exitCode===null){child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),pause(2000)]);}
  await hg?.close();if(db){assert.match(schema,/^agp_hg_[a-f0-9]{32}$/);await db.query(`drop schema if exists "${schema}" cascade`);await db.end();}
  const output=resolve(root,'docs/validation/protocols-2026-10-30');await mkdir(output,{recursive:true});await writeFile(resolve(output,report.success?'integration.json':'failed-'+id+'.json'),JSON.stringify(report,null,2)+'\n');
  if(report.success){assert.equal(await realpath(directory),resolve(await realpath('.runtime'),'protocol-'+id));await rm(directory,{recursive:true,force:true});}
  console.log(JSON.stringify({success:report.success,checks:report.checks.length,error:report.error,output}));
}
