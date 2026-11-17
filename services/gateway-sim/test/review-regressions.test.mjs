import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,sep,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {chatCompletionsUrl,protocolUrl} from '@ai-gateway/contracts';
import {NativeProtocolOutput} from '../dist/protocol-native.js';
import {ProtocolOutput} from '../dist/protocol-output.js';
import {readMediaInput} from '../dist/media-input.js';
import {MediaGateway} from '../dist/media.js';
import {TraceJournal,RequestTrace} from '../dist/request-trace.js';
import {gatewayFixture} from './http-fixture.mjs';

test('native Messages error retains its error frame without promoting initial usage',()=>{
  const native=new NativeProtocolOutput('messages','logical');native.push({type:'message_start',message:{usage:{input_tokens:9,output_tokens:1,cache_read_input_tokens:4}}});native.push({type:'error',error:{type:'overloaded_error'}});
  assert.equal(native.done,true);assert.equal(native.successful,false);assert.equal(native.usageRaw,'');assert.match(native.complete(),/overloaded_error/);
});
test('native Messages only confirms usage after the final stop-reason delta',()=>{
  for(const final of [false,true]){const native=new NativeProtocolOutput('messages','logical');native.push({type:'message_start',message:{usage:{input_tokens:9,output_tokens:0}}});if(final)native.push({type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:14}});native.push({type:'message_stop'});assert.equal(native.usageRaw!=='',final);}
});
test('a truncated Responses function call remains incomplete and inspectable',()=>{
  const out=new ProtocolOutput('responses','logical'),usage={inputTokens:1,outputTokens:32,cachedInputTokens:0};const value=out.json({choices:[{message:{role:'assistant',tool_calls:[{id:'call-a',type:'function',function:{name:'echo',arguments:'{"text":"'}}]},finish_reason:'length'}]},usage);
  assert.equal(value.status,'incomplete');assert.equal(value.output[0].status,'incomplete');assert.equal(value.output[0].arguments,'{"text":"');assert.match(out.complete(usage),/response.incomplete/);
});
test('an untruncated invalid tool call still fails strict JSON validation',()=>{
  assert.throws(()=>new ProtocolOutput('responses','logical').json({choices:[{message:{tool_calls:[{id:'call-a',function:{name:'echo',arguments:'{"text":"'}}]},finish_reason:'tool_calls'}]},{inputTokens:1,outputTokens:2,cachedInputTokens:0}));
});
test('Chat rejects unreserved multiple choices before authorization or forwarding',()=>gatewayFixture(async({call,requests,authorizations})=>{
  for(const n of [0,2,1.5,'1']){const r=await call({n});assert.equal(r.status,400);assert.match((await r.json()).error.message,/n=1/);}assert.equal(requests.length,0);assert.equal(authorizations.length,0);
},()=>assert.fail('unreserved request must not reach the provider')));
test('versioned provider endpoints preserve api/v3 across Chat and native protocols',()=>{
  assert.equal(chatCompletionsUrl('https://ark.example/api/v3'),'https://ark.example/api/v3/chat/completions');assert.equal(protocolUrl('https://ark.example/api/v3','responses'),'https://ark.example/api/v3/responses');assert.equal(protocolUrl('https://ark.example/api/v3','messages'),'https://ark.example/api/v3/messages');
});
test('media input separates batch Token totals from each input context and rejects poisoned identifiers',async()=>{
  const req=body=>Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]),{headers:{'content-type':'application/json'}});
  const input=await readMediaInput(req({model:'logical',input:[Array(1024).fill(0),Array(8192).fill(0)]}),'embeddings');assert.equal(input.tokens,9216);assert.equal(input.maxInputTokens,8192);
  for(const model of ['x'.repeat(161),'invalid\nmodel'])await assert.rejects(readMediaInput(req({model,prompt:'local'}),'image'),/identifier/);
});
async function temporary(work){const directory=await mkdtemp(join(tmpdir(),'agp-review-fix-'));try{return await work(directory);}finally{const target=await realpath(directory),parent=await realpath(tmpdir());assert.ok(target.startsWith(parent+sep)&&basename(target).startsWith('agp-review-fix-'));await rm(target,{recursive:true,force:true});}}
test('permanently rejected traces are retained separately while valid traces drain',()=>temporary(async directory=>{
  let journal=new TraceJournal(directory);await journal.initialize(async row=>row.requestId==='bad'?400:200);
  try{
    for(const name of ['bad','good']){const trace=new RequestTrace(journal,'POST','/v1/images/generations',name);await trace.mark('accepted');await trace.mark('completed',{status:400});}
    await journal.flush();assert.equal((await journal.status()).pending,0);assert.equal((await journal.status()).rejected,1);assert.equal((await readdir(join(directory,'rejected'))).length,1);
  }finally{await journal.close();}
  journal=new TraceJournal(directory);try{await journal.initialize(async()=>assert.fail('a rejected immutable trace must not reenter the active queue'));assert.equal((await journal.status()).rejected,1);}finally{await journal.close();}
}));
for(const terminal of ['failed','completed'])test(terminal+' video preserves known seconds and leaves missing duration unresolved',()=>temporary(async directory=>{
  await mkdir(join(directory,'media-receipts'));const vendor=createServer((request,response)=>{response.setHeader('content-type','application/json');response.end(JSON.stringify({status:terminal,...(request.url.endsWith('/known')?{seconds:3}:request.url.endsWith('/null')?{seconds:null}:request.url.endsWith('/empty')?{duration:''}:{})}));});await new Promise(done=>vendor.listen(0,'127.0.0.1',done));
  const events=[],jobs=['known','null','empty','missing'].map(upstreamId=>({id:randomUUID(),requestId:randomUUID(),reservationId:randomUUID(),upstreamId,status:'queued',settled:false,revision:0,createdAt:new Date().toISOString(),meterUnit:'per_second',result:null,modelId:'video',purpose:'personal',identity:{subjectId:'local'},route:{kind:'video',baseUrl:`http://127.0.0.1:${vendor.address().port}/v1`}}));
  const media=new MediaGateway({journal:{directory,finalize:async event=>{events.push(event);return true;}},activeUpstreams:new Set(),trace:()=>undefined,send:()=>{},cors:()=>({}),rpc:async(path,body)=>{
    if(path.endsWith('/claim'))return {status:200,value:structuredClone(jobs)};if(path.endsWith('/get'))return {status:200,value:structuredClone(jobs.find(j=>j.id===body.id))};if(path.endsWith('/renew'))return {status:200,value:{renewed:true}};if(path.endsWith('/update')){const job=jobs.find(j=>j.id===body.id);Object.assign(job,body,{finishedAt:new Date().toISOString()});return {status:200,value:{recorded:true}};}assert.fail(path);
  }});
  try{await media.tick();assert.equal(events.length,4);for(const job of jobs){const event=events.find(e=>e.requestId===job.requestId);assert.equal(event.usageFinal,job.upstreamId==='known');if(job.upstreamId==='known')assert.equal(event.meteredUsage.quantity,3);else assert.equal(event.meteredUsage,undefined);}}
  finally{await media.close();vendor.closeAllConnections();await new Promise(done=>vendor.close(done));}
}));
