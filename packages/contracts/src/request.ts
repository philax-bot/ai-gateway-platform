import {Tiktoken} from 'js-tiktoken/lite';
import cl100k from 'js-tiktoken/ranks/cl100k_base';

let encoding:Tiktoken|undefined;
/** Generic BPE estimate with headroom, not the selected provider's exact tokenizer.
 * Images get a separate provisional budget; encoded file bytes are not text tokens.
 * Authoritative upstream usage remains the settlement source.
 */
export function estimateChatInput(request:Record<string,unknown>):number {
  return estimateProtocolInput(request,'chat');
}
export function estimateProtocolInput(request:Record<string,unknown>,protocol:'chat'|'messages'|'responses'):number {
  let images=0;
  const project=(value:unknown):unknown=>{
    if(Array.isArray(value))return value.map(project);
    if(!value||typeof value!=='object')return value;
    const block=value as Record<string,unknown>;
    if(['image_url','input_image','image'].includes(String(block.type))){images++;return {type:block.type};}
    return Object.fromEntries(Object.entries(block).map(([key,item])=>[key,project(item)]));
  };
  const keys=protocol==='chat'?['messages','tools','tool_choice','response_format']:
    protocol==='messages'?['system','messages','tools','tool_choice']:
    ['instructions','input','tools','tool_choice','text'];
  const input=project(Object.fromEntries(keys.filter(key=>request[key]!==undefined).map(key=>[key,request[key]])));
  encoding??=new Tiktoken(cl100k);
  // Treat special-token-looking user strings as ordinary text, never as control tokens.
  const tokens=encoding.encode(JSON.stringify(input),[],[]).length;
  // 25% text headroom + envelope overhead; 8192/image is a provisional cross-provider
  // reserve, not an upper bound for every model/resolution. Never fetch remote URLs.
  return Math.ceil(tokens*1.25)+256+images*8192;
}
export function chatCompletionsUrl(baseUrl:string):string{
  const url=new URL(baseUrl),path=url.pathname.replace(/\/+$/,'');
  url.pathname=path.endsWith('/chat/completions')?path:path.endsWith('/v1')?`${path}/chat/completions`:`${path}/v1/chat/completions`;
  return url.toString();
}
