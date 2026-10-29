// Deterministic local HTTP fixture, never a model provider. Do not record bodies or keys.
const {createServer}=require('node:http');
const requests=[];
const transportErrors=[];
const held=new Map();
const usage={prompt_tokens:13,completion_tokens:14,total_tokens:27,prompt_tokens_details:{cached_tokens:4}};
function json(res,value,status=200){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));}
function event(res,value){res.write(`data: ${JSON.stringify(value)}\n\n`);}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
createServer(async(req,res)=>{
  if(req.url==='/_poc/ready'||(req.method==='GET'&&req.url==='/v1/chat/completions'))return json(res,{ready:true});
  if(req.url==='/_poc/requests')return json(res,requests);
  if(req.url==='/_poc/transport-errors')return json(res,transportErrors);
  if(req.method==='POST'&&req.url.startsWith('/_poc/release/')){if(req.headers.authorization!==`Bearer ${process.env.MOCK_API_TOKEN}`)return json(res,{},401);held.get(decodeURIComponent(req.url.slice('/_poc/release/'.length)))?.();return json(res,{released:true});}
  if(req.method!=='POST'||req.url!=='/v1/chat/completions'){transportErrors.push({method:req.method,path:req.url,requestId:req.headers['x-request-id']});return json(res,{},404);}
  if(req.headers.authorization!==`Bearer ${process.env.MOCK_API_TOKEN}`)return json(res,{error:{type:'fixture_authentication_failed'}},401);
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString());
  const scenario=body.messages?.findLast(m=>m.role==='user')?.content??'';
  const entry={requestId:req.headers['x-request-id'],model:body.model,stream:body.stream===true,maxOutput:body.max_tokens??body.max_completion_tokens,includeUsage:body.stream_options?.include_usage===true,tools:body.tools?.map(t=>t.function.name)??[],hasToolResult:body.messages?.some(m=>m.role==='tool'),hopCredentialPresent:!!req.headers['x-atlas-hop-token'],closed:false};requests.push(entry);
  res.on('close',()=>{entry.closed=true;});
  res.setHeader('x-request-id',`upstream-${entry.requestId}`);
  if(scenario==='POC_ERROR')return json(res,{error:{type:'fixture_error'}},500);
  if(scenario==='POC_TIMEOUT')return;
  const needsTool=entry.tools.length&&!entry.hasToolResult;
  const tool={id:'call-local',type:'function',function:{name:'local_echo',arguments:'{"text":"上海"}'}};
  const message={role:'assistant',content:needsTool?null:'POC_OK',reasoning_content:'local fixture',...(needsTool?{tool_calls:[tool]}:{})};
  if(!body.stream)return json(res,{id:'fixture',object:'chat.completion',model:body.model,choices:[{index:0,message,finish_reason:needsTool?'tool_calls':'stop'}],usage});
  res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
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
  event(res,{model:body.model,choices:[],usage});res.end('data: [DONE]\n\n');
}).listen(4010,'0.0.0.0');
