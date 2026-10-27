import test from 'node:test';
import assert from 'node:assert/strict';
import {gatewayFixture,pause,send,streamStart,usage} from './http-fixture.mjs';

const tools=[{type:'function',function:{name:'local_echo',parameters:{type:'object',properties:{text:{type:'string'}}}}}];
const toolCall={id:'tool-1',type:'function',function:{name:'local_echo',arguments:'{"text":"上海"}'}};
test('model discovery is scoped to the signed-in key and rejects invalid keys',()=>gatewayFixture(async({base})=>{
  const list=await fetch(`${base}/v1/models`,{headers:{authorization:'Bearer http-test-key'}});
  assert.deepEqual((await list.json()).data.map(model=>model.id),['logical-model']);
  assert.equal((await fetch(`${base}/v1/models`,{headers:{authorization:'Bearer bad'}})).status,401);
},async()=>{}));
test('a non-stream tool call and its result retain history, reasoning and authoritative usage',()=>gatewayFixture(async({call,requests,settlements})=>{
  const messages=[{role:'developer',content:[{type:'text',text:'Use the local tool.'}]},{role:'user',content:'echo'}];
  const first=await(await call({messages,tools,max_completion_tokens:32})).json();
  assert.equal(first.model,'logical-model');assert.deepEqual(first.choices[0].message.tool_calls,[toolCall]);
  messages.push(first.choices[0].message,{role:'tool',tool_call_id:'tool-1',content:'上海'});
  const final=await(await call({messages,tools})).json();assert.equal(final.choices[0].message.content,'收到上海');
  assert.equal(requests.length,2);assert.equal(requests[0].model,'physical-model');assert.equal(requests[0].max_completion_tokens,32);
  assert.deepEqual(requests[1].messages,messages);assert.equal(requests[1].messages[2].reasoning_content,'local tool needed');
  assert.equal(settlements.length,2);for(const settlement of settlements){assert.equal(settlement.inputTokens,13);assert.equal(settlement.outputTokens,14);assert.equal(settlement.cachedInputTokens,4);assert.equal(settlement.usageFinal,true);}
},async(body,response)=>{
  const complete=body.messages.at(-1).role==='tool';
  send(response,{model:body.model,choices:[{message:{role:'assistant',content:complete?'收到上海':null,reasoning_content:'local tool needed',...(complete?{}:{tool_calls:[toolCall]})},finish_reason:complete?'stop':'tool_calls'}],usage:{prompt_tokens:13,completion_tokens:14,prompt_cache_hit_tokens:4,completion_tokens_details:{reasoning_tokens:10}}});
}));
test('fragmented UTF-8 and SSE tool deltas preserve arguments, model identity and final usage',()=>gatewayFixture(async({call,requests,waitSettlement})=>{
  const raw=await(await call({stream:true,tools})).text();assert.ok(raw.endsWith('data: [DONE]\n\n'));assert.ok(!raw.includes('physical-model'));
  const events=raw.split(/\r?\n\r?\n/).flatMap(event=>{const line=event.split(/\r?\n/).find(line=>line.startsWith('data:'));if(!line||line.includes('[DONE]'))return [];return [JSON.parse(line.slice(5))];});
  const args=events.flatMap(event=>event.choices??[]).flatMap(choice=>choice.delta?.tool_calls??[]).map(call=>call.function?.arguments??'').join('');
  assert.deepEqual(JSON.parse(args),{text:'上海'});assert.equal(requests[0].stream_options.include_usage,true);
  const settlement=await waitSettlement();assert.equal(settlement.cachedInputTokens,4);assert.equal(settlement.outcome,'completed');assert.equal(settlement.usageFinal,true);
},async(body,response)=>{
  streamStart(response);response.write(': keepalive\r\n\r\n');
  const chunks=[{delta:{reasoning_content:'consider tool'}},{delta:{tool_calls:[{index:0,id:'tool-1',type:'function',function:{name:'local_echo',arguments:'{"text":"'}}]}},{delta:{tool_calls:[{index:0,function:{arguments:'上海"}'}}]},finish_reason:'tool_calls'}];
  for(const choice of chunks){const data=Buffer.from(`data: ${JSON.stringify({model:body.model,choices:[choice],usage:null})}\r\n\r\n`);for(let offset=0;offset<data.length;offset+=13){response.write(data.subarray(offset,offset+13));await pause(1);}}
  response.write(`data: ${JSON.stringify({model:body.model,choices:[],usage})}\n\n`);response.end('data: [DONE]\n\n');
}));
test('upstream HTTP failures are passed through once without an automatic generation retry',()=>gatewayFixture(async({call,requests,waitSettlement})=>{
  const response=await call();assert.equal(response.status,429);assert.equal((await response.json()).error.type,'rate_limit_error');
  assert.equal(requests.length,1);assert.equal((await waitSettlement()).outcome,'upstream_error');
},async(body,response)=>send(response,{error:{type:'rate_limit_error',message:'local test limit'}},429)));
