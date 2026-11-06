import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptUpstreamChatRequest } from '../dist/upstream-compat.js';

const deepseek = new URL('https://api.deepseek.com/v1');

test('DeepSeek adaptation preserves image parts in user and instruction messages', () => {
  const content=[{type:'text',text:'Inspect this.'},{type:'image_url',image_url:{url:'data:image/png;base64,fixture'}}];
  const request={messages:[{role:'developer',content},{role:'user',content}]};
  const result=adaptUpstreamChatRequest(deepseek,request);
  assert.deepEqual(result.messages,[{role:'system',content},{role:'user',content}]);
  assert.deepEqual(request.messages[0],{role:'developer',content});
});

test('a generic reasoning client can send developer instructions through a DeepSeek route', () => {
  const request = {
    model: 'private-logical-model',
    messages: [
      { role: 'developer', name: 'instructions', content: [{ type: 'text', text: 'First rule.' }, { type: 'text', text: 'Second rule.' }] },
      { role: 'system', content: [{ type: 'text', text: 'More instructions.' }] },
      { role: 'user', content: 'Hello' },
    ],
    max_completion_tokens: 80000,
    max_tokens: 1,
    reasoning_effort: 'high',
    stream: true,
    stream_options: { include_usage: true },
  };
  const original = structuredClone(request);
  const result = adaptUpstreamChatRequest(deepseek, request);
  assert.deepEqual(result.messages, [
    { role: 'system', name: 'instructions', content: 'First rule.\nSecond rule.' },
    { role: 'system', content: 'More instructions.' },
    { role: 'user', content: 'Hello' },
  ]);
  assert.equal(result.max_tokens, 80000);
  assert.equal('max_completion_tokens' in result, false);
  assert.equal(result.model, 'private-logical-model');
  assert.equal(result.reasoning_effort, 'high');
  assert.deepEqual(result.stream_options, { include_usage: true });
  assert.deepEqual(request, original, 'public request and admission fingerprint input stay unchanged');
});

test('DeepSeek tool history, reasoning, and an already admitted max_tokens value are preserved', () => {
  const request = {
    messages: [
      { role: 'developer', content: 'Use tools when needed.' },
      { role: 'assistant', content: null, reasoning_content: 'Tool needed.', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'echo', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: 'OK' },
    ],
    tools: [{ type: 'function', function: { name: 'echo', parameters: { type: 'object', properties: {} } } }],
    thinking: { type: 'enabled' },
    max_tokens: 256,
  };
  const result = adaptUpstreamChatRequest(deepseek, request);
  assert.deepEqual(result.messages.slice(1), request.messages.slice(1));
  assert.deepEqual(result.tools, request.tools);
  assert.deepEqual(result.thinking, request.thinking);
  assert.equal(result.max_tokens, 256);
});

test('DeepSeek-like model names and hostname suffixes do not alter other providers', () => {
  const request = { model: 'deepseek-flash', messages: [{ role: 'developer', content: 'Keep this role.' }], max_completion_tokens: 80000 };
  for (const url of ['https://api.openai.com/v1', 'http://localhost:4310/v1', 'https://api.deepseek.com.example.org/v1']) {
    assert.deepEqual(adaptUpstreamChatRequest(new URL(url), request), request);
  }
});
