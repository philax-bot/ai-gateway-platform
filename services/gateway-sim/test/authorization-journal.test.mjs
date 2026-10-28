import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,readdir,readFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {SettlementJournal} from '../dist/journal.js';

const input=()=>({requestId:randomUUID(),idempotencyKey:randomUUID(),admissionAttemptId:randomUUID(),identity:{subjectType:'employee',subjectId:'member',credentialId:'credential'},purpose:'personal',modelId:'model',mode:'chat',policyVersion:'policy',requestFingerprint:'a'.repeat(64)});
const allowed=(request,overrides={})=>({status:200,value:{requestId:request.requestId,admissionAttemptId:request.admissionAttemptId,decision:'allow',reservation:{reservationId:`hold-${request.requestId}`},...overrides}});
async function fixture(work){
  const directory=await mkdtemp(join(tmpdir(),'agp-auth-journal-')),journals=[];
  const newJournal=()=>{const journal=new SettlementJournal(directory);journals.push(journal);return journal;};
  try{await work(directory,newJournal);}finally{
    await Promise.allSettled(journals.map(journal=>journal.close()));
    const physical=await realpath(directory),parent=await realpath(tmpdir());assert.ok(physical.startsWith(parent+sep)&&basename(physical).startsWith('agp-auth-journal-'));await rm(physical,{recursive:true,force:true});
  }
}
test('an active authorization cannot be recovered by the background flusher',()=>fixture(async(directory,newJournal)=>{
  const journal=newJournal();let resolutions=0;await journal.initialize(async()=>200,async request=>{resolutions++;return allowed(request);});
  const request=input();await journal.beginAuthorization(request);await journal.flush();assert.equal(resolutions,0);assert.equal((await journal.status()).authorizing,1);
  await journal.forgetAuthorization(request.admissionAttemptId);assert.equal((await journal.status()).active,0);
}));
test('lost replies resolve the same physical attempt and durably release only its original hold',()=>fixture(async(directory,newJournal)=>{
  const journal=newJournal(),released=[],resolved=[];await journal.initialize(async event=>{released.push(event);return 200;},async request=>{resolved.push(request);return allowed(request);});
  const request=input();await journal.beginAuthorization(request);await journal.deferAuthorization(request.admissionAttemptId);await journal.flush();
  assert.deepEqual(resolved,[request]);assert.equal(released.length,1);assert.equal(released[0].idempotencyKey,`${request.idempotencyKey}:settlement`);
  assert.equal(released[0].reservationId,`hold-${request.requestId}`);assert.equal(released[0].forwarded,false);assert.equal(released[0].usageFinal,true);assert.equal(released[0].actualAmount,0);assert.equal((await journal.status()).queued,0);
  await journal.flush();assert.equal(released.length,1);
}));
test('restart resolves an intent persisted before the original authorization RPC completed',()=>fixture(async(directory,newJournal)=>{
  let journal=newJournal();await journal.initialize(async()=>503);const request=input();await journal.beginAuthorization(request);await journal.close();
  const released=[];journal=newJournal();await journal.initialize(async event=>{released.push(event);return 200;},async retry=>allowed(retry));
  assert.equal(released.length,1);assert.equal((await journal.status()).active,0);assert.equal((await journal.status()).authorizationPending,0);
}));
test('another gateway attempt never releases the original dispatched reservation',()=>fixture(async(directory,newJournal)=>{
  const journal=newJournal(),released=[];await journal.initialize(async event=>{released.push(event);return 200;},async request=>allowed(request,{admissionAttemptId:'other-gateway-owner',replayed:true}));
  const request=input();await journal.beginAuthorization(request);await journal.deferAuthorization(request.admissionAttemptId);await journal.flush();
  assert.equal(released.length,0);assert.equal((await journal.status()).queued,0);assert.deepEqual(await journal.inspect(),[]);
}));
test('legacy ownerless responses block visibly and manual retry preserves the original intent',()=>fixture(async(directory,newJournal)=>{
  const journal=newJournal(),resolved=[],released=[];let legacy=true;
  await journal.initialize(async event=>{released.push(event);return 200;},async request=>{resolved.push(request);return allowed(request,{admissionAttemptId:legacy?undefined:request.admissionAttemptId});});
  const request=input();await journal.beginAuthorization(request);await journal.deferAuthorization(request.admissionAttemptId);await journal.flush();
  assert.equal(released.length,0);assert.equal((await journal.status()).authorizationBlocked,1);
  const items=await journal.inspect(request.requestId);assert.equal(items[0].errorCode,'authorization_owner_unverified');assert.ok(!/identity|requestFingerprint|credential/.test(JSON.stringify(items)));
  legacy=false;await Promise.all([journal.retryAuthorization(request.requestId,request.admissionAttemptId,'owner contract restored'),journal.retryAuthorization(request.requestId,request.admissionAttemptId,'owner contract restored')]);
  assert.deepEqual(resolved,[request,request]);assert.equal(released.length,1);assert.equal((await journal.status()).blocked,0);
}));
test('a failed recovery settlement keeps the immutable release in the normal outbox across restart',()=>fixture(async(directory,newJournal)=>{
  let journal=newJournal();await journal.initialize(async()=>503,async request=>allowed(request));const request=input();await journal.beginAuthorization(request);await journal.deferAuthorization(request.admissionAttemptId);await journal.flush();
  assert.equal((await journal.status()).authorizationPending,0);assert.equal((await journal.status()).queued,1);await journal.close();
  const released=[];journal=newJournal();await journal.initialize(async event=>{released.push(event);return 200;});
  await new Promise(resolve=>setTimeout(resolve,2100));await journal.flush();assert.equal(released.length,1);assert.equal(released[0].idempotencyKey,`${request.idempotencyKey}:settlement`);
}));
test('coexisting dispatch evidence takes precedence over an authorization intent',()=>fixture(async(directory,newJournal)=>{
  let journal=newJournal();await journal.initialize(async()=>503);const request=input();await journal.beginAuthorization(request);
  await journal.admitted({requestId:request.requestId,idempotencyKey:`${request.idempotencyKey}:settlement`,reservationId:`hold-${request.requestId}`,outcome:'rejected_before_upstream',forwarded:false,usageFinal:true,completedAt:new Date().toISOString()});await journal.dispatched(request.requestId);await journal.close();
  const events=[];journal=newJournal();await journal.initialize(async event=>{events.push(event);return 200;},async retry=>allowed(retry));
  assert.equal(events.length,1);assert.equal(events[0].forwarded,true);assert.equal(events[0].usageFinal,false);assert.equal(events[0].outcome,'partial');
}));
test('authorization IO failure happens before an intent can be used, without losing another attempt',()=>fixture(async(directory,newJournal)=>{
  const journal=newJournal();await journal.initialize(async()=>200);const request=input();
  const key=createHash('sha256').update(request.admissionAttemptId).digest('hex');await mkdir(join(directory,'authorizations',`${key}.json`));await assert.rejects(journal.beginAuthorization(request));
  const files=await readdir(join(directory,'authorizations'));assert.ok(!files.some(file=>file.endsWith('.json')&&file!==`${key}.json`));
}));
test('journaled authorization contains no prompt, API key or request body',()=>fixture(async(directory,newJournal)=>{
  const journal=newJournal();await journal.initialize(async()=>200);const request=input();await journal.beginAuthorization(request);
  const [name]=(await readdir(join(directory,'authorizations'))).filter(name=>name.endsWith('.json'));const text=await readFile(join(directory,'authorizations',name),'utf8');assert.deepEqual(JSON.parse(text).input,request);assert.ok(!/apiKey|messages|content|Bearer/.test(text));
}));
