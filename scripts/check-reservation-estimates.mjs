import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {connectionConfig} from './lib/backup.mjs';
import {estimateChatInput} from '../packages/contracts/dist/index.js';

// Deterministic store/quote acceptance in a disposable PostgreSQL schema. No upstream calls.
const require=createRequire(new URL('../apps/control-plane/package.json',import.meta.url)),{Pool}=require('pg');
const {connectionString}=await connectionConfig(),schema=`agp_estimate_${randomUUID().replaceAll('-','')}`;
const admin=new Pool({connectionString,connectionTimeoutMillis:5000});let store,created=false;
try{
  assert.match(schema,/^agp_estimate_[a-f0-9]{32}$/);await admin.query(`create schema "${schema}"`);created=true;
  Object.assign(process.env,{DATABASE_URL:connectionString,DATABASE_SCHEMA:schema,PLATFORM_MODE:'development',REDIS_URL:'',PGOPTIONS:'',PGAPPNAME:schema});
  const {PostgresStore}=require('./dist/store/postgres.store.js'),{WorkspaceRepository}=require('./dist/platform/workspace.repository.js'),{PlatformService}=require('./dist/platform/platform.service.js');
  store=new PostgresStore();await store.initialize();const repository=new WorkspaceRepository(store);await repository.initialize();
  const identity=(await store.getDemoCredential('local-employee-key')).identity;
  await repository.transact(async tx=>{
    const s=tx.state,range={poolId:s.pools[0].id,mode:'follow',definitionIds:[]};
    s.settings.limits={mode:'none'};Object.assign(s.definitions[0],{contextTokens:1000000,estimatedOutputTokens:100});
    s.services[0].verification='passed';s.pools[0].entries[0].open=true;
    Object.assign(s.services[0].mappings[0],{inputPrice:2,outputPrice:3,cachedInputPrice:0.5});
    const plan={id:'estimate-plan',version:1,name:'估算测试',range,amount:10,cadence:'once',quotaDays:30,entitlementDays:365,active:true,limits:{mode:'inherit'}};
    s.plans.push(plan);s.entitlements.push({id:'estimate-entitlement',memberId:identity.subjectId,planId:plan.id,planVersion:1,planSnapshot:plan,range,grantedAt:new Date().toISOString(),expiresAt:'2099-01-01T00:00:00Z',status:'active',futureGrants:true,source:'manual',ruleIds:[],periods:['once']});
    s.keys.push({id:'estimate-key',credentialId:identity.credentialId,name:'估算测试',ownerId:identity.subjectId,subjectType:'employee',subjectId:identity.subjectId,purpose:'personal',projectId:null,masked:'test',keyHash:'unit-only',status:'active',createdAt:new Date().toISOString(),expiresAt:'2099-01-01T00:00:00Z',lastUsedAt:null});
    s.applications.push({id:'estimate-app',billingMode:'accounting',name:'记账估算测试',ownerId:identity.subjectId,organizationId:'department-engineering',description:'',active:true,range,limits:{mode:'inherit'}});
    s.keys.push({id:'estimate-app-key',credentialId:'estimate-app-credential',name:'应用估算测试',ownerId:identity.subjectId,subjectType:'application',subjectId:'estimate-app',purpose:'application',projectId:null,masked:'test',keyHash:'unit-only-app',status:'active',createdAt:new Date().toISOString(),expiresAt:'2099-01-01T00:00:00Z',lastUsedAt:null});
  });
  await store.withClient(c=>c.query("update quota_batches set entitlement_id='estimate-entitlement',expires_at='2099-01-01' where id='personal-batch-demo-001'"));
  const request=(patch={})=>({requestId:randomUUID(),idempotencyKey:randomUUID(),identity,purpose:'personal',modelId:'test-model',mode:'chat',estimatedInputTokens:100,maxOutputTokens:80000,policyVersion:'estimate-check',...patch});
  const finish=(r,a,patch={})=>({requestId:r.requestId,idempotencyKey:`settle-${r.requestId}`,reservationId:a.reservation.reservationId,outcome:'completed',inputTokens:1000,outputTokens:1000,usageFinal:true,completedAt:new Date().toISOString(),...patch});
  const messages=[{role:'user',content:'quote and admission'}],r=request({estimatedInputTokens:estimateChatInput({messages})}),a=await store.authorize(r);
  const q=await new PlatformService(repository,store).quote(identity.subjectId,{purpose:'personal',model:'test-model',messages,max_tokens:80000});
  assert.equal(q.reservedAmount,a.reservation.reservedAmount);assert.equal(q.estimatedOutputTokens,100);assert.equal(a.admission.route.maxOutputTokens,80000);
  await store.settle(finish(r,a,{inputTokens:0,outputTokens:0}));
  const omitted=request({maxOutputTokens:undefined}),unbounded=await store.authorize(omitted);
  assert.ok(!('maxOutputTokens' in unbounded.admission.route));assert.equal(unbounded.admission.estimate.outputTokens,100);
  await store.settle(finish(omitted,unbounded,{inputTokens:0,outputTokens:0}));

  await store.withClient(c=>c.query("update quota_batches set total_amount=0.007,available_amount=0.007 where id='personal-batch-demo-001'"));
  const rs=[request(),request()],as=await Promise.all(rs.map(r=>store.authorize(r)));
  assert.ok(as.every(a=>a.decision==='allow'));assert.equal(as[0].reservation.reservedAmount,0.0005);
  const outcomes=await Promise.all(rs.map((r,i)=>store.settle(finish(r,as[i]))));
  assert.deepEqual(outcomes.map(o=>o.status).sort(),['pending_review','settled']);
  const funds=(await store.withClient(c=>c.query("select available_amount from quota_batches where id='personal-batch-demo-001'"))).rows[0];assert.equal(Number(funds.available_amount),0.0015);
  for(let i=0;i<2;i++)assert.equal((await store.settle(finish(rs[i],as[i]))).status,'already_finalized');
  const ledger=(await store.withClient(c=>c.query('select amount from usage_ledger_entries where request_id=any($1::text[])',[rs.map(r=>r.requestId)]))).rows;
  assert.equal(ledger.length,1);assert.equal(Number(ledger[0].amount),0.005);

  const appIdentity={...identity,credentialId:'estimate-app-credential',subjectType:'application',subjectId:'estimate-app',projectId:null};
  await store.withClient(async c=>{
    await c.query('insert into credentials(credential_id,api_key,identity,purpose,model_ids) values($1,$2,$3,$4,$5)',['estimate-app-credential','estimate-app-api-key',appIdentity,'application',JSON.stringify(['test-model'])]);
    await c.query("insert into quota_batches(id,source_type,source_id,purpose,total_amount,available_amount,model_ids,expires_at,organization_id,accounting) values('estimate-account','application_wallet','estimate-app','application',0,0,'[\"test-model\"]','2099-01-01',$1,true)",[identity.organizationId]);
  });
  const app=request({identity:appIdentity,purpose:'application'}),appAuth=await store.authorize(app);assert.equal(appAuth.decision,'allow');
  assert.equal((await store.settle(finish(app,appAuth))).status,'settled');
  assert.equal(Number((await store.withClient(c=>c.query("select available_amount from quota_batches where id='estimate-account'"))).rows[0].available_amount),-0.005);
  const unknown=request({identity:appIdentity,purpose:'application'}),unknownAuth=await store.authorize(unknown);
  assert.equal((await store.settle(finish(unknown,unknownAuth,{usageFinal:false}))).status,'pending_review');
  console.log('PASS isolated PostgreSQL: quote/admission parity, optional output, immutable large cap, concurrent original-batch top-up, no overdraft, one ledger entry, accounting negative balance, unknown usage held; zero upstream calls');
}finally{
  await store?.onModuleDestroy();
  try{if(created){assert.match(schema,/^agp_estimate_[a-f0-9]{32}$/);await admin.query(`drop schema "${schema}" cascade`);}}finally{await admin.end();}
}
