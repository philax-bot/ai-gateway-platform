import test from 'node:test';
import assert from 'node:assert/strict';
import {IsolatedFilePublisher} from './file-publisher.mjs';
import {ingress} from './poc-config.mjs';

test('copy success remains pending until the running data plane observes the requested version',async()=>{
  let releaseProbe;const gate=new Promise(resolve=>{releaseProbe=resolve;});
  const publisher=new IsolatedFilePublisher({write:async()=>{},probe:async()=>{await gate;return {ok:true,version:'v2'};}});
  const work=publisher.publish(ingress('v2'),{idempotencyKey:'new'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(publisher.operations[0].status,'pending');assert.equal(publisher.appliedVersion,null);
  releaseProbe();assert.equal((await work).appliedVersion,'v2');assert.equal(publisher.appliedVersion,'v2');
});

test('an unusable runtime retains the last working version and supports an explicit rollback',async()=>{
  let observed='v1',ok=true,writes=0;
  const publisher=new IsolatedFilePublisher({write:async()=>{writes++;},probe:async()=>({ok,version:observed})});
  await publisher.publish(ingress(),{idempotencyKey:'initial'});
  observed='v2';ok=false;
  const failed=await publisher.publish(ingress('v2',{unavailable:true}),{idempotencyKey:'broken',timeoutMs:1});
  assert.equal(failed.status,'rejected');assert.equal(failed.observedVersion,'v2');assert.equal(failed.appliedVersion,'v1');
  assert.equal(await publisher.publish(ingress('v2',{unavailable:true}),{idempotencyKey:'broken'}),failed);assert.equal(writes,2);
  await assert.rejects(publisher.publish(ingress('v3'),{idempotencyKey:'broken'}),/idempotency conflict/);
  observed='v1';ok=true;assert.equal((await publisher.publish(ingress(),{idempotencyKey:'rollback'})).status,'applied');
});

test('a failed configuration write cannot be marked applied',async()=>{
  const publisher=new IsolatedFilePublisher({write:async()=>{throw new Error('unavailable');},probe:async()=>{throw new Error('must not probe');}});
  const operation=await publisher.publish(ingress(),{idempotencyKey:'failed-write'});
  assert.equal(operation.status,'rejected');assert.equal(operation.appliedVersion,null);
  await assert.rejects(publisher.publish(ingress()),/idempotency key required/);
});
