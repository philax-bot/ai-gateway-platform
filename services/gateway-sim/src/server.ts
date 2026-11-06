import {checkGuardrail,defaultGuardrailPolicy,type GuardrailPolicy} from '@ai-gateway/contracts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { isAbsolute,resolve } from 'node:path';
import type { AuthorizeRequest, AuthorizeResponse, SettlementRequest, SettlementResponse } from '@ai-gateway/contracts';
import { chatCompletionsUrl,estimateProtocolInput,extractUpstreamUsage,isRequestReference,readUpstreamRequestId,validateRuntimeConfig } from '@ai-gateway/contracts';
import { SettlementJournal } from './journal.js';
import { definitelyNotSent, shouldRetryConnect } from './connection-failure.js';
import { adaptUpstreamChatRequest } from './upstream-compat.js';
import { gatewayTimeouts, UpstreamDeadline } from './upstream-timeout.js';
import {normalizeProtocolRequest,protocolError,ProtocolInputError,type PublicProtocol} from './protocol-input.js';
import {ProtocolOutput} from './protocol-output.js';
import {NativeProtocolOutput} from './protocol-native.js';
import {validateChatContent} from './chat-content.js';
import {protocolUrl,extractProtocolUsage} from '@ai-gateway/contracts';

const runtimeMode=validateRuntimeConfig(process.env,'gateway');
if(runtimeMode==='production'&&!isAbsolute(process.env.GATEWAY_JOURNAL_DIR!))throw new Error('GATEWAY_JOURNAL_DIR must be absolute in production');
const port = Number(process.env.PORT ?? 4000);
const controlPlaneUrl = process.env.CONTROL_PLANE_URL ?? 'http://127.0.0.1:4001';
const modelUrl = process.env.MODEL_URL ?? 'http://127.0.0.1:4010';
const serviceToken = process.env.SERVICE_TOKEN ?? 'local-service-token';
const timeouts = gatewayTimeouts(process.env);
const controlPlaneTimeoutMs=Number(process.env.CONTROL_PLANE_RPC_TIMEOUT_MS??5000);
if(!Number.isSafeInteger(controlPlaneTimeoutMs)||controlPlaneTimeoutMs<1000||controlPlaneTimeoutMs>60000)throw Error('CONTROL_PLANE_RPC_TIMEOUT_MS must be 1000–60000');
const webOrigin = process.env.WEB_ORIGIN ?? 'http://127.0.0.1:5173';
const localWebOrigins = new Set(runtimeMode==='production'?[webOrigin]:[webOrigin, 'http://127.0.0.1:5173', 'http://localhost:5173']);
const journal=new SettlementJournal(process.env.GATEWAY_JOURNAL_DIR??resolve(process.cwd(),`.runtime/gateway-${port}`));
const activeUpstreams=new Set<AbortController>();
let closing=false,draining=false;

function corsHeaders(origin?: string): Record<string, string> {
  return { 'access-control-allow-origin': origin && localWebOrigins.has(origin) ? origin : webOrigin,
    'access-control-allow-headers': 'authorization, x-api-key, anthropic-version, anthropic-beta, content-type, idempotency-key, x-request-id, x-price-version, x-retry-of-request-id',
    'access-control-allow-methods': 'POST, OPTIONS', 'access-control-expose-headers': 'x-request-id, x-atlas-protocol-mode', vary: 'Origin' };
}
function sendJson(response: ServerResponse, status: number, value: unknown, origin?: string): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.end(`event: error\ndata: ${JSON.stringify(value)}\n\n`); return; }
  response.writeHead(status, { 'content-type':'application/json; charset=utf-8', ...corsHeaders(origin) });
  response.end(JSON.stringify(value));
}
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size=0;
  for await (const chunk of request) { size+=chunk.length; if(size>20*1048576) throw new Error('request body exceeds 20 MiB'); chunks.push(Buffer.from(chunk)); }
  const value: unknown=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('body must be a JSON object');
  return value as Record<string, unknown>;
}
async function controlPlane<T>(path: string, body: unknown): Promise<{ status: number; value: T }> {
  const response=await fetch(`${controlPlaneUrl}${path}`, { method:'POST',signal:AbortSignal.timeout(controlPlaneTimeoutMs),
    headers:{ authorization:`Bearer ${serviceToken}`,'content-type':'application/json' },body:JSON.stringify(body) });
  return { status:response.status,value:await response.json() as T };
}
type ResolvedCredential = { guardrailPolicy?:GuardrailPolicy; credentialId:string; identity:AuthorizeRequest['identity']; purpose:AuthorizeRequest['purpose']; modelIds?:string[] };
async function boundedText(response:Response,onBytes:()=>void):Promise<string>{
  if(!response.body)return '';
  const reader=response.body.getReader(),decoder=new TextDecoder();let result='',size=0;
  try{while(true){const chunk=await reader.read();if(chunk.done)break;if(chunk.value.byteLength)onBytes();size+=chunk.value.byteLength;if(size>16777216){await reader.cancel();throw new Error('upstream response exceeds 16 MiB');}result+=decoder.decode(chunk.value,{stream:true});}return result+decoder.decode();}finally{reader.releaseLock();}
}
/**
 * Dispatch an upstream request with a bounded retry that is only allowed for
 * connect-phase failures: no request bytes reached the upstream, so usage is
 * provably zero and no customer can be charged twice. A partially received
 * response (or any abort) is never retried.
 */
