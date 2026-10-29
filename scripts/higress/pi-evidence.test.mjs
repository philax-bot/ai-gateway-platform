import test from 'node:test';
import assert from 'node:assert/strict';
import {completedSse} from './pi-evidence.mjs';
test('a literal response marker can span multiple SSE events and network lines',()=>{
  const raw=['HIGRESS','_RETRY','_OK'].map(content=>'data: '+JSON.stringify({choices:[{index:0,delta:{content},finish_reason:null}]})).concat('data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:16,completion_tokens:8}}),'data: [DONE]').join('\r\n\r\n');
  assert.equal(raw.includes('HIGRESS_RETRY_OK'),false);
  assert.deepEqual(completedSse(raw),{content:'HIGRESS_RETRY_OK',done:true,finishReason:'stop',usage:{prompt_tokens:16,completion_tokens:8}});
});
test('thinking text, other choices and incomplete streams do not satisfy completion evidence',()=>{
  const raw='data: '+JSON.stringify({choices:[{index:0,delta:{reasoning_content:'HIGRESS_RETRY_OK'}},{index:1,delta:{content:'HIGRESS_RETRY_OK'}}]});
  assert.deepEqual(completedSse(raw),{content:'',done:false,finishReason:null,usage:null});
});
