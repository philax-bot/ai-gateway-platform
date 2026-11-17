import test from 'node:test';
import assert from 'node:assert/strict';
import {gatewayFixture,send,usage} from './http-fixture.mjs';

for(const protocol of ['chat','responses','messages'])for(const native of [false,true]){
  if(protocol==='chat'&&!native)continue;
  test(`${protocol} ${native?'native':'adapted'} preserves output options independently of reservation`,()=>gatewayFixture(async({base,call,requests,authorizations})=>{
    const field=protocol==='responses'?'max_output_tokens':'max_tokens';
    const values=protocol==='messages'?[80000]:[undefined,null,80000];
    for(const value of values){
      const payload={model:'logical-model',...(protocol==='responses'?{input:'Hi'}:{messages:[{role:'user',content:'Hi'}]}),...(value===undefined?{}:{[field]:value})};
      const r=protocol==='chat'?await call(payload):await fetch(`${base}/v1/${protocol}`,{method:'POST',headers:{authorization:'Bearer http-test-key','content-type':'application/json','anthropic-version':'2023-06-01'},body:JSON.stringify(payload)});
      assert.equal(r.status,200);await r.text();
      assert.equal(authorizations.at(-1).maxOutputTokens,value??undefined);
      const forwarded=requests.at(-1),forwardedField=native?field:'max_tokens';
      if(value==null){assert.ok(forwarded[forwardedField]==null);assert.ok(forwarded.max_completion_tokens==null);}
      else assert.equal(forwarded[forwardedField],80000);
    }
    if(protocol==='chat'){
      const r=await call({max_completion_tokens:80000});assert.equal(r.status,200);await r.text();
      assert.equal(requests.at(-1).max_completion_tokens,80000);assert.ok(!('max_tokens' in requests.at(-1)));
    }
    if(protocol==='messages'){
      const r=await fetch(`${base}/v1/messages`,{method:'POST',headers:{authorization:'Bearer http-test-key','content-type':'application/json','anthropic-version':'2023-06-01'},body:JSON.stringify({model:'logical-model',messages:[{role:'user',content:'Hi'}]})});
      assert.equal(r.status,400);assert.equal(requests.length,1);
    }
  },async(b,r)=>send(r,!native||protocol==='chat'?{model:b.model,choices:[{message:{role:'assistant',content:'OK'},finish_reason:'stop'}],usage}:protocol==='responses'?{object:'response',model:b.model,status:'completed',output:[],usage:{input_tokens:13,output_tokens:14}}:{id:'msg-test',type:'message',model:b.model,content:[{type:'text',text:'OK'}],stop_reason:'end_turn',usage:{input_tokens:13,output_tokens:14}}),{TEST_NO_OUTPUT_CAP:'true',...(native?{TEST_NATIVE_PROTOCOLS:JSON.stringify({messages:{status:'supported'},responses:{status:'supported'}})}:{})}));
}
