import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute,resolve } from 'node:path';
import type { AuthorizeRequest, AuthorizeResponse, SettlementRequest, SettlementResponse } from '@ai-gateway/contracts';
import { chatCompletionsUrl,estimateChatInput,validateRuntimeConfig } from '@ai-gateway/contracts';
import { SettlementJournal } from './journal.js';
import { definitelyNotSent } from './connection-failure.js';

const runtimeMode=validateRuntimeConfig(process.env,'gateway');
if(runtimeMode==='production'&&!isAbsolute(process.env.GATEWAY_JOURNAL_DIR!))throw new Error('GATEWAY_JOURNAL_DIR must be absolute in production');
const port = Number(process.env.PORT ?? 4000);
const controlPlaneUrl = process.env.CONTROL_PLANE_URL ?? 'http://127.0.0.1:4001';
const modelUrl = process.env.MODEL_URL ?? 'http://127.0.0.1:4010';
const serviceToken = process.env.SERVICE_TOKEN ?? 'local-service-token';
const upstreamTimeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 30000);
const webOrigin = process.env.WEB_ORIGIN ?? 'http://127.0.0.1:5173';
const localWebOrigins = new Set(runtimeMode==='production'?[webOrigin]:[webOrigin, 'http://127.0.0.1:5173', 'http://localhost:5173']);
const journal=new SettlementJournal(process.env.GATEWAY_JOURNAL_DIR??resolve(process.cwd(),`.runtime/gateway-${port}`));

function corsHeaders(origin?: string): Record<string, string> {
  return { 'access-control-allow-origin': origin && localWebOrigins.has(origin) ? origin : webOrigin,
    'access-control-allow-headers': 'authorization, content-type, idempotency-key, x-request-id, x-price-version',
    'access-control-allow-methods': 'POST, OPTIONS', 'access-control-expose-headers': 'x-request-id', vary: 'Origin' };
}
function sendJson(response: ServerResponse, status: number, value: unknown, origin?: string): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.end(`event: error\ndata: ${JSON.stringify(value)}\n\n`); return; }
  response.writeHead(status, { 'content-type':'application/json; charset=utf-8', ...corsHeaders(origin) });
  response.end(JSON.stringify(value));
}
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size=0;
  for await (const chunk of request) { size+=chunk.length; if(size>1048576) throw new Error('request body exceeds 1 MiB'); chunks.push(Buffer.from(chunk)); }
  const value: unknown=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('body must be a JSON object');
  return value as Record<string, unknown>;
}
async function controlPlane<T>(path: string, body: unknown): Promise<{ status: number; value: T }> {
  const response=await fetch(`${controlPlaneUrl}${path}`, { method:'POST',signal:AbortSignal.timeout(5000),
    headers:{ authorization:`Bearer ${serviceToken}`,'content-type':'application/json' },body:JSON.stringify(body) });
  return { status:response.status,value:await response.json() as T };
}
type ResolvedCredential = { credentialId:string; identity:AuthorizeRequest['identity']; purpose:AuthorizeRequest['purpose'] };
type Usage = { inputTokens:number; outputTokens:number; cachedInputTokens:number };
async function boundedText(response:Response):Promise<string>{
  if(!response.body)return '';
  const reader=response.body.getReader(),decoder=new TextDecoder();let result='',size=0;
  try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>16777216){await reader.cancel();throw new Error('upstream response exceeds 16 MiB');}result+=decoder.decode(chunk.value,{stream:true});}return result+decoder.decode();}finally{reader.releaseLock();}
}
function extractUsage(raw: string): Usage | null {
  const objects: Record<string, unknown>[]=[];
  try { objects.push(JSON.parse(raw)); } catch {
    for(const line of raw.split(/\r?\n/).reverse()) {
      if(!line.startsWith('data:')) continue;
      try { objects.push(JSON.parse(line.slice(5).trim())); } catch { /* SSE marker or partial line */ }
    }
  }
  for(const object of objects) {
    const usage=object.usage as Record<string, unknown> | undefined;
    if(!usage) continue;
    const inputTokens=usage.prompt_tokens??usage.input_tokens;
    const outputTokens=usage.completion_tokens??usage.output_tokens;
    const cachedInputTokens=(usage.prompt_tokens_details as Record<string,unknown>|undefined)?.cached_tokens??0;
    if([inputTokens,outputTokens,cachedInputTokens].every(v=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=2147483647)&&Number(cachedInputTokens)<=Number(inputTokens)) {
      return { inputTokens:inputTokens as number,outputTokens:outputTokens as number,cachedInputTokens:cachedInputTokens as number };
    }
  }
  return null;
}

