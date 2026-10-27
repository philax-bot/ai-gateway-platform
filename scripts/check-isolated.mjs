import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdir, realpath, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
import { checkBusiness } from './check-business.mjs';

const root=fileURLToPath(new URL('../', import.meta.url));
const require=createRequire(resolve(root,'apps/control-plane/package.json'));
const postgres=process.argv.includes('--postgres');
const children=[];
let admin, schema;
let ownedDirectory;
const runtimeRoot=resolve(root,'.runtime');
let assertions=0;
const check=(condition,message)=>{assert.ok(condition,message); assertions++;};
const closeEnough=(a,b,message)=>check(Math.abs(a-b)<0.0000001,`${message}: ${a} != ${b}`);
const pause=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort() {
  const server=createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port; await new Promise(resolve=>server.close(resolve)); return port;
}
function start(file,env={}) {
  const child=spawn(process.execPath,[file],{cwd:root,env:{...process.env,PLATFORM_MODE:'development',DATABASE_SCHEMA:'',...env},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output=''; child.stdout.on('data',data=>output=(output+data).slice(-8000)); child.stderr.on('data',data=>output=(output+data).slice(-8000));
  child.diagnostic=()=>output; children.push(child); return child;
}
async function ready(url,child) {
  for(let i=0;i<100;i++) {
    if(child?.exitCode!==null && child?.exitCode!==undefined) throw new Error(`service exited: ${child.diagnostic()}`);
    try { const r=await fetch(url,{signal:AbortSignal.timeout(300)}); if(r.ok)return; } catch {}
    await pause(100);
  }
  throw new Error(`service did not become ready: ${url} ${child?.diagnostic()??''}`);
}
try {
  await mkdir(runtimeRoot,{recursive:true});
  const physicalRoot=await realpath(root),physicalRuntime=await realpath(runtimeRoot);
  if(!physicalRuntime.startsWith(physicalRoot+sep))throw new Error('test runtime directory resolves outside this workspace');
  const candidate=resolve(runtimeRoot,`check-${randomUUID()}`);await mkdir(candidate);ownedDirectory=candidate;
  const [cpPort,gwPort,modelPort,offlinePort]=await Promise.all([freePort(),freePort(),freePort(),freePort()]);
  const cp=`http://127.0.0.1:${cpPort}`, gw=`http://127.0.0.1:${gwPort}`;
  let dbEnv={DATABASE_URL:'',REDIS_URL:'',STORE_MODE:'memory',PGOPTIONS:''};
  if(postgres) {
    const config=process.env.DATABASE_URL?{}:require('dotenv').parse(readFileSync(resolve(root,'apps/control-plane/.env')));
    const connectionString=process.env.DATABASE_URL||config.DATABASE_URL;
    if(!connectionString)throw new Error('DATABASE_URL required for isolated PostgreSQL checks');
    const {Pool}=require('pg'); admin=new Pool({connectionString,connectionTimeoutMillis:5000});
    schema=`agp_check_${randomUUID().replaceAll('-','')}`;
    await admin.query(`create schema "${schema}"`);
    dbEnv={DATABASE_URL:connectionString,REDIS_URL:'',STORE_MODE:'postgres',PGOPTIONS:`-c search_path=${schema}`,PGAPPNAME:schema};
  }
  let control=start('apps/control-plane/dist/main.js',{...dbEnv,PORT:String(cpPort)});
  await ready(`${cp}/health`,control);
  const model=process.env.SIMULATION_MODEL_URL||`http://127.0.0.1:${modelPort}`;
  if(!process.env.SIMULATION_MODEL_URL) {
    const mock=start('postman/mocks/test-model/default.js',{PORT:String(modelPort)});
    await ready(`${model}/health`,mock);
  } else await ready(`${model}/health`);
  const gateway=start('services/gateway-sim/dist/server.js',{PORT:String(gwPort),CONTROL_PLANE_URL:cp,MODEL_URL:model,SERVICE_TOKEN:'local-service-token',UPSTREAM_TIMEOUT_MS:'600',GATEWAY_JOURNAL_DIR:resolve(ownedDirectory,'gateway')});
  await ready(`${gw}/health`,gateway);
  const headers={'content-type':'application/json',authorization:'Bearer local-service-token'};
  async function call(path,body) {
    const r=await fetch(`${cp}${path}`,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(6000)});
    return {status:r.status,body:await r.json()};
  }
  const quota=async(purpose='personal')=>(await call(`/api/v1/calls/quota?purpose=${purpose}`)).body.availableAmount;
  const logs=async()=>(await call('/api/v1/calls')).body.data;
  async function waitLog(id) {
    for(let i=0;i<60;i++) {const log=(await logs()).find(log=>log.requestId===id); if(log)return log; await pause(50);}
    throw new Error(`missing call log: ${id}`);
  }
  async function auth(key='local-employee-key', overrides={}) {
    const c=(await call('/internal/v1/policy/credentials/resolve',{apiKey:key})).body;
    const id=`check-${randomUUID()}`;
    const input={requestId:id,idempotencyKey:id,identity:c.identity,purpose:c.purpose,modelId:'test-model',mode:'chat',policyVersion:'policy-local-1',...overrides};
    return {input,...await call('/internal/v1/policy/authorize',input)};
  }
  const settlement=(a,overrides={})=>({requestId:a.input.requestId,idempotencyKey:`settle-${a.input.idempotencyKey}`,reservationId:a.body.reservation?.reservationId,outcome:'upstream_error',completedAt:new Date().toISOString(),...overrides});
  async function gatewayRequest({key='local-employee-key',scenario,stream=false,id=`gateway-${randomUUID()}`,signal,base=gw}={}) {
    const r=await fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${key}`,'x-request-id':id,'idempotency-key':id},body:JSON.stringify({model:'test-model',messages:[{role:'user',content:'local check'}],stream,test_scenario:scenario}),signal});
    return {r,id};
  }

  const legacy=start('scripts/check-local-vertical-slice.mjs',{CONTROL_PLANE_URL:cp,GATEWAY_URL:gw,MODEL_URL:model,SERVICE_TOKEN:'local-service-token'});
  const legacyCode=await new Promise(resolve=>legacy.once('exit',resolve));
  check(legacyCode===0,legacy.diagnostic());
  console.log('PASS existing vertical slice (health, CORS, usage, deny, auth, provider, quota, calls)');

  const personalBefore=await quota(), projectBefore=await quota('project');
  const project=await gatewayRequest({key:'local-project-key'}); check(project.r.status===200,'project gateway response'); await project.r.text();
  closeEnough(await quota(),personalBefore,'project never spends personal');
  closeEnough(await quota('project'),projectBefore-0.02,'project member quota spent');
  const projectLog=await waitLog(project.id); check(projectLog.projectId==='project-demo-001'&&projectLog.purpose==='project','project log attribution');
  const p=await auth('local-project-key',{purpose:'personal'}); check(p.body.reasonCode==='credential_invalid','reject cross-purpose credential');
  const credential=(await call('/internal/v1/policy/credentials/resolve',{apiKey:'local-project-key'})).body;
  for(const identity of [{...credential.identity,projectId:'another-project'},{...credential.identity,organizationId:'another-org'},{...credential.identity,subjectType:'application'}]) {
    const denied=await auth('local-project-key',{identity}); check(denied.body.decision==='deny','reject forged identity scope');
  }
  if(postgres) {
    const personal=await quota(), project=await quota('project');
    await admin.query(`update "${schema}".quota_batches set available_amount=0 where id='project-member-batch-demo-001'`);
    check((await auth('local-project-key')).body.reasonCode==='quota_insufficient','exhausted project cannot fall back to personal');
    closeEnough(await quota(),personal,'personal balance unchanged after project exhaustion');
    await admin.query(`update "${schema}".quota_batches set available_amount=$1 where id='project-member-batch-demo-001'`,[project]);
  }
  check((await call('/api/v1/calls/quota?purpose=wrong')).status===400,'reject invalid purpose query');
  console.log('PASS project/personal quota and identity scope isolation');

  const before=await quota();
  const identity=(await call('/internal/v1/policy/credentials/resolve',{apiKey:'local-employee-key'})).body.identity;
  const id=`concurrent-${randomUUID()}`;
  const input={requestId:id,idempotencyKey:id,identity,purpose:'personal',modelId:'test-model',mode:'chat',policyVersion:'policy-local-1'};
  const concurrent=await Promise.all(Array.from({length:8},()=>call('/internal/v1/policy/authorize',input)));
  check(concurrent.every(r=>r.status===200&&r.body.reservation.reservationId===concurrent[0].body.reservation.reservationId),'same authorization for parallel retries');
  check(concurrent.filter(r=>!r.body.replayed).length===1,'only one forwarding owner');
  closeEnough(await quota(),before-0.02,'parallel authorization reserves once');
  const a={input,body:concurrent[0].body};
  const releases=await Promise.all(Array.from({length:8},()=>call('/internal/v1/usage/settlements',settlement(a))));
  check(releases.filter(r=>r.body.status==='released').length===1,`parallel release executes once: ${JSON.stringify(releases.map(r=>({http:r.status,state:r.body.status,error:r.body.message})))}`);
  check(releases.every(r=>r.status===200&&r.body.billableState==='not_billable'),'parallel release retains original billing state');
  closeEnough(await quota(),before,'parallel release restores exactly once');
  check((await logs()).filter(log=>log.requestId===id).length===1,'one call log for repeated settlement');
  check((await call('/internal/v1/policy/authorize',{...input,modelId:'different'})).status===409,'authorization fingerprint conflict');
  const other=await auth();
  check((await call('/internal/v1/usage/settlements',settlement(other,{idempotencyKey:settlement(a).idempotencyKey}))).status===409,'settlement key cannot cross requests');
  check((await call('/internal/v1/usage/settlements',settlement(other,{actualAmount:-1}))).status===400,'reject negative amount');
  check((await call('/internal/v1/usage/settlements',settlement(other,{purpose:'project'}))).status===409,'settlement cannot rewrite quota purpose');
  await call('/internal/v1/usage/settlements',settlement(other));
  console.log('PASS concurrent authorization/settlement, key conflicts, and invalid settlement protection');

  const precisionBefore=await quota(); const fraction=await auth();
  check((await call('/internal/v1/usage/settlements',settlement(fraction,{outcome:'completed',actualAmount:0.005}))).body.status==='settled','fractional settlement');
  closeEnough(await quota(),precisionBefore-0.005,'preserve six-decimal ledger precision');
  const afterFraction=await auth();
  closeEnough(await quota(),precisionBefore-0.025,'subsequent reserve preserves fractional balance');
  await call('/internal/v1/usage/settlements',settlement(afterFraction));
  closeEnough(await quota(),precisionBefore-0.005,'fractional balance preserved after release');
  const over=await auth();
  check((await call('/internal/v1/usage/settlements',settlement(over,{outcome:'completed',actualAmount:1}))).body.status==='pending_review','overrun held for review');

  for(const scenario of ['error','html-error']) {
    const before=await quota(); const {r,id}=await gatewayRequest({scenario});
    await r.text(); check(r.status===(scenario==='error'?500:502),`${scenario} status`);
    const log=await waitLog(id); check(log.billableState==='not_billable'&&log.outcome==='upstream_error',`${scenario} released`);
    closeEnough(await quota(),before,`${scenario} refunds`);
  }
  for(const scenario of ['timeout','truncate','incomplete','reset-before-headers']) {
    const before=await quota(); const {r,id}=await gatewayRequest({scenario,stream:scenario!=='timeout'});
    await r.text(); if(scenario==='timeout')check(r.status===504,'timeout response');
    const log=await waitLog(id); check(log.billableState==='pending_review',`${scenario} incomplete usage retained (outcome=${log.outcome}, billing=${log.billableState})`);
    closeEnough(await quota(),before-0.02,`${scenario} keeps hold`);
  }
  const abort=new AbortController(); const cancelBefore=await quota();
  const cancelled=await gatewayRequest({scenario:'cancel',stream:true,signal:abort.signal});
  const reader=cancelled.r.body.getReader(); await reader.read(); abort.abort(); try{await reader.cancel();}catch{}
  const cancelLog=await waitLog(cancelled.id);
  check(cancelLog.outcome==='client_cancelled'&&cancelLog.billableState==='pending_review','client cancellation recorded for review');
  closeEnough(await quota(),cancelBefore-0.02,'client cancellation keeps unknown usage hold');
  const duplicateId=`duplicate-${randomUUID()}`;
  const once=await gatewayRequest({id:duplicateId}); await once.r.text();
  const duplicate=await gatewayRequest({id:duplicateId}); check(duplicate.r.status===409,'duplicate request not forwarded twice'); await duplicate.r.text();
  check((await logs()).filter(log=>log.requestId===duplicateId).length===1,'duplicate forwarding yields one log');
  console.log('PASS upstream JSON/HTML failure, timeout, truncated SSE, cancellation, and duplicate forwarding');

  const offlineGwPort=await freePort(); const offlineGw=`http://127.0.0.1:${offlineGwPort}`;
  const offline=start('services/gateway-sim/dist/server.js',{PORT:String(offlineGwPort),CONTROL_PLANE_URL:cp,MODEL_URL:`http://127.0.0.1:${offlinePort}`,SERVICE_TOKEN:'local-service-token',GATEWAY_JOURNAL_DIR:resolve(ownedDirectory,'offline-gateway')});
  await ready(`${offlineGw}/health`,offline); const beforeOffline=await quota();
  const unreachable=await gatewayRequest({base:offlineGw}); await unreachable.r.text(); check(unreachable.r.status===502,'unreachable upstream 502');
  check((await waitLog(unreachable.id)).billableState==='not_billable','unreachable upstream not billable');
  closeEnough(await quota(),beforeOffline,'unreachable upstream releases hold');
  assertions+=await checkBusiness({controlPlaneUrl:cp,gatewayUrl:gw,modelUrl:model,start,freePort,runtimeDirectory:ownedDirectory,
    updateWorkspaceForCheck:postgres?async work=>{
      assert.match(schema,/^agp_check_[a-f0-9]{32}$/);
      await admin.query('begin');try{
        const result=await admin.query(`select payload from "${schema}".platform_workspace where id='org-demo' for update`),state=result.rows[0].payload;
        work(state);await admin.query(`update "${schema}".platform_workspace set payload=$1 where id='org-demo'`,[state]);await admin.query('commit');
      }catch(error){await admin.query('rollback');throw error;}
    }:undefined,
    expireReservation:postgres?async requestId=>{assert.match(schema,/^agp_check_[a-f0-9]{32}$/);await admin.query(`update "${schema}".reservations set expires_at=clock_timestamp()-interval '1 second' where request_id=$1`,[requestId]);}:undefined,
    inspectLedger:postgres?async requestId=>(await admin.query(`select kind,detail->>'actorId' as actor from "${schema}".usage_ledger_entries where request_id=$1`,[requestId])).rows:undefined,
    withCollectionFailure:postgres?async work=>{
      assert.match(schema,/^agp_check_[a-f0-9]{32}$/);
      await admin.query(`alter table "${schema}".call_logs rename to call_logs_collection_check`);
      try{return await work();}finally{await admin.query(`alter table "${schema}".call_logs_collection_check rename to call_logs`);}
    }:undefined,
  });
  if(postgres) {
    const result=await admin.query("select count(*)::int as active from pg_stat_activity where state='idle in transaction' and application_name=$1",[schema]);
    check(result.rows[0].active===0,'no transaction left open by repeated settlements');
    const personal=await quota(),project=await quota('project'),callCount=(await logs()).length;
    const monitoringBefore=(await admin.query(`select payload->'monitoring'->'collectionEvents' as events from "${schema}".platform_workspace where id='org-demo'`)).rows[0].events;
    control.kill(); await new Promise(resolve=>control.once('exit',resolve));
    control=start('apps/control-plane/dist/main.js',{...dbEnv,PORT:String(cpPort)});
    await ready(`${cp}/health`,control);
    closeEnough(await quota(),personal,'personal balance survives restart');
    closeEnough(await quota('project'),project,'project balance survives restart');
    check((await logs()).length===callCount,'logs survive restart without seed duplication');
    const monitoringAfter=(await admin.query(`select payload->'monitoring'->'collectionEvents' as events from "${schema}".platform_workspace where id='org-demo'`)).rows[0].events;
    check(monitoringBefore.length>0&&monitoringBefore.every(e=>monitoringAfter.some(v=>v.id===e.id&&v.acknowledgedAt===e.acknowledgedAt)),'collection event identities and acknowledgements survive PostgreSQL restart');
    console.log('PASS PostgreSQL restart preserves balances and call logs');
  }
  console.log(`PASS ${assertions} assertions (${postgres?'isolated PostgreSQL schema':'memory store'}; ${process.env.SIMULATION_MODEL_URL?'Postman simulation':'repository HTTP model mock'})`);
} catch(error) {
  const knownErrors=/deadlock detected|Connection terminated due to connection timeout|timeout exceeded when trying to connect|remaining connection slots[^\r\n]*|too many clients|ETIMEDOUT|ECONNRESET|ECONNREFUSED|could not serialize access/gi;
  const diagnostics=children.flatMap(child=>child.diagnostic().match(knownErrors)??[]);
  if(diagnostics.length)console.error(`Service failure categories: ${JSON.stringify([...new Set(diagnostics)])}`);
  const failureHeaders=children.flatMap(child=>child.diagnostic().replace(/\x1b\[[0-9;]*m/g,'').split(/\r?\n/).filter(line=>line.includes('[ExceptionsHandler]')).map(line=>line.split('[ExceptionsHandler]')[1].replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi,'[redacted-url]').replace(/'[^']*'|"[^"]*"/g,'[redacted-value]').slice(0,200)));
  if(failureHeaders.length)console.error(`Redacted service errors: ${JSON.stringify([...new Set(failureHeaders)])}`);
  console.error(error instanceof Error?error.message:String(error)); process.exitCode=1;
} finally {
  for(const child of children.reverse()) {
    if(child.exitCode===null) {child.kill(); await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(2000)]);}
  }
  if(admin) {
    // Only this run's generated schema is eligible for removal. Never touch public or a supplied schema.
    if(schema && /^agp_check_[a-f0-9]{32}$/.test(schema)) {
      await admin.query(`drop schema "${schema}" cascade`);
      console.log('CLEANUP isolated test schema removed; shared demo balances untouched');
    }
    await admin.end();
  }
  if(ownedDirectory){
    const physicalDirectory=await realpath(ownedDirectory),physicalRuntime=await realpath(runtimeRoot);
    if(physicalDirectory===resolve(physicalRuntime,ownedDirectory.split(/[\\/]/).pop())&&physicalDirectory.startsWith(physicalRuntime+sep)&&/^check-[a-f0-9-]{36}$/.test(ownedDirectory.split(/[\\/]/).pop()))await rm(ownedDirectory,{recursive:true,force:true});
    else throw new Error('refused to remove an unexpected test directory');
  }
}
