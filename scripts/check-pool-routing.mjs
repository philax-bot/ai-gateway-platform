import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {resolve,sep,basename} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdir,rm} from 'node:fs/promises';
const require=createRequire(resolve('apps/control-plane/package.json'));
const {Pool}=require('pg'),{parse}=require('dotenv');
const connectionString=process.env.DATABASE_URL||parse(readFileSync('apps/control-plane/.env')).DATABASE_URL;
assert.ok(connectionString,'development database configuration is required');
const schema=`agp_check_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString,connectionTimeoutMillis:5000});
let store,replica,created=false,checks=0;
const children=[],servers=[],journal=resolve('.runtime',`pool-routing-${randomUUID()}`);
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const listen=server=>new Promise(done=>server.listen(0,'127.0.0.1',()=>done(server.address().port)));
async function freePort(){const server=createServer();const port=await listen(server);await new Promise(done=>server.close(done));return port;}
function start(file,env){const child=spawn(process.execPath,[resolve(file)],{windowsHide:true,stdio:'ignore',env:{...process.env,...env}});children.push(child);return child;}
async function ready(url){for(let i=0;i<100;i++){try{if((await fetch(url,{signal:AbortSignal.timeout(300)})).ok)return;}catch{}await pause(100);}throw new Error('local fixture readiness timed out');}
const check=(value,label)=>{assert.ok(value,label);checks++;};
try{
  await admin.query(`create schema "${schema}"`);created=true;
  Object.assign(process.env,{DATABASE_URL:connectionString,DATABASE_SCHEMA:schema,REDIS_URL:'',PLATFORM_MODE:'development'});
  const {PostgresStore}=require(resolve('apps/control-plane/dist/store/postgres.store.js'));
  const {WorkspaceRepository}=require(resolve('apps/control-plane/dist/platform/workspace.repository.js'));
  store=new PostgresStore();await store.initialize();const repo=new WorkspaceRepository(store);await repo.initialize();
  replica=new PostgresStore();await replica.initialize();
  const credential=await store.getDemoCredential('local-employee-key'),identity=credential.identity;
  await repo.transact(async tx=>{
    const s=tx.state;s.settings.limits={mode:'none'};
    s.services[0].verification='passed';s.services[0].limits={mode:'custom',concurrency:1};
    Object.assign(s.services[0].mappings[0],{inputPrice:2,outputPrice:3,cachedInputPrice:0.5});
    s.services.push({...structuredClone(s.services[0]),id:'service-second',name:'Second independent source'});
    s.pools[0].entries[0].open=true;s.pools[0].entries.push({...s.pools[0].entries[0],serviceId:'service-second'});
    const plan={id:'pool-routing-plan',version:1,name:'Routing test',range:{poolId:s.pools[0].id,mode:'follow',definitionIds:[]},amount:10,cadence:'once',quotaDays:30,entitlementDays:365,active:true,limits:{mode:'none'}};
    s.plans.push(plan);s.entitlements.push({id:'pool-routing-entitlement',memberId:identity.subjectId,planId:plan.id,planVersion:1,planSnapshot:plan,range:plan.range,grantedAt:new Date().toISOString(),expiresAt:'2099-01-01T00:00:00Z',status:'active',futureGrants:true,source:'manual',ruleIds:[],periods:['once']});
    s.keys.push({id:'routing-key',credentialId:identity.credentialId,name:'Routing test',ownerId:identity.subjectId,subjectType:'employee',subjectId:identity.subjectId,purpose:'personal',projectId:null,masked:'test',keyHash:'unit-only',status:'active',createdAt:new Date().toISOString(),expiresAt:'2099-01-01T00:00:00Z',lastUsedAt:null});
  });
  await store.withClient(c=>c.query("update quota_batches set entitlement_id='pool-routing-entitlement',expires_at='2099-01-01',available_amount=10 where id='personal-batch-demo-001'"));
  const request=()=>{const id=randomUUID();return {requestId:id,idempotencyKey:id,identity,purpose:'personal',modelId:'test-model',mode:'chat',estimatedInputTokens:100,maxOutputTokens:200,policyVersion:'routing-check'};};
  const inputs=Array.from({length:16},request),results=await Promise.all(inputs.map((r,i)=>(i%2?store:replica).authorize(r)));
  const allowed=results.filter(r=>r.decision==='allow');
  check(allowed.length===2,'two stores concurrently admit exactly two independent service slots');
  check(new Set(allowed.map(r=>r.admission.route.serviceId)).size===2,'both services receive requests');
  check(results.filter(r=>r.reasonCode==='rate_limited').length===14,'no oversubscription beyond combined service concurrency');
  const balance=await store.withClient(async c=>(await c.query("select available_amount from quota_batches where id='personal-batch-demo-001'")).rows[0]);
  check(Math.abs(Number(balance.available_amount)-9.9984)<1e-8,'only admitted requests reserve funds');
  const first=allowed[0],input=inputs.find(i=>i.requestId===first.requestId),replay=await replica.authorize(input);
  check(replay.replayed&&replay.reservation.reservationId===first.reservation.reservationId,'cross-instance replay preserves reservation and selected service');
  for(const r of allowed)await store.settle({requestId:r.requestId,idempotencyKey:randomUUID(),reservationId:r.reservation.reservationId,outcome:'completed',inputTokens:10,outputTokens:8,cachedInputTokens:4,usageFinal:true,completedAt:new Date().toISOString(),forwarded:true});
  const logs=await store.listCalls();
  check(new Set(logs.filter(l=>allowed.some(r=>r.requestId===l.requestId)).map(l=>l.admission.route.serviceId)).size===2,'settled logs retain both actual routes');
  check(logs.filter(l=>allowed.some(r=>r.requestId===l.requestId)).every(l=>l.actualAmount===0.000038),'each actual route settles its frozen price once');
  for(const metric of ['rpm','tpm']){
    await store.withClient(c=>c.query('delete from admission_windows'));
    await repo.transact(async tx=>{for(const s of tx.state.services)s.limits={mode:'custom',[metric]:metric==='tpm'?300:1};});
    const r=await Promise.all([store.authorize(request()),replica.authorize(request()),store.authorize(request())]);
    check(r.filter(v=>v.decision==='allow').length===2&&r.some(v=>v.reasonCode==='rate_limited'),metric+' spare capacity works across instances');
    for(const a of r.filter(v=>v.decision==='allow'))await store.settle({requestId:a.requestId,idempotencyKey:randomUUID(),reservationId:a.reservation.reservationId,outcome:'upstream_error',inputTokens:0,outputTokens:0,usageFinal:true,completedAt:new Date().toISOString()});
  }
  await store.withClient(c=>c.query('delete from admission_windows'));
  await repo.transact(async tx=>{tx.state.pools[0].limits={mode:'custom',concurrency:1};for(const s of tx.state.services)s.limits={mode:'custom',concurrency:2};});
  const capped=await Promise.all([store.authorize(request()),replica.authorize(request())]);
  check(capped.filter(r=>r.decision==='allow').length===1,'pool cap remains shared across routes');
  for(const a of capped.filter(r=>r.decision==='allow'))await store.settle({requestId:a.requestId,idempotencyKey:randomUUID(),reservationId:a.reservation.reservationId,outcome:'upstream_error',inputTokens:0,outputTokens:0,usageFinal:true,completedAt:new Date().toISOString()});
  let release;const held=new Promise(done=>release=done),hits=[0,0],sourcePorts=[];
  for(let i=0;i<2;i++){
    const server=createServer(async(req,res)=>{
      for await(const chunk of req){}hits[i]++;await held;
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:randomUUID(),object:'chat.completion',model:'test-model',choices:[{index:0,message:{role:'assistant',content:'source-'+i},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:8,total_tokens:18}}));
    });servers.push(server);sourcePorts.push(await listen(server));
  }
  await repo.transact(async tx=>{tx.state.pools[0].limits={mode:'none'};tx.state.services.forEach((s,i)=>{s.limits={mode:'custom',concurrency:1};s.baseUrl=`http://127.0.0.1:${sourcePorts[i]}/v1`;});});
  const cp=await freePort(),gw=await freePort(),token=randomUUID();await mkdir(journal,{recursive:true});
  start('apps/control-plane/dist/main.js',{PORT:String(cp),HOST:'127.0.0.1',SERVICE_TOKEN:token,STORE_MODE:'postgres',ALLOW_UPSTREAM_VALIDATION:'false',GATEWAY_DATA_PLANE:'direct'});
  await ready(`http://127.0.0.1:${cp}/health`);
  start('services/gateway-sim/dist/server.js',{PORT:String(gw),HOST:'127.0.0.1',SERVICE_TOKEN:token,CONTROL_PLANE_URL:`http://127.0.0.1:${cp}`,ALLOW_UPSTREAM_REQUESTS:'false',GATEWAY_DATA_PLANE:'direct',GATEWAY_JOURNAL_DIR:journal});
  await ready(`http://127.0.0.1:${gw}/health`);
  const chat=()=>fetch(`http://127.0.0.1:${gw}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer local-employee-key'},body:JSON.stringify({model:'test-model',messages:[{role:'user',content:'Hello'}],max_tokens:200}),signal:AbortSignal.timeout(15000)});
  const pending=[chat(),chat()];
  try{
    for(let i=0;i<100&&hits.some(n=>!n);i++)await pause(50);
    check(hits.every(n=>n===1),'real gateway forwards simultaneous requests to both local upstreams');
    const third=await chat();await third.text();check(third.status===429,'real gateway rejects only after both source slots fill');
  }finally{release();}
  const completed=await Promise.all(pending);check(completed.every(r=>r.ok),'both real upstream responses succeed');
  const bodies=await Promise.all(completed.map(r=>r.json()));check(new Set(bodies.map(b=>b.choices[0].message.content)).size===2,'client responses identify both actual HTTP sources');
  console.log(`PASS ${checks} pool-routing assertions (isolated PostgreSQL, two instances, real local HTTP forwarding)`);

}finally{
  for(const child of children){if(child.exitCode===null){child.kill();await Promise.race([new Promise(done=>child.once('exit',done)),pause(3000)]);}}
  for(const server of servers){server.closeAllConnections();await new Promise(done=>server.close(done));}
  if(journal.startsWith(resolve('.runtime')+sep)&&/^pool-routing-[a-f0-9-]{36}$/.test(basename(journal)))await rm(journal,{recursive:true,force:true});
  await replica?.onModuleDestroy();await store?.onModuleDestroy();
  if(created&&/^agp_check_[a-f0-9]{32}$/.test(schema))await admin.query(`drop schema "${schema}" cascade`);
  await admin.end();
}
