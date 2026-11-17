import { createHash } from 'node:crypto';
import type { PriceSnapshot, VerificationCost, VerificationMappingSnapshot, VerificationMappingResult,ModelProtocol } from '@ai-gateway/contracts';
import { extractUpstreamUsage,extractProtocolUsage,readUpstreamRequestId, shouldRetryConnect } from '@ai-gateway/contracts';
import { costForUsage } from '../store/admission';

/** Verification waits for a real model answer; the 5s default was below a normal connect+reasoning latency. */
const DEFAULT_VERIFICATION_TIMEOUT_MS = 20000;
export function verificationTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.UPSTREAM_VALIDATION_TIMEOUT_MS ?? DEFAULT_VERIFICATION_TIMEOUT_MS);
  return Number.isSafeInteger(value) && value >= 1000 && value <= 120000 ? value : DEFAULT_VERIFICATION_TIMEOUT_MS;
}

/**
 * One bounded retry, and only when the failure provably happened before any
 * request bytes were sent. Diagnostic traffic is never billed, but the same rule
 * keeps verification results honest about what actually reached the upstream.
 */
export async function fetchVerifiedUpstream(url: string, init: RequestInit): Promise<Response> {
  let attempt = 0;
  for (;;) {
    try {
      // pi-lens-ignore: ts-ssrf — the service URL is validated on save and the loopback/explicit-enable gate is checked by the caller.
      return await fetch(url, init);
    } catch (error) {
      if (!shouldRetryConnect(error, attempt)) throw error;
      attempt++;
    }
  }
}

export interface VerificationMappingInput {
  kind?:import('@ai-gateway/contracts').ModelKind;
  costPrice?: {inputPrice:number;outputPrice:number;cachedInputPrice:number}|null;
  definitionId: string;
  upstreamModel: string;
  inputPrice: number | null;
  outputPrice: number | null;
  cachedInputPrice: number | null;
}

export function verificationMappingSnapshots(mappings: VerificationMappingInput[]): VerificationMappingSnapshot[] {
  return mappings.map(mapping => ({
    kind:mapping.kind??'chat',
    protocols:(mapping.kind??'chat')==='chat'?['chat','responses','messages']:undefined,
    definitionId: mapping.definitionId,
    upstreamModel: mapping.upstreamModel,
    inputPrice: mapping.costPrice?.inputPrice??null,
    outputPrice: mapping.costPrice?.outputPrice??null,
    cachedInputPrice: mapping.costPrice?.cachedInputPrice??null,
    attemptedAt: null,
  }));
}

/** Non-generative connectivity check. Never spends generation quota during connection setup. */
export async function probeModelCatalog(baseUrl:string,mapping:VerificationMappingInput,credential:string|null,adapter='openai'):Promise<VerificationMappingResult>{
  const base={definitionId:mapping.definitionId,upstreamModel:mapping.upstreamModel,usage:{inputTokens:null,outputTokens:null,cachedInputTokens:null,complete:false},cost:{state:'usage_unknown' as const,amount:null,price:null},upstreamRequestId:null};
  try{
    const {modelEndpoint}=await import('@ai-gateway/contracts'),url=new URL(modelEndpoint(baseUrl,'chat'));url.pathname=adapter==='cohere'?'/v1/models':url.pathname.replace(/chat\/completions$/,'models');
    const response=await fetchVerifiedUpstream(url.toString(),{method:'GET',redirect:'error',signal:AbortSignal.timeout(verificationTimeoutMs()),headers:credential?{authorization:`Bearer ${credential}`}:{}});
    let text='',size=0;const reader=response.body?.getReader();if(reader)try{for(;;){const c=await reader.read();if(c.done)break;size+=c.value.length;if(size>1048576){await reader.cancel();throw Error('model catalog too large');}text+=new TextDecoder().decode(c.value);}}finally{reader.releaseLock();}
    const value=JSON.parse(text),rows=Array.isArray(value)?value:value.data??value.models;
    const found=response.ok&&Array.isArray(rows)&&rows.some((r:{id?:string;name?:string})=>r.id===mapping.upstreamModel||r.name===mapping.upstreamModel);
    return {...base,outcome:found?'passed':'failed',httpStatus:response.status,errorCode:found?null:response.ok?'model_not_found':verificationFailure(response.status,null).errorCode,message:found?'模型目录连通性通过；未执行生成，效果和计量需实际调用验证':'模型目录未确认该模型；请核对模型标识与供应商目录接口',completedAt:new Date().toISOString()};
  }catch(error){return {...base,outcome:'failed',httpStatus:null,...verificationFailure(null,error),completedAt:new Date().toISOString()};}
}

