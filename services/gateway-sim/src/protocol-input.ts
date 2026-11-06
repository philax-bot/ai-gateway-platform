/** Native protocols retain provider payloads; Chat fallback converts the supported subset. */
export type PublicProtocol='chat'|'responses'|'messages';
type Obj=Record<string,unknown>;
export class ProtocolInputError extends Error {constructor(message:string,readonly code='invalid_request_error'){super(message);}}
const fail=(message:string):never=>{throw new ProtocolInputError(message);};
const unsupported=(message:string):never=>{throw new ProtocolInputError(message,'unsupported_parameter');};
function object(v:unknown,label:string):Obj {if(!v||typeof v!=='object'||Array.isArray(v))fail(label+' must be an object');return v as Obj;}
function array(v:unknown,label:string):unknown[]{if(!Array.isArray(v))fail(label+' must be an array');return v as unknown[];}
function text(v:unknown,label:string):string {if(typeof v!=='string')fail(label+' must be a string');return v as string;}
function name(v:unknown,label:string):string {const s=text(v,label);if(!/^[a-zA-Z0-9_-]{1,64}$/.test(s))fail(label+' must contain 1–64 letters, digits, underscores or hyphens');return s;}
function reference(v:unknown,label:string):string {const s=text(v,label);if(!s||s.length>160||/[\u0000-\u0020\u007f]/.test(s))fail(label+' must be an opaque reference');return s;}
function fields(v:Obj,allowed:string[],label:string){for(const k of Object.keys(v))if(!allowed.includes(k))unsupported(label+'.'+k+' is not supported by this stateless text/tool adapter');}
function positive(v:unknown,label:string){if(typeof v!=='number'||!Number.isSafeInteger(v)||v<1||v>2147483647)fail(label+' must be a positive integer');return v;}
function boolean(v:unknown,label:string){if(typeof v!=='boolean')fail(label+' must be a boolean');return v;}
function number(v:unknown,min:number,max:number,label:string){if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)fail(label+' is outside its supported range');return v;}
function jsonObject(v:unknown,label:string){const s=text(v,label);try{object(JSON.parse(s),label);}catch{fail(label+' must encode a JSON object');}return s;}
function schema(v:unknown){const s=object(v,'tool schema');if(s.type!=='object')fail('tool schema.type must be object');return s;}
function textParts(v:unknown,types:string[],label:string):string {if(typeof v==='string')return v;return array(v,label).map(p=>{const b=object(p,label+' block');if(!types.includes(String(b.type)))unsupported(label+' accepts text blocks only');fields(b,['type','text','annotations','logprobs','cache_control'],'text block');return text(b.text,'text');}).join('\n');}
function toolHistory(messages:Obj[]){const ids=new Set<string>(),pending=new Set<string>();for(const m of messages){if(m.role==='tool'){const id=String(m.tool_call_id);if(!pending.delete(id))fail('tool result requires a preceding matching tool call in the supplied history');continue;}if(pending.size)fail('all preceding tool calls require results before the next message');for(const t of (m.tool_calls??[])as Obj[]){const id=String(t.id);if(ids.has(id))fail('tool call IDs must be unique');ids.add(id);pending.add(id);}}if(pending.size)fail('supply results for preceding tool calls before requesting the next turn');}
function toolsUnique(tools:Obj[]){const names=tools.map(t=>(t.function as Obj).name);if(new Set(names).size!==names.length)fail('tool names must be unique');}

