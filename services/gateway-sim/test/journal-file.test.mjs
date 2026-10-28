import test from 'node:test';
import assert from 'node:assert/strict';
import {replaceJournalFile} from '../dist/journal-file.js';

test('transient replacement denial retries the same source/target instead of losing the final event',async()=>{
  let attempts=0;const calls=[];
  await replaceJournalFile('fsynced.tmp','last.json',async(source,target)=>{calls.push([source,target]);if(++attempts<3)throw Object.assign(new Error('brief reader lock'),{code:'EPERM'});});
  assert.equal(attempts,3);assert.deepEqual(calls,[['fsynced.tmp','last.json'],['fsynced.tmp','last.json'],['fsynced.tmp','last.json']]);
});
test('permanent storage faults are not blindly retried',async()=>{
  let attempts=0;await assert.rejects(replaceJournalFile('fsynced.tmp','last.json',async()=>{attempts++;throw Object.assign(new Error('disk error'),{code:'EIO'});}),{code:'EIO'});assert.equal(attempts,1);
});
