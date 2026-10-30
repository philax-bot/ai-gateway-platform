import test from 'node:test';import assert from 'node:assert/strict';
import {gatewayFixture,send,pause,streamStart,streamEvent,usage}from'./http-fixture.mjs';
import {createHash}from'node:crypto';import{rename,mkdir,rmdir}from'node:fs/promises';import{join}from'node:path';
const events=raw=>raw.split(/\r?\n\r?\n/).flatMap(e=>{const data=e.split(/\r?\n/).find(l=>l.startsWith('data:'));return data?[JSON.parse(data.slice(5))]:[];});
const body=p=>p==='responses'?{model:'logical-model',input:'local test',max_output_tokens:32,store:false}:{model:'logical-model',messages:[{role:'user',content:'local test'}],max_tokens:32};
function call(base,p,extra={},headers={},signal){return fetch(base+'/v1/'+p,{method:'POST',headers:{'content-type':'application/json',...(p==='responses'?{authorization:'Bearer http-test-key'}:{'x-api-key':'http-test-key','anthropic-version':'2023-06-01'}),...headers},body:JSON.stringify({...body(p),...extra}),signal});}
const nativeConfig=JSON.stringify({responses:{status:'supported'},messages:{status:'supported'}});
for(const p of ['responses','messages'])test(p+' Chat fallback forwards the converted conversation and tools rather than the admission estimate',()=>gatewayFixture(async({base,requests})=>{
 const tool=p==='messages'?{name:'echo',input_schema:{type:'object',properties:{text:{type:'string'}}}}:{type:'function',name:'echo',parameters:{type:'object',properties:{text:{type:'string'}}}};
 const r=await call(base,p,{tools:[tool],...(p==='messages'?{system:'Be brief.'}:{instructions:'Be brief.'})});assert.equal(r.status,200);
 assert.deepEqual(requests[0].messages,[{role:'system',content:'Be brief.'},{role:'user',content:'local test'}]);assert.equal(requests[0].tools[0].function.name,'echo');assert.equal(requests[0].max_tokens,32);
},async(b,r)=>send(r,{model:b.model,choices:[{message:{role:'assistant',content:'OK'},finish_reason:'stop'}],usage})));
const nativeValue=(p,model)=>p==='responses'?{id:'resp_native',object:'response',model,status:'completed',output:[{id:'msg_native',type:'message',role:'assistant',content:[{type:'output_text',text:'上海',annotations:[]}]}],usage:{input_tokens:13,output_tokens:14,input_tokens_details:{cached_tokens:4}},vendor_marker:{preserved:true}}:{id:'msg_native',type:'message',role:'assistant',model,content:[{type:'text',text:'上海'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:9,output_tokens:14,cache_read_input_tokens:4},vendor_marker:{preserved:true}};
for(const p of ['responses','messages']){
 test(p+' falls back to Chat with one generation and trusted cached usage',()=>gatewayFixture(async({base,requests,settlements})=>{
  const response=await call(base,p);assert.equal(response.status,200);assert.equal(response.headers.get('x-atlas-protocol-mode'),'adapted');const value=await response.json();assert.equal(value.model,'logical-model');assert.equal(requests.length,1);assert.equal(requests[0].model,'physical-model');assert.equal(requests[0].max_tokens,32);assert.equal(settlements[0].inputTokens,13);assert.equal(settlements[0].cachedInputTokens,4);assert.equal(settlements[0].usageFinal,true);
 },async(b,r,q)=>{assert.equal(q.url,'/v1/chat/completions');send(r,{model:b.model,choices:[{index:0,message:{role:'assistant',content:'上海'},finish_reason:'stop'}],usage});}));
 test(p+' prefers native protocol and preserves provider response fields',()=>gatewayFixture(async({base,requests,settlements})=>{
  const response=await call(base,p);assert.equal(response.status,200);assert.equal(response.headers.get('x-atlas-protocol-mode'),'native');const value=await response.json();assert.equal(value.model,'logical-model');assert.deepEqual(value.vendor_marker,{preserved:true});assert.equal(requests.length,1);assert.equal(settlements[0].inputTokens,13);assert.equal(settlements[0].cachedInputTokens,4);
 },async(b,r,q)=>{assert.equal(q.url,'/v1/'+p);assert.equal(b.model,'physical-model');assert.equal(b.messages===undefined,p==='responses');send(r,nativeValue(p,b.model));},{TEST_NATIVE_PROTOCOLS:nativeConfig}));
 test(p+' native stream retains event types/fields, never synthesizes DONE, and settles before terminal',()=>gatewayFixture(async({base,settlements})=>{
  const response=await call(base,p,{stream:true});const raw=await response.text(),parsed=events(raw);assert.equal(response.status,200);assert.ok(!raw.includes('physical-model')&&!raw.includes('[DONE]'));assert.equal(parsed.at(-1).type,p==='responses'?'response.completed':'message_stop');assert.equal(settlements[0].usageFinal,true);assert.equal(settlements[0].cachedInputTokens,4);assert.ok(raw.includes('vendor_marker'));
 },async(b,r)=>{streamStart(r);const value=nativeValue(p,b.model);const values=p==='responses'?[{type:'response.created',response:{...value,status:'in_progress',usage:null,output:[]}},{type:'response.output_text.delta',delta:'上海'},{type:'response.completed',response:value}]:[{type:'message_start',message:{...value,content:[],stop_reason:null,usage:{input_tokens:9,cache_read_input_tokens:4,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'上海'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:14}},{type:'message_stop'}];for(const v of values){const bytes=Buffer.from('event: '+v.type+'\r\ndata: '+JSON.stringify(v)+'\r\n\r\n');for(let i=0;i<bytes.length;i+=13){r.write(bytes.subarray(i,i+13));await pause(1);}}r.end();},{TEST_NATIVE_PROTOCOLS:nativeConfig}));
 test(p+' never retries a native HTTP error through the adapter',()=>gatewayFixture(async({base,requests,settlements})=>{const r=await call(base,p);assert.equal(r.status,429);assert.equal((await r.json()).error.type,'rate_limit_error');assert.equal(requests.length,1);assert.equal(settlements[0].outcome,'upstream_error');},async(b,r)=>send(r,{error:{type:'rate_limit_error'}},429),{TEST_NATIVE_PROTOCOLS:nativeConfig}));
 test(p+' streaming cancellation keeps unknown usage pending and never emits terminal success',()=>gatewayFixture(async({base,requests,waitSettlement})=>{const c=new AbortController(),response=await call(base,p,{stream:true},{},c.signal),reader=response.body.getReader();await reader.read();c.abort();await reader.cancel().catch(()=>{});const s=await waitSettlement();assert.equal(s.usageFinal,false);assert.equal(s.outcome,'client_cancelled');assert.equal(requests.length,1);},async(b,r)=>{streamStart(r);streamEvent(r,{choices:[{index:0,delta:{content:'begin'},finish_reason:null}],usage:null});await new Promise(resolve=>r.once('close',resolve));}));
 test(p+' adapted stream tools retain arguments and proper completion events',()=>gatewayFixture(async({base,directory})=>{
  const r=await call(base,p,{stream:true});const raw=await r.text(),parsed=events(raw);assert.equal(parsed.at(-1).type,p==='responses'?'response.completed':'message_stop');const deltas=parsed.filter(e=>e.type===(p==='responses'?'response.function_call_arguments.delta':'content_block_delta'));const args=deltas.map(e=>p==='responses'?e.delta:e.delta.partial_json??'').join('');assert.deepEqual(JSON.parse(args),{text:'上海'});
 },async(b,r)=>{streamStart(r);streamEvent(r,{choices:[{index:0,delta:{tool_calls:[{index:0,id:'call-a',function:{name:'echo',arguments:'{"text":"'}}]},finish_reason:null}]});streamEvent(r,{choices:[{index:0,delta:{tool_calls:[{index:0,function:{arguments:'上海"}'}}]},finish_reason:'tool_calls'}]});streamEvent(r,{choices:[],usage});r.end('data: [DONE]\n\n');}));
 test(p+' suppresses terminal success on durable settlement IO failure',async()=>{
  let resume;const gate=new Promise(r=>resume=r);
  await gatewayFixture(async({base,directory,requests,waitSettlement})=>{
   const requestId='protocol-write-failure-'+p,key=createHash('sha256').update(requestId).digest('hex'),target=join(directory,key+'.json'),saved=target+'.saved';const pending=call(base,p,{stream:true},{'x-request-id':requestId});
   for(let n=0;n<100&&!requests.length;n++)await pause(20);assert.equal(requests.length,1);await rename(target,saved);await mkdir(target);resume();const raw=await(await pending).text();assert.ok(!raw.includes('response.completed')&&!raw.includes('message_stop'));assert.ok(raw.includes('settlement_pending'));await rmdir(target);await rename(saved,target);const settled=await waitSettlement();assert.equal(settled.usageFinal,true);assert.equal(requests.length,1);
  },async(b,r)=>{streamStart(r);streamEvent(r,{choices:[{delta:{content:'上海'},finish_reason:'stop'}]});await gate;streamEvent(r,{choices:[],usage});r.end('data: [DONE]\n\n');});
 });
}
test('unsupported state, unmatched tools and invalid authentication never generate',()=>gatewayFixture(async({base,requests,authorizations})=>{
 assert.equal((await call(base,'responses',{previous_response_id:'cross-user'})).status,400);
 assert.equal((await call(base,'messages',{}, {'x-api-key':'bad'})).status,401);
 assert.equal((await call(base,'messages',{}, {authorization:'Bearer different'})).status,400);
 assert.equal((await call(base,'responses',{input:[{type:'function_call_output',call_id:'unknown',output:'x'}]})).status,400);
 assert.equal(requests.length,0);assert.equal(authorizations.length,1);
},async()=>{}));

for(const p of ['responses','messages'])test(p+' native forwards image tool output and unknown content without rewriting provider fields',()=>gatewayFixture(async({base,requests,settlements})=>{
 const content=[{type:p==='responses'?'input_image':'image',...(p==='responses'?{image_url:'data:image/png;base64,fixture'}:{source:{type:'base64',media_type:'image/png',data:'fixture'}})},{type:'future_block',vendor_marker:{keep:true}}];
 const patch=p==='responses'?{input:[{type:'custom_tool_call_output',call_id:'a',output:content},{type:'future_item',vendor_marker:1}],tools:[{type:'namespace',name:'local',tools:[{type:'function',name:'inspect',parameters:{type:'object'}}]}]}:{messages:[{role:'user',content:[{type:'tool_result',tool_use_id:'a',content}]}]};
 const r=await call(base,p,{...patch,store:undefined,...(p==='responses'?{max_output_tokens:64}:{max_tokens:64})});assert.equal(r.status,200);assert.equal(requests.length,1);
 for(const [key,value]of Object.entries(patch))assert.deepEqual(requests[0][key],value);
 if(p==='responses')assert.equal(requests[0].store,false);
 assert.equal(requests[0][p==='responses'?'max_output_tokens':'max_tokens'],32);
 assert.equal(settlements[0].usageFinal,true);assert.equal(settlements[0].inputTokens,13);
},async(b,r)=>send(r,nativeValue(p,b.model)),{TEST_NATIVE_PROTOCOLS:nativeConfig}));

test('native Messages forwards version and beta headers; Chat fallback rejects unknown versions before dispatch',async()=>{
 await gatewayFixture(async({base,requests})=>{
  const r=await call(base,'messages',{}, {'anthropic-version':'future-version','anthropic-beta':'future-feature'});assert.equal(r.status,200);assert.equal(requests.length,1);
  const missing=await call(base,'messages',{}, {'anthropic-version':''});assert.equal(missing.status,400);assert.equal(requests.length,1);
 },async(b,r,q)=>{assert.equal(q.headers['anthropic-version'],'future-version');assert.equal(q.headers['anthropic-beta'],'future-feature');send(r,nativeValue('messages',b.model));},{TEST_NATIVE_PROTOCOLS:nativeConfig});
 await gatewayFixture(async({base,requests,settlements})=>{
  const r=await call(base,'messages',{}, {'anthropic-version':'future-version'});assert.equal(r.status,400);assert.equal((await r.json()).error.type,'unsupported_version');assert.equal(requests.length,0);assert.equal(settlements[0].forwarded,false);assert.equal(settlements[0].usageFinal,true);
 },async()=>assert.fail('fallback must not dispatch an unknown version'));
});

test('native execution boundaries reject paid and nested tools before admission',()=>gatewayFixture(async({base,requests,authorizations})=>{
 for(const patch of [{store:true},{background:true},{conversation:'c'},{previous_response_id:'r'},{tools:[{type:'file_search'}]},{tools:[{type:'namespace',name:'local',tools:[{type:'mcp'}]}]},{modalities:['audio']},{input:[{type:'function_call_output',call_id:'a',output:[{type:'input_audio',input_audio:{}}]}]}]){
  const r=await call(base,'responses',patch);assert.equal(r.status,400);assert.equal((await r.json()).error.type,'unsupported_parameter');
 }
 assert.equal(requests.length,0);assert.equal(authorizations.length,0);
},async()=>assert.fail('unsupported execution must not dispatch'),{TEST_NATIVE_PROTOCOLS:nativeConfig}));
test('control-plane RPC timeout override is bounded and rejects invalid startup values',async()=>{
 for(const value of ['0','60001','NaN'])await assert.rejects(()=>gatewayFixture(async()=>{},async()=>{},{CONTROL_PLANE_RPC_TIMEOUT_MS:value}),/CONTROL_PLANE_RPC_TIMEOUT_MS/);
 await gatewayFixture(async({base})=>assert.equal((await fetch(base+'/health')).status,200),async()=>{},{CONTROL_PLANE_RPC_TIMEOUT_MS:'15000'});
});