async function handleCompletions(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const startedAt=Date.now();let ttftMs:number|undefined;
  let body: Record<string,unknown>;
  try { body=await readJson(request); } catch(error) {
    sendJson(response,400,{error:{type:'invalid_request_error',message:error instanceof Error?error.message:'invalid JSON'}},request.headers.origin); return;
  }
  const origin=request.headers.origin;
  if(typeof body.model!=='string'||!body.model.trim()||!Array.isArray(body.messages)){
    sendJson(response,400,{error:{type:'invalid_request_error',message:'model and messages are required'}},origin);return;
  }
  if(body.messages.some(message=>!message||typeof message!=='object'||Array.isArray(message)||('content'in message&&message.content!==null&&typeof message.content!=='string'&&!(Array.isArray(message.content)&&message.content.every((part:unknown)=>part&&typeof part==='object'&&!Array.isArray(part)&&'type'in part&&part.type==='text'&&'text'in part&&typeof part.text==='string'))))){
    sendJson(response,400,{error:{type:'unsupported_content',message:'this release accepts text messages and tool calls; image/audio content requires a separate adapter'}},origin);return;
  }
  const requestedOutput=body.max_completion_tokens??body.max_tokens;
  if(requestedOutput!==undefined&&(typeof requestedOutput!=='number'||!Number.isSafeInteger(requestedOutput)||requestedOutput<1)){
    sendJson(response,400,{error:{type:'invalid_request_error',message:'output token limit must be a positive integer'}},origin);return;
  }
  const requestId=String(request.headers['x-request-id']??`request-${randomUUID()}`);
  const idempotencyKey=String(request.headers['idempotency-key']??requestId);
  let credential: ResolvedCredential|null;
  let decision: AuthorizeResponse;
  try {
    const resolved=await controlPlane<ResolvedCredential|null>('/internal/v1/policy/credentials/resolve', { apiKey:(request.headers.authorization??'').replace(/^Bearer\s+/i,'') });
    if(resolved.status!==200) throw new Error('credential lookup failed');
    credential=resolved.value;
    if(!credential) { sendJson(response,401,{error:{type:'authentication_error',message:'invalid API key'}},origin); return; }
    const auth=await controlPlane<AuthorizeResponse>('/internal/v1/policy/authorize', {
      requestId,idempotencyKey,identity:credential.identity,purpose:credential.purpose,modelId:body.model,mode:'chat',
      estimatedInputTokens:estimateChatInput(body),expectedPriceVersion:typeof request.headers['x-price-version']==='string'?request.headers['x-price-version']:undefined,
      maxOutputTokens:requestedOutput as number|undefined,requestFingerprint:createHash('sha256').update(JSON.stringify(body)).digest('hex'),policyVersion:'policy-local-1',
    } satisfies AuthorizeRequest);
    if(auth.status!==200) {
      sendJson(response,auth.status===409?409:503,{error:{type:'authorization_error',message:'authorization unavailable or conflicting'},requestId},origin); return;
    }
    decision=auth.value;
  } catch { sendJson(response,503,{error:{type:'control_plane_unavailable',message:'authorization service is unavailable'},requestId},origin); return; }
  if(decision.decision!=='allow'||!decision.reservation) {
    sendJson(response,decision.reasonCode==='rate_limited'?429:decision.reasonCode==='request_limit_exceeded'?400:decision.reasonCode==='price_unconfigured'?503:403,{error:{type:'policy_denied',code:decision.reasonCode,message:decision.reasonMessage},requestId},origin); return;
  }
  if(decision.replayed) {
    sendJson(response,409,{error:{type:'request_already_authorized',message:'request already authorized; repeat forwarding is disabled'},requestId:decision.requestId},origin); return;
  }
  const logicalModel=body.model;
  const admission=decision.admission;
  const configured=admission?.kind==='configured';
  const baseSettlement:SettlementRequest={requestId,idempotencyKey:`${idempotencyKey}:settlement`,reservationId:decision.reservation.reservationId,
    outcome:'rejected_before_upstream',forwarded:false,usageFinal:true,inputTokens:0,outputTokens:0,cachedInputTokens:0,actualAmount:0,currency:'CNY',completedAt:new Date().toISOString(),
    modelId:logicalModel,purpose:credential.purpose,subjectId:credential.identity.subjectId};
  try{await journal.admitted(baseSettlement);}catch{
    try{await controlPlane('/internal/v1/usage/settlements',baseSettlement);}catch{/* control plane retains the reservation for reconciliation */}
    sendJson(response,503,{error:{type:'journal_unavailable',message:'usage journal is unavailable; upstream was not called'},requestId},origin);return;
  }
  const controller=new AbortController();
  let clientCancelled=response.destroyed;
  let timedOut=false;
  const onClose=()=>{ if(!response.writableEnded) { clientCancelled=true; controller.abort(); } };
  response.on('close',onClose);
  if(clientCancelled) controller.abort();
  const timeout=setTimeout(()=>{timedOut=true;controller.abort();},upstreamTimeoutMs);
  const heartbeat=setInterval(()=>{void controlPlane<{renewed:boolean}>('/internal/v1/usage/leases/renew',{requestId,reservationId:decision.reservation!.reservationId}).then(result=>{if(result.status===200&&!result.value.renewed)controller.abort();}).catch(()=>undefined);},60000);heartbeat.unref();
  let raw=''; let outcome: SettlementRequest['outcome']='upstream_error';
  let usageFinal=true;
  let upstreamStatus=502;
  let failureMessage='test model is unavailable';
  let streamStarted=false;
  let dispatched=false;
  let done=false;
  let upstream: Response|undefined;
  try {
    const route=admission?.route;
    if(runtimeMode==='production'&&!configured)throw new Error('production requires a configured admission route');
    if(configured&&!route)throw new Error('configured authorization has no route');
    const target=new URL(configured?route!.baseUrl:modelUrl);
    if(!['http:','https:'].includes(target.protocol)||target.username||target.password||target.search||target.hash)throw new Error('invalid controlled upstream URL');
    if(!['127.0.0.1','localhost','[::1]'].includes(target.hostname)&&process.env.ALLOW_UPSTREAM_REQUESTS!=='true')throw new Error('external upstream access is disabled');
    const upstreamCredential=route?.credentialRef?process.env[route.credentialRef]:null;
    if(route?.credentialRef&&(!/^UPSTREAM_[A-Z0-9_]+$/.test(route.credentialRef)||!upstreamCredential))throw new Error('upstream credential reference is not configured');
    const forwarded:Record<string,unknown>={...body,model:route?.upstreamModel??logicalModel};
    if(configured){if(body.max_completion_tokens!==undefined){forwarded.max_completion_tokens=route!.maxOutputTokens;delete forwarded.max_tokens;}else forwarded.max_tokens=route!.maxOutputTokens;}
    if(body.stream===true)forwarded.stream_options={...(body.stream_options as Record<string,unknown>|undefined),include_usage:true};
    await journal.dispatched(requestId);dispatched=true;
    upstream=await fetch(chatCompletionsUrl(target.toString()), { method:'POST',redirect:'error', signal:controller.signal,
      headers:{'content-type':'application/json','x-request-id':requestId,...(upstreamCredential?{authorization:`Bearer ${upstreamCredential}`}:{})},body:JSON.stringify(forwarded) });
    upstreamStatus=upstream.status;
    if(!upstream.ok) { raw=await boundedText(upstream); outcome='upstream_error';usageFinal=extractUsage(raw)!==null||!configured||upstream.status<500; }
    else if(body.stream===true && upstream.body) {
      response.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache','x-request-id':requestId,...corsHeaders(origin)});
      streamStarted=true;
      const reader=upstream.body.getReader(); const decoder=new TextDecoder();let eventBuffer='';
      const forwardEvent=async(event:string)=>{
        const data=event.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
        if(data.trim()==='[DONE]'){done=true;return;}
        let forwardedEvent=event;
        try{const value=JSON.parse(data);if(ttftMs===undefined&&value?.choices?.some((choice:{delta?:{content?:string;tool_calls?:unknown[]}})=>choice.delta?.content||choice.delta?.tool_calls?.length))ttftMs=Math.min(2147483647,Date.now()-startedAt);if(value&&typeof value==='object'&&'model'in value){value.model=logicalModel;forwardedEvent=event.split(/\r?\n/).filter(line=>!line.startsWith('data:')).concat(`data: ${JSON.stringify(value)}`).join('\n');}}catch{/* pass through non-JSON SSE events */}
        if(!response.destroyed&&!response.write(`${forwardedEvent}\n\n`))await new Promise<void>(resolve=>{
          const finish=()=>{response.off('drain',finish);response.off('close',finish);resolve();};response.once('drain',finish);response.once('close',finish);
        });
      };
      try {
        while(true) {
          const chunk=await reader.read(); if(chunk.done) break;
          const text=decoder.decode(chunk.value,{stream:true}); raw=(raw+text).slice(-262144);eventBuffer+=text;
          if(eventBuffer.length>1048576)throw new Error('upstream SSE event exceeds the supported size');
          let separator;
          while((separator=/\r?\n\r?\n/.exec(eventBuffer))){const event=eventBuffer.slice(0,separator.index);eventBuffer=eventBuffer.slice(separator.index+separator[0].length);await forwardEvent(event);}
        }
        const tail=decoder.decode();raw+=tail;eventBuffer+=tail;if(eventBuffer.trim())await forwardEvent(eventBuffer);
      } finally { reader.releaseLock(); }
      outcome=done?'completed':'partial'; usageFinal=extractUsage(raw)!==null;
    } else {
      raw=await boundedText(upstream);
      const value=JSON.parse(raw) as Record<string,unknown>;
      if(!Array.isArray(value.choices))throw new Error('upstream returned an invalid completion');
      value.model=logicalModel;raw=JSON.stringify(value);outcome='completed';usageFinal=extractUsage(raw)!==null;
    }
  } catch (error) {
    controller.abort();
    outcome=!dispatched?'rejected_before_upstream':clientCancelled?'client_cancelled':timedOut?'timeout':streamStarted?'partial':'upstream_error';
    // Interrupted generation may have incurred usage, even without its final usage event.
    usageFinal=!dispatched||definitelyNotSent(error);
    if(extractUsage(raw)) { outcome='partial'; usageFinal=true; }
    upstreamStatus=!dispatched?503:timedOut?504:502; failureMessage=!dispatched?'controlled upstream configuration is unavailable':timedOut?'upstream model timed out':'upstream model connection interrupted';
  } finally { clearTimeout(timeout);clearInterval(heartbeat); response.off('close',onClose); }

  const usage=extractUsage(raw)??{inputTokens:0,outputTokens:0,cachedInputTokens:0};
  const errorCode=outcome==='completed'?undefined:outcome==='upstream_error'?`upstream_http_${upstream?.status??'connection'}`:outcome==='rejected_before_upstream'?'controlled_configuration_unavailable':outcome;
  const settlement: SettlementRequest={...baseSettlement,outcome,forwarded:dispatched,ttftMs,errorCode,...usage,usageFinal,actualAmount:configured?undefined:outcome==='completed'||outcome==='partial'?0.02:0,completedAt:new Date().toISOString()};
  let settled=false;
  try{settled=await journal.finalize(settlement);}catch{console.error(JSON.stringify({event:'settlement_journal_failed',requestId,reservationId:settlement.reservationId}));}
  if(!settled) { sendJson(response,503,{error:{type:'settlement_pending',message:'usage settlement is pending durable replay or reconciliation'},requestId},origin); return; }
  if(clientCancelled||response.destroyed) return;
  if(streamStarted) {
    if(outcome==='completed'&&done)response.write('data: [DONE]\n\n');
    if(outcome!=='completed') response.write(`event: error\ndata: ${JSON.stringify({error:{type:'upstream_interrupted'},requestId})}\n\n`);
    response.end(); return;
  }
  if(outcome==='completed') {
    response.writeHead(200,{'content-type':'application/json; charset=utf-8','x-request-id':requestId,...corsHeaders(origin)}); response.end(raw);
  } else if(upstream && !upstream.ok && raw) {
    response.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json',...corsHeaders(origin)}); response.end(raw);
  } else sendJson(response,upstreamStatus,{error:{type:outcome,message:failureMessage},requestId},origin);
}
let closing=false;
const pendingRequests=new Set<Promise<void>>();
async function serveRequest(request:IncomingMessage,response:ServerResponse){
  try {
    if(closing){sendJson(response,503,{error:{type:'gateway_stopping',message:'gateway is draining active requests'}},request.headers.origin);return;}
    if(request.method==='GET'&&request.url==='/health') {const outbox=await journal.status();sendJson(response,200,{status:outbox.blocked?'degraded':'ok',dataPlane:runtimeMode==='production'?'controlled-proxy':'local-simulation',outbox},request.headers.origin);return;}
    if(request.method==='OPTIONS'&&request.url==='/v1/chat/completions') {response.writeHead(204,corsHeaders(request.headers.origin));response.end();return;}
    if(request.method==='POST'&&request.url==='/v1/chat/completions') {await handleCompletions(request,response);return;}
    sendJson(response,404,{error:{type:'not_found',message:'route not found'}},request.headers.origin);
  } catch {sendJson(response,500,{error:{type:'gateway_error',message:'gateway request failed'}},request.headers.origin);}
}
const server=createServer((request,response)=>{
  const pending=serveRequest(request,response);pendingRequests.add(pending);
  void pending.finally(()=>pendingRequests.delete(pending)).catch(()=>undefined);
});
function shutdown(){
  if(closing)return;closing=true;
  // A bounded drain preserves normal in-flight settlement. On deadline, leave the fsynced
  // journal for restart recovery rather than claiming that all work completed.
  const deadline=setTimeout(()=>process.exit(1),40000);deadline.unref();
  server.close(()=>{void (async()=>{
    await Promise.allSettled([...pendingRequests]);await journal.flush();await journal.close();
  })().then(()=>{clearTimeout(deadline);process.exit(0);}).catch(()=>process.exit(1));});
}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
await journal.initialize(async event=>(await controlPlane<SettlementResponse>('/internal/v1/usage/settlements',event)).status);
const host=process.env.HOST??'127.0.0.1';
server.listen(port,host,()=>console.log(`gateway listening on ${host}:${port}`));