/** Native requests are inspected for the platform boundary, never round-tripped through Chat. */
function inspectNative(protocol:Exclude<PublicProtocol,'chat'>,body:Obj):Obj {
  for(const key of ['previous_response_id','conversation'])if(body[key]!=null)unsupported(key+' requires platform-owned conversation storage, which is not implemented');
  if(body.store!==undefined&&body.store!==false)unsupported('store=true is not supported');
  if(body.background!==undefined&&body.background!==false)unsupported('background execution is not supported');
  if(body.modalities!==undefined&&array(body.modalities,'modalities').some(v=>v!=='text'))unsupported('only text output is enabled');
  for(const key of ['audio','image','video'])if(body[key]!=null)unsupported(key+' is not enabled');
  // Content is provider-owned. Inspect only known unsupported billing modalities, including
  // nested tool results; leave unknown item/block types and image validation to the upstream.
  const parts=(value:unknown):void=>{if(Array.isArray(value)){for(const item of value)parts(item);return;}if(!value||typeof value!=='object')return;
    const block=value as Obj;
    if(['input_audio','output_audio','audio','input_video','output_video','video'].includes(String(block.type)))unsupported('audio/video content requires separate metering support');
    for(const key of ['content','output'])if(block[key]!==undefined)parts(block[key]);
  };
  // Keep a positive execution boundary: unknown server tools may incur fees absent from our
  // token ledger. web_search is an existing compatibility exception, not a billing guarantee.
  const tools=(value:unknown,nested=false):void=>{for(const raw of array(value,'tools')){const tool=object(raw,'tool');
    const accepted=protocol==='responses'?['function','custom','namespace',...(nested?[]:['web_search'])]:[undefined,'custom'];
    if(!accepted.includes(tool.type as string|undefined))unsupported('server or unknown tool '+String(tool.type)+' requires separate pricing and acceptance');
    if(tool.type==='namespace')tools(tool.tools,true);
  }};
  if(body.tools!==undefined)tools(body.tools);
  if(body.mcp_servers!=null)unsupported('mcp_servers requires separate pricing and acceptance');
  if(protocol==='responses'){
    if(body.input===undefined&&body.instructions===undefined)fail('input or instructions is required');
    if(body.input!==undefined)parts(body.input);
  }else{
    parts(array(body.messages,'messages'));
    if(body.system!==undefined)parts(body.system);
  }
  // This projection is for boundary/guardrail checks only. Admission estimates the
  // original structured request; upstream forwarding never uses this serialized string.
  const result:Obj={model:body.model,messages:[{role:'user',content:JSON.stringify(body)}]};
  if(body.stream!==undefined)result.stream=boolean(body.stream,'stream');
  const limit=protocol==='responses'?body.max_output_tokens:body.max_tokens;if(limit!==undefined)result.max_tokens=positive(limit,'output token limit');else if(protocol==='messages')fail('max_tokens is required');
  return result;
}

