import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {dirname,resolve,sep,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {availableParallelism,cpus,totalmem,platform,arch} from 'node:os';

const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2);
const postgres=args.includes('--postgres');if(postgres)args.splice(args.indexOf('--postgres'),1);
function option(name,fallback){const index=args.indexOf(name);if(index<0)return fallback;const value=args[index+1];args.splice(index,2);return value;}
const concurrency=Number(option('--concurrency','4')),durationSeconds=Number(option('--duration','0')),requests=Number(option('--requests',durationSeconds?'2000':'48')),users=Number(option('--users','1')),out=option('--out',null);
assert.ok(!args.length&&Number.isInteger(concurrency)&&concurrency>=1&&concurrency<=64&&Number.isInteger(requests)&&requests>=concurrency&&requests<=2000&&Number.isInteger(users)&&users>=1&&users<=32&&users<=requests&&Number.isInteger(durationSeconds)&&durationSeconds>=0&&durationSeconds<=300,'Use --concurrency 1..64 --requests concurrency..2000 --users 1..32 --duration 0..300 [--postgres] [--out FILE]');
const children=[],runId=randomUUID().replaceAll('-',''),runtime=resolve(root,'.runtime'),directory=resolve(runtime,`load-${runId}`);
const outputPath=resolve(root,out??`.runtime/load-results/${new Date().toISOString().replace(/[:.]/g,'-')}-${postgres?'postgres':'memory'}.json`);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let db,schema,created=false,sampleTimer,lastSample=Promise.resolve(),sampling=false;
const report={success:false,createdAt:new Date().toISOString(),environment:{node:process.version,platform:platform(),arch:arch(),cpu:cpus()[0]?.model,logicalCpus:availableParallelism(),memoryGiB:Math.round(totalmem()/1073741824),revision:spawnSync('git',['rev-parse','--short','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).stdout.trim(),dirty:!!spawnSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8',windowsHide:true}).stdout.trim(),store:postgres?'isolated PostgreSQL schema':'isolated memory',network:'local control plane/gateway/model; PostgreSQL uses the configured development endpoint',model:'repository deterministic HTTP stand-in; 13 input / 14 output / 4 cached tokens',scope:`single instance, ${users} managed users with one quota batch each; not production or real-model capacity`},workload:{requestLimit:requests,durationSeconds,users,concurrency,streamEvery:3,adminEvery:8},database:{samples:0,sampleFailures:0,maxClients:0,maxLockWaiters:0,waitEvents:{}}};
async function freePort(){const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
function start(file,env){
  const clean=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('UPSTREAM_')&&!key.startsWith('GATEWAY_')));
  const child=spawn(process.execPath,[file],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...clean,DOTENV_CONFIG_PATH:resolve(directory,'unused.env'),PLATFORM_MODE:'development',STORE_MODE:'memory',HOST:'127.0.0.1',DATABASE_URL:'',DATABASE_SCHEMA:'',PGOPTIONS:'',REDIS_URL:'',BOOTSTRAP_TOKEN:'',ALLOW_UPSTREAM_REQUESTS:'false',ALLOW_UPSTREAM_VALIDATION:'false',MAINTENANCE_DISABLED:'true',...env}});
  let output='';child.stdout.on('data',data=>output=(output+data).slice(-3000));child.stderr.on('data',data=>output=(output+data).slice(-3000));child.diagnostic=()=>output;children.push(child);return child;
}
async function ready(url,child){for(let i=0;i<150;i++){if(child.exitCode!==null)throw new Error(`isolated service failed to start: ${child.diagnostic()}`);try{if((await fetch(url,{signal:AbortSignal.timeout(500)})).ok)return;}catch{}await pause(100);}throw new Error('isolated service startup timed out');}
function distribution(values){const sorted=[...values].sort((a,b)=>a-b),at=p=>sorted.length?Math.round(sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)]*100)/100:null;return {samples:values.length,p50:at(.5),p95:at(.95),p99:at(.99),max:sorted.length?Math.round(sorted.at(-1)*100)/100:null};}

