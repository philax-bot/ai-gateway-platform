import assert from 'node:assert/strict';import{createRequire}from'node:module';import{readFile}from'node:fs/promises';import{resolve}from'node:path';import{randomUUID}from'node:crypto';

/** Optional acceptance with existing official SDK installations; no global client configuration changes. */
export async function runProtocolSdkChecks({gateway,key,model,mode,sdkRoot,maxOutputTokens=32,nativeReasoning=false,onlyMessages=false}){
 const require=createRequire(resolve(sdkRoot,'package.json')),OpenAI=require('openai').default,Anthropic=require('@anthropic-ai/sdk').default;
 const version=async name=>JSON.parse(await readFile(resolve(sdkRoot,name,'package.json'),'utf8')).version;
 const report={success:false,mode,sdkVersions:{openai:await version('openai'),anthropic:await version('@anthropic-ai/sdk')},checks:[],calls:[]};
 const check=(v,label)=>{assert.ok(v,label);report.checks.push(label);};
 const wire=async(url,init)=>{const requestId='protocol-sdk-'+randomUUID(),headers=new Headers(init.headers);headers.set('x-request-id',requestId);const response=await fetch(url,{...init,headers});report.calls.push({requestId,httpStatus:response.status,mode:response.headers.get('x-atlas-protocol-mode')});if(response.ok)assert.equal(response.headers.get('x-atlas-protocol-mode'),mode,'SDK request uses selected '+mode+' route');return response;};
 const openai=new OpenAI({baseURL:gateway+'/v1',apiKey:key,maxRetries:0,timeout:120000,fetch:wire}),anthropic=new Anthropic({baseURL:gateway,apiKey:key,maxRetries:0,timeout:120000,fetch:wire});
 const parameters={type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},tool={type:'function',name:'local_echo',description:'Return the supplied text exactly',parameters,strict:false};
 if(!onlyMessages){
 const input=[{role:'user',content:'Call local_echo once with text 上海. Then repeat its result.'}];
 const first=await openai.responses.create({model,input,tools:[tool],tool_choice:{type:'function',name:'local_echo'},max_output_tokens:maxOutputTokens,store:false,stream:true,...(nativeReasoning?{reasoning:{effort:'none'}}:{})});let completed;
 for await(const event of first){if(event.type==='response.completed')completed=event.response;if(event.type==='response.failed')throw Error('SDK native response failed');}
 check(completed?.model===model,'OpenAI SDK receives final response with logical model');const call=completed.output.find(i=>i.type==='function_call');check(call?.name==='local_echo'&&JSON.parse(call.arguments).text==='上海','OpenAI SDK assembles streamed function arguments');
 const second=await openai.responses.create({model,input:[...input,...completed.output,{type:'function_call_output',call_id:call.call_id,output:'上海'}],tools:[tool],tool_choice:'none',max_output_tokens:maxOutputTokens,store:false,stream:true,...(nativeReasoning?{reasoning:{effort:'none'}}:{})});let final;
 for await(const event of second)if(event.type==='response.completed')final=event.response;
 check(final?.model===model&&final.output.some(i=>i.type==='message'&&i.content.some(c=>c.type==='output_text'&&c.text)),'OpenAI SDK completes tool-result turn');check(!!final?.usage&&Number.isSafeInteger(final.usage.input_tokens),'OpenAI SDK exposes authoritative usage');
 }
 const tools=[{name:'local_echo',description:'Return the supplied text exactly',input_schema:parameters}];
 const messages=[{role:'user',content:'Call local_echo once with text 上海. Then repeat its result.'}];
 const message=await anthropic.messages.stream({model,messages,tools,tool_choice:{type:'tool',name:'local_echo'},max_tokens:maxOutputTokens,thinking:{type:'disabled'}}).finalMessage();
 check(message.model===model,'Anthropic SDK receives native Message shape with logical model');const block=message.content.find(b=>b.type==='tool_use');check(block?.name==='local_echo'&&block.input.text==='上海','Anthropic SDK assembles streamed tool input');
 const answer=await anthropic.messages.stream({model,messages:[...messages,{role:'assistant',content:message.content},{role:'user',content:[{type:'tool_result',tool_use_id:block.id,content:'上海'}]}],tools,tool_choice:{type:'none'},max_tokens:maxOutputTokens,thinking:{type:'disabled'}}).finalMessage();
 check(answer.model===model&&answer.content.some(c=>c.type==='text'&&c.text),'Anthropic SDK completes tool-result turn');check(Number.isSafeInteger(answer.usage.input_tokens)&&Number.isSafeInteger(answer.usage.output_tokens),'Anthropic SDK exposes authoritative usage');
 report.success=true;return report;
}
