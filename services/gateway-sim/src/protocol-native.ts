import {extractProtocolUsage,type ModelProtocol} from '@ai-gateway/contracts';

type Obj=Record<string,unknown>;
/** Observe native events for settlement while preserving their protocol and provider fields. */
export class NativeProtocolOutput {
  private meter:Obj={};
  private terminal='';
  private status:'completed'|'failed'|null=null;
  private begun=false;
  constructor(readonly protocol:Exclude<ModelProtocol,'chat'>,private model:string){}
  get done(){return this.status!==null;}
  get successful(){return this.status==='completed';}
  get usage(){return extractProtocolUsage(this.protocol,{usage:this.meter});}
  get usageRaw(){const u=this.usage;return u?JSON.stringify({usage:{prompt_tokens:u.inputTokens,completion_tokens:u.outputTokens,prompt_tokens_details:{cached_tokens:u.cachedInputTokens}}}):'';}
  private rewrite(value:Obj):Obj {
    if('model'in value)value.model=this.model;
    for(const key of ['response','message'])if(value[key]&&typeof value[key]==='object'&&!Array.isArray(value[key]))value[key]={...(value[key]as Obj),model:this.model};
    return value;
  }
  json(value:Obj):Obj {
    const valid=this.protocol==='responses'?value.object==='response'&&Array.isArray(value.output)&&['completed','incomplete'].includes(String(value.status)):value.type==='message'&&Array.isArray(value.content)&&typeof value.stop_reason==='string';
    if(!valid)throw Error('invalid native protocol response');
    this.meter=(value.usage??{})as Obj;
    return this.rewrite(value);
  }
  push(value:Obj,eventName?:string):string {
    if(this.done)throw Error('native event after terminal marker');
    const type=String(value.type??eventName??'');if(!type)throw Error('native SSE event type missing');
    if(eventName&&eventName!==type)throw Error('native SSE event name/type conflict');
    if(this.protocol==='responses'){
      if(type==='response.created')this.begun=true;
      if(type.startsWith('response.')&&value.response&&typeof value.response==='object'){const response=value.response as Obj;if(response.usage)this.meter=response.usage as Obj;}
      if(['response.completed','response.incomplete','response.failed','error'].includes(type)){if(!this.begun)throw Error('native response terminal without creation');this.status=type==='response.failed'||type==='error'?'failed':'completed';}
    }else{
      if(type==='message_start'){this.begun=true;this.meter={...((value.message as Obj)?.usage as Obj??{})};}
      if(type==='message_delta'&&value.usage)this.meter={...this.meter,...value.usage as Obj};
      if(type==='message_stop'||type==='error'){if(!this.begun&&type!=='error')throw Error('native message terminal without start');this.status=type==='error'?'failed':'completed';}
    }
    const frames=`event: ${type}\ndata: ${JSON.stringify(this.rewrite(value))}\n\n`;
    if(this.done){this.terminal=frames;return '';}
    return frames;
  }
  complete(){return this.terminal;}
}
