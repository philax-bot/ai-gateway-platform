// Deterministic local HTTP fixture, never a model provider. Do not record bodies or keys.
const {createServer}=require('node:http');
const requests=[];
const transportErrors=[];
const held=new Map();
const usage={prompt_tokens:13,completion_tokens:14,total_tokens:27,prompt_tokens_details:{cached_tokens:4}};
function json(res,value,status=200){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));}
function event(res,value){res.write(`data: ${JSON.stringify(value)}\n\n`);}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function nativeResponse(protocol,body,res,entry,scenario){
  const tools=entry.tools.length&&!entry.hasToolResult;
  const functionItem={id:'fc_fixture',type:'function_call',status:'completed',call_id:'call-local',name:'local_echo',arguments:'{"text":"上海"}'};
  const textItem={id:'msg_fixture',type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:'POC_OK',annotations:[]}]};
  const value=protocol==='responses'?{id:'resp_fixture',object:'response',status:'completed',created_at:1,model:body.model,output:[tools?functionItem:textItem],usage:{input_tokens:13,output_tokens:14,input_tokens_details:{cached_tokens:4}},native_marker:'preserved'}:{id:'msg_fixture',type:'message',role:'assistant',model:body.model,content:[tools?{type:'tool_use',id:'call-local',name:'local_echo',input:{text:'上海'}}:{type:'text',text:'POC_OK'}],stop_reason:tools?'tool_use':'end_turn',stop_sequence:null,usage:{input_tokens:9,output_tokens:14,cache_read_input_tokens:4},native_marker:'preserved'};
  if(!body.stream)return json(res,value);
  res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});let sequence=0;
  const emit=async(type,data={})=>{const bytes=Buffer.from(`event: ${type}\ndata: ${JSON.stringify({type,...data,...(protocol==='responses'?{sequence_number:sequence++}:{})})}\n\n`);for(let i=0;i<bytes.length&&!res.destroyed;i+=17){res.write(bytes.subarray(i,i+17));await sleep(1);}};
  if(protocol==='responses')await emit('response.created',{response:{...value,status:'in_progress',usage:null,output:[]}});else await emit('message_start',{message:{...value,stop_reason:null,content:[],usage:{input_tokens:9,cache_read_input_tokens:4,output_tokens:0}}});
  if(scenario==='POC_CANCEL'){const timer=setTimeout(()=>res.end(),15000);res.once('close',()=>clearTimeout(timer));return;}
  if(scenario==='POC_INCOMPLETE'){res.end();return;}
  if(protocol==='responses'){
    const item=value.output[0];await emit('response.output_item.added',{output_index:0,item:tools?{...item,status:'in_progress',arguments:''}:{...item,status:'in_progress',content:[]}});
    if(tools){for(const delta of ['{"text":"','上海"}'])await emit('response.function_call_arguments.delta',{item_id:item.id,output_index:0,delta});await emit('response.function_call_arguments.done',{item_id:item.id,output_index:0,arguments:item.arguments,name:item.name});}
    else{await emit('response.content_part.added',{item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});await emit('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:'POC_OK'});await emit('response.output_text.done',{item_id:item.id,output_index:0,content_index:0,text:'POC_OK'});await emit('response.content_part.done',{item_id:item.id,output_index:0,content_index:0,part:item.content[0]});}
    await emit('response.output_item.done',{output_index:0,item});await emit('response.completed',{response:value});
  }else{
    await emit('content_block_start',{index:0,content_block:tools?{type:'tool_use',id:'call-local',name:'local_echo',input:{}}:{type:'text',text:''}});
    if(tools){for(const partial_json of ['{"text":"','上海"}'])await emit('content_block_delta',{index:0,delta:{type:'input_json_delta',partial_json}});}else await emit('content_block_delta',{index:0,delta:{type:'text_delta',text:'POC_OK'}});
    await emit('content_block_stop',{index:0});await emit('message_delta',{delta:{stop_reason:value.stop_reason,stop_sequence:null},usage:{output_tokens:14}});await emit('message_stop');
  }res.end();
}
createServer(async(req,res)=>{
  if(req.url==='/_poc/ready'||(req.method==='GET'&&req.url==='/v1/chat/completions'))return json(res,{ready:true});
  if(req.url==='/_poc/requests')return json(res,requests);
  if(req.url==='/_poc/transport-errors')return json(res,transportErrors);
  if(req.method==='POST'&&req.url.startsWith('/_poc/release/')){if(req.headers.authorization!==`Bearer ${process.env.MOCK_API_TOKEN}`)return json(res,{},401);held.get(decodeURIComponent(req.url.slice('/_poc/release/'.length)))?.();return json(res,{released:true});}
  const native=req.url.startsWith('/native/'),protocol=native&&req.url.endsWith('/responses')?'responses':native&&req.url.endsWith('/messages')?'messages':'chat';
  if(req.method!=='POST'||!['/v1/chat/completions','/native/v1/chat/completions','/native/v1/responses','/native/v1/messages'].includes(req.url)){transportErrors.push({method:req.method,path:req.url,requestId:req.headers['x-request-id']});return json(res,{},404);}
  if(req.headers.authorization!==`Bearer ${process.env.MOCK_API_TOKEN}`)return json(res,{error:{type:'fixture_authentication_failed'}},401);
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString());
  if(protocol==='messages'&&req.headers['x-api-key']!==process.env.MOCK_API_TOKEN)return json(res,{error:{type:'fixture_api_key_missing'}},401);
  const scenario=protocol==='responses'?(typeof body.input==='string'?body.input:body.input?.findLast(m=>m.role==='user')?.content??''):body.messages?.findLast(m=>m.role==='user')?.content??'';
  const entry={protocol,path:req.url,requestId:req.headers['x-request-id'],model:body.model,stream:body.stream===true,maxOutput:body.max_output_tokens??body.max_tokens??body.max_completion_tokens,includeUsage:body.stream_options?.include_usage===true,tools:body.tools?.map(t=>t.function?.name??t.name)??[],hasToolResult:protocol==='responses'?body.input?.some?.(m=>m.type==='function_call_output'):body.messages?.some(m=>m.role==='tool'||m.content?.some?.(b=>b.type==='tool_result')),hopCredentialPresent:!!req.headers['x-atlas-hop-token'],nativeControlPresent:!!(body.reasoning||body.thinking),closed:false};requests.push(entry);
  res.on('close',()=>{entry.closed=true;});
  res.setHeader('x-request-id',`upstream-${entry.requestId}`);
  if(scenario==='POC_ERROR')return json(res,{error:{type:'fixture_error'}},500);
  if(scenario==='POC_TIMEOUT')return;
  if(protocol!=='chat')return nativeResponse(protocol,body,res,entry,scenario);
  const needsTool=entry.tools.length&&!entry.hasToolResult;
  const tool={id:'call-local',type:'function',function:{name:'local_echo',arguments:'{"text":"上海"}'}};
  const message={role:'assistant',content:needsTool?null:'POC_OK',reasoning_content:'local fixture',...(needsTool?{tool_calls:[tool]}:{})};
  if(!body.stream)return json(res,{id:'fixture',object:'chat.completion',model:body.model,choices:[{index:0,message,finish_reason:needsTool?'tool_calls':'stop'}],usage});
  res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
  if(scenario==='POC_SPLIT_MARKER'){
    for(const content of ['HIGRESS','_RETRY','_OK'])event(res,{model:body.model,choices:[{index:0,delta:{content},finish_reason:null}],usage:null});
    event(res,{model:body.model,choices:[{index:0,delta:{},finish_reason:'stop'}],usage});res.end('data: [DONE]\n\n');return;
  }
  event(res,{model:body.model,choices:[{index:0,delta:{content:'POC_BEGIN'},finish_reason:null}],usage:null});
  if(scenario==='POC_CANCEL'||scenario==='POC_CRASH'){
    const timer=setTimeout(()=>res.end(),15000);res.on('close',()=>clearTimeout(timer));return;
  }
  if(scenario==='POC_INCOMPLETE'){res.end();return;}
  if(scenario==='POC_CONFIG_HOLD')await new Promise(resolve=>{const timer=setTimeout(resolve,45000);const release=()=>{clearTimeout(timer);held.delete(entry.requestId);resolve();};held.set(entry.requestId,release);res.once('close',release);});
  if(scenario==='POC_LONG_STREAM'){for(let index=0;index<35&&!res.destroyed;index++){await sleep(1000);if(!res.destroyed)event(res,{model:body.model,choices:[{index:0,delta:{content:'.'},finish_reason:null}],usage:null});}}
  if(scenario==='POC_DELAYED')await sleep(700);
  if(res.destroyed)return;
  if(needsTool){
    for(const args of ['{"text":"','上海"}']){
      const data=Buffer.from(`data: ${JSON.stringify({model:body.model,choices:[{index:0,delta:{tool_calls:[{index:0,...(args.startsWith('{')?{id:tool.id,type:tool.type}:{}),function:{...(args.startsWith('{')?{name:'local_echo'}:{}),arguments:args}}]},finish_reason:null}],usage:null})}\n\n`);
      for(let offset=0;offset<data.length;offset+=11){res.write(data.subarray(offset,offset+11));await sleep(1);}
    }
  }
  event(res,{model:body.model,choices:[{index:0,delta:{},finish_reason:needsTool?'tool_calls':'stop'}],usage:null});
  event(res,{model:body.model,choices:[],usage});res.end('data: [DONE]\n\n');
}).listen(4010,'0.0.0.0');
