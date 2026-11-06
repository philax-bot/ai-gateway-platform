import test from 'node:test';
import assert from 'node:assert/strict';
import {gatewayFixture,send,usage} from './http-fixture.mjs';

for(const protocol of ['chat','messages','responses'])test(protocol+' estimates structured image input without counting Base64 or wrapping JSON twice',()=>gatewayFixture(async({base,call,authorizations,requests,waitSettlement})=>{
  const data='A'.repeat(1268236);
  const image=protocol==='chat'?{type:'image_url',image_url:{url:'data:image/png;base64,'+data}}:protocol==='messages'?{type:'image',source:{type:'base64',media_type:'image/png',data}}:{type:'input_image',image_url:'data:image/png;base64,'+data};
  const content=[{type:protocol==='responses'?'input_text':'text',text:'Describe this image.'},image];
  const messages=[{role:'user',content}];
  const patch=protocol==='responses'?{input:messages,max_output_tokens:32000,store:false}:{messages,max_tokens:32000};
  const r=protocol==='chat'?await call(patch):await fetch(base+'/v1/'+protocol,{method:'POST',headers:{authorization:'Bearer http-test-key','content-type':'application/json','anthropic-version':'2023-06-01'},body:JSON.stringify({model:'logical-model',...patch})});
  assert.equal(r.status,200);await r.text();
  assert.ok(authorizations[0].estimatedInputTokens>8192);assert.ok(authorizations[0].estimatedInputTokens<10000);
  assert.equal(authorizations[0].maxOutputTokens,32000);
  assert.deepEqual(requests[0][protocol==='responses'?'input':'messages'],messages);
  assert.equal((await waitSettlement()).inputTokens,13);
},async(b,r)=>send(r,protocol==='chat'?{model:b.model,choices:[{message:{role:'assistant',content:'OK'},finish_reason:'stop'}],usage}:protocol==='responses'?{object:'response',model:b.model,status:'completed',output:[],usage:{input_tokens:13,output_tokens:14}}:{id:'msg-test',type:'message',model:b.model,content:[{type:'text',text:'OK'}],stop_reason:'end_turn',usage:{input_tokens:13,output_tokens:14}}),{TEST_NATIVE_PROTOCOLS:JSON.stringify({messages:{status:'supported'},responses:{status:'supported'}})}));
