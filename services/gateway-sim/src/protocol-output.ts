import {randomUUID} from 'node:crypto';
import {extractUpstreamUsage} from '@ai-gateway/contracts';
import type {PublicProtocol} from './protocol-input.js';

type Obj=Record<string,unknown>;
type Usage=NonNullable<ReturnType<typeof extractUpstreamUsage>>;
type Item={kind:'text';id:string;text:string}|{kind:'tool';id:string;callId:string;name:string;arguments:string};
const id=(prefix:string)=>prefix+randomUUID().replaceAll('-','');
function invalid():never {throw new Error('invalid upstream protocol response');}
const obj=(value:unknown):Obj=>value&&typeof value==='object'&&!Array.isArray(value)?value as Obj:invalid();
const string=(value:unknown):string=>typeof value==='string'?value:invalid();
function toolInput(value:string):Obj {try{return obj(JSON.parse(value));}catch{return invalid();}}
function responseUsage(u:Usage){return {input_tokens:u.inputTokens,input_tokens_details:{cached_tokens:u.cachedInputTokens},output_tokens:u.outputTokens,output_tokens_details:{reasoning_tokens:0},total_tokens:u.inputTokens+u.outputTokens};}
function messageUsage(u:Usage){return {input_tokens:u.inputTokens-u.cachedInputTokens,cache_read_input_tokens:u.cachedInputTokens,cache_creation_input_tokens:0,output_tokens:u.outputTokens};}

