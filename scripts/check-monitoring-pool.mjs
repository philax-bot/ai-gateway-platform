import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
const require=createRequire(resolve('apps/control-plane/package.json'));
const {Pool}=require('pg'),{parse}=require('dotenv');
const connectionString=process.env.DATABASE_URL||parse(readFileSync('apps/control-plane/.env')).DATABASE_URL;
assert.ok(connectionString,'development database configuration is required');
const schema=`agp_check_${randomUUID().replaceAll('-','')}`;
const admin=new Pool({connectionString,connectionTimeoutMillis:5000});
let store,occupied,created=false,checks=0;
const check=(value,message)=>{assert.ok(value,message);checks++;};
try{
  await admin.query(`create schema "${schema}"`);created=true;
  Object.assign(process.env,{DATABASE_URL:connectionString,DATABASE_SCHEMA:schema,PGAPPNAME:schema,REDIS_URL:'',PLATFORM_MODE:'development'});
  const {PostgresStore}=require(resolve('apps/control-plane/dist/store/postgres.store.js'));
  const {WorkspaceRepository}=require(resolve('apps/control-plane/dist/platform/workspace.repository.js'));
  const {MonitoringService}=require(resolve('apps/control-plane/dist/platform/monitoring.service.js'));
  store=new PostgresStore();
  // Constrain only this fixture's private pool. One occupied slot leaves exactly
  // one usable connection: a healthy monitor must not require a nested checkout.
  store.pool.options.max=2;store.pool.options.connectionTimeoutMillis=300;
  await store.initialize();const repo=new WorkspaceRepository(store);await repo.initialize();
  const monitor=new MonitoringService(repo,store),before=await repo.view();
  occupied=await store.pool.connect();
  await monitor.evaluate(true);
  const collected=await repo.read();
  check(collected.monitoring.collection.quality==='collected','monitoring must collect with one available connection, without marking healthy storage unavailable');
  console.log('PASS monitoring under occupied pool: no nested checkout required');
  await occupied.query(`alter table "${schema}".call_logs rename to call_logs_pool_check`);
  try{
    await monitor.evaluate(true);
    const failed=await repo.read();
    check(failed.monitoring.collection.quality==='collection_failed','query failure must persist collection failure without aborting workspace transaction');
    check(failed.monitoring.collection.failedStages.includes('call_totals'),'query failure stage is retained');
  }finally{await occupied.query(`alter table "${schema}".call_logs_pool_check rename to call_logs`);}
  await monitor.evaluate(true);
  const after=await repo.view();
  check(after.state.monitoring.collection.quality==='collected','same connection remains usable after failed statistics query');
  check(after.state.revision===before.state.revision,'monitoring must not invalidate business previews');
  check(JSON.stringify(after.batches)===JSON.stringify(before.batches)&&JSON.stringify(after.budgets)===JSON.stringify(before.budgets),'monitoring never changes funded amounts');
  occupied.release();occupied=null;
  // Queued authorization uses the real store's normal 5 s checkout timeout.
  // The earlier 300 ms value only makes the deterministic nested-checkout
  // regression fail quickly; it is not a request latency requirement.
  store.pool.options.connectionTimeoutMillis=5000;
  const credential=await store.getDemoCredential('local-employee-key');
  let entered,continueCollection;
  const inside=new Promise(resolve=>{entered=resolve;}),proceed=new Promise(resolve=>{continueCollection=resolve;});
  const transact=repo.transact.bind(repo);
  repo.transact=(work,options)=>transact(async tx=>{entered();await proceed;return work(tx);},options);
  const collecting=monitor.evaluate(true);
  await inside;
  const authorize=()=>{const id=`monitor-pool-${randomUUID()}`;return store.authorize({requestId:id,idempotencyKey:id,identity:credential.identity,purpose:'personal',modelId:'unknown-monitor-fixture',mode:'chat',policyVersion:'monitor-pool-check'});};
  const pending=Promise.allSettled([authorize(),authorize()]);
  for(let i=0;i<50&&store.pool.waitingCount<1;i++)await new Promise(resolve=>setTimeout(resolve,5));
  check(store.pool.waitingCount>=1,'authorization pressure actually fills the constrained pool');
  continueCollection();
  const outcomes=await pending;await collecting;repo.transact=transact;
  check(outcomes.every(result=>result.status==='fulfilled'&&result.value.decision==='deny'),'concurrent policy requests finish with ordinary denials instead of pool-checkout failures');
  check((await repo.read()).monitoring.collection.quality==='collected','concurrent policy requests do not turn healthy monitoring into an outage');
  const idle=await admin.query("select count(*)::int as n from pg_stat_activity where application_name=$1 and state='idle in transaction'",[schema]);
  check(idle.rows[0].n===0,'no open transaction after successful or failed collection');
  console.log(`PASS ${checks} monitoring-pool assertions (isolated PostgreSQL)`);
}catch(error){console.error(error instanceof assert.AssertionError?error.message:'Monitoring pool check failed; private connection details are not logged.');process.exitCode=1;}
finally{
  occupied?.release();await store?.onModuleDestroy();
  if(created&&/^agp_check_[a-f0-9]{32}$/.test(schema)){await admin.query(`drop schema "${schema}" cascade`);console.log('CLEANUP own monitoring test schema removed');}
  await admin.end();
}
