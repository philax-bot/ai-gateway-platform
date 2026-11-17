import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {connectionConfig} from './lib/backup.mjs';

// Never run against the review schema: this check owns its schema and makes no upstream requests.
const require=createRequire(new URL('../apps/control-plane/package.json',import.meta.url)),{Pool}=require('pg');
const {connectionString}=await connectionConfig(),schema='agp_billing_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString,connectionTimeoutMillis:5000});
let store,created=false;
try{
  assert.match(schema,/^agp_billing_[a-f0-9]{32}$/);await admin.query(`create schema "${schema}"`);created=true;
  Object.assign(process.env,{DATABASE_URL:connectionString,DATABASE_SCHEMA:schema,PLATFORM_MODE:'development',REDIS_URL:'',PGOPTIONS:'',PGAPPNAME:schema});
  const {PostgresStore}=require('./dist/store/postgres.store.js'),{WorkspaceRepository}=require('./dist/platform/workspace.repository.js'),{aggregateUsage}=require('./dist/store/call-analytics.js');
  store=new PostgresStore();await store.initialize();const repository=new WorkspaceRepository(store);await repository.initialize();
  const identity=(await store.getDemoCredential('local-employee-key')).identity;
  await repository.transact(async tx=>{
    const s=tx.state,range={poolId:s.pools[0].id,mode:'follow',definitionIds:[]};
    s.settings.limits={mode:'none'};s.services[0].verification='passed';s.pools[0].entries[0].open=true;s.definitions[0].billingMultiplier=1.5;
    Object.assign(s.services[0].mappings[0],{inputPrice:2,outputPrice:3,cachedInputPrice:0.5,costPrice:{inputPrice:1,outputPrice:2,cachedInputPrice:0.1}});
    const plan={id:'billing-plan',name:'隔离倍率验证',version:1,range,amount:10,cadence:'once',quotaDays:30,entitlementDays:365,active:true,limits:{mode:'none'}};
    s.plans.push(plan);s.entitlements.push({id:'billing-entitlement',memberId:identity.subjectId,planId:plan.id,planVersion:1,planSnapshot:plan,range,grantedAt:new Date().toISOString(),expiresAt:'2099-01-01T00:00:00Z',status:'active',futureGrants:false,source:'manual',ruleIds:[],periods:['once']});
    s.keys.push({id:'billing-key',credentialId:identity.credentialId,name:'隔离验证',ownerId:identity.subjectId,subjectType:'employee',subjectId:identity.subjectId,purpose:'personal',projectId:null,masked:'fixture',keyHash:'fixture',status:'active',createdAt:new Date().toISOString(),expiresAt:null,lastUsedAt:null});
  });
  await store.withClient(c=>c.query("update quota_batches set entitlement_id='billing-entitlement',expires_at='2099-01-01',total_amount=10,available_amount=10 where id='personal-batch-demo-001'"));
  store.businessState=()=>repository.read();
  const request=()=>({requestId:randomUUID(),idempotencyKey:randomUUID(),identity,purpose:'personal',modelId:'test-model',mode:'chat',estimatedInputTokens:100,maxOutputTokens:200,policyVersion:'billing-check'});
  const finish=(input,auth,extra={})=>({requestId:input.requestId,idempotencyKey:randomUUID(),reservationId:auth.reservation.reservationId,outcome:'completed',inputTokens:100,outputTokens:100,cachedInputTokens:20,usageFinal:true,forwarded:true,completedAt:new Date().toISOString(),...extra});
  const first=request(),auth=await store.authorize(first);assert.equal(auth.reservation.reservedAmount,0.0012);
  await repository.transact(async tx=>{tx.state.definitions[0].billingMultiplier=3;tx.state.services[0].mappings[0].costPrice.outputPrice=99;});
  assert.deepEqual((await store.authorize(first)).admission,JSON.parse(JSON.stringify(auth.admission)));
  const settlement=finish(first,auth),results=await Promise.all([store.settle(settlement),store.settle(settlement)]);assert.equal(results.filter(r=>r.status==='settled').length,1);
  let log=(await store.queryCalls({requestId:first.requestId})).items[0];assert.equal(log.actualAmount,0.000705);assert.equal(log.admission.costPrice.outputPrice,2);
  await repository.transact(async tx=>{tx.state.definitions[0].billingMultiplier=0;tx.state.services[0].mappings[0].costPrice={inputPrice:0.000001,outputPrice:0.000001,cachedInputPrice:0};});
  const free=request(),freeAuth=await store.authorize(free);assert.equal(freeAuth.reservation.reservedAmount,0);await store.settle(finish(free,freeAuth));
  log=(await store.queryCalls({requestId:free.requestId})).items[0];assert.equal(log.actualAmount,0);assert.equal(log.billableState,'confirmed');
  const pending=request(),pendingAuth=await store.authorize(pending);await store.settle(finish(pending,pendingAuth,{usageFinal:false,outcome:'partial'}));
  await repository.transact(async tx=>{tx.state.definitions[0].billingMultiplier=7;});
  await repository.transact(tx=>tx.reconcile({requestId:pending.requestId,idempotencyKey:'billing-reconcile',actorId:'operator-demo-001',reason:'isolated complete usage',mode:'confirm_usage',inputTokens:100,outputTokens:100,cachedInputTokens:20}));
  assert.equal((await store.queryCalls({requestId:pending.requestId})).items[0].actualAmount,0);
  const window={from:new Date(Date.now()-60000).toISOString(),to:new Date(Date.now()+1000).toISOString()},rows=(await store.queryCalls(window)).items;
  const comparable=({collectedAt,...report})=>report;
  assert.deepEqual(comparable(await store.queryUsage(window,null,'Asia/Shanghai')),comparable(aggregateUsage(rows,window,null,'Asia/Shanghai')));
  const report=await store.queryUsage(window,null,'Asia/Shanghai');assert.equal(report.totals.cost.comparableRequests,3);assert.equal(report.totals.cost.knownAmount,0.000284);assert.equal(report.totals.cost.differenceAmount,0.000421);
  const ledger=await store.withClient(c=>c.query('select count(*)::int as count,sum(amount)::text as amount from usage_ledger_entries where kind in (\'settlement\',\'reconciliation\')'));
  assert.equal(ledger.rows[0].count,3);assert.equal(Number(ledger.rows[0].amount),0.000705);
  console.log('PASS isolated PostgreSQL billing: frozen multiplier/cost, concurrent exactly-once settlement, zero multiplier with cost, original-price reconciliation, micro-CNY rounding, SQL/memory report parity; zero upstream calls');
}finally{
  await store?.onModuleDestroy();
  try{if(created){assert.match(schema,/^agp_billing_[a-f0-9]{32}$/);await admin.query(`drop schema "${schema}" cascade`);}}finally{await admin.end();}
}
