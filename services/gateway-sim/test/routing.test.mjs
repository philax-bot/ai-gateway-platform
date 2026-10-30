import test from 'node:test';
import assert from 'node:assert/strict';
import {gatewayFixture,send,usage} from './http-fixture.mjs';

const headers={'content-type':'application/json','x-api-key':'http-test-key','anthropic-version':'2023-06-01',authorization:'Bearer http-test-key'};
test('Claude beta query reaches Messages without weakening authentication or matching subroutes',()=>gatewayFixture(async({base,requests,authorizations,settlements})=>{
  const body={model:'logical-model',messages:[{role:'user',content:'local route test'}],max_tokens:32};
  const post=(path,value=body,extra={})=>fetch(base+path,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(value)});
  for(const path of ['/v1/messages','/v1/messages?beta=true']){
    const invalid=await post(path,{});assert.equal(invalid.status,400);assert.equal((await invalid.json()).type,'error');
  }
  const denied=await post('/v1/messages?beta=true',body,{'x-api-key':'invalid',authorization:'Bearer invalid'});
  assert.equal(denied.status,401);assert.equal(requests.length,0);assert.equal(authorizations.length,0);
  const response=await post('/v1/messages?beta=true');assert.equal(response.status,200);
  const value=await response.json();assert.equal(value.type,'message');assert.equal(value.model,'logical-model');
  assert.equal(requests.length,1);assert.equal(requests[0].model,'physical-model');assert.equal(settlements[0].usageFinal,true);
  for(const path of ['/v1/messages/extra?beta=true','/v1/messages-other?beta=true'])assert.equal((await post(path)).status,404);
  assert.equal((await fetch(base+'/v1/messages?beta=true')).status,404);
  assert.equal(requests.length,1);
},async(body,response,request)=>{assert.equal(request.url,'/v1/chat/completions');send(response,{model:body.model,choices:[{message:{role:'assistant',content:'local reply'},finish_reason:'stop'}],usage});}));

test('queries also reach Responses, Chat, discovery and CORS preflight',()=>gatewayFixture(async({base,requests})=>{
  for(const path of ['/v1/responses?beta=true','/v1/chat/completions?client=test']){
    const response=await fetch(base+path,{method:'POST',headers,body:'{}'});assert.equal(response.status,400);
  }
  const models=await fetch(base+'/v1/models?limit=10',{headers});assert.equal(models.status,200);assert.equal((await models.json()).data[0].id,'logical-model');
  for(const path of ['/v1/messages','/v1/responses','/v1/chat/completions','/v1/models'])assert.equal((await fetch(base+path+'?beta=true',{method:'OPTIONS'})).status,204);
  assert.equal((await fetch(base+'/health?check=ready')).status,200);
  assert.equal(requests.length,0);
},async()=>assert.fail('validation and discovery must not generate')));
