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
const concurrency=Number(option('--concurrency','4')),requests=Number(option('--requests','48')),out=option('--out',null);
assert.ok(!args.length&&Number.isInteger(concurrency)&&concurrency>=1&&concurrency<=64&&Number.isInteger(requests)&&requests>=concurrency&&requests<=2000,'Use --concurrency 1..64 --requests concurrency..2000 [--postgres] [--out FILE]');
const children=[],runId=randomUUID().replaceAll('-',''),runtime=resolve(root,'.runtime'),directory=resolve(runtime,`load-${runId}`);
const outputPath=resolve(root,out??`.runtime/load-results/${new Date().toISOString().replace(/[:.]/g,'-')}-${postgres?'postgres':'memory'}.json`);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let db,schema,created=false,sampleTimer,lastSample=Promise.resolve(),sampling=false;
const report={success:false,createdAt:new Date().toISOString(),environment:{node:process.version,platform:platform(),arch:arch(),cpu:cpus()[0]?.model,logicalCpus:availableParallelism(),memoryGiB:Math.round(totalmem()/1073741824),revision:spawnSync('git',['rev-parse','--short','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).stdout.trim(),store:postgres?'isolated PostgreSQL schema':'isolated memory',network:'local control plane/gateway/model; PostgreSQL uses the configured development endpoint',model:'repository deterministic HTTP stand-in; 13 input / 14 output / 4 cached tokens',scope:'single instance, one managed user and one quota batch; not production or real-model capacity'},workload:{requests,concurrency,streamEvery:3,adminEvery:8},database:{samples:0,sampleFailures:0,maxClients:0,maxLockWaiters:0,waitEvents:{}}};
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
  let dbEnv={};
  if(postgres){
    const require=createRequire(resolve(root,'apps/control-plane/package.json')),{Pool}=require('pg');
    let connectionString=process.env.DATABASE_URL;
    if(!connectionString){const {parse}=require('dotenv');connectionString=parse(await readFile(resolve(root,'apps/control-plane/.env'))).DATABASE_URL;}
    assert.ok(connectionString,'DATABASE_URL is required for the isolated PostgreSQL load check');
    db=new Pool({connectionString,connectionTimeoutMillis:5000,max:2});schema=`agp_load_${runId}`;await db.query(`create schema "${schema}"`);created=true;
    dbEnv={STORE_MODE:'postgres',DATABASE_URL:connectionString,DATABASE_SCHEMA:schema,PGAPPNAME:schema};
  }
  const control=start('apps/control-plane/dist/main.js',{...dbEnv,PORT:String(cpPort),SERVICE_TOKEN:serviceToken});await ready(`${cp}/health`,control);
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
  await command('save.service',{...service,baseUrl:model,mappings:service.mappings.map(mapping=>({...mapping,inputPrice:1,outputPrice:2,cachedInputPrice:.5}))});
  assert.equal((await request(`/api/v1/platform/services/${service.id}/verify`,{},admin)).body.verification,'passed');
  await command('save.pool',{...pool,entries:pool.entries.map(entry=>({...entry,open:true}))});
  const range={poolId:pool.id,mode:'follow',definitionIds:[]};
  const plan=await command('save.plan',{name:'隔离负载方案',range,amount:10,cadence:'once',quotaDays:30,entitlementDays:30});
  const member=await command('save.member',{name:'隔离负载用户',directoryId:'load-member',password,organizationId:'department-engineering',category:'employee',roles:['employee'],tags:[]});
  await command('distribution.execute',{planId:plan.id,memberIds:[member.id]});
  const memberCookie=(await request('/api/v1/auth/login',{directoryId:'load-member',password})).cookie;
  const key=await command('key.issue',{name:'隔离负载密钥',purpose:'personal'},memberCookie);
  const before=(await state()).quotaBatches.filter(batch=>batch.sourceId===member.id).reduce((sum,batch)=>sum+Math.round(batch.availableAmount*1e6),0);
  if(db){
    const sample=()=>{if(sampling)return;sampling=true;lastSample=(async()=>{try{
      const rows=(await db.query('select wait_event_type,wait_event from pg_stat_activity where application_name=$1',[schema])).rows;
      report.database.samples++;report.database.maxClients=Math.max(report.database.maxClients,rows.length);report.database.maxLockWaiters=Math.max(report.database.maxLockWaiters,rows.filter(row=>row.wait_event_type==='Lock').length);
      for(const row of rows){const key=row.wait_event_type?`${row.wait_event_type}:${row.wait_event}`:'running';report.database.waitEvents[key]=(report.database.waitEvents[key]??0)+1;}
    }catch{report.database.sampleFailures++;}})().finally(()=>{sampling=false;});};sample();sampleTimer=setInterval(sample,250);
  }
  const latencies=[],streamLatencies=[],plainLatencies=[],ttft=[],adminLatencies=[],errors={},ids=[];let next=0,successes=0;
  const began=performance.now();
  await Promise.all(Array.from({length:concurrency},async()=>{for(;;){const index=next++;if(index>=requests)return;const id=`load-${runId}-${index}`;ids.push(id);
    try{
      if(index%8===0){const beganAdmin=performance.now();await request('/api/v1/platform/state',null,admin);await request('/api/v1/platform/maintenance/run',{},admin);adminLatencies.push(performance.now()-beganAdmin);}
      const stream=index%3===0,beganCall=performance.now();
      const response=await fetch(`${gw}/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${key.secret}`,'content-type':'application/json','x-request-id':id,'idempotency-key':id},body:JSON.stringify({model:'test-model',messages:[{role:'user',content:'isolated capacity fixture'}],max_tokens:32,stream,test_scenario:'cached'}),signal:AbortSignal.timeout(30000)});
      const raw=await response.text();const duration=performance.now()-beganCall;latencies.push(duration);(stream?streamLatencies:plainLatencies).push(duration);
      if(response.status!==200){let type='unknown';try{const value=JSON.parse(raw).error?.type;if(typeof value==='string'&&/^[a-z0-9_]{1,64}$/.test(value))type=value;}catch{}throw new Error(`HTTP_${response.status}:${type}`);}if(stream)assert.ok(raw.endsWith('data: [DONE]\n\n'),'STREAM_INCOMPLETE');else assert.ok(JSON.parse(raw).usage,'USAGE_MISSING');successes++;
    }catch(error){const category=/^(HTTP_\d+:[a-z0-9_]+|STREAM_INCOMPLETE|USAGE_MISSING)$/.test(error.message)?error.message:'request_failed';errors[category]=(errors[category]??0)+1;}
  }}));
  const durationMs=performance.now()-began;if(sampleTimer)clearInterval(sampleTimer);await lastSample;
  const afterState=await state(),after=afterState.quotaBatches.filter(batch=>batch.sourceId===member.id).reduce((sum,batch)=>sum+Math.round(batch.availableAmount*1e6),0);
  const calls=(await request('/api/v1/platform/calls/query',{subjectId:member.id,limit:200},admin)).body;
  let page=calls,logs=[...page.items];while(page.nextCursor){page=(await request('/api/v1/platform/calls/query',{subjectId:member.id,limit:200,cursor:page.nextCursor},admin)).body;logs.push(...page.items);}
  for(const log of logs)if(log.ttftMs!=null)ttft.push(log.ttftMs);
  const outbox=(await fetch(`${gw}/health`).then(response=>response.json())).outbox;
  report.results={durationMs:Math.round(durationMs),successfulRequests:successes,errors,errorRate:(requests-successes)/requests,requestsPerSecond:Math.round(requests*1000/durationMs*100)/100,latencyMs:distribution(latencies),streamLatencyMs:distribution(streamLatencies),nonStreamLatencyMs:distribution(plainLatencies),ttftMs:distribution(ttft),adminLatencyMs:distribution(adminLatencies),confirmedCalls:calls.summary.ended,pendingReview:calls.summary.pendingReview,confirmedAmount:calls.summary.confirmedAmount,quotaBefore:before/1e6,quotaAfter:after/1e6,chargedMicros:before-after,expectedChargedMicros:requests*39,outbox};
  assert.equal(successes,requests,'all requests must complete');assert.equal(logs.length,requests);assert.equal(new Set(logs.map(log=>log.requestId)).size,requests);assert.ok(logs.every(log=>ids.includes(log.requestId)&&log.billableState==='confirmed'&&log.actualAmount===.000039));
  assert.equal(calls.summary.pendingReview,0);assert.equal(before-after,requests*39,'original-source funds must match confirmed usage exactly');assert.equal(outbox.queued+outbox.blocked+outbox.active,0);
  if(db){const count=(await db.query(`select count(*)::int as count from "${schema}".usage_ledger_entries where kind='settlement'`)).rows[0].count;assert.equal(count,requests);report.results.ledgerEntries=count;assert.ok(report.database.samples>0&&report.database.maxClients>0,'database sampler must observe actual tagged application connections');}
  report.success=true;
}catch(error){report.failure=error instanceof Error?error.message:'load check failed';process.exitCode=1;}
finally{
  if(sampleTimer)clearInterval(sampleTimer);await lastSample;
  for(const child of children.reverse())if(child.exitCode===null){child.kill();await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(3000)]);}
  if(db){if(created&&/^agp_load_[a-f0-9]{32}$/.test(schema))await db.query(`drop schema "${schema}" cascade`);await db.end();}
  try{const physical=await realpath(directory),parent=await realpath(runtime);assert.ok(physical===resolve(parent,basename(directory))&&physical.startsWith(parent+sep)&&/^load-[a-f0-9]{32}$/.test(basename(physical)));await rm(physical,{recursive:true,force:true});}catch(error){if(error.code!=='ENOENT')throw error;}
  await mkdir(dirname(outputPath),{recursive:true});await writeFile(outputPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({success:report.success,output:outputPath,results:report.results,failure:report.failure},null,2));
}
