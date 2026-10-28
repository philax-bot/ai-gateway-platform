import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';

const require=createRequire(resolve('apps/control-plane/package.json')),{Pool}=require('pg');
const connectionString=process.env.DATABASE_URL||require('dotenv').parse(readFileSync('apps/control-plane/.env')).DATABASE_URL;
const schema=`agp_check_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString,max:2,connectionTimeoutMillis:5000});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),pending=[],releases=[];
let store,holder,created=false,checks=0;
const check=(value,message)=>{assert.ok(value,message);checks++;};
const track=work=>{pending.push(work);void work.catch(()=>undefined);return work;};
const gate=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});releases.push(release);return {promise,release};};
async function waitFor(work,message){for(let attempt=0;attempt<100;attempt++){if(await work())return;await pause(50);}throw new Error(`CHECK: ${message}`);}
async function deadline(work,message){let timer;try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`CHECK: ${message}`)),4000);})]);}finally{clearTimeout(timer);}}
try{
  await admin.query(`create schema "${schema}"`);created=true;
  Object.assign(process.env,{DATABASE_URL:connectionString,DATABASE_SCHEMA:schema,PGAPPNAME:schema,REDIS_URL:'',PLATFORM_MODE:'development'});
  const {PostgresStore}=require(resolve('apps/control-plane/dist/store/postgres.store.js')),{WorkspaceRepository}=require(resolve('apps/control-plane/dist/platform/workspace.repository.js'));
  const {ADMISSION_POLICY_SQL}=require(resolve('apps/control-plane/dist/store/admission-policy-lock.js'));
  store=new PostgresStore();await store.initialize();const repo=new WorkspaceRepository(store);await repo.initialize();
  const identity=(await store.getDemoCredential('local-employee-key')).identity,before=(await store.getQuota()).availableAmount;
  const input=()=>({requestId:randomUUID(),idempotencyKey:randomUUID(),identity,purpose:'personal',modelId:'test-model',mode:'chat',policyVersion:'policy-lock-check'});
  const release=async(request,response)=>store.settle({requestId:request.requestId,idempotencyKey:`${request.idempotencyKey}:settlement`,reservationId:response.reservation.reservationId,outcome:'rejected_before_upstream',forwarded:false,usageFinal:true,inputTokens:0,outputTokens:0,completedAt:new Date().toISOString()});
  const waiting=async fragment=>(await admin.query(`select count(*)::int as n from pg_stat_activity where application_name=$1 and wait_event_type='Lock' and position($2 in query)>0`,[schema,fragment])).rows[0].n>0;
  check((await admin.query(`select admission_lock_version from "${schema}".platform_installation`)).rows[0].admission_lock_version===2,'schema declares the admission lock protocol');
  {
    const hold=gate();let entered=false;const revision=(await repo.read()).revision;
    const writer=track(repo.transact(async tx=>{entered=true;await hold.promise;tx.state.audit.push({id:randomUUID(),actorId:'system:fixture',action:'runtime.fixture',objectId:'fixture',reason:'metadata concurrency check',createdAt:new Date().toISOString(),detail:{}});},{runtimeOnly:true,diagnosticContext:'monitoring_commit'}));
    await waitFor(()=>entered,'runtime row lock must be held');const request=input(),authorization=await deadline(track(store.authorize(request)),'metadata writer blocked admission');
    check(authorization.decision==='allow','admission reads policy while a runtime writer holds the JSON row');hold.release();await writer;
    check((await repo.read()).revision===revision,'runtime updates preserve the business revision');await release(request,authorization);
    const policy=(await admin.query(`select ${ADMISSION_POLICY_SQL} as value from "${schema}".platform_workspace where id='org-demo'`)).rows[0].value;
    check(!['audit','sessions','operations','monitoring','notifications'].some(field=>field in policy),'admission projection excludes operational and historical records');
    check(policy.members.some(member=>member.id===identity.subjectId&&member.active)&&policy.organizations.length>0,'projection retains authoritative subject and organization policy');
  }
  {
    const hold=gate();let entered=false,finished=false;
    const writer=track(repo.transact(async tx=>{entered=true;await hold.promise;tx.state.members.find(m=>m.id===identity.subjectId).active=false;}));
    await waitFor(()=>entered,'policy writer must hold its fence');const authorization=track(store.authorize(input()).then(value=>{finished=true;return value;}));
    await waitFor(()=>waiting('pg_advisory_xact_lock_shared'),'admission must wait on the active policy writer');check(!finished,'policy change cannot be bypassed by an MVCC read');hold.release();await writer;
    check((await authorization).reasonCode==='subject_disabled','admission observes the committed subject revocation');
    await repo.transact(async tx=>{tx.state.members.find(m=>m.id===identity.subjectId).active=true;});
  }
  {
    holder=await admin.connect();await holder.query('begin');await holder.query(`select id from "${schema}".quota_batches where id='personal-batch-demo-001' for update`);
    const request=input(),authorization=track(store.authorize(request));await waitFor(()=>waiting('quota_batches'),'admission must hold its policy snapshot while waiting on the funded row');
    let entered=false;const writer=track(repo.transact(async tx=>{entered=true;tx.state.members.find(m=>m.id===identity.subjectId).active=false;}));
    await waitFor(()=>waiting('pg_advisory_xact_lock('),'policy writer must wait for the admitted snapshot');check(!entered,'revocation waits for the existing authorization transaction');await holder.query('commit');holder.release();holder=null;
    const response=await authorization;await writer;check(response.decision==='allow','already admitted snapshot keeps its original decision');check((await store.authorize(input())).reasonCode==='subject_disabled','new authorizations see revocation');
    check((await release(request,response)).status==='released','an earlier hold can settle to its original source after revocation');
  }
  {
    const state=await repo.read(),funds=(await store.getQuota()).availableAmount;
    await assert.rejects(repo.transact(async tx=>{tx.state.members.find(m=>m.id===identity.subjectId).active=true;},{runtimeOnly:true}),/cannot change admission policy/);checks++;
    await assert.rejects(repo.transact(tx=>tx.disableCredentials(identity.subjectId),{runtimeOnly:true}),/cannot change funds or credentials/);checks++;
    check(JSON.stringify(await repo.read())===JSON.stringify(state),'invalid runtime policy mutation rolls back the full workspace');check((await store.getQuota()).availableAmount===funds,'runtime rejection preserves funds');
    await assert.rejects(repo.transact(async tx=>{tx.state.members.find(m=>m.id===identity.subjectId).active=true;throw new Error('fixture rollback');}),/fixture rollback/);checks++;
    check((await store.authorize(input())).reasonCode==='subject_disabled','failed policy writer does not publish its mutation');
  }
  check((await store.getQuota()).availableAmount===before,'all known unforwarded holds refund exactly once');
  const residual=(await admin.query(`select (select count(*)::int from "${schema}".reservations where finalized=false) as holds,(select count(*)::int from pg_stat_activity where application_name=$1 and state='idle in transaction') as idle`,[schema])).rows[0];
  check(residual.holds===0&&residual.idle===0,'no unfinished reservations or idle transactions remain');
  console.log(`PASS ${checks} policy/runtime lock assertions (isolated PostgreSQL; no model requests)`);
}catch(error){console.error(error instanceof assert.AssertionError||error?.message?.startsWith('CHECK:')?error.message:'Policy lock check failed; private database details are not logged.');process.exitCode=1;}
finally{
  for(const release of releases)release();if(holder){await holder.query('rollback').catch(()=>undefined);holder.release();}
  await Promise.allSettled(pending);await store?.onModuleDestroy();
  if(created&&/^agp_check_[a-f0-9]{32}$/.test(schema)){await admin.query(`drop schema "${schema}" cascade`);console.log('CLEANUP owned policy-lock schema removed');}await admin.end();
}
