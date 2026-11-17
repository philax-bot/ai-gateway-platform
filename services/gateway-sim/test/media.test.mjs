import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,mkdir,readdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {modelEndpoint,meteredQuantity} from '@ai-gateway/contracts';
import {readMediaInput,mediaTokenUsage,validMediaResponse} from '../dist/media-input.js';
import {MediaGateway,controlledMediaTarget} from '../dist/media.js';

test('video cancellation recovers pre-dispatch failures, uncertain transport and legacy markers without resubmitting generation',async()=>{
  let behavior='drop',supplierRequests=0,credentialAvailable=false;
  const supplier=createServer((request,response)=>{supplierRequests++;assert.equal(request.method,'POST');assert.ok(request.url.endsWith('/cancel'));if(behavior==='drop'){request.socket.destroy();return;}response.writeHead(behavior==='reject'?409:200,{'content-type':'application/json'});response.end(JSON.stringify({status:'in_progress'}));});
  await new Promise(resolve=>supplier.listen(0,'127.0.0.1',resolve));
  try{
    const identity={subjectType:'employee',subjectId:'cancel-user',credentialId:'cancel-key',organizationId:'org-demo',projectId:null};
    const job={id:randomUUID(),requestId:randomUUID(),reservationId:randomUUID(),identity,purpose:'personal',modelId:'video-model',status:'in_progress',upstreamId:'vendor-job',result:null,route:{baseUrl:`http://127.0.0.1:${supplier.address().port}/v1`,credential:{id:'managed',version:1},videoCancellation:{method:'POST',path:'/v1/videos/{id}/cancel'}}};
    const replies=[],context={activeUpstreams:new Set(),journal:{directory:tmpdir()},trace:()=>undefined,cors:()=>({}),send:(_response,status,value)=>replies.push({status,value}),rpc:async(path,body)=>{
      if(path.endsWith('/credentials/resolve'))return {status:200,value:{identity,purpose:'personal'}};
      if(path.endsWith('/upstream/resolve'))return {status:credentialAvailable?200:503,value:{secret:'local-fixture'}};
      if(path.endsWith('/get'))return {status:200,value:structuredClone(job)};
      if(path.endsWith('/cancel/claim')){if(job.cancelOperation&&Date.parse(job.cancelOperation.expiresAt)>Date.now())return {status:200,value:{claimed:false,job:structuredClone(job)}};job.cancelOperation={token:body.token,expiresAt:new Date(Date.now()+30000).toISOString()};job.result={...job.result,cancel_requested:true,cancel_uncertain:true};return {status:200,value:{claimed:true,job:structuredClone(job)}};}
      if(path.endsWith('/update')){Object.assign(job,structuredClone(body));if(body.cancelToken)delete job.cancelOperation;return {status:200,value:{recorded:true}};}
      assert.fail('cancellation must not create another generation or reservation: '+path);
    }};
    const request={headers:{authorization:'Bearer local'}};
    await new MediaGateway(context).cancel(request,{},job.id);
    assert.equal(replies.at(-1).status,503);assert.equal(job.result,null);assert.equal(supplierRequests,0);
    credentialAvailable=true;
    await new MediaGateway(context).cancel(request,{},job.id);
    assert.equal(replies.at(-1).value.error.type,'video_cancellation_unknown');assert.deepEqual(job.result,{cancel_requested:true,cancel_uncertain:true});assert.equal(supplierRequests,1);
    await new MediaGateway(context).cancel(request,{},job.id);assert.equal(replies.at(-1).status,409);assert.equal(supplierRequests,1);job.cancelOperation.expiresAt=new Date(Date.now()-1).toISOString();
    behavior='reject';
    await new MediaGateway(context).cancel(request,{},job.id);
    assert.equal(replies.at(-1).status,502);assert.equal(job.result.cancel_requested,false);assert.equal(supplierRequests,2);
    job.result={cancel_requested:true};behavior='success';
    await new MediaGateway(context).cancel(request,{},job.id);
    assert.equal(replies.at(-1).status,200);assert.equal(job.result.cancel_uncertain,false);assert.equal(supplierRequests,3);
    await new MediaGateway(context).cancel(request,{},job.id);
    assert.equal(replies.at(-1).status,200);assert.equal(supplierRequests,3,'confirmed cancellation is not sent twice');assert.equal(context.activeUpstreams.size,0);
  }finally{await new Promise(resolve=>supplier.close(resolve));}
});
test('modality endpoints preserve controlled hosts and handle native video/rerank paths',()=>{
  assert.equal(modelEndpoint('https://api.example/v1/chat/completions','image'),'https://api.example/v1/images/generations');
  assert.equal(modelEndpoint('https://api.example/v2','rerank','cohere'),'https://api.example/v2/rerank');
  assert.equal(modelEndpoint('https://api.example/api/v3','video','volcengine','', 'job-1'),'https://api.example/api/v3/contents/generations/tasks/job-1');
  assert.equal(modelEndpoint('https://api.example/v1','video','xai'),'https://api.example/v1/videos/generations');
  assert.equal(modelEndpoint('https://api.example/v1','video','openai','/custom/tasks/{id}','a/b'),'https://api.example/custom/tasks/a%2Fb');
  assert.throws(()=>modelEndpoint('https://secret@api.example/v1','tts'));assert.throws(()=>modelEndpoint('https://api.example','video','openai','//uncontrolled.example/task'));assert.throws(()=>modelEndpoint('https://api.example','image','openai','/../private'));
});
test('input parsing counts Unicode characters and token arrays; ASR preserves multipart files',async()=>{
  const json=body=>Object.assign(Readable.from([Buffer.from(JSON.stringify({model:'logical',...body}))]),{headers:{'content-type':'application/json'}});
  const tts=await readMediaInput(json({input:'你好🙂',voice:'alloy'}),'tts');assert.equal(tts.units,3);
  assert.equal((await readMediaInput(json({input:[[1,2],[3,4,5]]}),'embeddings')).tokens,5);
  await assert.rejects(readMediaInput(json({prompt:'image',n:0}),'image'));await assert.rejects(readMediaInput(json({query:'query',documents:[]}),'rerank'));
  const form=new FormData();form.set('model','logical');form.set('file',new Blob(['local audio'],{type:'audio/wav'}),'sample.wav');const req=new Request('http://local',{method:'POST',body:form}),raw=Buffer.from(await req.arrayBuffer()),input=await readMediaInput(Object.assign(Readable.from([raw]),{headers:{'content-type':req.headers.get('content-type')}}),'asr');
  assert.equal(input.form.get('file').size,11);assert.equal(input.form.get('response_format'),'verbose_json');assert.equal(input.units,undefined);
});
test('authoritative modality usage does not invent tokens or duration, or accept a JSON error as audio',()=>{
  assert.deepEqual(mediaTokenUsage({usage:{prompt_tokens:12,total_tokens:12}}),{inputTokens:12,outputTokens:0,cachedInputTokens:0});
  assert.equal(mediaTokenUsage({meta:{billed_units:{search_units:1}}}),null);assert.equal(meteredQuantity('per_second','asr',{text:'no duration'},999),null);
  assert.equal(meteredQuantity('per_second','asr',{duration:1.12345678}),1.123457);assert.equal(meteredQuantity('per_image','image',{data:[{},{}]}),2);
  assert.equal(validMediaResponse('tts',{error:{message:'failed'}},'application/json',100),false);assert.equal(validMediaResponse('tts',null,'audio/wav',100),true);assert.equal(validMediaResponse('embeddings',{data:[{embedding:[0.1]}]},'application/json',10),true);
});
test('media receipt recovery keeps a lost acknowledgement durable and never resubmits a generation',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'agp-media-'));let media,available=false;const received=[],id=randomUUID();
  try{
    await mkdir(join(directory,'media-receipts'));const receipt={id,upstreamId:'vendor-task-123',status:'queued',result:null};await writeFile(join(directory,'media-receipts',id+'.tmp'),JSON.stringify(receipt));
    const context={journal:{directory,finalize:()=>{throw Error('unexpected settlement');}},activeUpstreams:new Set(),trace:()=>undefined,send:()=>{},cors:()=>({}),rpc:async(path,body)=>{assert.ok(path.endsWith('/receipt'),'recovery only delivers the accepted receipt');received.push(body);return {status:available?200:503,value:{recorded:available}};}};
    media=new MediaGateway(context);await media.initialize();assert.equal((await media.status()).pendingReceipts,1);await media.close();available=true;
    media=new MediaGateway(context);await media.initialize();assert.equal((await media.status()).pendingReceipts,0);assert.deepEqual(received,[receipt,receipt]);assert.deepEqual(await readdir(join(directory,'media-receipts')),[]);
  }finally{await media?.close();const path=await realpath(directory),parent=await realpath(tmpdir());assert.ok(path.startsWith(parent+sep)&&path.split(/[\\/]/).at(-1).startsWith('agp-media-'));await rm(path,{recursive:true,force:true});}
});
test('controlled media forwarding requires the existing explicit external opt-in',()=>{
  const previous=process.env.ALLOW_UPSTREAM_REQUESTS;process.env.ALLOW_UPSTREAM_REQUESTS='false';try{const route={baseUrl:'https://api.example/v1',credentialRef:null};assert.throws(()=>controlledMediaTarget(route,'image'),/disabled/);assert.ok(controlledMediaTarget({...route,baseUrl:'http://127.0.0.1:4010'},'image').url.startsWith('http://127.0.0.1:4010/'));}finally{if(previous===undefined)delete process.env.ALLOW_UPSTREAM_REQUESTS;else process.env.ALLOW_UPSTREAM_REQUESTS=previous;}
});