async function dispatchUpstream(url:string,init:RequestInit):Promise<Response>{
  let attempt=0;
  for(;;){
    try{
      // pi-lens-ignore: ts-ssrf — the URL is the validated controlled route; loopback/explicit-enable gate is checked by the caller.
      return await fetch(url,init);
    }
    catch(error){
      if(!shouldRetryConnect(error,attempt))throw error;
      console.error(JSON.stringify({event:'upstream_connect_retry',attempt:attempt+1,causeCode:(error as {cause?:{code?:string}}).cause?.code??null}));
      attempt++;
    }
  }
}

async function handleModels(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const origin=request.headers.origin;
  let credential: ResolvedCredential|null;
  try {
    const resolved=await controlPlane<ResolvedCredential|null>('/internal/v1/policy/credentials/resolve', { apiKey:(request.headers.authorization??'').replace(/^Bearer\s+/i,'') });
    if(resolved.status!==200) throw new Error('credential lookup failed');
    credential=resolved.value;
  } catch { sendJson(response,503,{error:{type:'control_plane_unavailable',message:'authorization service is unavailable'}},origin); return; }
  if(!credential) { sendJson(response,401,{error:{type:'authentication_error',message:'invalid API key'}},origin); return; }
  // Discovery only: the credential's currently authorized logical model IDs. Authorization still rechecks on every call.
  const data=(credential.modelIds??[]).map(id=>({id,object:'model',created:0,owned_by:'platform'}));
  sendJson(response,200,{object:'list',data},origin);
}

