import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {randomUUID, createHash} from 'node:crypto';
import {mkdir, readFile, writeFile, realpath, rm} from 'node:fs/promises';
import {resolve, dirname, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

// Runs real, pinned Octop against isolated platform services and a local model.
// Never reads a user's .env, Octop home, model credentials, or review database.
const root=fileURLToPath(new URL('../',import.meta.url));
const PIN='890111b7879665840414ca28ab168b05b0db0921';
const args=process.argv.slice(2),shared=args.includes('--shared');
const liveMode=args.includes('--live-deepseek');
const priorArg=args.find(arg=>arg.startsWith('--budget-from='));
assert.ok(args.every(arg=>!arg.startsWith('--')||['--shared','--live-deepseek','--allow-upstream'].includes(arg)||arg.startsWith('--budget-from=')),'unsupported option');
assert.ok(!priorArg||liveMode,'budget carry-forward requires live mode');
assert.ok(!liveMode||args.includes('--allow-upstream'),'live mode requires --allow-upstream before reading private configuration');
assert.ok(!args.includes('--allow-upstream')||liveMode,'--allow-upstream requires --live-deepseek');
assert.ok(!liveMode||!shared,'real personal keys must use per-user instances');
const source=resolve(root,args.find(arg=>!arg.startsWith('--'))??'.runtime/octop-source-890111b');
const python=resolve(source,'.venv/Scripts/python.exe');
assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8',windowsHide:true}).trim(),PIN,'Octop revision must match the reviewed pin');
assert.equal(execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:source,encoding:'utf8',windowsHide:true}).trim(),'','Octop tracked sources must be unmodified');
const id=randomUUID(),runtime=resolve(root,'.runtime'),directory=resolve(runtime,`octop-check-${id}`);
const output=resolve(root,process.env.OCTOP_REPORT_PATH??`.runtime/octop-results/${id}.json`);
const children=[],secrets=[],sockets=new Set(),pause=ms=>new Promise(r=>setTimeout(r,ms));
const report={success:false,createdAt:new Date().toISOString(),octop:{repository:'https://github.com/TencentCloud/Octop',revision:PIN},scope:{actualOctop:true,topology:shared?'shared-instance-diagnostic':'per-user-instances',upstream:'local deterministic HTTP stand-in',realModelRequests:0,platformStore:'isolated memory',octopStore:'isolated SQLite',network:'Octop Python process restricted to loopback',deployment:false,osUserIsolation:false},checks:[],modelRequests:[],turns:[]};
let model,stage='prepare',live,budget,gatewayBase,stateReader,priorBudget={attempts:0,estimatedUpperBound:0};const liveKeys=new Set(),fixtureMarkers=new Map();
const check=(ok,label)=>{assert.ok(ok,label);report.checks.push(label);};
function redact(value){let s=String(value);for(const secret of secrets)s=s.replaceAll(secret,'[redacted]');return s.replace(/sa_[A-Za-z0-9_-]{20,}/g,'[redacted-key]').replace(/eyJ[A-Za-z0-9_.-]{30,}/g,'[redacted-jwt]');}
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
const inherited=Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i.test(k)));
function start(exe,args,env,cwd=root){const child=spawn(exe,args,{cwd,env:{...inherited,...env},windowsHide:true,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',d=>log=(log+d).slice(-48000));child.stderr.on('data',d=>log=(log+d).slice(-48000));child.log=()=>log;child.on('error',e=>{log+=e.message;});children.push(child);return child;}
async function stop(child){
  if(child.exitCode!==null||child.signalCode!==null)return;
  const exited=new Promise(r=>child.once('exit',r));
  if(process.platform==='win32'){
    // uv's Windows venv launcher can have a separate interpreter child.
    // Terminate only this runner-owned PID tree, never processes by name.
    try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:6000});}
    catch(error){if(child.exitCode===null&&child.signalCode===null)throw error;}
  }else child.kill();
  let timer;try{await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('owned child failed to stop')),5000);})]);}finally{clearTimeout(timer);}
}
async function ready(url,child){for(let i=0;i<300;i++){if(child.exitCode!==null)throw Error('service exited: '+redact(child.log().slice(-6000)));try{if((await fetch(url,{signal:AbortSignal.timeout(500)})).ok)return;}catch{}await pause(200);}throw Error('service readiness timeout: '+redact(child.log().slice(-6000)));}
async function connectionRefused(url){try{await fetch(url,{signal:AbortSignal.timeout(1000)});return false;}catch(error){return error.cause?.code==='ECONNREFUSED';}}
async function waitForClosedPort(url){for(let i=0;i<30;i++){if(await connectionRefused(url))return true;await pause(100);}return false;}
async function jsonBody(req){let raw='';for await(const part of req){raw+=part;if(Buffer.byteLength(raw)>1048576)throw Error('fixture request too large');}return JSON.parse(raw||'{}');}
async function request(base,path,{body,token,cookie,method}={}){const r=await fetch(base+path,{method:method??(body===undefined?'GET':'POST'),headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{cookie:cookie??''})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(90000)});const raw=await r.text();let value;try{value=raw?JSON.parse(raw):null;}catch{throw Error(`non-JSON response ${path} ${r.status}`);}return {status:r.status,value,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
function expect(result,status=200){assert.equal(result.status,status,redact(JSON.stringify(result.value)?.slice(0,1200)));return result.value;}
try{
  await mkdir(runtime,{recursive:true});await mkdir(directory);check((await realpath(directory)).startsWith((await realpath(root))+sep),'runtime stays inside workspace');
  if(liveMode){
    const {loadLiveConfig,LiveBudget}=await import('./octop-live-config.mjs');live=await loadLiveConfig(root);
    if(priorArg){const previous=JSON.parse(await readFile(resolve(root,priorArg.slice('--budget-from='.length))));assert.equal(previous.scope.upstream,'DeepSeek official via controlled gateway');assert.equal(previous.model,live.definition.modelId);priorBudget=previous.cumulativeBudget??previous.budget;assert.ok(Number.isSafeInteger(priorBudget.attempts)&&priorBudget.attempts>=0&&priorBudget.attempts<12&&Number.isFinite(priorBudget.estimatedUpperBound)&&priorBudget.estimatedUpperBound>=0&&priorBudget.estimatedUpperBound<1);report.priorBudget={...priorBudget};}
    budget=new LiveBudget(live.mapping,12-priorBudget.attempts,1-priorBudget.estimatedUpperBound);secrets.push(live.credential);
    Object.assign(report.scope,{upstream:'DeepSeek official via controlled gateway',realModelRequests:null,priceBasis:'configured platform price; conservative transport estimate, not supplier invoice'});
    report.priceSnapshot={input:live.mapping.inputPrice,output:live.mapping.outputPrice,cached:live.mapping.cachedInputPrice};
  }
  const publicModel=liveMode?live.definition.modelId:'test-model';report.model=publicModel;
  const [cpPort,gwPort]=await Promise.all([port(),port()]);
  const cp=`http://127.0.0.1:${cpPort}`,gw=`http://127.0.0.1:${gwPort}`;
  gatewayBase=gw;
  stage='local-model';
  model=createServer(async(req,res)=>{try{
    if(liveMode){
      const key=(req.headers.authorization??'').replace(/^Bearer\s+/i,'');
      if(!liveKeys.has(key)){res.writeHead(401);res.end();return;}
      if(!(req.method==='GET'&&req.url==='/v1/models')&&!(req.method==='POST'&&req.url==='/v1/chat/completions')){res.writeHead(404);res.end();return;}
      let body,entry;const requestId=`octop-live-${randomUUID()}`;
      if(req.method==='POST'){
        body=await jsonBody(req);assert.equal(body.model,publicModel);body.max_tokens=body.max_completion_tokens??body.max_tokens??1024;delete body.max_completion_tokens;body.thinking={type:'disabled'};body.reasoning_effort='none';
        if(body.tools)body.tools=body.tools.filter(t=>t.function?.name==='read_file');
        const messages=body.messages??[],lastUser=messages.findLastIndex(m=>m.role==='user'),text=JSON.stringify(messages[lastUser]?.content??''),owner=text.includes('OCTOP_OWNER_ALICE')?'alice':text.includes('OCTOP_OWNER_BOB')?'bob':null;
        const marker=fixtureMarkers.get(owner),toolResultMatched=!!marker&&messages.slice(lastUser+1).some(m=>m.role==='tool'&&JSON.stringify(m.content).includes(marker));
        try{budget.reserve(body);}catch{res.writeHead(403,{'content-type':'application/json'});res.end(JSON.stringify({error:{type:'policy_denied',code:'local_validation_budget_exceeded',message:'Live validation request or cost ceiling reached'}}));return;}
        entry={requestId,owner,scenario:text.includes('OCTOP_SLOW')?'cancel':text.includes('OCTOP_TOOL')?'tool':'basic',stream:body.stream===true,tools:body.tools?.map(t=>t.function?.name)??[],toolResultMatched,includeUsage:body.stream_options?.include_usage===true,receivedBytes:0};report.modelRequests.push(entry);
      }
      const controller=new AbortController();res.once('close',()=>{if(!res.writableEnded)controller.abort();});
      try{
        const upstream=await fetch(gatewayBase+req.url,{method:req.method,headers:{authorization:`Bearer ${key}`,'content-type':'application/json','x-request-id':requestId,'idempotency-key':requestId},body:body?JSON.stringify(body):undefined,signal:controller.signal,redirect:'error'});
        if(entry)entry.httpStatus=upstream.status;res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json'});
        if(upstream.body)for await(const chunk of upstream.body){if(entry)entry.receivedBytes+=chunk.length;if(res.destroyed)break;res.write(chunk);}res.end();
      }catch{if(!res.destroyed){if(!res.headersSent)res.writeHead(502);res.end();}}return;
    }
    if(req.method!=='POST'||req.url!=='/v1/chat/completions'){res.writeHead(404);res.end();return;}
    const body=await jsonBody(req),messages=body.messages??[],lastUser=messages.findLastIndex(m=>m.role==='user'),text=JSON.stringify(messages[lastUser]?.content??''),owner=text.includes('OCTOP_OWNER_ALICE')?'alice':text.includes('OCTOP_OWNER_BOB')?'bob':null;
    const toolResult=messages.slice(lastUser+1).some(m=>m.role==='tool'&&JSON.stringify(m.content).includes(`OCTOP_TOOL_FIXTURE_${owner?.toUpperCase()}_OK`));
    const scenario=text.includes('OCTOP_SLOW')?'cancel':text.includes('OCTOP_TOOL')?'tool':'basic';
    const entry={requestId:req.headers['x-request-id']??null,scenario,owner,stream:body.stream===true,tools:body.tools?.map(t=>t.function?.name)??[],toolResultMatched:toolResult,includeUsage:body.stream_options?.include_usage===true};report.modelRequests.push(entry);
    const needsTool=scenario==='tool'&&!toolResult;
    const tool=needsTool?body.tools?.find(t=>t.function?.name==='read_file'):null;
    if(needsTool)assert.ok(tool,'actual Octop must advertise read_file');
    const toolCall={id:'call_local_read',type:'function',function:{name:'read_file',arguments:JSON.stringify({file_path:'/fixture.txt'})}};
    const content=scenario==='tool'?'OCTOP_TOOL_OK':'OCTOP_BASIC_OK';
    const usage={prompt_tokens:13,completion_tokens:14,total_tokens:27,prompt_tokens_details:{cached_tokens:4}};
    const completion={id:'chatcmpl-local',object:'chat.completion',created:0,model:body.model,choices:[{index:0,message:needsTool?{role:'assistant',content:null,tool_calls:[toolCall]}:{role:'assistant',content},finish_reason:needsTool?'tool_calls':'stop'}],usage};
    if(!body.stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(completion));return;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    const send=value=>res.write(`data: ${JSON.stringify({id:'chatcmpl-local',object:'chat.completion.chunk',created:0,model:body.model,...value})}\n\n`);
    send({choices:[{index:0,delta:{role:'assistant'},finish_reason:null}]});
    if(scenario==='cancel'){await new Promise(r=>{const t=setTimeout(r,20000);res.once('close',()=>{clearTimeout(t);r();});});if(res.destroyed)return;}
    if(needsTool){send({choices:[{index:0,delta:{tool_calls:[{index:0,...toolCall,function:{name:'read_file',arguments:''}}]},finish_reason:null}]});send({choices:[{index:0,delta:{tool_calls:[{index:0,function:{arguments:toolCall.function.arguments}}]},finish_reason:null}]});}
    else {for(const part of [content.slice(0,7),content.slice(7)]){send({choices:[{index:0,delta:{content:part},finish_reason:null}]});await pause(30);}}
    send({choices:[{index:0,delta:{},finish_reason:needsTool?'tool_calls':'stop'}]});send({choices:[],usage});res.end('data: [DONE]\n\n');
  }catch(error){report.fixtureError=redact(error.message);if(!res.headersSent)res.writeHead(500);res.end();}});
  await new Promise(r=>model.listen(0,'127.0.0.1',r));const modelBase=`http://127.0.0.1:${model.address().port}`;
  const serviceToken=randomUUID();secrets.push(serviceToken);
  const common={PLATFORM_MODE:'development',STORE_MODE:'memory',DATABASE_URL:'',DATABASE_SCHEMA:'',PGOPTIONS:'',REDIS_URL:'',BOOTSTRAP_TOKEN:'',HOST:'127.0.0.1',DOTENV_CONFIG_PATH:resolve(directory,'unused.env'),SERVICE_TOKEN:serviceToken,MAINTENANCE_DISABLED:'true',ALLOW_UPSTREAM_REQUESTS:String(liveMode),ALLOW_UPSTREAM_VALIDATION:String(liveMode),...(liveMode?{[live.service.credentialRef]:live.credential,UPSTREAM_VALIDATION_TIMEOUT_MS:'120000',UPSTREAM_TIMEOUT_MS:'180000'}:{})};
  stage='platform-start';
  const control=start(process.execPath,['apps/control-plane/dist/main.js'],{...common,PORT:String(cpPort)});await ready(cp+'/health',control);
  const gateway=start(process.execPath,['services/gateway-sim/dist/server.js'],{...common,PORT:String(gwPort),CONTROL_PLANE_URL:cp,GATEWAY_JOURNAL_DIR:resolve(directory,'journal')});await ready(gw+'/health',gateway);
  const password=`Qa1-${randomUUID()}`;secrets.push(password);
  expect(await request(cp,'/api/v1/auth/setup',{body:{directoryId:'octop-operator',name:'Octop isolated QA',password}}));
  const cookie= (await request(cp,'/api/v1/auth/login',{body:{directoryId:'octop-operator',password}})).cookie;assert.ok(cookie);secrets.push(cookie);
  async function state(){return expect(await request(cp,'/api/v1/platform/state',{cookie}));}
  stateReader=state;
  async function command(type,payload,actorCookie=cookie){const c={type,payload,idempotencyKey:randomUUID()},preview=expect(await request(cp,'/api/v1/platform/preview',{cookie:actorCookie,body:c}));return expect(await request(cp,'/api/v1/platform/commands',{cookie:actorCookie,body:{...c,previewToken:preview.previewToken}})).result;}
  const initial=await state();let service=initial.services[0],definitionId='definition-test-model';
  if(liveMode){
    const definition=await command('save.definition',{...live.definition,id:undefined});definitionId=definition.id;
    service=await command('save.service',{name:'Octop isolated DeepSeek',active:true,baseUrl:live.service.baseUrl,credentialRef:live.service.credentialRef,limits:{mode:'custom',maxOutputTokens:1024},mappings:[{...live.mapping,definitionId}]});
    budget.reserve({model:live.mapping.upstreamModel,messages:[{role:'user',content:'Connection validation'}],max_tokens:1});
  }else await command('save.service',{...service,baseUrl:modelBase,credentialRef:null,mappings:service.mappings.map(m=>({...m,inputPrice:1,outputPrice:2,cachedInputPrice:0.5}))});
  const verification=expect(await request(cp,`/api/v1/platform/services/${service.id}/verify`,{cookie,body:{}}));check(verification.verification==='passed','model service connection verification passed');
  if(liveMode)report.verification=verification.verificationRun?.results?.map(r=>({outcome:r.outcome,usage:r.usage,cost:r.cost}));
  const range={poolId:'pool-local-test',mode:'follow',definitionIds:[]};
  await command('save.pool',{id:range.poolId,name:'Octop QA',entries:[{definitionId,serviceId:service.id,open:true}]});
  const initialAmount=liveMode?.5:10;
  const plan=await command('save.plan',{name:'Octop QA',range,amount:initialAmount,cadence:'once',quotaDays:1,entitlementDays:1});
  const people=[];
  const tinyPlan=await command('save.plan',{name:'Octop QA insufficient quota',range,amount:.000001,cadence:'once',quotaDays:1,entitlementDays:1});
  for(const name of ['alice','bob','low']){
    const userPassword=`Qa1-${randomUUID()}`;secrets.push(userPassword);
    const member=await command('save.member',{name,directoryId:`octop-${name}`,password:userPassword,organizationId:'department-engineering',category:'employee',roles:['employee'],tags:[]});
    await command('distribution.execute',{planId:name==='low'?tinyPlan.id:plan.id,memberIds:[member.id]});
    const login=await request(cp,'/api/v1/auth/login',{body:{directoryId:`octop-${name}`,password:userPassword}});expect(login);secrets.push(login.cookie);
    const key=await command('key.issue',{name:'Octop QA',purpose:'personal'},login.cookie);secrets.push(key.secret);liveKeys.add(key.secret);people.push({name,member,key,password:userPassword});
    const discovered=expect(await request(gw,'/v1/models',{token:key.secret}));check(discovered.data.some(m=>m.id===publicModel),`${name}: gateway model discovery`);
  }
  async function launchInstance(instance){
    instance.child=start(python,[resolve(root,'scripts/octop-local-only.py'),'run','--host','127.0.0.1','--port',String(instance.port)],{OCTOP_GATEWAY_COMPAT:'1',OCTOP_HOME:instance.home,OCTOP_DATABASE_DRIVER:'sqlite',PYTHONPATH:resolve(source,'src'),PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1',LANGCHAIN_TRACING_V2:'false',LANGSMITH_TRACING:'false',NO_PROXY:'127.0.0.1,localhost',no_proxy:'127.0.0.1,localhost'},directory);
    await ready(instance.base+'/api/health',instance.child);
  }
  async function newInstance(name){
    const instance={name,port:await port(),home:resolve(directory,`octop-${name}`)};instance.base=`http://127.0.0.1:${instance.port}`;
    await mkdir(instance.home);await writeFile(resolve(instance.home,'config.json'),JSON.stringify({bind_host:'127.0.0.1',port:instance.port,enable_dashboard:false,enable_api_docs:true,require_setup_password:false,database:{driver:'sqlite',sqlite_path:'octop.db'}}));
    await launchInstance(instance);
    const wizard=expect(await request(instance.base,'/api/setup/begin',{body:{}})).wizard_token;secrets.push(wizard);
    const adminPassword=`Qa1-${randomUUID()}`;secrets.push(adminPassword);
    const admin=expect(await request(instance.base,'/api/setup/initial-admin',{token:wizard,body:{username:'qa-admin',password:adminPassword}}),201);secrets.push(admin.access_token);instance.adminToken=admin.access_token;
    expect(await request(instance.base,'/api/setup/finish',{token:instance.adminToken,body:{}}));return instance;
  }
  stage='octop-start';const sharedInstance=shared?await newInstance('shared'):null;
  for(const p of people){
    stage=`octop-${p.name}-setup`;
    p.instance=sharedInstance??await newInstance(p.name);const oct=p.instance.base,adminToken=p.instance.adminToken;
    expect(await request(oct,'/api/users',{token:adminToken,body:{username:p.name,password:p.password,role:'user',permissions:[]}}),201);
    p.token=expect(await request(oct,'/api/auth/login',{body:{username:p.name,password:p.password}})).access_token;secrets.push(p.token);
    const gatewayUrl=liveMode?modelBase:gw;
    p.provider=expect(await request(oct,'/api/admin/providers',{token:adminToken,body:{name:`gateway-${p.name}`,kind:'openai',base_url:gatewayUrl+'/v1',api_key:p.key.secret,stream_usage:true,models:[{id:publicModel,name:'QA text model',enabled:true,input:['text'],api_mode:'chat_completions',api_fallback:'none'}]}}),201);
    p.agent=expect(await request(oct,'/api/agents',{token:p.token,body:{name:`QA ${p.name}`,default_model:`gateway-${p.name}/${publicModel}`,system_prompt:'QA validation only. For OCTOP_TOOL, actually call read_file on /fixture.txt and reply with its exact contents. Do not guess the file contents. For OCTOP_BASIC requests reply exactly OCTOP_BASIC_OK. For OCTOP_SLOW follow the long-output request. Never call any other tool.',max_iters:32,max_tokens:liveMode?1024:128,skill_package_ids:[],knowledge_base_ids:[],mcp_servers:[],config:{memory:{memory_enabled:false,extract_on_session_end:false}}}}),201);
    p.fixtureMarker=`OCTOP_TOOL_FIXTURE_${p.name.toUpperCase()}_${liveMode?randomUUID()+'_':''}OK`;fixtureMarkers.set(p.name,p.fixtureMarker);
    const workspace=resolve(p.instance.home,'agents',p.agent.agent_id);await mkdir(workspace,{recursive:true});await writeFile(resolve(workspace,'fixture.txt'),p.fixtureMarker+'\n');
    if(liveMode){await mkdir(resolve(workspace,'.octop'),{recursive:true});await writeFile(resolve(workspace,'.octop/.bootstrapped'),'Configured QA identity; onboarding completed before paid validation.\n');}
    expect(await request(oct,`/api/agents/${p.agent.agent_id}/start`,{token:p.token,body:{}}),204);
    if(liveMode){expect(await request(oct,`/api/agents/${p.agent.agent_id}/reload`,{token:p.token,body:{}}),204);check(expect(await request(oct,`/api/agents/${p.agent.agent_id}`,{token:p.token})).bootstrap_pending===false,`${p.name}: QA onboarding is complete before paid turns`);}
    const discovered=expect(await request(oct,'/api/admin/providers/fetch-models',{token:adminToken,body:{kind:'openai',base_url:gatewayUrl+'/v1',api_key:p.key.secret}}));
    check(discovered.ok&&JSON.stringify(discovered).includes(publicModel),`${p.name}: actual Octop model discovery`);
    if(p.name!=='low'&&!liveMode){
      const probe=expect(await request(oct,`/api/admin/providers/${p.provider.id}/test`,{token:adminToken,body:{model_id:publicModel,api_mode:'chat_completions',api_fallback:'none'}}));
      check(probe.ok,`${p.name}: actual Octop Provider non-stream probe`);
    }
  }
  const [alice,bob]=people;
  if(shared){
    const oct=sharedInstance.base,visibleToBob=expect(await request(oct,'/api/providers',{token:bob.token}));
    report.sharedInstanceReadiness={ready:false,reason:'providers are global in the pinned upstream',bobCanReadAliceProvider:visibleToBob.some(v=>v.id===alice.provider.id),bobCanReadAliceRawKey:visibleToBob.some(v=>v.id===alice.provider.id&&v.api_key===alice.key.secret),regularUserProviderCreateStatus:(await request(oct,'/api/providers',{token:bob.token,body:{name:'not-created',kind:'openai'}})).status};
    check(report.sharedInstanceReadiness.bobCanReadAliceRawKey,'diagnostic reproduced: shared instance exposes test Provider key to another ordinary user');
    check([403,404].includes((await request(oct,`/api/agents/${alice.agent.agent_id}`,{token:bob.token})).status),'Octop rejects cross-user agent access');
  }else{
    report.instances=people.map(p=>({owner:p.name,platformMemberId:p.member.id,port:p.instance.port,processId:p.instance.child.pid,home:`octop-${p.name}`,providerName:p.provider.name}));
    check(new Set(people.map(p=>p.instance.child.pid)).size===people.length,'each user has a distinct Octop process');
    check(new Set(people.map(p=>p.instance.home)).size===people.length,'each user has a distinct Octop home and SQLite database');
    for(const p of people){
      const list=expect(await request(p.instance.base,'/api/providers',{token:p.token}));
      check(list.length===1&&list[0].name===`gateway-${p.name}`&&list[0].api_key===p.key.secret,`${p.name}: instance contains only its own Provider and Key`);
      for(const other of people.filter(o=>o!==p)){
        check((await request(other.instance.base,'/api/providers',{token:p.token})).status===401,`${p.name}: token cannot read ${other.name}'s Provider`);
        check((await request(other.instance.base,`/api/agents/${other.agent.agent_id}`,{token:p.token})).status===401,`${p.name}: token cannot read ${other.name}'s Agent`);
      }
    }
    for(const [from,to] of [[alice,bob],[bob,alice]]){
      const opened=await new Promise((resolveWs,reject)=>{
        const ws=new WebSocket(`${to.instance.base.replace('http:','ws:')}/api/agents/${to.agent.agent_id}/chat/ws?token=${from.token}`);sockets.add(ws);let finished=false;
        const timer=setTimeout(()=>end(Error('cross-instance WebSocket refusal timed out')),5000);
        function end(error,value=false){if(finished)return;finished=true;clearTimeout(timer);ws.close();sockets.delete(ws);error?reject(error):resolveWs(value);}
        ws.addEventListener('open',()=>end(null,true));ws.addEventListener('error',()=>end(null,false));ws.addEventListener('close',()=>end(null,false));
      });
      check(!opened,`${from.name}: session cannot open ${to.name}'s chat WebSocket`);
    }
  }
  async function turn(p,text,{cancel=false,cancelAfterTool=false,expectError=false}={}){
    const summary={user:p.name,scenario:text,frameTypes:[],done:false,error:false};report.turns.push(summary);let receivedText='';
    await new Promise((resolveTurn,reject)=>{
      const ws=new WebSocket(`${p.instance.base.replace('http:','ws:')}/api/agents/${p.agent.agent_id}/chat/ws?token=${p.token}`);sockets.add(ws);
      let threadId,finished=false;const before=report.modelRequests.length;
      const end=error=>{if(finished)return;finished=true;clearTimeout(timer);clearInterval(canceller);ws.close();sockets.delete(ws);error?reject(error):resolveTurn();};
      const timer=setTimeout(()=>end(Error(`Octop turn timeout (${p.name}, ${text})`)),liveMode?180000:60000);
      const canceller=setInterval(()=>{if((cancel||cancelAfterTool)&&threadId&&report.modelRequests.slice(before).some(x=>x.owner===p.name&&(cancelAfterTool?x.toolResultMatched:x.scenario==='cancel')&&(!liveMode||x.receivedBytes>0))){ws.send(JSON.stringify({type:'cancel',thread_id:threadId}));summary.cancelSent=true;cancel=false;cancelAfterTool=false;}},20);
      ws.addEventListener('open',()=>ws.send(JSON.stringify({type:'user_turn',text:`${text} OCTOP_OWNER_${p.name.toUpperCase()}`,session_key:randomUUID(),skills:[],knowledge_base_ids:[],mcp_servers:[],conversation_mode:'ask'})));
      ws.addEventListener('error',()=>end(Error('Octop WebSocket transport error')));
      ws.addEventListener('close',()=>{if(!finished)end(Error('Octop WebSocket closed before completion'));});
      ws.addEventListener('message',event=>{const frame=JSON.parse(event.data);if(!summary.frameTypes.includes(frame.type))summary.frameTypes.push(frame.type);threadId=frame.thread_id??threadId;if(frame.type==='token')receivedText+=frame.content??'';
        if(frame.type==='error'){summary.error=true;summary.errorMessage=redact(frame.message??'').slice(0,1200);if(!expectError&&!summary.cancelSent)end(Error('Octop error: '+summary.errorMessage));else end();}
        if(frame.type==='done'){summary.done=true;end();}
      });
    });
    summary.receivedTextBytes=Buffer.byteLength(receivedText);
    if(expectError)check(summary.error,`${p.name}: ${text} produces a visible error`);
    else if(summary.cancelSent)check(summary.done,'explicit cancellation completes the Octop turn');
    else {check(summary.done,`${p.name}: ${text} completed`);summary.finalMarkerMatched=receivedText.includes(text.includes('OCTOP_TOOL')?(liveMode?p.fixtureMarker:'OCTOP_TOOL_OK'):'OCTOP_BASIC_OK');check(summary.finalMarkerMatched,`${p.name}: ${text} streamed expected content`);}
    return summary;
  }
  if(!priorArg){stage='octop-chat';await Promise.all([turn(alice,'OCTOP_BASIC'),turn(bob,'OCTOP_BASIC')]);}
  stage='octop-tool';await Promise.all([turn(alice,'OCTOP_TOOL: read /fixture.txt'),turn(bob,'OCTOP_TOOL: read /fixture.txt',{cancelAfterTool:!!priorArg})]);
  for(const p of [alice,bob])check(report.modelRequests.some(x=>x.owner===p.name&&x.toolResultMatched),`${p.name}: actual Octop read_file returned its own workspace fixture`);
  if(!shared&&!liveMode){
    stage='per-user-auxiliary';
    for(const p of [alice,bob]){
      const before=await state();
      const assisted=expect(await request(p.instance.base,'/api/text/assist',{token:p.token,body:{kind:'chat.prompt',text:`OCTOP_BASIC OCTOP_OWNER_${p.name.toUpperCase()}`}}));
      check(assisted.text==='OCTOP_BASIC_OK',`${p.name}: instance automatic auxiliary model routing succeeds`);
      const after=await state(),added=after.callLogs.filter(l=>!before.callLogs.some(old=>old.requestId===l.requestId));
      check(added.length===1&&added[0].subjectId===p.member.id&&added[0].credentialId===p.key.key.credentialId,`${p.name}: auxiliary model call uses only its own credential`);
    }
    stage='per-user-restart';const oldPid=bob.instance.child.pid;await stop(bob.instance.child);
    check(await waitForClosedPort(bob.instance.base+'/api/health'),'Bob stopped instance refuses TCP connection before restart');
    await turn(alice,'OCTOP_BASIC_WHILE_BOB_STOPPED');await launchInstance(bob.instance);
    check(bob.instance.child.pid!==oldPid,'Bob restarts in a new owned process');
    check(expect(await request(bob.instance.base,'/api/providers',{token:bob.token}))[0]?.api_key===bob.key.secret,'Bob restart retains its Provider and accepts its existing session');
    check((await request(bob.instance.base,'/api/providers',{token:alice.token})).status===401,'Bob restart still rejects Alice session');
    await turn(bob,'OCTOP_BASIC_AFTER_RESTART');Object.assign(report.instances.find(i=>i.owner==='bob'),{restartedProcessId:bob.instance.child.pid,stoppedPortRefusedConnection:true});
  }
  if(!priorArg){stage='quota-insufficient';const beforeLow=(await state()).callLogs.length;const lowTurn=await turn(people[2],'OCTOP_BASIC_LOW_QUOTA',{expectError:true});
  check(lowTurn.errorMessage?.includes('额度不足'),'insufficient quota is explained as platform quota, not authentication failure');
  const lowLogs=(await state()).callLogs.slice(0,(await state()).callLogs.length-beforeLow);check(lowLogs.length===1&&lowLogs[0].forwarded===false,'policy refusal is not retried or forwarded');}
  stage='octop-cancel';await turn(alice,'OCTOP_SLOW: write the numbers 1 through 10000, each with a detailed sentence',{cancel:true});if(liveMode&&!priorArg)await turn(bob,'OCTOP_SLOW: write the numbers 1 through 10000, each with a detailed sentence',{cancel:true});await pause(500);
  stage='key-revoke';await command('key.status',{id:alice.key.key.id,status:'disabled',reason:'QA revoke'});
  if(!priorArg){const countBefore=(await state()).callLogs.filter(l=>l.forwarded).length;await turn(alice,'OCTOP_BASIC_REVOKED',{expectError:true});check((await state()).callLogs.filter(l=>l.forwarded).length===countBefore,'revoked key never reaches model through Octop');}
  check((await request(gw,'/v1/models',{token:alice.key.secret})).status===401,'revoked key cannot discover models');
  if(!priorArg)await turn(bob,'OCTOP_BASIC_AFTER_ALICE_REVOKED');
  stage='accounting';await pause(300);const final=await state();
  for(const p of [alice,bob]){
    const calls=report.modelRequests.filter(r=>r.owner===p.name);check(calls.length>0,`${p.name}: model request provenance is present`);
    check(calls.filter(r=>!liveMode||r.httpStatus===200).every(r=>final.callLogs.some(l=>l.requestId===r.requestId&&l.subjectId===p.member.id&&l.credentialId===p.key.key.credentialId)),`${p.name}: every actual model request settles against its own member and credential`);
  }
  report.accounts=people.map(p=>{const logs=final.callLogs.filter(l=>l.subjectId===p.member.id),batches=final.quotaBatches.filter(b=>b.sourceId===p.member.id);return {user:p.name,subjectId:p.member.id,calls:logs.map(l=>({requestId:l.requestId,outcome:l.outcome,billableState:l.billableState,usageFinal:l.usageFinal,inputTokens:l.inputTokens,outputTokens:l.outputTokens,cachedInputTokens:l.cachedInputTokens,actualAmount:l.actualAmount,reservedAmount:l.admission?.reservedAmount??0})),initial:p.name==='low'?.000001:initialAmount,available:batches.reduce((s,b)=>s+b.availableAmount,0)};});
  for(const a of report.accounts){
    if(a.user!=='low')check(a.calls.some(l=>l.billableState==='confirmed'),`${a.user}: own confirmed accounting`);
    for(const call of a.calls.filter(l=>l.billableState==='confirmed')){const price=liveMode?live.mapping:{inputPrice:1,outputPrice:2,cachedInputPrice:.5};const expected=Math.round((call.inputTokens-call.cachedInputTokens)*price.inputPrice+call.cachedInputTokens*price.cachedInputPrice+call.outputTokens*price.outputPrice);check(Math.round(call.actualAmount*1e6)===expected,`${a.user}: authoritative cached-token price`);}
    a.confirmedAmount=a.calls.filter(l=>l.billableState==='confirmed').reduce((s,l)=>s+l.actualAmount,0);a.pendingReservedAmount=a.calls.filter(l=>l.billableState==='pending_review').reduce((s,l)=>s+l.reservedAmount,0);
    check(Math.round((a.available+a.confirmedAmount+a.pendingReservedAmount)*1e6)===Math.round(a.initial*1e6),`${a.user}: independent balance, charge and pending hold conserve funds`);
  }
  check(report.accounts[2].calls.every(l=>l.billableState==='not_billable'&&l.actualAmount===0&&l.reservedAmount===0),'insufficient quota retains only non-billable refusal records');
  check(report.accounts[0].calls.some(l=>l.billableState==='pending_review'&&l.usageFinal===false),'explicit Octop cancellation preserves unknown usage');
  if(liveMode)check(report.accounts[1].calls.some(l=>l.billableState==='pending_review'&&l.usageFinal===false),'Bob real cancellation preserves its own unknown usage');
  check(report.modelRequests.filter(x=>x.stream).every(x=>x.includeUsage),'all streaming model requests include final usage');
  report.outbox=expect(await request(gw,'/health')).outbox;check(!report.outbox.queued&&!report.outbox.blocked,'gateway settlement outbox drained');
  check(!report.fixtureError,'model fixture completed without handler errors');
  if(!shared)report.perUserReadiness={localApplicationIsolationVerified:true,realModelBasicVerified:liveMode,productionReady:false,remaining:[liveMode?'real model long-task and sustained load':'real model acceptance','SSO and account-to-instance routing','per-user OS/container and tool sandbox isolation','target deployment and recovery']};
  report.success=true;
}catch(error){report.failure={stage,message:redact(error.message??error)};report.serviceDiagnostics=children.map(c=>redact(c.log().slice(-6000)));if(stateReader)try{const s=await stateReader();report.failureAudit={calls:s.callLogs.map(l=>({requestId:l.requestId,subjectId:l.subjectId,outcome:l.outcome,billableState:l.billableState,actualAmount:l.actualAmount,reservedAmount:l.admission?.reservedAmount??0})),balances:s.quotaBatches.map(b=>({subjectId:b.sourceId,available:b.availableAmount})),scope:'snapshot before shutdown; in-flight calls may not yet be settled'};}catch{report.failureAuditUnavailable=true;}process.exitCode=1;}
finally{
  if(budget){report.budget=budget.snapshot();report.cumulativeBudget={maxRequests:12,maxEstimatedAmount:1,attempts:priorBudget.attempts+budget.attempts,estimatedUpperBound:priorBudget.estimatedUpperBound+budget.upper};report.scope.realModelRequests=report.accounts?report.accounts.reduce((s,a)=>s+a.calls.filter(l=>l.outcome!=='rejected_before_upstream').length,1):null;}
  for(const ws of sockets)ws.close();
  for(const child of children.reverse())try{await stop(child);}catch(error){report.success=false;report.cleanupFailure=redact(error.message);process.exitCode=1;}
  if(model){model.closeAllConnections();await new Promise(r=>model.close(r));}
  report.finishedAt=new Date().toISOString();await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  const physical=await realpath(directory),parent=await realpath(runtime);assert.equal(physical,resolve(parent,`octop-check-${id}`));assert.ok(physical.startsWith(parent+sep));await rm(physical,{recursive:true,force:true});
  console.log(JSON.stringify({success:report.success,output,checks:report.checks.length,failure:report.failure},null,2));
}
