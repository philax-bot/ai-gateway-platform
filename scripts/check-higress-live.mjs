import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile,rename,realpath,rm,open,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {openHigress,freePort} from './lib/higress-runtime.mjs';
import {connectionConfig} from './lib/backup.mjs';
import {LiveBudget,loadLiveConfig} from './octop-live-config.mjs';
import {runPiAcceptance} from './higress/pi-acceptance.mjs';

const args=process.argv.slice(2),piCli=args[1]==='--pi'?args[2]:null;
const reuseFile=args[3]==='--reuse-pi-evidence'?args[4]:null;
const longEvidenceFile=args[5]==='--reuse-long-evidence'?args[6]:null;
assert.ok(args[0]==='--allow-upstream'&&(args.length===1||(args.length===3&&piCli)||(args.length===5&&piCli&&reuseFile)||(args.length===7&&piCli&&reuseFile&&longEvidenceFile)),'Usage: --allow-upstream [--pi <absolute Pi CLI path> [--reuse-pi-evidence <report> [--reuse-long-evidence <report>]]]; aggregate limit 22 requests / CNY 1');
const root=process.cwd(),id=randomUUID(),directory=resolve(root,'.runtime',`higress-live-${id}`),require=createRequire(resolve(root,'apps/control-plane/package.json')),{Pool}=require('pg');
const budgetFile=resolve(root,'.runtime/higress-live-budget-2026-10-29.json'),output=resolve(root,process.env.HIGRESS_LIVE_REPORT_PATH??`.runtime/higress-live-results/${id}.json`);
const schema=`agp_hg_live_${id.replaceAll('-','')}`,token=randomUUID(),password=randomUUID(),children=[],secrets=[token,password];
const report={success:false,createdAt:new Date().toISOString(),scope:{database:'isolated PostgreSQL schema',provider:'formal HigressProvider',model:'DeepSeek official; reused existing configuration',defaultWorkspaceTouched:false},checks:[],calls:[]};
const pause=ms=>new Promise(r=>setTimeout(r,ms)),check=(value,label)=>{assert.ok(value,label);report.checks.push(label);};
let hg,db,common,cp,gw,cookie='',phase='preflight',budget,live,control,gateway,key,budgetLock,authorizationExtension;
const clean=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^UPSTREAM_|^HIGRESS_|^GATEWAY_|^DATABASE_|^PGOPTIONS$|^NODE_OPTIONS$/.test(key)));
function start(file,env){const child=spawn(process.execPath,[resolve(root,file)],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...clean,...common,...env}});let out='';child.stdout.on('data',v=>out=(out+v).slice(-6000));child.stderr.on('data',v=>out=(out+v).slice(-6000));child.output=()=>out;children.push(child);return child;}
async function stop(child){if(child&&child.exitCode===null&&child.signalCode===null){child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),pause(3000)]);}}
async function ready(base,child){for(let n=0;n<150;n++){if(child.exitCode!==null)throw new Error('isolated_service_startup_failed');try{if((await fetch(base+'/health',{signal:AbortSignal.timeout(600)})).ok)return;}catch{}await pause(100);}throw new Error('isolated_service_readiness_timeout');}
async function api(path,body){const response=await fetch(cp+path,{method:body===undefined?'GET':'POST',headers:{cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(150000)});const value=await response.json();if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];assert.equal(response.status,200,`API ${path}: ${response.status}`);return value;}
const state=()=>api('/api/v1/platform/state');
async function command(type,payload){const c={type,payload,idempotencyKey:randomUUID()},preview=await api('/api/v1/platform/preview',c);return (await api('/api/v1/platform/commands',{...c,previewToken:preview.previewToken})).result;}
async function reserve(body,label){
  const extensionCheck=new LiveBudget(budget.price,22,Math.min(1,authorizationExtension.estimatedUpperBoundAtApproval+.02),budget.maxOutputTokens);extensionCheck.attempts=budget.attempts;extensionCheck.upper=budget.upper;extensionCheck.reserve(body);
  const estimate=budget.reserve(body),temporary=budgetFile+'.tmp';await writeFile(temporary,JSON.stringify({authorization:'2026-10-29: explicitly extended to 22 requests / CNY 1',authorizationExtension,price:budget.price,...budget.snapshot(),updatedAt:new Date().toISOString()}),{mode:0o600});await rename(temporary,budgetFile);report.budget=budget.snapshot();console.log(`LIVE ${budget.attempts}/22 ${label}; estimated upper CNY ${budget.upper.toFixed(6)}`);return estimate;
}
async function call(body,label){const requestId=`higress-live-${id}-${budget.attempts+1}`;await reserve(body,label);const response=await fetch(gw+'/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${key.secret}`,'content-type':'application/json','x-request-id':requestId,'idempotency-key':requestId},body:JSON.stringify({model:live.definition.modelId,...body}),signal:AbortSignal.timeout(180000)});return {requestId,response};}
async function waitLog(id){for(let n=0;n<100;n++){const log=(await state()).callLogs.find(l=>l.requestId===id);if(log)return log;await pause(150);}throw new Error('missing_live_call_log');}
try{
  await mkdir(directory,{recursive:true});await writeFile(resolve(directory,'empty.env'),'');live=await loadLiveConfig(root);secrets.push(live.credential);
  if(piCli)await realpath(piCli);
  budgetLock=await open(budgetFile+'.lock','wx',0o600);await budgetLock.writeFile(JSON.stringify({pid:process.pid,id}));
  const price={inputPrice:live.mapping.inputPrice,outputPrice:live.mapping.outputPrice,cachedInputPrice:live.mapping.cachedInputPrice};budget=new LiveBudget(price,22,1,piCli?8192:1024);
  const prior=JSON.parse(await readFile(budgetFile,'utf8'));assert.deepEqual(prior.price,price,'configured prices changed within this authorization');assert.ok([20,22].includes(prior.maxRequests));assert.equal(prior.maxEstimatedAmount,1);budget.attempts=prior.attempts;budget.upper=prior.estimatedUpperBound;assert.ok(Number.isSafeInteger(budget.attempts)&&budget.attempts>=0&&budget.attempts<=prior.maxRequests&&Number.isFinite(budget.upper)&&budget.upper>=0&&budget.upper<=1);
  authorizationExtension=prior.authorizationExtension??{authorizedBy:'explicit user reply: allow 22 total requests, total CNY 1',previousAuthorization:prior.authorization,previousMaxRequests:20,attemptsAtApproval:prior.attempts,estimatedUpperBoundAtApproval:prior.estimatedUpperBound,additionalRequests:2,additionalEstimatedAmount:.02};
  assert.equal(authorizationExtension.attemptsAtApproval,20);assert.equal(authorizationExtension.additionalRequests,2);assert.equal(authorizationExtension.additionalEstimatedAmount,.02);assert.ok(Number.isFinite(authorizationExtension.estimatedUpperBoundAtApproval)&&authorizationExtension.estimatedUpperBoundAtApproval<=budget.upper);
  report.authorizationExtension=authorizationExtension;
  report.budgetAtStart=budget.snapshot();report.priceSnapshot=price;
  let reuse,reuseLong;
  if(reuseFile){const raw=await readFile(reuseFile,'utf8');reuse=JSON.parse(raw);assert.deepEqual(reuse.priceSnapshot,price);assert.ok(reuse.checks?.includes('real DeepSeek connection verification passes through formal HigressProvider')&&reuse.pi?.coding?.exitCode===0&&reuse.pi.independentTests?.passed&&reuse.pi.originalConfigurationsUnchanged);assert.equal(live.service.verification,'passed');report.reusedEvidence={file:resolve(reuseFile),sha256:createHash('sha256').update(raw).digest('hex'),scope:'previous actual Pi coding and connection verification; copied existing verified service configuration into this isolated schema'};}
  if(longEvidenceFile){const raw=await readFile(longEvidenceFile,'utf8');reuseLong=JSON.parse(raw);assert.deepEqual(reuseLong.priceSnapshot,price);const wire=reuseLong.pi?.requests?.find(r=>r.phase==='long');assert.ok(reuseLong.pi.long?.exitCode===0&&reuseLong.pi.long.finalMarkerMatched&&reuseLong.pi.long.stopReason==='stop'&&wire?.done&&wire.finishReason==='stop'&&wire.usage&&wire.generationSpanMs>30000&&reuseLong.pi.originalConfigurationsUnchanged&&reuseLong.higressDiagnostics?.gateway?.includes(wire.requestId));report.reusedLongEvidence={file:resolve(longEvidenceFile),sha256:createHash('sha256').update(raw).digest('hex'),scope:'completed long stream; original scenario-mention counting assertion is retained as failed'};}
  assert.ok(budget.maxRequests-budget.attempts>=(piCli?(reuseLong?2:reuse?3:8):8),'authorized request budget exhausted or insufficient for this acceptance phase');
  const {connectionString}=await connectionConfig();db=new Pool({connectionString,connectionTimeoutMillis:5000});await db.query(`create schema "${schema}"`);
  hg=await openHigress({root,directory:resolve(directory,'runtime')});secrets.push(hg.state.proxyToken,hg.state.apiToken);
  const controlPort=await freePort(),gatewayPort=await freePort();cp=`http://127.0.0.1:${controlPort}`;gw=`http://127.0.0.1:${gatewayPort}`;
  common={PLATFORM_MODE:'development',HOST:'127.0.0.1',DOTENV_CONFIG_PATH:resolve(directory,'empty.env'),NODE_OPTIONS:'',STORE_MODE:'postgres',DATABASE_URL:connectionString,DATABASE_SCHEMA:schema,PGOPTIONS:'',REDIS_URL:'',BOOTSTRAP_TOKEN:'',SERVICE_TOKEN:token,MAINTENANCE_DISABLED:'true',ALLOW_UPSTREAM_VALIDATION:'true',ALLOW_UPSTREAM_REQUESTS:'true',...hg.environment};
  control=start('apps/control-plane/dist/main.js',{PORT:String(controlPort),UPSTREAM_VALIDATION_TIMEOUT_MS:'120000',[live.service.credentialRef]:live.credential});await ready(cp,control);
  gateway=start('services/gateway-sim/dist/server.js',{PORT:String(gatewayPort),CONTROL_PLANE_URL:cp,GATEWAY_JOURNAL_DIR:resolve(directory,'journal'),UPSTREAM_TIMEOUT_MS:'180000',UPSTREAM_FIRST_BYTE_TIMEOUT_MS:'120000',UPSTREAM_IDLE_TIMEOUT_MS:'60000'});await ready(gw,gateway);
  await api('/api/v1/auth/setup',{directoryId:'higress-live',name:'Higress 真实验收',password});await api('/api/v1/auth/login',{directoryId:'higress-live',password});
  if(reuse){
    // Fixture import from the read-only, already verified development configuration.
    // This is confined to the new test schema and is not a new verification outcome.
    await db.query(`update "${schema}".platform_workspace set payload=jsonb_set(jsonb_set(payload,'{definitions}',(payload->'definitions')||$1::jsonb),'{services}',(payload->'services')||$2::jsonb) where id='org-demo'`,[JSON.stringify([live.definition]),JSON.stringify([live.service])]);
  }
  if(piCli)await command('settings.update',{limits:{mode:'custom',rpm:60,concurrency:2,maxOutputTokens:8192}});
  const actor=(await state()).actor,definition=reuse?live.definition:await command('save.definition',{...live.definition,id:undefined});
  const service=reuse?live.service:await command('save.service',{name:'Higress DeepSeek 真实验收',baseUrl:live.service.baseUrl,credentialRef:live.service.credentialRef,active:true,limits:{mode:'custom',maxOutputTokens:piCli?8192:1024,concurrency:2,rpm:60},mappings:[{...live.mapping,definitionId:definition.id}]});
  phase='zero-generation runtime readiness';
  const prepared=await fetch(cp+'/internal/v1/gateway-sync/reconcile',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(90000)}).then(r=>r.json());
  report.runtimePreparation=prepared;
  const targetResource=`route-${createHash('sha256').update(JSON.stringify([service.id,definition.id])).digest('hex').slice(0,32)}`;
  if(prepared.routes?.find(r=>r.resourceId===targetResource)?.status!=='applied'){
    report.configurationOperations=(await db.query(`select payload->'latest' as latest from "${schema}".gateway_sync_state`)).rows;
    const ingresses=await fetch(hg.api+'/apis/networking.k8s.io/v1/namespaces/higress-system/ingresses',{headers:{authorization:`Bearer ${hg.state.apiToken}`}}).then(r=>r.json());
    report.runtimeReadiness=await Promise.all((ingresses.items??[]).filter(i=>/^atlas-[a-f0-9]{32}$/.test(i.metadata?.name??'')).map(async i=>({route:i.metadata.name,...await fetch(hg.api+'/runtime/ready/'+i.metadata.name,{headers:{authorization:`Bearer ${hg.state.apiToken}`}}).then(r=>r.json())})));
    const diagnostic=`const http=require('node:http'),net=require('node:net');http.get('http://127.0.0.1:15000/clusters?format=json',res=>{let raw='';res.on('data',c=>raw+=c);res.on('end',async()=>{const clusters=JSON.parse(raw).cluster_statuses.filter(c=>c.name.includes('atlas-'));const result=[];for(const c of clusters){const hosts=[];for(const host of c.host_statuses??[]){const address=host.address?.socket_address;if(!address)continue;const connected=await new Promise(resolve=>{const s=net.connect({host:address.address,port:Number(address.port_value),timeout:1500});let done=false;const finish=code=>{if(done)return;done=true;s.destroy();resolve(code);};s.on('connect',()=>finish('connected'));s.on('error',e=>finish(e.code));s.on('timeout',()=>finish('timeout'));});hosts.push({address,health:host.health_status,connected});}result.push({name:c.name,hosts});}console.log(JSON.stringify(result));});});`;
    const diagnosticResult=await hg.run(['exec',hg.name+'-management','node','-e',diagnostic],{allowFailure:true});
    try{report.runtimeClusterDiagnostics=JSON.parse(diagnosticResult.out);}catch{report.runtimeClusterDiagnostics={available:false};}
    throw Error('zero_generation_runtime_not_ready');
  }
  check(true,'zero-generation readiness confirms the actual Higress route before reserving a real request');
  if(!reuse){phase='real provider verification';await reserve({messages:[{role:'user',content:'Connection validation'}],max_tokens:1},'diagnostic verification');
  const verified=await api(`/api/v1/platform/services/${service.id}/verify`,{idempotencyKey:'higress-live-verification-'+id});report.verification=verified.verificationRun?.results?.map(r=>({outcome:r.outcome,httpStatus:r.httpStatus,errorCode:r.errorCode,usage:r.usage,cost:r.cost}));check(verified.verification==='passed','real DeepSeek connection verification passes through formal HigressProvider');
  }else{report.verificationReused=true;report.verification=reuse.verification;}
  const pool=await command('save.pool',{name:'Higress 真实验收池',entries:[{definitionId:definition.id,serviceId:service.id,open:true}]});
  const plan=await command('save.plan',{name:'Higress 真实验收预算',range:{poolId:pool.id,mode:'follow',definitionIds:[]},amount:1,cadence:'once',quotaDays:1,entitlementDays:1});await command('distribution.execute',{planId:plan.id,memberIds:[actor.id]});key=await command('key.issue',{name:'Higress 真实验收 Key',purpose:'personal'});secrets.push(key.secret);
  if(piCli){
    phase='actual Pi coding, long stream and cancellation';
    await runPiAcceptance({root,directory,piCli,gw,key:key.secret,model:live.definition.modelId,reserve,budget,check,report,waitLog,hg,reuse,reuseLong});
  }else{
  phase='real protocol and tool round trip';
  let result=await call({messages:[{role:'developer',content:[{type:'text',text:'Reply with exactly HIGRESS_OK.'}]},{role:'user',content:'Confirm the gateway integration.'}],max_completion_tokens:128},'non-stream compatibility');
  let value=await result.response.json();report.nonStreamStatus=result.response.status;check(result.response.ok&&value.model===live.definition.modelId&&!!value.usage,'real non-stream response, logical model and usage are preserved');await waitLog(result.requestId);
  const tool={type:'function',function:{name:'local_echo',description:'Return the given text unchanged.',parameters:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}}};
  const messages=[{role:'user',content:'Call local_echo exactly once with text HIGRESS_TOOL_OK. After its result, reply with exactly that result.'}];
  result=await call({messages,tools:[tool],max_tokens:512},'tool request');value=await result.response.json();check(result.response.ok&&value.choices?.[0].message.tool_calls?.some(t=>t.function.name==='local_echo'),'real DeepSeek emits a tool call through Higress');await waitLog(result.requestId);
  const assistant=value.choices[0].message,toolCalls=assistant.tool_calls;for(const t of toolCalls)assert.equal(t.function.name,'local_echo');
  result=await call({messages:[...messages,assistant,...toolCalls.map(t=>({role:'tool',tool_call_id:t.id,content:JSON.parse(t.function.arguments).text}))],tools:[tool],max_tokens:512},'tool result');value=await result.response.json();check(result.response.ok&&value.choices?.[0].message.content?.includes('HIGRESS_TOOL_OK'),'real model consumes the tool result and completes the round trip');await waitLog(result.requestId);
  phase='real cache and stream';
  const prefix=Array.from({length:144},(_,n)=>`Reference ${String(n).padStart(4,'0')}: identical cache validation prefix, keep this content unchanged.`).join('\n');
  for(let n=0;n<2;n++){result=await call({messages:[{role:'system',content:'Reply exactly CACHE_OK.'},{role:'user',content:prefix+'\nReturn CACHE_OK.'}],max_tokens:128},'cache sample '+(n+1));value=await result.response.json();check(result.response.ok&&!!value.usage,'real cache sample '+(n+1)+' returns usage');await waitLog(result.requestId);}
  const started=Date.now();result=await call({messages:[{role:'user',content:'Write a numbered list of 100 careful software testing tips, each with a sentence of explanation.'}],max_tokens:1024,stream:true},'completed SSE');const raw=await result.response.text();check(result.response.ok&&raw.includes('data: [DONE]')&&raw.includes(`"model":"${live.definition.modelId}"`),'real SSE completes with the logical model');report.stream={durationMs:Date.now()-started};await waitLog(result.requestId);
  phase='real cancellation';result=await call({messages:[{role:'user',content:'Write 100 detailed numbered tips about reliable software testing.'}],max_tokens:1024,stream:true},'cancelled SSE');check(result.response.ok,'real cancellation stream opens');const reader=result.response.body.getReader();await reader.read();await reader.cancel();const cancelled=await waitLog(result.requestId);check(cancelled.billableState==='pending_review'&&!cancelled.usageFinal,'cancelled real usage without final evidence stays pending review');
  }
  const final=await state(),logs=final.callLogs.filter(l=>l.subjectId===actor.id),batches=final.quotaBatches.filter(b=>b.sourceId===actor.id);
  report.calls=logs.map(l=>({requestId:l.requestId,upstreamRequestId:l.upstreamRequestId,retryOfRequestId:l.retryOfRequestId,outcome:l.outcome,forwarded:l.forwarded,usageFinal:l.usageFinal,billableState:l.billableState,inputTokens:l.inputTokens,outputTokens:l.outputTokens,cachedInputTokens:l.cachedInputTokens,amount:l.actualAmount,latencyMs:l.latencyMs,ttftMs:l.ttftMs,admission:l.admission}));
  if(!piCli)check(logs.some(l=>l.cachedInputTokens>0),'real cached-token usage is observed and persisted');
  const available=batches.reduce((s,b)=>s+b.availableAmount,0),confirmed=logs.filter(l=>l.billableState==='confirmed').reduce((s,l)=>s+l.actualAmount,0),held=logs.filter(l=>l.billableState==='pending_review').reduce((s,l)=>s+(l.admission?.reservedAmount??0),0);
  report.accounting={originalAmount:1,available,confirmed,held};check(Math.abs(1-available-confirmed-held)<1e-7,'real PostgreSQL funds reconcile with confirmed costs and cancellation holds');
  report.ledger=(await db.query(`select request_id,count(*)::int as entries from "${schema}".usage_ledger_entries where kind='settlement' and request_id=any($1::text[]) group by request_id`,[logs.map(l=>l.requestId)])).rows;
  check(logs.every(l=>report.ledger.filter(r=>r.request_id===l.requestId).reduce((s,r)=>s+r.entries,0)===(l.billableState==='confirmed'?1:0)),'each final usage has exactly one settlement and unknown cancellation has none');
  check(logs.filter(l=>l.billableState==='confirmed').every(l=>Math.round(l.actualAmount*1e6)===Math.round((l.inputTokens-l.cachedInputTokens)*price.inputPrice+l.cachedInputTokens*price.cachedInputPrice+l.outputTokens*price.outputPrice)),'persisted real usage reconciles exactly with the original configured price');
  const configurations=(await db.query(`select payload from "${schema}".gateway_sync_state`)).rows;check(!secrets.some(s=>JSON.stringify(configurations).includes(s)),'real configuration operation records contain no plaintext credentials');
  report.outbox=await fetch(gw+'/health').then(r=>r.json()).then(v=>v.outbox);check(report.outbox.queued===0&&report.outbox.blocked===0&&report.outbox.writePending===0,'real settlement outbox is drained');report.success=true;
}catch(error){
  report.error={phase,message:secrets.reduce((s,key)=>s.replaceAll(key,'[redacted]'),error.message)};console.error(report.error);process.exitCode=1;
  if(key&&db&&cp){try{
    const snapshot=await state(),logs=snapshot.callLogs.filter(l=>l.subjectId===snapshot.actor.id),batches=snapshot.quotaBatches.filter(b=>b.sourceId===snapshot.actor.id);
    report.calls=logs.map(l=>({requestId:l.requestId,retryOfRequestId:l.retryOfRequestId,billableState:l.billableState,usageFinal:l.usageFinal,outcome:l.outcome,inputTokens:l.inputTokens,outputTokens:l.outputTokens,cachedInputTokens:l.cachedInputTokens,amount:l.actualAmount,reservedAmount:l.admission?.reservedAmount}));
    report.accounting={originalAmount:1,available:batches.reduce((s,b)=>s+b.availableAmount,0),confirmed:logs.filter(l=>l.billableState==='confirmed').reduce((s,l)=>s+l.actualAmount,0),held:logs.filter(l=>l.billableState==='pending_review').reduce((s,l)=>s+(l.admission?.reservedAmount??0),0)};
    report.ledger=(await db.query(`select request_id,count(*)::int as entries from "${schema}".usage_ledger_entries where kind='settlement' and request_id=any($1::text[]) group by request_id`,[logs.map(l=>l.requestId)])).rows;
    report.outbox=await fetch(gw+'/health').then(r=>r.json()).then(v=>v.outbox);report.accountingSnapshotAfterFailure=true;
  }catch{report.accountingSnapshotAfterFailure=false;}}
}
finally{
  for(const child of children.toReversed())await stop(child);
  if(hg&&!report.success){report.higressDiagnostics={};for(const file of ['gateway','controller']){const result=await hg.run(['exec',hg.name+'-gateway','tail','-c','7000',`/var/log/higress/${file}.log`],{allowFailure:true});report.higressDiagnostics[file]=secrets.reduce((text,key)=>text.replaceAll(key,'[redacted]'),result.out);}}
  await hg?.close();
  if(db){if(/^agp_hg_live_[a-f0-9]{32}$/.test(schema))await db.query(`drop schema "${schema}" cascade`);await db.end();}
  report.budget=budget?.snapshot();report.completedAt=new Date().toISOString();await mkdir(resolve(root,'.runtime/higress-live-results'),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
  if(budgetLock){await budgetLock.close();await unlink(budgetFile+'.lock');}
  if(report.success){assert.equal(await realpath(directory),resolve(await realpath(resolve(root,'.runtime')),`higress-live-${id}`));await rm(directory,{recursive:true,force:true});}
  console.log(JSON.stringify({success:report.success,checks:report.checks.length,budget:report.budget,output}));
}
