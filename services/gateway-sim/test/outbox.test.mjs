import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,rename,rmdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {gatewayFixture,pause,send,usage} from './http-fixture.mjs';

test('a final usage write failure retries the original completed event after storage recovers',async()=>{
  let resume;const gate=new Promise(resolve=>{resume=resolve;});
  await gatewayFixture(async({directory,base,call,requests,settlements,waitSettlement})=>{
    const requestId='final-usage-io-recovery',key=createHash('sha256').update(requestId).digest('hex'),target=join(directory,`${key}.json`),saved=`${target}.saved`;
    const pending=call({},undefined,{'x-request-id':requestId});
    for(let i=0;i<100&&!requests.length;i++)await pause(20);
    assert.equal(requests.length,1);await rename(target,saved);await mkdir(target);resume();
    const response=await pending;assert.equal(response.status,503);assert.equal((await response.json()).error.type,'settlement_pending');
    await rmdir(target);await rename(saved,target);const event=await waitSettlement();
    assert.equal(event.outcome,'completed');assert.equal(event.usageFinal,true);assert.equal(event.inputTokens,13);assert.equal(event.outputTokens,14);assert.equal(event.cachedInputTokens,4);
    assert.equal(requests.length,1);assert.equal(settlements.length,1);assert.equal((await(await fetch(`${base}/health`)).json()).outbox.writePending,0);
  },async(body,response)=>{await gate;send(response,{model:body.model,choices:[],usage});});
});

test('authorization intent IO failure refuses the authorization RPC before any hold or generation',()=>gatewayFixture(async({directory,call,requests,authorizations,settlements})=>{
  const path=join(directory,'authorizations');await rename(path,`${path}-saved`);await writeFile(path,'blocked journal path');
  const response=await call();assert.equal(response.status,503);assert.equal((await response.json()).error.type,'journal_unavailable');
  assert.equal(authorizations.length,0);assert.equal(requests.length,0);assert.equal(settlements.length,0);
},async(body,response)=>send(response,{choices:[],usage})));

test('blocked settlements degrade health and require a service token and reason for a bounded unchanged replay',()=>gatewayFixture(async({base,call,requests,settlements,setSettlementStatus})=>{
  setSettlementStatus(409);const response=await call();assert.equal(response.status,503);await response.text();
  const health=await(await fetch(`${base}/health`)).json();assert.equal(health.status,'degraded');assert.equal(health.outbox.blocked,1);assert.ok(health.outbox.oldestBlockedAgeMs>=0);
  const path=`${base}/internal/v1/outbox`,headers={authorization:'Bearer http-service-token','content-type':'application/json'};
  assert.equal((await fetch(path)).status,401);assert.equal((await fetch(path,{headers:{authorization:'Bearer http-test-key'}})).status,401);
  const inspected=await(await fetch(path,{headers})).json(),requestId=inspected.items[0].requestId;
  assert.equal(inspected.items[0].lastStatus,409);assert.ok(!/price|credentialRef|baseUrl/.test(JSON.stringify(inspected.items)));
  const retry=body=>fetch(`${path}/retry`,{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal((await retry({requestId})).status,400);
  assert.equal((await retry({requestId,reason:'fix',actualAmount:0})).status,400);
  setSettlementStatus(200);const retried=await retry({requestId,reason:'合同已修复，按原结算补发'});assert.equal((await retried.json()).delivered,true);
  assert.equal(requests.length,1);assert.equal(settlements.length,2);assert.deepEqual(settlements[1],settlements[0]);
  assert.equal((await(await fetch(`${base}/health`)).json()).status,'ok');assert.equal((await retry({requestId,reason:'already delivered'})).status,404);
},async(body,response)=>send(response,{model:body.model,choices:[{message:{role:'assistant',content:'done'}}],usage})));
test('retryable settlement backlog also degrades readiness while preserving the queued event',()=>gatewayFixture(async({base,call,setSettlementStatus})=>{
  setSettlementStatus(503);await(await call()).text();const health=await(await fetch(`${base}/health`)).json();
  assert.equal(health.status,'degraded');assert.equal(health.outbox.queued,1);assert.equal(health.outbox.blocked,0);assert.ok(health.outbox.oldestQueuedAgeMs>=0);
},async(body,response)=>send(response,{model:body.model,choices:[],usage})));
test('an actual journal rename failure refuses forwarding and records a pre-upstream release',()=>gatewayFixture(async({directory,call,requests,settlements})=>{
  const requestId='disk-write-failure',key=createHash('sha256').update(requestId).digest('hex');await mkdir(join(directory,`${key}.json`));
  const response=await call({},undefined,{'x-request-id':requestId});assert.equal(response.status,503);assert.equal((await response.json()).error.type,'journal_unavailable');
  assert.equal(requests.length,0);assert.equal(settlements.length,1);assert.equal(settlements[0].forwarded,false);assert.equal(settlements[0].usageFinal,true);assert.equal(settlements[0].actualAmount,0);
},async(body,response)=>send(response,{choices:[],usage})));