export function normalizeProtocolRequest(protocol:PublicProtocol,body:Obj,native=false):Obj {
  if(protocol==='chat')return body;
  const model=text(body.model,'model');if(!model.trim())fail('model is required');
  if(native)return inspectNative(protocol,body);
  const out:Obj={model,messages:[]};if(body.stream!==undefined)out.stream=boolean(body.stream,'stream');
  if(body.temperature!==undefined)out.temperature=number(body.temperature,0,protocol==='messages'?1:2,'temperature');
  if(body.top_p!==undefined)out.top_p=number(body.top_p,0,1,'top_p');
  const messages=out.messages as Obj[];
  if(protocol==='responses'){
    fields(body,['model','input','instructions','max_output_tokens','stream','temperature','top_p','tools','tool_choice','parallel_tool_calls','store','background','previous_response_id','conversation','metadata','text','reasoning','truncation','include','service_tier','user'],'request');
    if(body.store!==undefined&&body.store!==false)unsupported('store=true is not supported; supply complete input history with store=false');
    if(body.background!==undefined&&body.background!==false)unsupported('background responses are not supported');
    for(const k of ['previous_response_id','conversation'])if(body[k]!=null)unsupported(k+' is not supported; supply complete input history');
    if(body.truncation!==undefined&&body.truncation!=='disabled')unsupported('automatic input truncation is not supported');
    if(body.include!==undefined&&array(body.include,'include').length)unsupported('include extensions are not supported');
    if(body.service_tier!==undefined&&body.service_tier!=='auto')unsupported('service_tier is not supported');
    if(body.reasoning!==undefined&&Object.keys(object(body.reasoning,'reasoning')).length&&!native)unsupported('reasoning controls and encrypted history require native protocol support');
    if(body.text!==undefined&&!native){const t=object(body.text,'text');fields(t,['format'],'text');if(t.format!==undefined){const f=object(t.format,'text.format');fields(f,['type'],'text.format');if(f.type!=='text')unsupported('structured output formats require native protocol support');}}
    if(body.max_output_tokens!==undefined)out.max_tokens=positive(body.max_output_tokens,'max_output_tokens');
    if(body.instructions!=null)messages.push({role:'system',content:text(body.instructions,'instructions')});
    const input=body.input===undefined?[]:typeof body.input==='string'?[{role:'user',content:body.input}]:array(body.input,'input');
    for(const item of input){const v=object(item,'input item');if(v.type===undefined||v.type==='message'){fields(v,['type','role','content','id','status'],'message');if(!['user','assistant','system','developer'].includes(String(v.role)))fail('invalid message role');messages.push({role:v.role,content:textParts(v.content,['input_text','output_text'],'message.content')});}
      else if(v.type==='function_call'){fields(v,['type','id','call_id','name','arguments','status'],'function_call');const call={id:reference(v.call_id,'call_id'),type:'function',function:{name:name(v.name,'function name'),arguments:jsonObject(v.arguments,'arguments')}};const previous=messages.at(-1);if(previous?.role==='assistant')previous.tool_calls=[...(previous.tool_calls as Obj[]??[]),call];else messages.push({role:'assistant',content:null,tool_calls:[call]});}
      else if(v.type==='function_call_output'){fields(v,['type','id','call_id','output','status'],'function_call_output');messages.push({role:'tool',tool_call_id:reference(v.call_id,'call_id'),content:textParts(v.output,['input_text'],'function output')});}
      else if(v.type==='reasoning'&&native)continue;
      else unsupported('input item type '+String(v.type)+' is not supported');
    }
    if(body.tools!==undefined){out.tools=array(body.tools,'tools').map(t=>{const v=object(t,'tool');if(v.type!=='function')unsupported('only client function tools are supported');fields(v,['type','name','description','parameters','strict'],'tool');return {type:'function',function:{name:name(v.name,'tool name'),...(v.description===undefined?{}:{description:text(v.description,'tool description')}),parameters:v.parameters===undefined?{type:'object',properties:{}}:schema(v.parameters),...(v.strict===undefined?{}:{strict:boolean(v.strict,'strict')})}};});}
    if(body.parallel_tool_calls!==undefined)out.parallel_tool_calls=boolean(body.parallel_tool_calls,'parallel_tool_calls');
    if(body.tool_choice!==undefined){if(['auto','none','required'].includes(String(body.tool_choice)))out.tool_choice=body.tool_choice;else{const c=object(body.tool_choice,'tool_choice');fields(c,['type','name'],'tool_choice');if(c.type!=='function')unsupported('only function tool_choice is supported');out.tool_choice={type:'function',function:{name:name(c.name,'tool_choice.name')}};}}
  }else{
    fields(body,['model','messages','system','max_tokens','stream','temperature','top_p','tools','tool_choice','metadata','stop_sequences','thinking','output_config','service_tier'],'request');
    out.max_tokens=positive(body.max_tokens,'max_tokens');
    if(body.thinking!==undefined&&!native){const v=object(body.thinking,'thinking');if(v.type!=='disabled'||Object.keys(v).some(k=>k!=='type'))unsupported('signed/extended thinking requires native protocol support');}
    if(body.output_config!==undefined&&Object.keys(object(body.output_config,'output_config')).length&&!native)unsupported('output_config requires native protocol support');
    if(body.service_tier!==undefined&&body.service_tier!=='auto')unsupported('service_tier is not supported');
    if(body.stop_sequences!==undefined&&array(body.stop_sequences,'stop_sequences').length&&!native)unsupported('stop_sequences require native provider stop-sequence metadata');
    if(body.system!==undefined)messages.push({role:'system',content:textParts(body.system,['text'],'system')});
    for(const item of array(body.messages,'messages')){const m=object(item,'message');fields(m,['role','content'],'message');if(!['user','assistant'].includes(String(m.role)))fail('Messages roles must be user or assistant');
      if(typeof m.content==='string'){messages.push({role:m.role,content:m.content});continue;}
      const parts=array(m.content,'message.content');let content:string[]=[],calls:Obj[]=[];
      const flush=()=>{if(content.length||calls.length){messages.push({role:m.role,content:content.length?content.join('\n'):null,...(calls.length?{tool_calls:calls}:{})});content=[];calls=[];}};
      for(const part of parts){const b=object(part,'content block');if(b.type==='text'){fields(b,['type','text','cache_control'],'text');content.push(text(b.text,'text'));}
        else if(b.type==='tool_use'&&m.role==='assistant'){fields(b,['type','id','name','input','cache_control'],'tool_use');calls.push({id:reference(b.id,'tool_use.id'),type:'function',function:{name:name(b.name,'tool_use.name'),arguments:JSON.stringify(object(b.input,'tool_use.input'))}});}
        else if(b.type==='tool_result'&&m.role==='user'){fields(b,['type','tool_use_id','content','is_error','cache_control'],'tool_result');flush();const result=b.content===undefined?'':textParts(b.content,['text'],'tool result');if(b.is_error!==undefined)boolean(b.is_error,'tool_result.is_error');messages.push({role:'tool',tool_call_id:reference(b.tool_use_id,'tool_use_id'),content:b.is_error?'Tool execution error: '+result:result});}
        else if(native&&m.role==='assistant'&&['thinking','redacted_thinking'].includes(String(b.type)))continue;
        else unsupported('content block '+String(b.type)+' is not supported for '+String(m.role));
      }flush();
    }
    if(body.tools!==undefined)out.tools=array(body.tools,'tools').map(t=>{const v=object(t,'tool');fields(v,['name','description','input_schema','cache_control'],'tool');return {type:'function',function:{name:name(v.name,'tool name'),...(v.description===undefined?{}:{description:text(v.description,'tool description')}),parameters:schema(v.input_schema)}};});
    if(body.tool_choice!==undefined){const c=object(body.tool_choice,'tool_choice');fields(c,['type','name','disable_parallel_tool_use'],'tool_choice');if(c.disable_parallel_tool_use!==undefined)out.parallel_tool_calls=!boolean(c.disable_parallel_tool_use,'disable_parallel_tool_use');if(c.type==='tool')out.tool_choice={type:'function',function:{name:name(c.name,'tool_choice.name')}};else if(['auto','any','none'].includes(String(c.type)))out.tool_choice=c.type==='any'?'required':c.type;else unsupported('unsupported tool_choice');}
  }
  if(!messages.length)fail('at least one input message is required');toolHistory(messages);
  const tools=(out.tools??[])as Obj[];toolsUnique(tools);const choice=out.tool_choice as Obj|string|undefined;if(choice&&choice!=='auto'&&choice!=='none'&&!tools.length)fail('tool_choice requires tools');if(choice&&typeof choice==='object'&&!tools.some(t=>(t.function as Obj).name===(choice.function as Obj).name))fail('tool_choice must name a supplied tool');
  return out;
}

export function protocolError(protocol:PublicProtocol,value:unknown):unknown {
  if(protocol!=='messages')return value;
  const v=object(value,'error'),e=object(v.error??{type:'api_error',message:'gateway request failed'},'error');
  return {type:'error',error:{...e,message:e.message??String(e.type)},...(v.requestId?{request_id:v.requestId}:{})};
}
