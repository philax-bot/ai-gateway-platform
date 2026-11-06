import test from 'node:test';
import assert from 'node:assert/strict';
import {gatewayFixture,send,streamStart,streamEvent,usage} from './http-fixture.mjs';

// Pi's read tool returns images as user image_url parts following the tool result.
for(const stream of [false,true])test(`Pi image tool history is forwarded intact (stream=${stream})`,()=>gatewayFixture(async({call,requests,waitSettlement})=>{
  const messages=[{role:'user',content:'Read the screenshot.'},
    {role:'assistant',content:null,tool_calls:[{id:'read-1',type:'function',function:{name:'read',arguments:'{"path":"preview.png"}'}}]},
    {role:'tool',tool_call_id:'read-1',content:'Read image file [image/png]'},
    {role:'user',content:[{type:'text',text:'Describe this image.'},{type:'image_url',image_url:{url:'data:image/png;base64,'+'A'.repeat(1100000),detail:'auto'}},{type:'image_url',image_url:{url:'https://example.invalid/image.png',detail:'low'}}]}];
  const r=await call({messages,stream});assert.equal(r.status,200);
  const raw=await r.text();assert.ok(raw.includes('image received'));assert.deepEqual(requests[0].messages,messages);
  const s=await waitSettlement();assert.equal(s.outcome,'completed');assert.equal(s.inputTokens,13);assert.equal(s.usageFinal,true);
},async(b,r)=>{
  if(!b.stream)return send(r,{model:b.model,choices:[{message:{role:'assistant',content:'image received'},finish_reason:'stop'}],usage});
  streamStart(r);streamEvent(r,{model:b.model,choices:[{delta:{content:'image received'},finish_reason:'stop'}]});streamEvent(r,{choices:[],usage});r.end('data: [DONE]\n\n');
}));

test('invalid image blocks and audio/video are rejected before authorization',()=>gatewayFixture(async({call,requests,authorizations})=>{
  for(const part of [{type:'image_url',image_url:'invalid'},{type:'image_url',image_url:{}},{type:'input_audio',input_audio:{data:'x',format:'wav'}},{type:'video_url',video_url:{url:'x'}},null]){
    const r=await call({messages:[{role:'user',content:[part]}]});assert.equal(r.status,400);assert.equal((await r.json()).error.type,'unsupported_content');
  }
  for(const patch of [{audio:{voice:'alloy'}},{modalities:['text','audio']}])assert.equal((await call(patch)).status,400);
  assert.equal(requests.length,0);assert.equal(authorizations.length,0);
},async()=>assert.fail('invalid content must not dispatch')));

test('image upstream rejection is returned once without silently dropping the image',()=>gatewayFixture(async({call,requests,waitSettlement})=>{
  const r=await call({messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,fixture'}}]}]});
  assert.equal(r.status,400);assert.equal((await r.json()).error.type,'invalid_request_error');assert.equal(requests.length,1);
  const s=await waitSettlement();assert.equal(s.outcome,'upstream_error');assert.equal(s.inputTokens,0);
},async(b,r)=>send(r,{error:{type:'invalid_request_error',message:'model does not support image input'}},400)));