try{
  await mkdir(runtime,{recursive:true});assert.ok((await realpath(runtime)).startsWith((await realpath(root))+sep));await mkdir(directory);
  const [cpPort,gwPort,modelPort]=await Promise.all([freePort(),freePort(),freePort()]);
  const cp=`http://127.0.0.1:${cpPort}`,gw=`http://127.0.0.1:${gwPort}`,model=`http://127.0.0.1:${modelPort}`,serviceToken=`load-${randomUUID()}`;
  const diagnostics=()=>fetch(`${cp}/internal/v1/diagnostics/hot-path`,{headers:{authorization:`Bearer ${serviceToken}`},signal:AbortSignal.timeout(1000)}).then(response=>response.json());
  let dbEnv={};
  if(postgres){
    const require=createRequire(resolve(root,'apps/control-plane/package.json')),{Pool}=require('pg');
    let connectionString=process.env.DATABASE_URL;
    if(!connectionString){const {parse}=require('dotenv');connectionString=parse(await readFile(resolve(root,'apps/control-plane/.env'))).DATABASE_URL;}
    assert.ok(connectionString,'DATABASE_URL is required for the isolated PostgreSQL load check');
    db=new Pool({connectionString,connectionTimeoutMillis:5000,max:2});schema=`agp_load_${runId}`;await db.query(`create schema "${schema}"`);created=true;
    dbEnv={STORE_MODE:'postgres',DATABASE_URL:connectionString,DATABASE_SCHEMA:schema,PGAPPNAME:schema};
  }
  const control=start('apps/control-plane/dist/main.js',{...dbEnv,PORT:String(cpPort),SERVICE_TOKEN:serviceToken,CONTROL_PLANE_DIAGNOSTICS:'true'});await ready(`${cp}/health`,control);
  const mock=start('postman/mocks/test-model/default.js',{PORT:String(modelPort)});await ready(`${model}/health`,mock);
  const gateway=start('services/gateway-sim/dist/server.js',{PORT:String(gwPort),CONTROL_PLANE_URL:cp,MODEL_URL:model,SERVICE_TOKEN:serviceToken,UPSTREAM_TIMEOUT_MS:'15000',GATEWAY_JOURNAL_DIR:resolve(directory,'journal')});await ready(`${gw}/health`,gateway);
  async function request(path,body,cookie=''){
    const response=await fetch(`${cp}${path}`,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(cookie?{cookie}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
    const value=await response.json();assert.equal(response.status,200,`isolated fixture API failed: ${path} (${response.status})`);return {body:value,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  const password=`load-${randomUUID()}`;await request('/api/v1/auth/setup',{directoryId:'load-admin',name:'隔离负载运营',password});
  const admin=(await request('/api/v1/auth/login',{directoryId:'load-admin',password})).cookie;
  const state=async()=>(await request('/api/v1/platform/state',null,admin)).body;
  async function command(type,payload,cookie=admin){const c={type,payload,idempotencyKey:randomUUID()},preview=await request('/api/v1/platform/preview',c,cookie);return (await request('/api/v1/platform/commands',{...c,previewToken:preview.body.previewToken},cookie)).body.result;}
  await command('settings.update',{limits:{mode:'custom',rpm:100000,tpm:1000000000,concurrency:Math.max(concurrency,5),maxOutputTokens:128}});
  const initial=await state(),service=initial.services[0],pool=initial.pools[0];
  await command('save.service',{...service,baseUrl:model,credentialRef:null,mappings:service.mappings.map(mapping=>({...mapping,inputPrice:1,outputPrice:2,cachedInputPrice:.5}))});
  assert.equal((await request(`/api/v1/platform/services/${service.id}/verify`,{},admin)).body.verification,'passed');
  await command('save.pool',{...pool,entries:pool.entries.map(entry=>({...entry,open:true}))});
  const range={poolId:pool.id,mode:'follow',definitionIds:[]};
  const plan=await command('save.plan',{name:'隔离负载方案',range,amount:10,cadence:'once',quotaDays:30,entitlementDays:30});
  const actors=[];
  for(let index=0;index<users;index++){
    const directoryId=`load-member-${index}`;
    const member=await command('save.member',{name:`隔离负载用户 ${index+1}`,directoryId,password,organizationId:'department-engineering',category:'employee',roles:['employee'],tags:[]});
    await command('distribution.execute',{planId:plan.id,memberIds:[member.id]});
    const memberCookie=(await request('/api/v1/auth/login',{directoryId,password})).cookie;
    const key=await command('key.issue',{name:'隔离负载密钥',purpose:'personal'},memberCookie);actors.push({id:member.id,key:key.secret});
  }
  const actorIds=new Set(actors.map(actor=>actor.id)),balance=s=>s.quotaBatches.filter(batch=>actorIds.has(batch.sourceId)).reduce((sum,batch)=>sum+Math.round(batch.availableAmount*1e6),0);
  const beforeState=await state(),before=balance(beforeState);
  const configuredService=beforeState.services.find(item=>item.id===service.id);assert.equal(configuredService.baseUrl,model);assert.equal(configuredService.credentialRef,null);
  const checkpoint=(await diagnostics()).completed,mockBefore=(await fetch(`${model}/_test/stats`).then(response=>response.json())).totalRequests;
  report.environment.upstream={modelId:'test-model',implementation:'postman/mocks/test-model/default.js',engine:'deterministic-local-http',allowUpstreamRequests:false,allowUpstreamValidation:false,modelInference:false};
  report.workload.diagnosticsCheckpoint=checkpoint;
  if(db){
    const policyExpression=createRequire(resolve(root,'apps/control-plane/package.json'))(resolve(root,'apps/control-plane/dist/store/admission-policy-lock.js')).ADMISSION_POLICY_SQL;
    report.database.workspaceSize=(await db.query(`select octet_length(payload::text) as full_bytes,
      octet_length((payload-array['monitoring','notifications','sessions','audit','operations','retention']::text[])::text) as policy_bytes,
      octet_length((${policyExpression})::text) as admission_bytes
      from "${schema}".platform_workspace where id='org-demo'`)).rows[0];
    const sample=()=>{if(sampling)return;sampling=true;lastSample=(async()=>{try{
      const rows=(await db.query(`select a.pid,a.state,a.query,a.backend_xid::text as xid,pg_blocking_pids(a.pid) as blockers,extract(epoch from clock_timestamp()-a.xact_start)*1000 as age_ms,extract(epoch from clock_timestamp()-a.query_start)*1000 as query_age_ms,a.wait_event_type,a.wait_event,
        (select count(*)::int from pg_stat_activity b where b.pid=any(pg_blocking_pids(a.pid)) and b.application_name<>$1) as external_blockers
        from pg_stat_activity a where a.application_name=$1`,[schema])).rows;
      report.database.samples++;report.database.maxClients=Math.max(report.database.maxClients,rows.length);report.database.maxLockWaiters=Math.max(report.database.maxLockWaiters,rows.filter(row=>row.wait_event_type==='Lock').length);
      report.database.externalBlockerSamples=(report.database.externalBlockerSamples??0)+rows.reduce((sum,row)=>sum+row.external_blockers,0);
      const graph=()=>rows.map(({query,...row})=>({pid:row.pid,state:row.state,waitType:row.wait_event_type,wait:row.wait_event,xid:row.xid,ageMs:Math.round(Number(row.age_ms??0)),queryAgeMs:Math.round(Number(row.query_age_ms??0)),blockers:row.blockers,command:/^\s*(\w+)/.exec(query)?.[1]?.toLowerCase()??'other',rowLock:/\bfor\s+update\b/i.test(query)?'update':/\bfor\s+share\b/i.test(query)?'share':null,stage:['platform_workspace','quota_batches','gateway_lock_keys','reservations','admission_windows','reservation_limit_scopes','call_logs'].find(stage=>query.includes(stage))??(query==='commit'?'commit':'other')}));
      const age=Math.max(0,...rows.map(row=>Number(row.age_ms??0))),waitAge=Math.max(0,...rows.filter(row=>row.state==='active'&&row.wait_event_type==='Lock').map(row=>Number(row.query_age_ms??0)));
      if(age>(report.database.maxTransactionAgeMs??0)){report.database.maxTransactionAgeMs=Math.round(age);report.database.graphAtMax=graph();}
      if(waitAge>(report.database.maxQueryLockWaitMs??0)){
        report.database.maxQueryLockWaitMs=Math.round(waitAge);report.database.blockingGraph=graph();
        if(waitAge>=1000)try{const live=await diagnostics();report.database.activeAtMaxWait=live.active;}catch{report.database.traceCaptureFailures=(report.database.traceCaptureFailures??0)+1;}
      }
      for(const row of rows){const key=row.wait_event_type?`${row.wait_event_type}:${row.wait_event}`:'running';report.database.waitEvents[key]=(report.database.waitEvents[key]??0)+1;}
    }catch{report.database.sampleFailures++;}})().finally(()=>{sampling=false;});};sample();sampleTimer=setInterval(sample,250);
  }
  const latencies=[],streamLatencies=[],plainLatencies=[],ttft=[],adminLatencies=[],errors={},ids=[];let next=0,successes=0;
  const began=performance.now();
  await Promise.all(Array.from({length:concurrency},async()=>{for(;;){const index=next++;if(index>=requests||(durationSeconds&&performance.now()-began>=durationSeconds*1000))return;const id=`load-${runId}-${index}`,actor=actors[index%actors.length];ids.push(id);
    try{
      if(index%8===0){const beganAdmin=performance.now();await request('/api/v1/platform/state',null,admin);await request('/api/v1/platform/maintenance/run',{},admin);adminLatencies.push(performance.now()-beganAdmin);}
      const stream=index%3===0,beganCall=performance.now();
      const response=await fetch(`${gw}/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${actor.key}`,'content-type':'application/json','x-request-id':id,'idempotency-key':id},body:JSON.stringify({model:'test-model',messages:[{role:'user',content:'isolated capacity fixture'}],max_tokens:32,stream,test_scenario:'cached'}),signal:AbortSignal.timeout(30000)});
      const raw=await response.text();const duration=performance.now()-beganCall;latencies.push(duration);(stream?streamLatencies:plainLatencies).push(duration);
      if(response.status!==200){let type='unknown';try{const value=JSON.parse(raw).error?.type;if(typeof value==='string'&&/^[a-z0-9_]{1,64}$/.test(value))type=value;}catch{}throw new Error(`HTTP_${response.status}:${type}`);}if(stream)assert.ok(raw.endsWith('data: [DONE]\n\n'),'STREAM_INCOMPLETE');else assert.ok(JSON.parse(raw).usage,'USAGE_MISSING');successes++;
    }catch(error){const adminFailure=/isolated fixture API failed: (\/api\/v1\/platform\/(?:state|maintenance\/run)) \((\d+)\)/.exec(error.message),category=/^(HTTP_\d+:[a-z0-9_]+|STREAM_INCOMPLETE|USAGE_MISSING)$/.test(error.message)?error.message:adminFailure?`ADMIN_HTTP_${adminFailure[2]}`:'request_failed';errors[category]=(errors[category]??0)+1;}
  }}));
  const durationMs=performance.now()-began;if(sampleTimer)clearInterval(sampleTimer);await lastSample;
  const drainBegan=performance.now();let outbox;
  for(let attempt=0;attempt<150;attempt++){
    outbox=(await fetch(`${gw}/health`).then(response=>response.json())).outbox;
    if(outbox.blocked||outbox.queued+outbox.active===0)break;
    await pause(100);
  }
  const afterState=await state(),after=balance(afterState),actualRequests=ids.length;
  const logs=[];
  for(const actor of actors){let page=(await request('/api/v1/platform/calls/query',{subjectId:actor.id,limit:200},admin)).body;logs.push(...page.items);while(page.nextCursor){page=(await request('/api/v1/platform/calls/query',{subjectId:actor.id,limit:200,cursor:page.nextCursor},admin)).body;logs.push(...page.items);}}
  for(const log of logs)if(log.ttftMs!=null)ttft.push(log.ttftMs);
  report.hotPath=await fetch(`${cp}/internal/v1/diagnostics/hot-path?after=${checkpoint}`,{headers:{authorization:`Bearer ${serviceToken}`}}).then(response=>response.json());
  report.upstream={...(await fetch(`${model}/_test/stats`).then(response=>response.json())),workloadRequests:0};report.upstream.workloadRequests=report.upstream.totalRequests-mockBefore;
  const inspected=await fetch(`${gw}/internal/v1/outbox`,{headers:{authorization:`Bearer ${serviceToken}`}}).then(response=>response.json());
  const actorBalances=actors.map((actor,index)=>{
    const funds=s=>s.quotaBatches.filter(batch=>batch.sourceId===actor.id).reduce((sum,batch)=>sum+Math.round(batch.availableAmount*1e6),0),calls=logs.filter(log=>log.subjectId===actor.id&&log.billableState==='confirmed').length;
    return {actor:index+1,confirmedCalls:calls,chargedMicros:funds(beforeState)-funds(afterState),expectedChargedMicros:calls*39};
  });
  report.results={durationMs:Math.round(durationMs),drainMs:Math.round(performance.now()-drainBegan),stopReason:actualRequests===requests?'request_limit':'duration',requests:actualRequests,successfulRequests:successes,errors,errorRate:(actualRequests-successes)/actualRequests,requestsPerSecond:Math.round(actualRequests*1000/durationMs*100)/100,latencyMs:distribution(latencies),streamLatencyMs:distribution(streamLatencies),nonStreamLatencyMs:distribution(plainLatencies),ttftMs:distribution(ttft),adminLatencyMs:distribution(adminLatencies),confirmedCalls:logs.filter(log=>log.billableState==='confirmed').length,pendingReview:logs.filter(log=>log.billableState==='pending_review').length,confirmedAmount:logs.filter(log=>log.billableState==='confirmed').reduce((sum,log)=>sum+Math.round(log.actualAmount*1e6),0)/1e6,quotaBefore:before/1e6,quotaAfter:after/1e6,chargedMicros:before-after,expectedChargedMicros:actualRequests*39,actorBalances,outbox};
  report.results.outboxItems=inspected.items;
  report.gatewayEvents=children.flatMap(child=>child.diagnostic().split(/\r?\n/).flatMap(line=>{try{const event=JSON.parse(line);return event.event==='settlement_journal_failed'?[{event:event.event,requestId:event.requestId,causeCode:event.causeCode??null,errorName:event.errorName??null}]:[];}catch{return [];}}));
  const categories=/deadlock detected|timeout exceeded when trying to connect|Connection terminated due to connection timeout|too many clients|could not serialize access/gi;
  report.serviceFailureCategories=[...new Set(children.flatMap(child=>child.diagnostic().match(categories)??[]))];
  if(db){const row=(await db.query(`select (select count(*)::int from "${schema}".usage_ledger_entries where kind='settlement') as ledger,(select count(*)::int from "${schema}".reservations where finalized=false) as unfinished,(select count(*)::int from "${schema}".reservation_limit_scopes where active=true) as active_scopes`)).rows[0];report.results.ledgerEntries=row.ledger;report.results.unfinishedReservations=row.unfinished;report.results.activeLimitScopes=row.active_scopes;}
  assert.equal(successes,actualRequests,'all requests must complete');assert.equal(logs.length,actualRequests);assert.equal(new Set(logs.map(log=>log.requestId)).size,actualRequests);assert.ok(logs.every(log=>ids.includes(log.requestId)&&log.billableState==='confirmed'&&log.actualAmount===.000039));
  assert.equal(report.upstream.workloadRequests,actualRequests,'every generation must go to the counted local stand-in exactly once');
  assert.equal(report.results.pendingReview,0);assert.equal(before-after,actualRequests*39,'original-source funds must match confirmed usage exactly');assert.equal(outbox.queued+outbox.blocked+outbox.active,0);
  assert.ok(actorBalances.every(actor=>actor.chargedMicros===actor.expectedChargedMicros),'each actor spends only its own original quota');
  if(db){assert.equal(report.results.ledgerEntries,actualRequests);assert.equal(report.results.unfinishedReservations,0);assert.equal(report.results.activeLimitScopes,0);assert.ok(report.database.samples>0&&report.database.maxClients>0,'database sampler must observe actual tagged application connections');}
  report.success=true;
}catch(error){report.failure=error instanceof Error?error.message:'load check failed';process.exitCode=1;}
finally{
  if(sampleTimer)clearInterval(sampleTimer);await lastSample;
  for(const child of children.reverse())if(child.exitCode===null){child.kill();await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(3000)]);}
  if(db){if(created&&/^agp_load_[a-f0-9]{32}$/.test(schema))await db.query(`drop schema "${schema}" cascade`);await db.end();}
  try{const physical=await realpath(directory),parent=await realpath(runtime);assert.ok(physical===resolve(parent,basename(directory))&&physical.startsWith(parent+sep)&&/^load-[a-f0-9]{32}$/.test(basename(physical)));if(report.success)await rm(physical,{recursive:true,force:true});else report.evidenceDirectory=physical;}catch(error){if(error.code!=='ENOENT')throw error;}
  await mkdir(dirname(outputPath),{recursive:true});await writeFile(outputPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({success:report.success,output:outputPath,results:report.results,failure:report.failure},null,2));
}
