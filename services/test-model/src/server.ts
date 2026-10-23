import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

const port = Number(process.env.PORT ?? 4010);

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
}

function responseBody(request: Record<string, unknown>) {
  const model = String(request.model ?? 'test-model');
  const prompt = Array.isArray(request.messages) ? request.messages.length : 0;
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: '这是本地测试模型的确定性响应。' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12 + prompt, completion_tokens: 14, total_tokens: 26 + prompt, prompt_tokens_details: { cached_tokens: 0 } },
  };
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    sendJson(response, 200, { status: 'ok', model: 'test-model', environment: 'local' });
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    sendJson(response, 404, { error: { message: 'route not found', type: 'invalid_request_error' } });
    return;
  }
  let body: Record<string, unknown>;
  try { body = await readBody(request); } catch {
    sendJson(response, 400, { error: { message: 'invalid JSON body', type: 'invalid_request_error' } });
    return;
  }
  if (body.model !== undefined && body.model !== 'test-model') {
    sendJson(response, 404, { error: { message: 'model not found', type: 'model_not_found' } });
    return;
  }
  const value = responseBody(body);
  if (body.stream === true) {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    response.write(`data: ${JSON.stringify({ ...value, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '这是本地测试模型的' }, finish_reason: null }], usage: null })}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (response.destroyed) return;
    response.write(`data: ${JSON.stringify({ ...value, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '确定性响应。' }, finish_reason: 'stop' }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: value.id, object: 'chat.completion.chunk', model: value.model, choices: [], usage: value.usage })}\n\n`);
    response.end('data: [DONE]\n\n');
    return;
  }
  sendJson(response, 200, value);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`test-model listening on http://127.0.0.1:${port}`);
});
