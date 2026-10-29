import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveBudget} from './octop-live-config.mjs';
const price={inputPrice:2,outputPrice:8,cachedInputPrice:.2},body={messages:[{role:'user',content:'test'}],max_tokens:128};
test('budget reserves synchronously and refuses excess attempts without incrementing',()=>{const b=new LiveBudget(price,1,1);b.reserve(body);assert.throws(()=>b.reserve(body));assert.equal(b.attempts,1);});
test('budget rejects cost overflow, unknown output and oversized output before dispatch',()=>{const b=new LiveBudget(price,12,.000001);assert.throws(()=>b.reserve(body));assert.equal(b.attempts,0);for(const max of [undefined,0,1025,1.5])assert.throws(()=>new LiveBudget(price).reserve({...body,max_tokens:max}));});
