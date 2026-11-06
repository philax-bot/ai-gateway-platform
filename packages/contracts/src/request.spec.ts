import {describe,it,expect} from 'vitest';
import {estimateChatInput,estimateProtocolInput} from './request.js';

describe('input token estimates',()=>{
  it('counts text tokens rather than JSON bytes while including tools and instructions',()=>{
    const base={messages:[{role:'user',content:'Please review this TypeScript function. '.repeat(1000)}]};
    const estimate=estimateChatInput(base);
    expect(estimate).toBeGreaterThan(5000);expect(estimate).toBeLessThan(18000);
    expect(estimateChatInput({...base,tools:[{name:'read',description:'Read a file. '.repeat(2000)}]})).toBeGreaterThan(estimate);
    expect(estimateProtocolInput({system:'规则'.repeat(1000),messages:base.messages},'messages')).toBeGreaterThan(estimate);
  });
  it('uses an image reserve independent of Base64 size in all three protocols',()=>{
    for(const size of [1000,1300000]){
      const url='data:image/png;base64,'+'A'.repeat(size);
      const content=[{type:'text',text:'Describe it.'},{type:'image_url',image_url:{url}}];
      expect(estimateChatInput({messages:[{role:'user',content}]})).toBeLessThan(9000);
      expect(estimateProtocolInput({messages:[{role:'user',content:[{type:'tool_result',tool_use_id:'read-1',content:[{type:'image',source:{type:'base64',media_type:'image/png',data:'A'.repeat(size)}}]}]}]},'messages')).toBeLessThan(9000);
      expect(estimateProtocolInput({input:[{type:'function_call_output',output:[{type:'input_image',image_url:url}]}]},'responses')).toBeLessThan(9000);
    }
    const image={type:'image_url',image_url:{url:'https://example.invalid/image.png'}};
    const one=estimateChatInput({messages:[{role:'user',content:[image]}]});
    expect(estimateChatInput({messages:[{role:'user',content:[image,image]}]})-one).toBeGreaterThanOrEqual(8192);
  });
  it('does not mutate inputs or drop unknown text and treats special token strings as text',()=>{
    const request={messages:[{role:'user',content:'<|endoftext|> 中文🙂\\"'}]};const copy=structuredClone(request);
    expect(()=>estimateChatInput(request)).not.toThrow();expect(request).toEqual(copy);
    expect(estimateChatInput({messages:[{role:'user',content:'中文🙂'.repeat(3000)}]})).toBeGreaterThan(9000);
    expect(estimateProtocolInput({input:[{type:'future_block',payload:'data'.repeat(1000)}]},'responses')).toBeGreaterThan(1000);
  });
});
