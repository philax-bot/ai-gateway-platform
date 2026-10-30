import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeProtocolRequest as normalize}from'../dist/protocol-input.js';
import {ProtocolOutput}from'../dist/protocol-output.js';
import {NativeProtocolOutput}from'../dist/protocol-native.js';
const usage={inputTokens:13,outputTokens:14,cachedInputTokens:4};
const events=raw=>raw.split('\n\n').filter(Boolean).map(e=>JSON.parse(e.split('\n').find(l=>l.startsWith('data:')).slice(5)));
test('Responses maps instructions, full tool history, limits and tool choice without inventing state',()=>{
 const request={model:'logical',instructions:'system',max_output_tokens:32,store:false,tools:[{type:'function',name:'echo',parameters:{type:'object'}}],tool_choice:{type:'function',name:'echo'},input:[{role:'user',content:[{type:'input_text',text:'echo'}]},{type:'function_call',call_id:'c',name:'echo',arguments:'{"text":"上海"}'},{type:'function_call_output',call_id:'c',output:'上海'}]};
 const chat=normalize('responses',request);assert.equal(chat.max_tokens,32);assert.deepEqual(chat.messages.map(m=>m.role),['system','user','assistant','tool']);assert.equal(chat.messages[2].tool_calls[0].id,'c');assert.equal(chat.tool_choice.function.name,'echo');
 assert.doesNotThrow(()=>normalize('responses',{...request,input:[{type:'message',role:'assistant',content:[{type:'output_text',text:'tool follows',annotations:[],logprobs:[]}]},...request.input.slice(1)]}));
 for(const patch of [{previous_response_id:'other'},{store:true},{background:true},{conversation:'other'},{tools:[{type:'web_search'}]},{input:[{role:'user',content:[{type:'input_image',image_url:'x'}]}]}])assert.throws(()=>normalize('responses',{...request,...patch}));
});
test('Messages maps parallel tools, tool results and provider hints; native controls never silently fall back',()=>{
 const body={model:'logical',max_tokens:32,system:[{type:'text',text:'system',cache_control:{type:'ephemeral'}}],tools:[{name:'echo',input_schema:{type:'object'}}],tool_choice:{type:'any',disable_parallel_tool_use:true},messages:[{role:'user',content:'echo'},{role:'assistant',content:[{type:'tool_use',id:'a',name:'echo',input:{}},{type:'tool_use',id:'b',name:'echo',input:{}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'a',content:'A'},{type:'tool_result',tool_use_id:'b',content:'B',is_error:true},{type:'text',text:'continue'}]}]};
 const chat=normalize('messages',body);assert.equal(chat.parallel_tool_calls,false);assert.equal(chat.tool_choice,'required');const results=chat.messages.filter(m=>m.role==='tool');assert.equal(results[1].tool_call_id,'b');assert.ok(results[1].content.includes('Tool execution error'));assert.equal(chat.messages.at(-1).content,'continue');
 assert.throws(()=>normalize('messages',{...body,thinking:{type:'enabled',budget_tokens:1024}}));assert.doesNotThrow(()=>normalize('messages',{...body,thinking:{type:'enabled',budget_tokens:1024}},true));
 assert.throws(()=>normalize('messages',{...body,messages:[{role:'user',content:[{type:'tool_result',tool_use_id:'unknown',content:'x'}]}]}));
});
test('native inspection accepts provider custom tools and encrypted reasoning without converting them to Chat',()=>{
 const body={model:'logical',input:[{type:'reasoning',encrypted_content:'opaque'},{type:'custom_tool_call',call_id:'patch-1',name:'apply_patch',input:'patch text'},{type:'custom_tool_call_output',call_id:'patch-1',output:'done'}],tools:[{type:'custom',name:'apply_patch',format:{type:'text'}}],include:['reasoning.encrypted_content'],store:false};const original=structuredClone(body);assert.doesNotThrow(()=>normalize('responses',body,true));assert.deepEqual(body,original);assert.throws(()=>normalize('responses',body));
});
for(const protocol of ['responses','messages'])test(protocol+' adapter streams text/tool deltas and emits terminal only at completion',()=>{
 const out=new ProtocolOutput(protocol,'logical');let raw=out.start();raw+=out.push({choices:[{index:0,delta:{content:'上海'}}]});raw+=out.push({choices:[{index:0,delta:{tool_calls:[{index:0,id:'a',function:{name:'echo',arguments:'{"text":"'}}]}}]});raw+=out.push({choices:[{index:0,delta:{tool_calls:[{index:0,function:{arguments:'上海"}'}}]},finish_reason:'tool_calls'}]});
 assert.ok(!raw.includes('response.completed')&&!raw.includes('message_stop'));raw+=out.complete(usage);const parsed=events(raw);assert.equal(parsed.at(-1).type,protocol==='responses'?'response.completed':'message_stop');assert.ok(!raw.includes('[DONE]'));
 if(protocol==='responses'){const final=parsed.at(-1).response;assert.equal(final.output[1].call_id,'a');assert.equal(final.usage.input_tokens,13);assert.equal(final.usage.input_tokens_details.cached_tokens,4);assert.deepEqual(parsed.map(e=>e.sequence_number),parsed.map((_,i)=>i));}else{const final=parsed.find(e=>e.type==='message_delta');assert.equal(final.usage.input_tokens,9);assert.equal(final.usage.cache_read_input_tokens,4);assert.equal(final.delta.stop_reason,'tool_use');}
});
test('truncation remains incomplete and invalid tool JSON is never reported as complete',()=>{
 const out=new ProtocolOutput('responses','logical');out.push({choices:[{delta:{content:'cut'},finish_reason:'length'}]});assert.equal(events(out.complete(usage)).at(-1).type,'response.incomplete');
 const bad=new ProtocolOutput('messages','logical');bad.push({choices:[{delta:{tool_calls:[{index:0,id:'a',function:{name:'echo',arguments:'{'}}]},finish_reason:'tool_calls'}]});assert.throws(()=>bad.validate());assert.equal(events(bad.fail('invalid_response')).at(-1).type,'error');
});
for(const protocol of ['responses','messages'])test(protocol+' native observer preserves provider fields and normalizes only trusted usage',()=>{
 const out=new NativeProtocolOutput(protocol,'logical');const start=protocol==='responses'?{type:'response.created',response:{model:'physical',vendor:{v:1}}}:{type:'message_start',message:{model:'physical',vendor:{v:1},usage:{input_tokens:9,cache_read_input_tokens:4,output_tokens:0}}};const raw=out.push(start);assert.ok(raw.includes('"model":"logical"'));assert.ok(raw.includes('"vendor":{"v":1}'));assert.equal(out.done,false);
 if(protocol==='messages')out.push({type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:14}});
 const terminal=protocol==='responses'?{type:'response.completed',response:{model:'physical',usage:{input_tokens:13,output_tokens:14,input_tokens_details:{cached_tokens:4}},vendor:{v:2}}}:{type:'message_stop'};assert.equal(out.push(terminal),'');assert.equal(out.successful,true);assert.deepEqual(out.usage,usage);assert.ok(out.complete().includes(protocol==='responses'?'response.completed':'message_stop'));assert.throws(()=>out.push({type:'ping'}));
});