export function verificationProbeRequest(protocol:ModelProtocol,model:string,capability:'basic'|'stream'|'tools'='basic'):Record<string,unknown>{
  const body=protocol==='responses'?{model,input:'Connection validation',max_output_tokens:1,store:false}:protocol==='messages'?{model,messages:[{role:'user',content:'Connection validation'}],max_tokens:1}:{model,messages:[{role:'user',content:'Connection validation'}],max_tokens:1};
  if(capability==='stream'){Object.assign(body,{stream:true,stream_options:{include_usage:true}});}
  if(capability==='tools'){Object.assign(body,{max_tokens:64,tools:[{type:'function',function:{name:'gateway_probe',description:'Return validation result',parameters:{type:'object',properties:{ok:{type:'boolean'}},required:['ok']}}}],tool_choice:{type:'function',function:{name:'gateway_probe'}}});}
  return body;
}

export async function probeProtocol(protocol:ModelProtocol,url:string,model:string,credential:string|null|undefined,hop:boolean,mapping:VerificationMappingInput,price:PriceSnapshot|null,capability:'basic'|'stream'|'tools'='basic'):Promise<VerificationMappingResult>{
  const completed=()=>new Date().toISOString();
  const base={definitionId:mapping.definitionId,upstreamModel:mapping.upstreamModel,protocol};
  try{
    const body=verificationProbeRequest(protocol,model,capability);
    const response=await fetchVerifiedUpstream(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(verificationTimeoutMs()),headers:{'content-type':'application/json',...(protocol==='messages'?{'anthropic-version':'2023-06-01'}:{}),...(credential?hop?{'x-atlas-hop-token':`Bearer ${credential}`}:{authorization:`Bearer ${credential}`,...(protocol==='messages'?{'x-api-key':credential}:{})}:{})},body:JSON.stringify(body)});
    const upstreamRequestId=readUpstreamRequestId(response.headers);let raw='',size=0;const reader=response.body?.getReader();try{if(reader){const decoder=new TextDecoder();for(;;){const chunk=await reader.read();if(chunk.done){raw+=decoder.decode();break;}size+=chunk.value.byteLength;if(size>1048576){await reader.cancel();throw Error('响应不符合支持的大小');}raw+=decoder.decode(chunk.value,{stream:true});}}}finally{reader?.releaseLock();}
    let value:unknown;try{value=JSON.parse(raw);}catch{value=null;}
    if(capability==='stream'){
      const payloads=raw.split(/\r?\n\r?\n/).map(frame=>frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n'));
      const events=payloads.filter(data=>data.trim()!=='[DONE]').flatMap(data=>{try{return [JSON.parse(data)];}catch{return [];}});
      const usageEvent=[...events].reverse().find(event=>event.usage);
      const delta=events.some(event=>event.choices?.some((choice:any)=>typeof choice.delta?.content==='string'||Array.isArray(choice.delta?.tool_calls)));
      value=delta&&payloads.some(data=>data.trim()==='[DONE]')&&!events.some(event=>event.error)?{choices:[{message:{content:'stream validated'}}],usage:usageEvent?.usage}:null;
    }
    const usage=extractProtocolUsage(protocol,value),meter={usage:usage?{...usage,complete:true}:{inputTokens:null,outputTokens:null,cachedInputTokens:null,complete:false},cost:verificationCost(price,usage),upstreamRequestId,httpStatus:response.status,completedAt:completed()};
    if(!response.ok){const failure=verificationFailure(response.status,null);return {...base,...meter,outcome:'failed',support:[404,405,501].includes(response.status)?'unsupported':'unknown',errorCode:failure.errorCode,message:failure.message};}
    const v=value as Record<string,unknown>|null;
    const valid=!!v&&!Array.isArray(v)&&!v.error&&(protocol==='chat'?Array.isArray(v.choices)&&v.choices.length>0:protocol==='responses'?v.object==='response'&&v.status!=='failed'&&Array.isArray(v.output):v.type==='message'&&Array.isArray(v.content));
    if(capability==='tools'&&!(v?.choices as any[])?.some(choice=>choice.message?.tool_calls?.some((tool:any)=>tool.function?.name==='gateway_probe'&&typeof tool.function?.arguments==='string')))return {...base,...meter,outcome:'failed',support:'unknown',errorCode:'tool_response_missing',message:'HTTP 成功但没有返回要求的工具调用'};
    if(!valid)return {...base,...meter,outcome:'failed',support:'unknown',errorCode:'invalid_response',message:'HTTP 成功但响应不符合该协议，不能确认支持'};
    return {...base,...meter,outcome:'passed',support:'supported',errorCode:null,message:usage?'基础协议通过，已返回用量':'基础协议通过，上游未返回完整用量'};
  }catch(error){const failure=verificationFailure(null,error);return {...base,outcome:'failed',support:'unknown',httpStatus:null,errorCode:failure.errorCode,message:failure.message,upstreamRequestId:null,usage:{inputTokens:null,outputTokens:null,cachedInputTokens:null,complete:false},cost:verificationCost(price,null),completedAt:completed()};}
}