async function handleCompletions(request: IncomingMessage, response: ServerResponse, protocol:PublicProtocol='chat'): Promise<void> {
  const startedAt=Date.now();let ttftMs:number|undefined;
  const reply=(status:number,value:unknown)=>sendJson(response,status,protocolError(protocol,value),request.headers.origin);
  let body: Record<string,unknown>;
  let originalBody:Record<string,unknown>,apiKey=(request.headers.authorization??'').replace(/^Bearer\s+/i,'');
  try {
    originalBody=await readJson(request);
    if(protocol==='messages'){
      if(typeof request.headers['anthropic-version']!=='string'||!request.headers['anthropic-version'].trim())throw new ProtocolInputError('anthropic-version is required','unsupported_version');
      const key=request.headers['x-api-key'];if(key!==undefined){if(typeof key!=='string'||(apiKey&&apiKey!==key))throw new ProtocolInputError('conflicting or invalid API key headers');apiKey=key;}
    }
    body=normalizeProtocolRequest(protocol,originalBody,true);
  } catch(error) {
    reply(400,{error:{type:error instanceof ProtocolInputError?error.code:'invalid_request_error',message:error instanceof Error?error.message:'invalid JSON'}}); return;
  }
  const origin=request.headers.origin;
  if(typeof body.model!=='string'||!body.model.trim()||!Array.isArray(body.messages)){
    reply(400,{error:{type:'invalid_request_error',message:'model and messages are required'}});return;
  }
  const output=protocol==='chat'?null:new ProtocolOutput(protocol,body.model);
  try { validateChatContent(body); } catch(error) {
    reply(400,{error:{type:error instanceof ProtocolInputError?error.code:'invalid_request_error',message:error instanceof Error?error.message:'invalid content'}});return;
  }
  const requestedOutput=body.max_completion_tokens??body.max_tokens;
  if(requestedOutput!==undefined&&(typeof requestedOutput!=='number'||!Number.isSafeInteger(requestedOutput)||requestedOutput<1)){
    reply(400,{error:{type:'invalid_request_error',message:'output token limit must be a positive integer'}});return;
  }
  const requestId=String(request.headers['x-request-id']??`request-${randomUUID()}`);
  const retryHeader=request.headers['x-retry-of-request-id'];
  if(retryHeader!==undefined&&(typeof retryHeader!=='string'||!isRequestReference(retryHeader))){
    reply(400,{error:{type:'invalid_request_error',message:'x-retry-of-request-id must be an opaque reference of at most 160 characters'}});return;
  }
  const retryOfRequestId=typeof retryHeader==='string'?retryHeader:null;
  const idempotencyKey=String(request.headers['idempotency-key']??requestId);
  let credential: ResolvedCredential|null;
  try {
    const resolved=await controlPlane<ResolvedCredential|null>('/internal/v1/policy/credentials/resolve', { apiKey });
    if(resolved.status!==200) throw new Error('credential lookup failed');
    credential=resolved.value;
    if(!credential) { reply(401,{error:{type:'authentication_error',message:'invalid API key'}}); return; }
  } catch { reply(503,{error:{type:'control_plane_unavailable',message:'authorization service is unavailable'},requestId}); return; }
  const admissionAttemptId=randomUUID();
  const {model:_ignoredModel,...normalizedInput}=body;
  const assessment=checkGuardrail(credential.guardrailPolicy??defaultGuardrailPolicy(),body.model,protocol==='chat'?body:{...originalBody,normalizedInput});
  const authorization:AuthorizeRequest={
      guardrail:assessment,
      ...(protocol==='chat'?{}:{modelProtocol:protocol}),
      requestId,idempotencyKey,admissionAttemptId,identity:credential.identity,purpose:credential.purpose,modelId:body.model,mode:'chat',
      estimatedInputTokens:estimateProtocolInput(originalBody,protocol),expectedPriceVersion:typeof request.headers['x-price-version']==='string'?request.headers['x-price-version']:undefined,
      maxOutputTokens:requestedOutput as number|undefined,requestFingerprint:createHash('sha256').update(protocol==='chat'?JSON.stringify(body):protocol+':'+JSON.stringify(originalBody)).digest('hex'),policyVersion:'policy-local-1',
      retryOfRequestId,
  };
  try{await journal.beginAuthorization(authorization);}catch{
    reply(503,{error:{type:'journal_unavailable',message:'authorization journal is unavailable; authorization was not requested'},requestId});return;
  }
  const defer=()=>journal.deferAuthorization(admissionAttemptId).catch(()=>undefined);
  const forget=()=>journal.forgetAuthorization(admissionAttemptId).catch(()=>defer());
  let decision:AuthorizeResponse;
  try{
    const auth=await controlPlane<AuthorizeResponse>('/internal/v1/policy/authorize',authorization);
    if(auth.status!==200) {
      if(auth.status===400||auth.status===409)await forget();else await defer();
      const code=(auth.value as {message?:string})?.message;
      if(code==='guardrail_policy_stale'||code==='guardrail_unavailable'){await forget();reply(code==='guardrail_policy_stale'?409:503,{error:{type:code,code,message:code==='guardrail_policy_stale'?'安全策略已更新，请重试。':'安全检查暂不可用，请稍后重试。'},requestId});return;}
      reply(auth.status===409?409:auth.status===400?400:503,{error:{type:auth.status===400?'invalid_request_error':'authorization_error',message:auth.status===400?'retry reference is invalid':'authorization unavailable or conflicting'},requestId}); return;
    }
    decision=auth.value;
    if(!decision||!['allow','deny'].includes(decision.decision))throw new Error('invalid authorization response');
  } catch {await defer();reply(503,{error:{type:'control_plane_unavailable',message:'authorization service is unavailable; unresolved authorization will be recovered'},requestId}); return; }
  if(decision.decision!=='allow'||!decision.reservation) {
    if(decision.decision==='allow'){await defer();reply(503,{error:{type:'authorization_error',message:'authorization response is incomplete'},requestId});return;}
    await forget();
    reply(decision.reasonCode==='rate_limited'?429:decision.reasonCode==='request_limit_exceeded'?400:decision.reasonCode==='price_unconfigured'?503:403,{error:{type:decision.reasonCode==='safety_policy_violation'?'safety_policy_violation':'policy_denied',code:decision.reasonCode==='safety_policy_violation'?'sensitive_input':decision.reasonCode,message:decision.reasonMessage,...(decision.requestLimits?{details:{requestLimits:decision.requestLimits}}:{})},requestId}); return;
  }
  if(decision.replayed||decision.requestId!==requestId||(decision.admissionAttemptId&&decision.admissionAttemptId!==admissionAttemptId)) {
    if(decision.admissionAttemptId===admissionAttemptId)await defer();else await forget();
    reply(409,{error:{type:'request_already_authorized',message:'request already authorized; repeat forwarding is disabled'},requestId:decision.requestId}); return;
  }
  const logicalModel=body.model;
  const admission=decision.admission;
  const configured=admission?.kind==='configured';
  const baseSettlement:SettlementRequest={requestId,idempotencyKey:`${idempotencyKey}:settlement`,reservationId:decision.reservation.reservationId,
    outcome:'rejected_before_upstream',forwarded:false,usageFinal:true,inputTokens:0,outputTokens:0,cachedInputTokens:0,actualAmount:0,currency:'CNY',completedAt:new Date().toISOString(),
    modelId:logicalModel,purpose:credential.purpose,subjectId:credential.identity.subjectId};
  try{await journal.admitted(baseSettlement);await journal.forgetAuthorization(admissionAttemptId);}catch{
    await defer();
    try{await controlPlane('/internal/v1/usage/settlements',baseSettlement);}catch{/* control plane retains the reservation for reconciliation */}
    reply(503,{error:{type:'journal_unavailable',message:'usage journal is unavailable; upstream was not called'},requestId});return;
  }
  const controller=new AbortController();
  activeUpstreams.add(controller);
  let clientCancelled=response.destroyed;
  let deadline:UpstreamDeadline|undefined;
  const onClose=()=>{ if(!response.writableEnded) { clientCancelled=true; controller.abort(); } };
  response.on('close',onClose);
  if(clientCancelled||draining) controller.abort();
  const heartbeat=setInterval(()=>{void controlPlane<{renewed:boolean}>('/internal/v1/usage/leases/renew',{requestId,reservationId:decision.reservation!.reservationId}).then(result=>{if(result.status===200&&!result.value.renewed)controller.abort();}).catch(()=>undefined);},60000);heartbeat.unref();
  let raw=''; let outcome: SettlementRequest['outcome']='upstream_error';
  let usageFinal=true;
  let upstreamStatus=502;
  let upstreamRequestId:string|null=null;
  let failureMessage='test model is unavailable';
  let streamStarted=false;
  let dispatched=false;
  let done=false;
  let upstream: Response|undefined;
  let native:NativeProtocolOutput|null=null,protocolValidation:ProtocolInputError|null=null;
  let nativeMeter='';
  const writeFrames=async(frames:string)=>{
    if(frames&&!response.destroyed&&!response.write(frames))await new Promise<void>(resolve=>{
      const finish=()=>{response.off('drain',finish);response.off('close',finish);resolve();};response.once('drain',finish);response.once('close',finish);
    });
  };
  try {
    const route=admission?.route;
    if(protocol!=='chat'&&route?.protocols?.[protocol]?.status==='supported')native=new NativeProtocolOutput(protocol,logicalModel);
    if(protocol!=='chat'&&!native){
      if(protocol==='messages'&&request.headers['anthropic-version']!=='2023-06-01')throw new ProtocolInputError('Chat fallback requires anthropic-version 2023-06-01','unsupported_version');
      body=normalizeProtocolRequest(protocol,originalBody);if(request.headers['anthropic-beta'])throw new ProtocolInputError('anthropic-beta extensions require native protocol support','unsupported_parameter');
    }
    if(native&&protocol==='messages')console.info(JSON.stringify({event:'native_protocol_version',requestId,version:request.headers['anthropic-version']}));
    response.setHeader('x-atlas-protocol-mode',protocol==='chat'?'native':native?'native':'adapted');
    if(runtimeMode==='production'&&!configured)throw new Error('production requires a configured admission route');
    if(configured&&!route)throw new Error('configured authorization has no route');
    const target=new URL(configured?route!.baseUrl:modelUrl);
    if(!['http:','https:'].includes(target.protocol)||target.username||target.password||target.search||target.hash)throw new Error('invalid controlled upstream URL');
    if(!['127.0.0.1','localhost','[::1]'].includes(target.hostname)&&process.env.ALLOW_UPSTREAM_REQUESTS!=='true')throw new Error('external upstream access is disabled');
    if(route?.transport?.kind==='unavailable')throw new Error('Higress route is not applied');
    const transport=route?.transport?.kind==='higress'?route.transport:null;
    if(process.env.GATEWAY_DATA_PLANE==='higress'&&!transport)throw new Error('Higress dispatch metadata is required');
    const dispatchTarget=transport?new URL(transport.baseUrl):target;
    if(transport&&(!process.env.HIGRESS_PROXY_URL||!transport.baseUrl.startsWith(process.env.HIGRESS_PROXY_URL.replace(/\/$/,'')+'/atlas/')||!/^atlas-[a-f0-9]{32}$/.test(transport.model)))throw new Error('invalid Higress dispatch target');
    const upstreamCredential=transport?process.env.UPSTREAM_HIGRESS_INTERNAL:route?.credentialRef?process.env[route.credentialRef]:null;
    if(transport&&!upstreamCredential)throw new Error('Higress credential is not configured');
    if(!transport&&route?.credentialRef&&(!/^UPSTREAM_[A-Z0-9_]+$/.test(route.credentialRef)||!upstreamCredential))throw new Error('upstream credential reference is not configured');
    const forwarded:Record<string,unknown>={...(native?originalBody:body),model:native?route!.upstreamModel:transport?.model??route?.upstreamModel??logicalModel};
    if(native&&protocol==='responses')forwarded.store=false;
    if(configured){if(native&&protocol==='responses')forwarded.max_output_tokens=route!.maxOutputTokens;else if(body.max_completion_tokens!==undefined){forwarded.max_completion_tokens=route!.maxOutputTokens;delete forwarded.max_tokens;}else forwarded.max_tokens=route!.maxOutputTokens;}
    if(body.stream===true&&!native)forwarded.stream_options={...(body.stream_options as Record<string,unknown>|undefined),include_usage:true};
    await journal.dispatched(requestId);dispatched=true;
    deadline=new UpstreamDeadline(controller,timeouts);
    const dispatchUrl=native?(transport?transport.baseUrl+'/v1/'+protocol:protocolUrl(target.toString(),protocol,route?.protocolPaths)):chatCompletionsUrl(dispatchTarget.toString());
    upstream=await dispatchUpstream(dispatchUrl, { method:'POST',redirect:'error', signal:controller.signal,
      headers:{'content-type':'application/json','x-request-id':requestId,...(native&&protocol==='messages'?{'anthropic-version':String(request.headers['anthropic-version']),...(request.headers['anthropic-beta']?{'anthropic-beta':String(request.headers['anthropic-beta'])}:{})}:{}),...(upstreamCredential?{[transport?'x-atlas-hop-token':'authorization']:`Bearer ${upstreamCredential}`,...(native&&protocol==='messages'&&!transport?{'x-api-key':upstreamCredential}:{})}:{})},body:JSON.stringify(native?forwarded:adaptUpstreamChatRequest(target,forwarded)) });
    upstreamStatus=upstream.status;
    upstreamRequestId=readUpstreamRequestId(upstream.headers);
    if(!upstream.ok) { raw=await boundedText(upstream,()=>deadline!.receivedBytes()); outcome='upstream_error';usageFinal=extractUpstreamUsage(raw)!==null||!configured||upstream.status<500;
      // Local-only diagnostic: the client still gets a generic message, but operators need the vendor's own reason.
      let vendorType:string|null=null,vendorMessage:string|null=null;
      try{const body=JSON.parse(raw) as {error?:{type?:unknown;message?:unknown}};vendorType=typeof body.error?.type==='string'?body.error.type.slice(0,80):null;vendorMessage=typeof body.error?.message==='string'?body.error.message.slice(0,200):null;}catch{/* non-JSON vendor error body: the status code is still logged */}
      console.error(JSON.stringify({event:'upstream_error_response',requestId,status:upstream.status,vendorType,vendorMessage}));
    }
    else if(body.stream===true && upstream.body) {
      response.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache','x-request-id':requestId,...corsHeaders(origin)});
      streamStarted=true;
      if(output&&!native)await writeFrames(output.start());
      const reader=upstream.body.getReader(); const decoder=new TextDecoder();let eventBuffer='';
      const forwardEvent=async(event:string)=>{
        const data=event.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
        if(native){
          if(!data.trim())return;
          const value=JSON.parse(data),eventName=event.split(/\r?\n/).find(line=>line.startsWith('event:'))?.slice(6).trim();
          if(ttftMs===undefined&&(['response.output_text.delta','response.function_call_arguments.delta','content_block_delta'].includes(value.type)))ttftMs=Math.min(2147483647,Date.now()-startedAt);
          await writeFrames(native.push(value,eventName));done=native.done;return;
        }
        if(data.trim()==='[DONE]'){done=true;return;}
        if(output){
          if(!data.trim())return; // SSE comments/heartbeats carry no completion data.
          if(done)throw new Error('upstream data after terminal marker');
          const value=JSON.parse(data);
          if(ttftMs===undefined&&value?.choices?.some((c:{delta?:{content?:string;tool_calls?:unknown[]}})=>c.delta?.content||c.delta?.tool_calls?.length))ttftMs=Math.min(2147483647,Date.now()-startedAt);
          await writeFrames(output.push(value));return;
        }
        let forwardedEvent=event;
        try{const value=JSON.parse(data);if(ttftMs===undefined&&value?.choices?.some((choice:{delta?:{content?:string;tool_calls?:unknown[]}})=>choice.delta?.content||choice.delta?.tool_calls?.length))ttftMs=Math.min(2147483647,Date.now()-startedAt);if(value&&typeof value==='object'&&'model'in value){value.model=logicalModel;forwardedEvent=event.split(/\r?\n/).filter(line=>!line.startsWith('data:')).concat(`data: ${JSON.stringify(value)}`).join('\n');}}catch{/* pass through non-JSON SSE events */}
        if(!response.destroyed&&!response.write(`${forwardedEvent}\n\n`))await new Promise<void>(resolve=>{
          const finish=()=>{response.off('drain',finish);response.off('close',finish);resolve();};response.once('drain',finish);response.once('close',finish);
        });
      };
      try {
        while(true) {
          const chunk=await reader.read(); if(chunk.done) break;
          if(chunk.value.byteLength)deadline.receivedBytes();
          const text=decoder.decode(chunk.value,{stream:true}); raw=(raw+text).slice(-262144);eventBuffer+=text;
          if(eventBuffer.length>1048576)throw new Error('upstream SSE event exceeds the supported size');
          let separator;
          while((separator=/\r?\n\r?\n/.exec(eventBuffer))){const event=eventBuffer.slice(0,separator.index);eventBuffer=eventBuffer.slice(separator.index+separator[0].length);await forwardEvent(event);}
        }
        const tail=decoder.decode();raw+=tail;eventBuffer+=tail;if(eventBuffer.trim())await forwardEvent(eventBuffer);
      } finally { reader.releaseLock(); }
      if(native)raw=native.done?native.usageRaw:'';
      outcome=done&&(!native||native.successful)?'completed':'partial'; usageFinal=extractUpstreamUsage(raw)!==null;
      if(output){if(done&&!native)output.validate();if(!usageFinal)outcome='partial';}
    } else {
      raw=await boundedText(upstream,()=>deadline!.receivedBytes());
      const value=JSON.parse(raw) as Record<string,unknown>;
      if(!native&&!Array.isArray(value.choices))throw new Error('upstream returned an invalid completion');
      value.model=logicalModel;
      if(native){const usage=extractProtocolUsage(protocol,value);if(!usage)throw new Error('upstream response has no authoritative usage');const meter={prompt_tokens:usage.inputTokens,completion_tokens:usage.outputTokens,prompt_tokens_details:{cached_tokens:usage.cachedInputTokens}};nativeMeter=JSON.stringify({usage:meter});raw=JSON.stringify({adapted:native.json(value),usage:meter});}
      else if(output){const usage=extractUpstreamUsage(raw);if(!usage)throw new Error('upstream response has no authoritative usage');raw=JSON.stringify({chat:value,adapted:output.json(value,usage),usage:value.usage});}
      else raw=JSON.stringify(value);
      outcome='completed';usageFinal=extractUpstreamUsage(raw)!==null;
    }
  } catch (error) {
    controller.abort();
    if(native)raw=streamStarted?(native.done?native.usageRaw:''):nativeMeter;
    if(error instanceof ProtocolInputError)protocolValidation=error;
    // Redacted diagnostic: error class and cause code only, never URLs, headers or credentials.
    console.error(JSON.stringify({event:'upstream_failure',requestId,dispatched,errorName:error instanceof Error?error.name:'unknown',causeCode:(error as {cause?:{code?:string}}).cause?.code??null}));
    outcome=!dispatched?'rejected_before_upstream':clientCancelled?'client_cancelled':deadline?.phase?'timeout':draining?'partial':streamStarted?'partial':'upstream_error';
    // Interrupted generation may have incurred usage, even without its final usage event.
    usageFinal=!dispatched||definitelyNotSent(error);
    if(extractUpstreamUsage(raw)) { outcome='partial'; usageFinal=true; }
    upstreamStatus=protocolValidation?400:!dispatched?503:deadline?.phase?504:draining?503:502; failureMessage=protocolValidation?protocolValidation.message:!dispatched?'controlled upstream configuration is unavailable':deadline?.phase?`upstream ${deadline.phase} timeout`:draining?'gateway shutdown interrupted the upstream':'upstream model connection interrupted';
  } finally { deadline?.stop();activeUpstreams.delete(controller);clearInterval(heartbeat); response.off('close',onClose); }

  const usage=extractUpstreamUsage(raw)??{inputTokens:0,outputTokens:0,cachedInputTokens:0};
  const errorCode=protocolValidation?.code??(outcome==='completed'?undefined:deadline?.phase?`upstream_${deadline.phase}_timeout`:draining&&outcome==='partial'?'gateway_stopping':outcome==='upstream_error'?`upstream_http_${upstream?.status??'connection'}`:outcome==='rejected_before_upstream'?'controlled_configuration_unavailable':outcome);
  const settlement: SettlementRequest={...baseSettlement,outcome,forwarded:dispatched,ttftMs,errorCode,...usage,usageFinal,upstreamRequestId,actualAmount:configured?undefined:outcome==='completed'||outcome==='partial'?0.02:0,completedAt:new Date().toISOString()};
  let settled=false;
  try{settled=await journal.finalize(settlement);}catch(error){console.error(JSON.stringify({event:'settlement_journal_failed',requestId,reservationId:settlement.reservationId,errorName:error instanceof Error?error.name:'unknown',causeCode:(error as NodeJS.ErrnoException).code??null}));}
  if(!settled) {if(output&&streamStarted){await writeFrames(output.fail('settlement_pending','usage settlement is pending durable replay or reconciliation'));response.end();}else reply(503,{error:{type:'settlement_pending',message:'usage settlement is pending durable replay or reconciliation'},requestId}); return; }
  if(clientCancelled||response.destroyed) return;
  if(streamStarted) {
    if(output){await writeFrames(native&&native.done&&usageFinal?native.complete():outcome==='completed'&&done?output.complete(usage):output.fail(errorCode??'upstream_interrupted'));response.end();return;}
    if(outcome==='completed'&&done)response.write('data: [DONE]\n\n');
    if(outcome!=='completed') response.write(`event: error\ndata: ${JSON.stringify({error:{type:'upstream_interrupted',code:errorCode},requestId})}\n\n`);
    response.end(); return;
  }
  if(outcome==='completed') {
    response.writeHead(200,{'content-type':'application/json; charset=utf-8','x-request-id':requestId,...corsHeaders(origin)}); response.end(output?JSON.stringify(JSON.parse(raw).adapted):raw);
  } else if(upstream && !upstream.ok && raw) {
    if(output){reply(upstream.status,{error:{type:upstream.status===429?'rate_limit_error':'api_error',code:errorCode,message:'upstream model request failed'},requestId});return;}
    response.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json',...corsHeaders(origin)}); response.end(raw);
  } else reply(upstreamStatus,{error:{type:protocolValidation?.code??outcome,code:errorCode,message:failureMessage},requestId});
}
const pendingRequests=new Set<Promise<void>>();
async function handleOutbox(request:IncomingMessage,response:ServerResponse){
  const expected=createHash('sha256').update(`Bearer ${serviceToken}`).digest(),actual=createHash('sha256').update(request.headers.authorization??'').digest();
  if(!timingSafeEqual(expected,actual)){sendJson(response,401,{error:{type:'authentication_error',message:'service token required'}});return;}
  const url=new URL(request.url!,'http://gateway.local');
  if(request.method==='GET'&&url.pathname==='/internal/v1/outbox'){
    const requestId=url.searchParams.get('requestId');
    if(requestId!==null&&!isRequestReference(requestId)){sendJson(response,400,{error:{type:'invalid_request_error',message:'invalid requestId'}});return;}
    sendJson(response,200,{summary:await journal.status(),items:await journal.inspect(requestId??undefined),limit:100});return;
  }
  if(request.method==='POST'&&url.pathname==='/internal/v1/outbox/retry'){
    let body:Record<string,unknown>;try{body=await readJson(request);}catch{sendJson(response,400,{error:{type:'invalid_request_error',message:'invalid JSON body'}});return;}
    if(!isRequestReference(body.requestId)||(body.admissionAttemptId!==undefined&&!isRequestReference(body.admissionAttemptId))||typeof body.reason!=='string'||!body.reason.trim()||body.reason.length>1000||/[\u0000-\u001f\u007f]/.test(body.reason)||Object.keys(body).some(key=>!['requestId','reason','admissionAttemptId'].includes(key))){sendJson(response,400,{error:{type:'invalid_request_error',message:'requestId and a reason of 1–1000 characters are required; settlement changes are forbidden'}});return;}
    try{sendJson(response,200,{requestId:body.requestId,delivered:body.admissionAttemptId?await journal.retryAuthorization(body.requestId,body.admissionAttemptId as string,body.reason.trim()):await journal.retryBlocked(body.requestId,body.reason.trim())});}
    catch(error){const code=(error as {code?:string}).code;sendJson(response,code==='ENOENT'?404:code==='OUTBOX_NOT_BLOCKED'?409:503,{error:{type:code==='ENOENT'?'outbox_not_found':code==='OUTBOX_NOT_BLOCKED'?'outbox_not_blocked':'journal_unavailable'}});}
    return;
  }
  sendJson(response,404,{error:{type:'not_found'}});
}
async function serveRequest(request:IncomingMessage,response:ServerResponse){
  try {
    if(closing){sendJson(response,503,{error:{type:'gateway_stopping',message:'gateway is draining active requests'}},request.headers.origin);return;}
    // SDKs such as Claude Code append ?beta=true; query parameters do not change the public route.
    const {pathname}=new URL(request.url??'/','http://gateway.local');
    if(request.method==='GET'&&pathname==='/health') {const outbox=await journal.status();sendJson(response,200,{status:outbox.blocked||outbox.queued?'degraded':'ok',dataPlane:process.env.GATEWAY_DATA_PLANE==='higress'?'higress':runtimeMode==='production'?'controlled-proxy':'local-simulation',outbox},request.headers.origin);return;}
    if(pathname==='/internal/v1/outbox'||pathname.startsWith('/internal/v1/outbox/')){await handleOutbox(request,response);return;}
    if(request.method==='OPTIONS'&&['/v1/chat/completions','/v1/models','/v1/responses','/v1/messages'].includes(pathname)) {response.writeHead(204,corsHeaders(request.headers.origin));response.end();return;}
    if(request.method==='GET'&&pathname==='/v1/models') {await handleModels(request,response);return;}
    if(request.method==='POST'&&pathname==='/v1/chat/completions') {await handleCompletions(request,response);return;}
    if(request.method==='POST'&&pathname==='/v1/responses') {await handleCompletions(request,response,'responses');return;}
    if(request.method==='POST'&&pathname==='/v1/messages') {await handleCompletions(request,response,'messages');return;}
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
  const drain=setTimeout(()=>{draining=true;for(const controller of activeUpstreams)controller.abort();},timeouts.drainMs);drain.unref();
  const deadline=setTimeout(()=>process.exit(1),timeouts.drainMs+5000);deadline.unref();
  server.close(()=>{void (async()=>{
    await Promise.allSettled([...pendingRequests]);await journal.flush();await journal.close();
  })().then(()=>{clearTimeout(drain);clearTimeout(deadline);process.exit(0);}).catch(()=>process.exit(1));});
}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
await journal.initialize(async event=>(await controlPlane<SettlementResponse>('/internal/v1/usage/settlements',event)).status,input=>controlPlane<AuthorizeResponse>('/internal/v1/policy/authorize',input));
const host=process.env.HOST??'127.0.0.1';
server.listen(port,host,()=>console.log(`gateway listening on ${host}:${port}`));
