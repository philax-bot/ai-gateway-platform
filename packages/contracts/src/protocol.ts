import {extractUpstreamUsage,type UpstreamUsage} from './usage.js';
export type ModelProtocol='chat'|'responses'|'messages';
export const modelProtocols:ModelProtocol[]=['chat','responses','messages'];
export type ProtocolPaths=Partial<Record<'responses'|'messages',string>>;
export interface ProtocolCapability {status:'supported'|'unsupported'|'unknown';checkedAt:string;httpStatus:number|null;errorCode:string|null}
export interface ServiceProtocolCapabilities {configVersion:number;mappings:Record<string,Partial<Record<ModelProtocol,ProtocolCapability>>>}

/** Relative endpoint paths stay on the service's controlled authority. No model-name capability guesses. */
export function protocolUrl(baseUrl:string,protocol:ModelProtocol,paths:ProtocolPaths={}):string {
  const url=new URL(baseUrl);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('invalid controlled service URL');
  let base=url.pathname.replace(/\/+$/,'').replace(/\/(?:chat\/completions|responses|messages)$/,'');
  if(protocol!=='chat'&&paths[protocol]!==undefined){const path=paths[protocol]!;if(!/^\/(?!\/)[A-Za-z0-9_./~-]+$/.test(path)||path.includes('..'))throw Error('invalid relative protocol path');url.pathname=path;return url.toString();}
  if(protocol==='messages'&&url.hostname==='api.deepseek.com')base='/anthropic';
  url.pathname=(base.endsWith('/v1')?base:base+'/v1')+'/'+(protocol==='chat'?'chat/completions':protocol);
  return url.toString();
}

/** Normalize protocol-specific authoritative usage for the existing price snapshot. */
export function extractProtocolUsage(protocol:ModelProtocol,value:unknown):UpstreamUsage|null {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const usage=(value as {usage?:Record<string,unknown>}).usage;if(!usage)return null;
  if(protocol==='chat')return extractUpstreamUsage(JSON.stringify(value));
  if(protocol==='responses')return extractUpstreamUsage(JSON.stringify({usage:{prompt_tokens:usage.input_tokens,completion_tokens:usage.output_tokens,prompt_tokens_details:{cached_tokens:(usage.input_tokens_details as Record<string,unknown>|undefined)?.cached_tokens??0}}}));
  const input=usage.input_tokens,output=usage.output_tokens,read=usage.cache_read_input_tokens??0,created=usage.cache_creation_input_tokens??0;
  if(![input,output,read,created].every(n=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0&&n<=2147483647))return null;
  return extractUpstreamUsage(JSON.stringify({usage:{prompt_tokens:Number(input)+Number(read)+Number(created),completion_tokens:output,prompt_tokens_details:{cached_tokens:read}}}));
}
