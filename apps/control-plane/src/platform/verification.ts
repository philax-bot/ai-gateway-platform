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
  definitionId: string;
  upstreamModel: string;
  inputPrice: number | null;
  outputPrice: number | null;
  cachedInputPrice: number | null;
}

export function verificationMappingSnapshots(mappings: VerificationMappingInput[]): VerificationMappingSnapshot[] {
  return mappings.map(mapping => ({
    protocols:['chat','responses','messages'],
    definitionId: mapping.definitionId,
    upstreamModel: mapping.upstreamModel,
    inputPrice: mapping.inputPrice,
    outputPrice: mapping.outputPrice,
    cachedInputPrice: mapping.cachedInputPrice,
    attemptedAt: null,
  }));
}

export async function probeProtocol(protocol:ModelProtocol,url:string,model:string,credential:string|null|undefined,hop:boolean,mapping:VerificationMappingInput,price:PriceSnapshot|null):Promise<VerificationMappingResult>{
  const completed=()=>new Date().toISOString();
  const base={definitionId:mapping.definitionId,upstreamModel:mapping.upstreamModel,protocol};
  try{
    const body=protocol==='responses'?{model,input:'Connection validation',max_output_tokens:1,store:false}:protocol==='messages'?{model,messages:[{role:'user',content:'Connection validation'}],max_tokens:1}:{model,messages:[{role:'user',content:'Connection validation'}],max_tokens:1};
    const response=await fetchVerifiedUpstream(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(verificationTimeoutMs()),headers:{'content-type':'application/json',...(protocol==='messages'?{'anthropic-version':'2023-06-01'}:{}),...(credential?hop?{'x-atlas-hop-token':`Bearer ${credential}`}:{authorization:`Bearer ${credential}`,...(protocol==='messages'?{'x-api-key':credential}:{})}:{})},body:JSON.stringify(body)});
    const upstreamRequestId=readUpstreamRequestId(response.headers);let raw='',size=0;const reader=response.body?.getReader();try{if(reader){const decoder=new TextDecoder();for(;;){const chunk=await reader.read();if(chunk.done){raw+=decoder.decode();break;}size+=chunk.value.byteLength;if(size>1048576){await reader.cancel();throw Error('响应不符合支持的大小');}raw+=decoder.decode(chunk.value,{stream:true});}}}finally{reader?.releaseLock();}
    let value:unknown;try{value=JSON.parse(raw);}catch{value=null;}
    const usage=extractProtocolUsage(protocol,value),meter={usage:usage?{...usage,complete:true}:{inputTokens:null,outputTokens:null,cachedInputTokens:null,complete:false},cost:verificationCost(price,usage),upstreamRequestId,httpStatus:response.status,completedAt:completed()};
    if(!response.ok){const failure=verificationFailure(response.status,null);return {...base,...meter,outcome:'failed',support:[404,405,501].includes(response.status)?'unsupported':'unknown',errorCode:failure.errorCode,message:failure.message};}
    const v=value as Record<string,unknown>|null;
    const valid=!!v&&!Array.isArray(v)&&!v.error&&(protocol==='chat'?Array.isArray(v.choices)&&v.choices.length>0:protocol==='responses'?v.object==='response'&&v.status!=='failed'&&Array.isArray(v.output):v.type==='message'&&Array.isArray(v.content));
    if(!valid)return {...base,...meter,outcome:'failed',support:'unknown',errorCode:'invalid_response',message:'HTTP 成功但响应不符合该协议，不能确认支持'};
    return {...base,...meter,outcome:'passed',support:'supported',errorCode:null,message:usage?'基础协议通过，已返回用量':'基础协议通过，上游未返回完整用量'};
  }catch(error){const failure=verificationFailure(null,error);return {...base,outcome:'failed',support:'unknown',httpStatus:null,errorCode:failure.errorCode,message:failure.message,upstreamRequestId:null,usage:{inputTokens:null,outputTokens:null,cachedInputTokens:null,complete:false},cost:verificationCost(price,null),completedAt:completed()};}
}

/** Diagnostic pricing reuses the admission price shape, with its own version marker. */
export function verificationPrice(serviceId: string, configVersion: number, mapping: VerificationMappingInput): PriceSnapshot | null {
  if ([mapping.inputPrice, mapping.outputPrice, mapping.cachedInputPrice].some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) return null;
  return {
    version: createHash('sha256').update(JSON.stringify([serviceId, configVersion, mapping.definitionId, mapping.upstreamModel, mapping.inputPrice, mapping.outputPrice, mapping.cachedInputPrice, 'verification'])).digest('hex').slice(0, 24),
    currency: 'CNY',
    unit: 'per_million_tokens',
    inputPrice: mapping.inputPrice!,
    outputPrice: mapping.outputPrice!,
    cachedInputPrice: mapping.cachedInputPrice!,
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
