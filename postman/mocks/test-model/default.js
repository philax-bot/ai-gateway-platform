// Repository-owned local model stand-in, derived from services/test-model's response contract.
// Fault selectors are test-only and never sent to a real model provider.
const { createServer } = require('node:http');
const requests=[];
let totalRequests=0;
const server=createServer(async (req, res) => {
  if(await require('./multimodal.js')(req,res))return;
  if (req.url === '/health') { res.end('{"status":"ok","environment":"mock"}'); return; }
  if(req.url==='/_test/requests'){res.setHeader('content-type','application/json');res.end(JSON.stringify(requests));return;}
  if(req.url==='/_test/stats'){res.setHeader('content-type','application/json');res.end(JSON.stringify({totalRequests,retainedRequests:requests.length,engine:'deterministic-local-http',modelInference:false}));return;}
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end('{}'); return; }
  if(process.env.MOCK_API_TOKEN&&req.headers.authorization!==`Bearer ${process.env.MOCK_API_TOKEN}`){res.writeHead(401,{'content-type':'application/json'});res.end('{"error":{"type":"mock_authentication_failed"}}');return;}
  const chunks=[];
  for await (const chunk of req) chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString() || '{}');
  totalRequests++;
  requests.push({requestId:req.headers['x-request-id']??null,model:body.model,maxOutput:body.max_tokens??body.max_completion_tokens??null,stream:body.stream===true,tools:Array.isArray(body.tools)?body.tools.map(tool=>tool.function?.name):[]});if(requests.length>500)requests.shift();
  // Distinct upstream request identifier so call tracing is testable end to end.
  res.setHeader('x-request-id',`upstream-${String(req.headers['x-request-id']??'local').slice(0,140)}`);
  const scenario=body.test_scenario;
  if(scenario==='reset-before-headers'){req.socket.destroy();return;}
  if (scenario === 'timeout') return;
  if (scenario === 'error') { res.writeHead(500, {'content-type':'application/json'}); res.end('{"error":{"type":"upstream_error"}}'); return; }
  if (scenario === 'html-error') { res.writeHead(502, {'content-type':'text/html'}); res.end('<h1>Bad gateway</h1>'); return; }
  const usage={prompt_tokens:13,completion_tokens:14,total_tokens:27,prompt_tokens_details:{cached_tokens:scenario==='cached'?4:0}};
  const toolCall=Array.isArray(body.tools)&&body.tools.length?{id:'call-local',type:'function',function:{name:body.tools[0].function.name,arguments:'{"city":"Shanghai"}'}}:null;
  const content=process.env.REVIEW_MODEL==='true'?'本地审查模型已收到请求。\n\n本次用于验证在线输入、流式返回、额度结算和调用记录。此回复为固定示例；当前未连接真实智能模型。':'本地故障回归响应';
  const value={id:'chatcmpl-mock',object:'chat.completion',model:body.model,choices:[{index:0,message:{role:'assistant',content:toolCall?null:content,...(toolCall?{tool_calls:[toolCall]}:{})},finish_reason:toolCall?'tool_calls':'stop'}],usage};
  if (body.stream) {
    res.writeHead(200, {'content-type':'text/event-stream'});
    res.write(`data: ${JSON.stringify({choices:[{delta:{content:process.env.REVIEW_MODEL==='true'?content:'开始响应'}}],usage:null})}\n\n`);
    if (scenario === 'cancel') { const timer=setTimeout(()=>res.end(),2000); res.on('close',()=>clearTimeout(timer)); return; }
    if (scenario === 'truncate') { const timer=setTimeout(()=>res.destroy(),60); res.on('close',()=>clearTimeout(timer)); return; }
    if (scenario === 'incomplete') { res.end(); return; }
    if (scenario === 'delayed') { await new Promise(resolve=>setTimeout(resolve,1500)); if(res.destroyed)return; }
    if(toolCall)res.write(`data: ${JSON.stringify({model:body.model,choices:[{index:0,delta:{tool_calls:[{index:0,...toolCall}]},finish_reason:'tool_calls'}],usage:null})}\n\n`);
    res.write(`data: ${JSON.stringify({choices:[],usage})}\n\n`);
    res.end('data: [DONE]\n\n'); return;
  }
  res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify(value));
}).listen(Number(process.env.PORT), process.env.HOST || '127.0.0.1');
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
