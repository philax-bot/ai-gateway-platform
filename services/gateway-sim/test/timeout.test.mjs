import test from 'node:test';
import assert from 'node:assert/strict';
import { gatewayTimeouts } from '../dist/upstream-timeout.js';
import { gatewayFixture,pause,streamStart,streamEvent,usage } from './http-fixture.mjs';

test('timeout settings preserve the total-budget variable and reject invalid startup values',()=>{
  assert.equal(gatewayTimeouts({}).totalMs,600000);
  assert.equal(gatewayTimeouts({UPSTREAM_TIMEOUT_MS:'600'}).totalMs,600);
  for(const value of ['','NaN','-1','0','Infinity','100.5','3600001'])assert.throws(()=>gatewayTimeouts({UPSTREAM_IDLE_TIMEOUT_MS:value}),/UPSTREAM_IDLE_TIMEOUT_MS/);
});
test('ongoing response bytes renew the idle budget beyond the first-byte budget',()=>gatewayFixture(async({call,waitSettlement})=>{
  const response=await call({stream:true});const raw=await response.text();
  assert.ok(raw.endsWith('data: [DONE]\n\n'));assert.equal((await waitSettlement()).usageFinal,true);
},async(body,response)=>{
  streamStart(response);for(let i=0;i<7;i++){streamEvent(response,{model:body.model,choices:[{delta:{content:'text'}}]});await pause(90);}
  streamEvent(response,{choices:[],usage});response.end('data: [DONE]\n\n');
},{UPSTREAM_FIRST_BYTE_TIMEOUT_MS:'300',UPSTREAM_IDLE_TIMEOUT_MS:'400'}));
test('first-byte timeout keeps dispatched usage unknown and exposes its phase',()=>gatewayFixture(async({call,waitSettlement})=>{
  const response=await call();assert.equal(response.status,504);assert.equal((await response.json()).error.code,'upstream_first_byte_timeout');
  const settlement=await waitSettlement();assert.equal(settlement.usageFinal,false);assert.equal(settlement.forwarded,true);assert.equal(settlement.outcome,'timeout');
},async()=>{}, {UPSTREAM_FIRST_BYTE_TIMEOUT_MS:'300'}));
test('stream inactivity expires independently and omits the completion marker',()=>gatewayFixture(async({call,waitSettlement})=>{
  const raw=await(await call({stream:true})).text();assert.ok(raw.includes('upstream_idle_timeout'));assert.ok(!raw.includes('[DONE]'));
  assert.equal((await waitSettlement()).usageFinal,false);
},async(body,response)=>{streamStart(response);streamEvent(response,{choices:[{delta:{content:'first'}}]});},{UPSTREAM_IDLE_TIMEOUT_MS:'300'}));
test('total deadline bounds an otherwise continuously active stream',()=>gatewayFixture(async({call,waitSettlement})=>{
  const raw=await(await call({stream:true})).text();assert.ok(raw.includes('upstream_total_timeout'));assert.equal((await waitSettlement()).outcome,'timeout');
},async(body,response)=>{
  streamStart(response);const tick=setInterval(()=>streamEvent(response,{choices:[{delta:{content:'active'}}]}),60);response.on('close',()=>clearInterval(tick));
},{UPSTREAM_TIMEOUT_MS:'600'}));
test('client cancellation preserves unknown usage without retrying the model',()=>gatewayFixture(async({call,waitSettlement,requests})=>{
  const controller=new AbortController(),response=await call({stream:true},controller.signal),reader=response.body.getReader();await reader.read();controller.abort();
  const settlement=await waitSettlement();assert.equal(settlement.outcome,'client_cancelled');assert.equal(settlement.usageFinal,false);assert.equal(requests.length,1);
},async(body,response)=>{streamStart(response);streamEvent(response,{choices:[{delta:{content:'first'}}]});}));
test('shutdown drain expiry finalizes unknown usage before a normal process exit',()=>gatewayFixture(async({call,stop,settlements})=>{
  const response=await call({stream:true});const raw=response.text();await stop();
  assert.ok((await raw).includes('gateway_stopping'));assert.equal(settlements.length,1);assert.equal(settlements[0].usageFinal,false);assert.equal(settlements[0].outcome,'partial');
},async(body,response)=>{streamStart(response);streamEvent(response,{choices:[{delta:{content:'first'}}]});},{GATEWAY_DRAIN_TIMEOUT_MS:'300'}));
test('the default request budget preserves a real 31-second active stream past the former cutoff',{timeout:45000},()=>gatewayFixture(async({call,waitSettlement})=>{
  const began=Date.now(),raw=await(await call({stream:true})).text();
  assert.ok(Date.now()-began>=31000);assert.ok(raw.endsWith('data: [DONE]\n\n'));assert.equal((await waitSettlement()).usageFinal,true);
},async(body,response)=>{
  streamStart(response);streamEvent(response,{choices:[{delta:{content:'first'}}]});
  const tick=setInterval(()=>streamEvent(response,{choices:[{delta:{content:'active'}}]}),200);
  const finish=setTimeout(()=>{clearInterval(tick);streamEvent(response,{choices:[],usage});response.end('data: [DONE]\n\n');},31200);
  response.on('close',()=>{clearInterval(tick);clearTimeout(finish);});
},{UPSTREAM_TIMEOUT_MS:undefined}));