/** Incremental output conversion. Terminal success is emitted only after durable settlement. */
export class ProtocolOutput {
  private sequence=0;
  private items:Item[]=[];
  private tools=new Map<number,number>();
  private textIndex:number|undefined;
  private finishReason:string|null=null;
  private size=0;
  private reasoningTokens:number|undefined;
  readonly id:string;
  private created=Math.floor(Date.now()/1000);
  constructor(readonly protocol:Exclude<PublicProtocol,'chat'>,private model:string){this.id=id(protocol==='responses'?'resp_':'msg_');}
  private event(type:string,body:Obj={}):string {const value={type,...body,...(this.protocol==='responses'?{sequence_number:this.sequence++}:{})};return `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;}
  private publicItem(item:Item,status='completed'):Obj {
    if(this.protocol==='messages')return item.kind==='text'?{type:'text',text:item.text}:{type:'tool_use',id:item.callId,name:item.name,input:toolInput(item.arguments)};
    return item.kind==='text'?{id:item.id,type:'message',status,role:'assistant',content:[{type:'output_text',text:item.text,annotations:[],logprobs:[]}]}:{id:item.id,type:'function_call',status,call_id:item.callId,name:item.name,arguments:item.arguments};
  }
  private response(status:string,usage:Usage|null,error?:Obj):Obj {
    const u=usage?responseUsage(usage):null;
    // Reasoning is charged as part of output usage. Do not manufacture a breakdown.
    if(u&&this.reasoningTokens!==undefined)u.output_tokens_details.reasoning_tokens=this.reasoningTokens;
    else if(u)delete (u as Obj).output_tokens_details;
    return {id:this.id,object:'response',created_at:this.created,completed_at:status==='completed'?Math.floor(Date.now()/1000):null,status,error:error??null,incomplete_details:status==='incomplete'?{reason:'max_output_tokens'}:null,model:this.model,output:this.items.map(i=>this.publicItem(i,status==='incomplete'?'incomplete':status==='in_progress'?'in_progress':'completed')),usage:u,store:false,background:false,parallel_tool_calls:true,tool_choice:'auto',tools:[],truncation:'disabled',metadata:{}};
  }
  start():string {
    if(this.protocol==='responses')return this.event('response.created',{response:this.response('in_progress',null)})+this.event('response.in_progress',{response:this.response('in_progress',null)});
    return this.event('message_start',{message:{id:this.id,type:'message',role:'assistant',content:[],model:this.model,stop_reason:null,stop_sequence:null,usage:messageUsage({inputTokens:0,cachedInputTokens:0,outputTokens:0})}});
  }
  private add(item:Item):{index:number;frames:string}{
    const index=this.items.push(item)-1;
    if(this.protocol==='messages')return {index,frames:this.event('content_block_start',{index,content_block:item.kind==='text'?{type:'text',text:''}:{type:'tool_use',id:item.callId,name:item.name,input:{}}})};
    let frames=this.event('response.output_item.added',{output_index:index,item:item.kind==='text'?{id:item.id,type:'message',status:'in_progress',role:'assistant',content:[]}:this.publicItem(item,'in_progress')});
    if(item.kind==='text')frames+=this.event('response.content_part.added',{item_id:item.id,output_index:index,content_index:0,part:{type:'output_text',text:'',annotations:[],logprobs:[]}});
    return {index,frames};
  }
  push(value:unknown):string {
    const v=obj(value);if(v.error)invalid();
    if(v.usage){const u=obj(v.usage),details=u.completion_tokens_details;if(details){const count=obj(details).reasoning_tokens;if(count!==undefined){if(typeof count!=='number'||!Number.isSafeInteger(count)||count<0||typeof u.completion_tokens!=='number'||count>u.completion_tokens)invalid();this.reasoningTokens=count;}}}
    if(!Array.isArray(v.choices)||v.choices.length>1)invalid();if(!v.choices.length)return '';
    const choice=obj(v.choices[0]);if(choice.index!==undefined&&choice.index!==0)invalid();
    if(choice.finish_reason!=null){const reason=string(choice.finish_reason);if(!['stop','length','tool_calls','content_filter'].includes(reason)||this.finishReason)invalid();this.finishReason=reason;}
    const delta=obj(choice.delta??{});let frames='';
    const append=(s:string)=>{this.size+=Buffer.byteLength(s);if(this.size>16777216)throw new Error('adapted output exceeds 16 MiB');};
    if(delta.refusal)invalid(); // No unsupported refusal block is silently turned into ordinary text.
    if(delta.content!==undefined&&delta.content!==null&&delta.content!==''){
      const text=string(delta.content);append(text);
      if(this.textIndex===undefined){const added=this.add({kind:'text',id:id('msg_'),text:''});this.textIndex=added.index;frames+=added.frames;}
      const index=this.textIndex,item=this.items[index];if(item.kind!=='text')invalid();item.text+=text;
      frames+=this.protocol==='responses'?this.event('response.output_text.delta',{item_id:item.id,output_index:index,content_index:0,delta:text,logprobs:[]}):this.event('content_block_delta',{index,delta:{type:'text_delta',text}});
    }
    if(delta.tool_calls!==undefined){if(!Array.isArray(delta.tool_calls))invalid();for(const raw of delta.tool_calls){const call=obj(raw),ordinal=call.index;if(typeof ordinal!=='number'||!Number.isInteger(ordinal)||ordinal<0||ordinal>127)invalid();const fn=obj(call.function??{});let index=this.tools.get(ordinal);
      if(index===undefined){const callId=string(call.id),name=string(fn.name);if(!callId||callId.length>160||!name||name.length>64||this.items.some(i=>i.kind==='tool'&&i.callId===callId))invalid();const added=this.add({kind:'tool',id:id('fc_'),callId,name,arguments:''});index=added.index;this.tools.set(ordinal,index);frames+=added.frames;}
      const item=this.items[index];if(item.kind!=='tool'||(call.id!==undefined&&call.id!==item.callId)||(fn.name!==undefined&&fn.name!==item.name))invalid();
      if(fn.arguments!==undefined){const part=string(fn.arguments);append(part);item.arguments+=part;frames+=this.protocol==='responses'?this.event('response.function_call_arguments.delta',{item_id:item.id,output_index:index,delta:part}):this.event('content_block_delta',{index,delta:{type:'input_json_delta',partial_json:part}});}
    }}
    return frames;
  }
  validate():void {
    if(!this.finishReason)invalid();for(const item of this.items)if(item.kind==='tool'&&!(this.protocol==='responses'&&this.finishReason==='length'))toolInput(item.arguments);
    if(this.finishReason==='tool_calls'&&!this.tools.size)invalid();
    if(this.tools.size&&this.finishReason!=='tool_calls'&&this.finishReason!=='length')invalid();
    if(this.finishReason==='content_filter')invalid();
  }
  complete(usage:Usage):string {
    this.validate();let frames='';
    for(const [index,item]of this.items.entries()){
      if(this.protocol==='messages'){frames+=this.event('content_block_stop',{index});continue;}
      if(item.kind==='text')frames+=this.event('response.output_text.done',{item_id:item.id,output_index:index,content_index:0,text:item.text,logprobs:[]})+this.event('response.content_part.done',{item_id:item.id,output_index:index,content_index:0,part:{type:'output_text',text:item.text,annotations:[],logprobs:[]}});
      else frames+=this.event('response.function_call_arguments.done',{item_id:item.id,output_index:index,name:item.name,arguments:item.arguments});
      frames+=this.event('response.output_item.done',{output_index:index,item:this.publicItem(item,this.finishReason==='length'?'incomplete':'completed')});
    }
    if(this.protocol==='responses'){const status=this.finishReason==='length'?'incomplete':'completed';return frames+this.event('response.'+status,{response:this.response(status,usage)});}
    return frames+this.event('message_delta',{delta:{stop_reason:this.finishReason==='length'?'max_tokens':this.tools.size?'tool_use':'end_turn',stop_sequence:null},usage:messageUsage(usage)})+this.event('message_stop');
  }
  fail(code:string,message='upstream response interrupted; retry only as a new request'):string {
    if(this.protocol==='messages')return this.event('error',{error:{type:'api_error',code,message}});
    // A failed response may contain partial JSON arguments. It must remain inspectable.
    const response={id:this.id,object:'response',created_at:this.created,status:'failed',model:this.model,output:[],usage:null,error:{code:'server_error',message},incomplete_details:null};
    return this.event('response.failed',{response,error_code:code});
  }
  json(value:unknown,usage:Usage):unknown {
    const v=obj(value);if(!Array.isArray(v.choices)||v.choices.length!==1)invalid();const c=obj(v.choices[0]),m=obj(c.message);
    this.push({...v,choices:[{index:0,finish_reason:c.finish_reason,delta:{...m,...(Array.isArray(m.tool_calls)?{tool_calls:m.tool_calls.map((t,index)=>({...obj(t),index}))}:{})}}]});this.validate();
    if(this.protocol==='responses')return this.response(this.finishReason==='length'?'incomplete':'completed',usage);
    return {id:this.id,type:'message',role:'assistant',model:this.model,content:this.items.map(i=>this.publicItem(i)),stop_reason:this.finishReason==='length'?'max_tokens':this.tools.size?'tool_use':'end_turn',stop_sequence:null,usage:messageUsage(usage)};
  }
}
