import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { SettlementJournal } from '../dist/journal.js';

const event=()=>({requestId:crypto.randomUUID(),idempotencyKey:crypto.randomUUID(),reservationId:crypto.randomUUID(),outcome:'completed',usageFinal:true,inputTokens:10,outputTokens:8,cachedInputTokens:0,completedAt:new Date().toISOString()});
async function fixture(work){
  const directory=await mkdtemp(join(tmpdir(),'agp-journal-')),journals=[];
  try{await work(directory,()=>{const j=new SettlementJournal(directory);journals.push(j);return j;});}
  finally{
    await Promise.allSettled(journals.map(j=>j.close()));
    const physical=await realpath(directory),parent=await realpath(tmpdir());
    assert.ok(physical.startsWith(parent+sep)&&basename(physical).startsWith('agp-journal-'));
    await rm(physical,{recursive:true,force:true});
  }
}
test('restart releases an admission durably known not to have been dispatched',()=>fixture(async(directory,newJournal)=>{
  let j=newJournal();await j.initialize(async()=>503);const input=event();await j.admitted(input);await j.close();
  const received=[];j=newJournal();await j.initialize(async e=>{received.push(e);return 200;});
  assert.equal(received.length,1);assert.equal(received[0].outcome,'rejected_before_upstream');assert.equal(received[0].usageFinal,true);assert.deepEqual(await j.status(),{queued:0,blocked:0,active:0});
}));
test('restart preserves unknown usage after durable dispatch rather than releasing the hold',()=>fixture(async(directory,newJournal)=>{
  let j=newJournal();await j.initialize(async()=>503);const input=event();await j.admitted(input);await j.dispatched(input.requestId);await j.close();
  const received=[];j=newJournal();await j.initialize(async e=>{received.push(e);return 200;});
  assert.equal(received[0].outcome,'partial');assert.equal(received[0].usageFinal,false);
}));
test('a failed final settlement survives restart and is retried with the original idempotency key',()=>fixture(async(directory,newJournal)=>{
  let j=newJournal();await j.initialize(async()=>503);const input=event();assert.equal(await j.finalize(input),false);await j.close();
  const files=(await readdir(directory)).filter(f=>f.endsWith('.json'));assert.equal(files.length,1);
  assert.deepEqual(JSON.parse(await readFile(join(directory,files[0]),'utf8')).settlement,input);
  const received=[];j=newJournal();await j.initialize(async e=>{received.push(e);return 200;});
  await new Promise(resolve=>setTimeout(resolve,2100));await j.flush();
  assert.equal(received.length,1);assert.equal(received[0].idempotencyKey,input.idempotencyKey);assert.equal((await j.status()).queued,0);
}));
test('a permanent contract rejection remains inspectable and is not blindly retried',()=>fixture(async(directory,newJournal)=>{
  const j=newJournal();let calls=0;await j.initialize(async()=>{calls++;return 409;});assert.equal(await j.finalize(event()),false);await j.flush();
  assert.equal(calls,1);assert.equal((await j.status()).blocked,1);
}));
test('a live writer lock is respected',()=>fixture(async(directory,newJournal)=>{
  const first=newJournal();await first.initialize(async()=>200);
  const second=newJournal();await assert.rejects(second.initialize(async()=>200),/running process/);
}));
test('a prior runtime with a reused PID does not block a single-instance container restart',()=>fixture(async(directory,newJournal)=>{
  await writeFile(join(directory,'writer.lock'),JSON.stringify({pid:process.pid,runtimeToken:'previous-single-instance-runtime'}));
  const journal=newJournal();await journal.initialize(async()=>200);assert.equal((await journal.status()).queued,0);
}));