/** Diagnostic pricing reuses the admission price shape, with its own version marker. */
export function verificationPrice(serviceId: string, configVersion: number, mapping: VerificationMappingInput): PriceSnapshot | null {
  const cost=mapping.costPrice;
  if (!cost||[cost.inputPrice,cost.outputPrice,cost.cachedInputPrice].some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) return null;
  return {
    version: createHash('sha256').update(JSON.stringify([serviceId, configVersion, mapping.definitionId, mapping.upstreamModel, cost, 'verification-cost-v1'])).digest('hex').slice(0, 24),
    currency: 'CNY',
    unit: 'per_million_tokens',
    inputPrice: cost.inputPrice,
    outputPrice: cost.outputPrice,
    cachedInputPrice: cost.cachedInputPrice,
  };
}

export function verificationCost(price: PriceSnapshot | null, usage: ReturnType<typeof extractUpstreamUsage>): VerificationCost {
  if (!usage) return { state: 'usage_unknown', amount: null, price };
  if (!price) return { state: 'price_unknown', amount: null, price: null };
  try {
    return { state: 'priced', amount: costForUsage(price, usage.inputTokens, usage.outputTokens, usage.cachedInputTokens), price };
  } catch {
    return { state: 'price_unknown', amount: null, price: null };
  }
}

export function verificationFailure(status: number | null, error: unknown): { errorCode: string; message: string } {
  if (error instanceof Error && error.name === 'TimeoutError') return { errorCode: 'timeout', message: '连接超时' };
  if (status === 401 || status === 403) return { errorCode: 'auth_failed', message: '鉴权失败' };
  if (status === 404) return { errorCode: 'model_not_found', message: '模型或接口不存在' };
  if (status !== null && status >= 500) return { errorCode: 'upstream_error', message: `上游返回 HTTP ${status}` };
  if (status !== null) return { errorCode: 'http_error', message: `上游返回 HTTP ${status}` };
  const message = error instanceof Error ? error.message : '';
  if (/响应不符合/.test(message)) return { errorCode: 'invalid_response', message: '响应不符合文本对话格式' };
  if (/credential reference/.test(message)) return { errorCode: 'credential_missing', message: '受控凭据引用未配置' };
  return { errorCode: 'connection_failed', message: message || '连接失败' };
}
