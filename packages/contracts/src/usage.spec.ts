import {describe,it,expect} from 'vitest';
import {extractUpstreamUsage} from './usage.js';

describe('complete upstream usage evidence',()=>{
  it('counts provider cache hits as an input subset and does not add reasoning twice',()=>{
    expect(extractUpstreamUsage(JSON.stringify({usage:{prompt_tokens:100,completion_tokens:20,prompt_cache_hit_tokens:60,completion_tokens_details:{reasoning_tokens:15}}}))).toEqual({inputTokens:100,outputTokens:20,cachedInputTokens:60});
  });
  it('accepts matching cache representations and rejects contradictory or impossible usage',()=>{
    const usage={prompt_tokens:100,completion_tokens:20,prompt_tokens_details:{cached_tokens:60},prompt_cache_hit_tokens:60};
    expect(extractUpstreamUsage(JSON.stringify({usage}))?.cachedInputTokens).toBe(60);
    expect(extractUpstreamUsage(JSON.stringify({usage:{...usage,prompt_cache_hit_tokens:61}}))).toBeNull();
    expect(extractUpstreamUsage(JSON.stringify({usage:{...usage,prompt_tokens:50}}))).toBeNull();
  });
  it('uses the final SSE usage and refuses to confirm an earlier partial sample if the final one is invalid',()=>{
    const event=(usage:Record<string,unknown>)=>`data: ${JSON.stringify({usage})}\n\n`;
    const earlier=event({prompt_tokens:10,completion_tokens:2});
    expect(extractUpstreamUsage(earlier+event({prompt_tokens:10,completion_tokens:20})+'data: [DONE]\n\n')).toEqual({inputTokens:10,outputTokens:20,cachedInputTokens:0});
    expect(extractUpstreamUsage(earlier+event({prompt_tokens:10,completion_tokens:-1}))).toBeNull();
  });
});
