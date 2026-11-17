import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readdir,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,sep} from 'node:path';
import {TraceJournal,RequestTrace} from '../dist/request-trace.js';
import {otlpExporter} from '../dist/otlp-trace.js';
import {createServer} from 'node:http';
import {gatewayFixture,usage,pause} from './http-fixture.mjs';

test('trace journal recovers interrupted attempts and retries delivery without changing identity or losing the final snapshot',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'agp-trace-'));let journal;
  try{
    journal=new TraceJournal(directory);await journal.initialize(async()=>503);
    const trace=new RequestTrace(journal,'POST','/v1/chat/completions','logical-request',`00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`);
    await trace.mark('accepted');await trace.mark('authenticated',{identity:{subjectType:'employee',subjectId:'user',credentialId:'key'}});await journal.close();
    const received=[];journal=new TraceJournal(directory);await journal.initialize(async row=>{received.push(row);return 200;});
    assert.equal(received.length,1);assert.equal(received[0].traceId,'a'.repeat(32));assert.equal(received[0].parentSpanId,'b'.repeat(16));assert.equal(received[0].errorCode,'gateway_restarted');assert.equal(received[0].stages.at(-1).stage,'interrupted');
    assert.deepEqual((await readdir(directory)).filter(n=>n.endsWith('.json')),[]);
  }finally{await journal?.close();const target=await realpath(directory),parent=await realpath(tmpdir());assert.ok(target.startsWith(parent+sep)&&target.split(/[\\/]/).at(-1).startsWith('agp-trace-'));await rm(target,{recursive:true,force:true});}
});

test('real gateway records early JSON/auth failures and successful routing without bodies or keys, forwards W3C context',async()=>{
  let upstreamHeaders;
  await gatewayFixture(async({base,call,directory,traces})=>{
    const malformed=await fetch(base+'/v1/chat/completions',{method:'POST',body:'broken'});assert.equal(malformed.status,400);assert.ok(malformed.headers.get('x-request-id'));assert.match(malformed.headers.get('x-trace-id'),/^[a-f0-9]{32}$/);
    const unauthorized=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer private-secret'},body:JSON.stringify({model:'logical-model',messages:[]})});assert.equal(unauthorized.status,401);
    const good=await call({},undefined,{traceparent:`00-${'c'.repeat(32)}-${'d'.repeat(16)}-01`});assert.equal(good.status,200);await good.text();
    for(let i=0;i<100&&!(traces.some(t=>t.completedAt&&t.traceId==='c'.repeat(32))&&traces.some(t=>t.status===400)&&traces.some(t=>t.status===401));i++)await pause(40);
    const success=traces.findLast(t=>t.completedAt&&t.traceId==='c'.repeat(32));assert.ok(success);assert.equal(success.route.serviceId,'test-service');assert.equal(success.identity.subjectId,'test-user');assert.ok(success.stages.some(s=>s.stage==='settled'));
    assert.ok(traces.some(t=>t.status===400&&t.identity===null));assert.ok(traces.some(t=>t.status===401&&t.identity===null));
    assert.match(upstreamHeaders.traceparent,new RegExp(`^00-${'c'.repeat(32)}-`));assert.ok(!JSON.stringify(traces).includes('private-secret'));assert.ok(!JSON.stringify(traces).includes('local test'));
  },async(body,response,request)=>{upstreamHeaders=request.headers;response.writeHead(200,{'content-type':'application/json','x-request-id':'upstream-trace'});response.end(JSON.stringify({model:body.model,choices:[{message:{content:'ok'}}],usage}));});
});

test('fsynced terminal temporary snapshot survives restart and OTLP exports a real parent-linked span without sensitive payload',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'agp-trace-'));let journal;const received=[];
  const collector=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;received.push(JSON.parse(raw));res.writeHead(200,{'content-type':'application/json'});res.end('{}');});
  await new Promise(resolve=>collector.listen(0,'127.0.0.1',resolve));
  try{
    journal=new TraceJournal(directory);await journal.initialize(async()=>503);
    const trace=new RequestTrace(journal,'POST','/v1/chat/completions','otlp-test',`00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`);await trace.mark('accepted');await journal.close();
    const at=new Date().toISOString(),terminal={...trace.row,revision:2,completedAt:at,updatedAt:at,status:401,errorCode:'authentication_error',stages:[...trace.row.stages,{stage:'completed',at}]};
    await writeFile(join(directory,`${trace.row.attemptId}.12345678-1234-1234-1234-123456789012.tmp`),JSON.stringify(terminal));
    const send=otlpExporter(`http://127.0.0.1:${collector.address().port}/v1/traces`);journal=new TraceJournal(directory);await journal.initialize(async row=>await send(row)?200:503);
    assert.equal(received.length,1);const span=received[0].resourceSpans[0].scopeSpans[0].spans[0];assert.equal(span.parentSpanId,'b'.repeat(16));assert.equal(span.status.code,2);assert.equal(span.events.at(-1).name,'completed');assert.match(span.endTimeUnixNano,/^\d+$/);assert.equal((await readdir(directory)).filter(f=>f.endsWith('.json')).length,0);
  }finally{await journal?.close();await new Promise(resolve=>collector.close(resolve));const physical=await realpath(directory),parent=await realpath(tmpdir());assert.ok(physical.startsWith(parent+sep)&&physical.split(/[\\/]/).at(-1).startsWith('agp-trace-'));await rm(physical,{recursive:true,force:true});}
});
