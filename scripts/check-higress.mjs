import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,realpath,rm} from 'node:fs/promises';
import {resolve,dirname,sep,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {HIGRESS_IMAGE,MODEL_IMAGE,resources,ingress} from './higress/poc-config.mjs';
import {IsolatedFilePublisher} from './higress/file-publisher.mjs';

// Isolated verification only. Never reads .env, the review DB, or model credentials.
const root=fileURLToPath(new URL('../',import.meta.url)),runtime=resolve(root,'.runtime');
const id=randomUUID(),name=`atlas-higress-${id}`,directory=resolve(runtime,name);
const cli=process.env.HIGRESS_CONTAINER_CLI??'podman';
// Podman's Windows forwarding can be unavailable even when the VM and gateway are healthy.
// A task-owned SSH tunnel avoids changing the machine's networking or global configuration.
const tunnelled=process.platform==='win32'&&cli==='podman';
assert.ok(['podman','docker'].includes(cli),'HIGRESS_CONTAINER_CLI must be podman or docker');
assert.equal(process.argv.length,2,'this experiment accepts no CLI options');
const output=resolve(root,process.env.HIGRESS_REPORT_PATH??`.runtime/higress-results/${id}.json`);
const proxyToken=randomUUID(),upstreamToken=randomUUID(),serviceToken=randomUUID(),password=randomUUID();
const secrets=[proxyToken,upstreamToken,serviceToken,password];
const children=[],ownedContainers=[];
let networkCreated=false,shim,gateway,control,phase='preflight',blockSettlements=false,loseSettlementResponse=false;
const report={success:false,createdAt:new Date().toISOString(),branch:'codex/higress-poc',scope:{higress:true,higressImage:HIGRESS_IMAGE,modelImage:MODEL_IMAGE,model:'deterministic local HTTP fixture',realModelRequests:0,controlPlane:'isolated memory',network:'internal container network; loopback access only',hostAccess:tunnelled?'task-owned SSH tunnel':'loopback published ports',deployment:false},checks:[],configOperations:[],latency:{},cleanup:{}};
const redact=value=>secrets.reduce((text,secret)=>text.replaceAll(secret,'[redacted]'),String(value));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function check(value,message){assert.ok(value,message);report.checks.push(message);}
function run(command,args,{allowFailure=false,timeout=30000}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';
    child.stdout.on('data',data=>out=(out+data).slice(-2000000));child.stderr.on('data',data=>err=(err+data).slice(-16000));
    const timer=setTimeout(()=>child.kill(),timeout);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',code=>{clearTimeout(timer);if(code===0||allowFailure)resolve({code,out,err});else reject(new Error(redact(`${command} ${args[0]} failed (${code}): ${err||out}`)));});
  });
}
const container=(...args)=>run(cli,args);
async function freePort(){const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
function start(file,env={}){
  const clean=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^UPSTREAM_|^GATEWAY_|^HIGRESS_|^DATABASE_|^PG|^OCTOP_|^AGENT_/.test(key)));
  const child=spawn(process.execPath,[file],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...clean,NODE_OPTIONS:'',DOTENV_CONFIG_PATH:resolve(directory,'isolated.env'),DOTENV_CONFIG_QUIET:'true',HOST:'127.0.0.1',PLATFORM_MODE:'development',STORE_MODE:'memory',DATABASE_URL:'',DATABASE_SCHEMA:'',REDIS_URL:'',PGOPTIONS:'',BOOTSTRAP_TOKEN:'',SERVICE_TOKEN:serviceToken,ALLOW_UPSTREAM_VALIDATION:'false',ALLOW_UPSTREAM_REQUESTS:'false',ENABLE_DEMO_CREDENTIALS:'false',AGENT_RUNNER_ENABLED:'false',...env}});
  let text='';child.stdout.on('data',data=>text=(text+data).slice(-8000));child.stderr.on('data',data=>text=(text+data).slice(-8000));child.diagnostic=()=>redact(text);children.push(child);return child;
}
async function stop(child){if(!child||child.exitCode!==null||child.signalCode!==null)return;const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;}
async function eventually(work,{timeout=15000,label='condition'}={}){const deadline=Date.now()+timeout;let last;do{try{const value=await work();if(value)return value;}catch(error){last=error;}await pause(100);}while(Date.now()<deadline);throw new Error(`${label} not confirmed${last?`: ${redact(last.message)}`:''}`);}
async function ready(base,child){await eventually(async()=>{if(child.exitCode!==null)throw new Error(child.diagnostic());return (await fetch(`${base}/health`,{signal:AbortSignal.timeout(500)})).ok;},{label:'service readiness'});}
async function copyJson(path,value){const file=resolve(directory,path);await mkdir(dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value,null,2));await container('cp',file,`${name}-gateway:/data/${path}`);}
async function writeReport(){await mkdir(dirname(output),{recursive:true});const text=JSON.stringify(report,null,2);check(!secrets.some(secret=>text.includes(secret)),'report contains no test credentials');await writeFile(output,JSON.stringify(report,null,2)+'\n');}
try{
  await container('info');
  report.images=[];
  for(const image of [HIGRESS_IMAGE,MODEL_IMAGE]){const info=JSON.parse((await container('image','inspect',image)).out)[0];report.images.push({requested:image,id:info.Id,os:info.Os,architecture:info.Architecture});}
  await mkdir(directory,{recursive:true});
  // main.ts loads dotenv/config; point it at an owned empty file, never the user's .env.
  await writeFile(resolve(directory,'isolated.env'),'');
  const [higressPort,modelPort,controlPort,gatewayPort]=await Promise.all([freePort(),freePort(),freePort(),freePort()]);
  const hg=`http://127.0.0.1:${higressPort}`,model=`http://127.0.0.1:${modelPort}`,cp=`http://127.0.0.1:${controlPort}`,gw=`http://127.0.0.1:${gatewayPort}`;
  phase='isolated Higress startup';console.log('CHECK pinned Higress and bundled plugins on a dedicated test network');
  await container('network','create','--internal','--label',`atlas.higress-poc=${id}`,name);networkCreated=true;
  await container('create','--name',`${name}-model`,'--label',`atlas.higress-poc=${id}`,'--network',name,'--network-alias','model.poc.test',...(!tunnelled?['--publish',`127.0.0.1:${modelPort}:4010`]:[]),'--env',`MOCK_API_TOKEN=${upstreamToken}`,'--pull','never',MODEL_IMAGE,'node','/fixture.cjs');ownedContainers.push(`${name}-model`);
  await container('cp',resolve(root,'scripts/higress/model-fixture.cjs'),`${name}-model:/fixture.cjs`);await container('start',`${name}-model`);
  await container('create','--name',`${name}-gateway`,'--label',`atlas.higress-poc=${id}`,'--network',name,...(!tunnelled?['--publish',`127.0.0.1:${higressPort}:8080`]:[]),'--env','MODE=gateway','--env','O11Y=off','--env','USE_PLUGIN_SERVER=on','--env','GATEWAY_CONCURRENCY=2','--env','GATEWAY_AUTO_HTTPS_ENABLED=false','--pull','never',HIGRESS_IMAGE);ownedContainers.push(`${name}-gateway`);
  await container('cp',`${name}-gateway:/opt/data/defaultConfig`,resolve(directory,'defaults'));
  const meshFile=resolve(directory,'defaults/configmaps/higress-config.yaml');
  const mesh=(await readFile(meshFile,'utf8')).replace(/    accessLogFormat: \|[\s\S]*?(?=    configSources:)/,'    accessLogFormat: |\n      {"request_id":"%REQ(X-REQUEST-ID)%","response_code":"%RESPONSE_CODE%","route_name":"%ROUTE_NAME%"}\n');
  await writeFile(meshFile,mesh);await container('cp',meshFile,`${name}-gateway:/opt/data/defaultConfig/configmaps/higress-config.yaml`);
  await container('cp',resolve(directory,'defaults')+'/.',`${name}-gateway:/data`);
  // Copy a complete config tree so parent folders exist; JSON is valid YAML.
  for(const [path,value] of Object.entries(resources({proxyToken,upstreamToken}))){const file=resolve(directory,'config',path);await mkdir(dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value,null,2));}
  await container('cp',resolve(directory,'config')+'/.',`${name}-gateway:/data`);
  await container('start',`${name}-gateway`);
  if(tunnelled){
    const machine=JSON.parse((await container('machine','inspect')).out)[0].SSHConfig;
    const address=async suffix=>JSON.parse((await container('inspect',`${name}-${suffix}`)).out)[0].NetworkSettings.Networks[name].IPAddress;
    const args=['-N','-T','-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','StrictHostKeyChecking=accept-new','-o',`UserKnownHostsFile=${resolve(directory,'known_hosts')}`,'-i',machine.IdentityPath,'-p',String(machine.Port),'-L',`127.0.0.1:${higressPort}:${await address('gateway')}:8080`,'-L',`127.0.0.1:${modelPort}:${await address('model')}:4010`,`${machine.RemoteUsername}@127.0.0.1`];
    const child=spawn('ssh',args,{windowsHide:true,stdio:['ignore','ignore','pipe']});let diagnostic='';child.stderr.on('data',data=>diagnostic=(diagnostic+data).slice(-2000));child.diagnostic=()=>diagnostic;children.push(child);
    child.once('error',error=>{diagnostic=error.message;});
  }
  const probe=async()=>{const response=await fetch(`${hg}/v1/chat/completions`,{headers:{authorization:`Bearer ${proxyToken}`},signal:AbortSignal.timeout(800)});await response.text();return {ok:response.status===200,version:response.headers.get('x-atlas-poc-version')};};
  await eventually(async()=>{const result=await probe();return result.ok&&result.version==='v1';},{timeout:90000,label:'Higress runtime v1'});
  check(true,'real pinned Higress route v1 is observed in the data plane');
  for(const headers of [{},{authorization:'Bearer bad'},{authorization:'Bearer local-employee-key'}]){const response=await fetch(`${hg}/_poc/ready`,{headers});await response.text();check([401,403].includes(response.status),'Higress rejects a missing, invalid or platform demo key');}
  const inspect=JSON.parse((await container('inspect',`${name}-gateway`)).out)[0];check(Object.values(inspect.NetworkSettings.Ports).filter(Boolean).flat().every(port=>port.HostIp==='127.0.0.1'),'Higress management ports remain private; data-plane access is loopback only');
  const network=JSON.parse((await container('network','inspect',name)).out)[0];check(network.internal===true||network.Internal===true,'container network has no external route');
  check(Object.values(resources({proxyToken,upstreamToken})).every(resource=>!JSON.stringify(resource).includes('api.openai.com')),'PoC resources refer only to the local fixture and bundled plugins');

  phase='real control-plane setup';
  control=start('apps/control-plane/dist/main.js',{PORT:String(controlPort),UPSTREAM_HIGRESS_POC:proxyToken,UPSTREAM_LOCAL_POC:upstreamToken});await ready(cp,control);
  // Fault injection changes delivery only; authorization and ledger authority remain in the real control plane.
  shim=createServer(async(req,res)=>{const buffers=[];for await(const chunk of req)buffers.push(chunk);const body=Buffer.concat(buffers);const settlement=req.url==='/internal/v1/usage/settlements';
    if(settlement&&blockSettlements){res.writeHead(503);res.end('{}');return;}
    try{const upstream=await fetch(cp+req.url,{method:req.method,headers:{authorization:`Bearer ${serviceToken}`,'content-type':'application/json'},body:body.length?body:undefined,signal:AbortSignal.timeout(5000)});const text=await upstream.text();if(settlement&&loseSettlementResponse){loseSettlementResponse=false;res.destroy();return;}res.writeHead(upstream.status,{'content-type':'application/json'});res.end(text);}catch{res.writeHead(503);res.end('{}');}
  });await new Promise(resolve=>shim.listen(0,'127.0.0.1',resolve));
  const gatewayEnv={PORT:String(gatewayPort),CONTROL_PLANE_URL:`http://127.0.0.1:${shim.address().port}`,MODEL_URL:model,GATEWAY_JOURNAL_DIR:resolve(directory,'journal'),UPSTREAM_HIGRESS_POC:proxyToken,UPSTREAM_LOCAL_POC:upstreamToken,UPSTREAM_TIMEOUT_MS:'5000',UPSTREAM_FIRST_BYTE_TIMEOUT_MS:'1800',UPSTREAM_IDLE_TIMEOUT_MS:'1800'};
  const startGateway=async()=>{gateway=start('services/gateway-sim/dist/server.js',gatewayEnv);await ready(gw,gateway);};await startGateway();
  let cookie;
  async function api(path,body){const response=await fetch(cp+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(cookie?{cookie}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(6000)});const value=await response.json();return {response,value};}
  let result=await api('/api/v1/auth/setup',{directoryId:'higress-poc-admin',name:'Higress PoC',password});check(result.response.ok,'isolated real control plane is initialized');
  result=await api('/api/v1/auth/login',{directoryId:'higress-poc-admin',password});cookie=result.response.headers.get('set-cookie')?.split(';')[0];check(!!cookie,'PoC operator logs in with an isolated password');
  async function command(type,payload){const input={type,payload,idempotencyKey:randomUUID()};const preview=await api('/api/v1/platform/preview',input);assert.equal(preview.response.status,200,redact(JSON.stringify(preview.value)));const applied=await api('/api/v1/platform/commands',{...input,previewToken:preview.value.previewToken});assert.equal(applied.response.status,200,redact(JSON.stringify(applied.value)));return applied.value.result;}
  const state=async()=>(await api('/api/v1/platform/state')).value;
  let service=(await state()).services[0];
  async function configure(baseUrl=hg,credentialRef='UPSTREAM_HIGRESS_POC',extra={}){service=await command('save.service',{...service,baseUrl,credentialRef,limits:{mode:'custom',rpm:1000,concurrency:20,maxOutputTokens:128},mappings:[{...service.mappings[0],upstreamModel:'poc-model',inputPrice:2,outputPrice:8,cachedInputPrice:0.5}],...extra});if(service.active){const verified=await api(`/api/v1/platform/services/${service.id}/verify`,{});assert.equal(verified.value.verification,'passed',redact(JSON.stringify(verified.value)));service=verified.value;}}
  await configure();
  await command('save.pool',{id:'pool-local-test',name:'Higress PoC pool',entries:[{definitionId:'definition-test-model',serviceId:service.id,open:true}]});
  const plan=await command('save.plan',{name:'PoC plan',range:{poolId:'pool-local-test',mode:'follow',definitionIds:[]},amount:1,cadence:'once',quotaDays:30,entitlementDays:30});
  const operator=(await state()).members.find(m=>m.directoryId==='higress-poc-admin');await command('distribution.execute',{planId:plan.id,memberIds:[operator.id]});
  const key=await command('key.issue',{name:'PoC managed key',purpose:'personal'});secrets.push(key.secret);
  const modelRequests=async()=>await(await fetch(`${model}/_poc/requests`)).json();
  const waitLog=async requestId=>eventually(async()=>(await state()).callLogs.find(log=>log.requestId===requestId),{label:`ledger log ${requestId}`});
  function call({scenario='POC_BASIC',stream=false,tools,messages,requestId=randomUUID(),apiKey=key.secret,base=gw,...extra}={}){return {requestId,promise:fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json','x-request-id':requestId,'idempotency-key':requestId},body:JSON.stringify({model:'test-model',messages:messages??[{role:'user',content:scenario}],max_tokens:32,stream,...(tools?{tools}:{}),...extra}),signal:AbortSignal.timeout(12000)})};}
  const normalUsage=log=>log.usageFinal&&log.inputTokens===13&&log.outputTokens===14&&log.cachedInputTokens===4&&Math.abs(log.actualAmount-0.000132)<0.00000001;
  phase='protocol and authoritative settlement';console.log('CHECK managed admission → Higress ai-proxy → local model → authoritative settlement');
  const basic=call();const response=await basic.promise,value=await response.json();check(response.status===200&&value.model==='test-model','non-stream response retains the logical model');
  const basicLog=await waitLog(basic.requestId);check(normalUsage(basicLog)&&basicLog.billableState==='confirmed','real control plane settles input/output/cache usage using its price snapshot');
  report.tracing={clientRequestId:basic.requestId,upstreamRequestId:basicLog.upstreamRequestId,modelRequests:await modelRequests()};
  const observed=(await modelRequests()).find(entry=>entry.requestId===basic.requestId);check(observed?.model==='physical-model'&&observed.maxOutput===32,'Higress plugin maps the admitted alias to the physical model and applies its own upstream credential');
  check(basicLog.upstreamRequestId===`upstream-${basic.requestId}`,'upstream request ID survives both proxies');
  const opaque=call({requestId:`opaque-${randomUUID()}`});await(await opaque.promise).text();check((await waitLog(opaque.requestId)).upstreamRequestId===`upstream-${opaque.requestId}`,'opaque platform request IDs also survive Higress without being regenerated');
  const duplicate=call({requestId:basic.requestId});check((await duplicate.promise).status===409,'duplicate authorization cannot forward a second generation');
  check((await modelRequests()).filter(entry=>entry.requestId===basic.requestId).length===1,'idempotent call reaches the model exactly once');
  const stream=call({stream:true,scenario:'POC_DELAYED'}),started=performance.now(),streamResponse=await stream.promise,reader=streamResponse.body.getReader();let text=new TextDecoder().decode((await reader.read()).value);const first=performance.now();for(;;){const chunk=await reader.read();if(chunk.done)break;text+=new TextDecoder().decode(chunk.value);}const ended=performance.now();
  check(text.endsWith('data: [DONE]\n\n')&&!text.includes('physical-model'),'SSE preserves final completion marker and logical model metadata');check(ended-first>=400,'SSE forwards its first bytes before delayed final usage');check(normalUsage(await waitLog(stream.requestId)),'streaming usage settles exactly once');report.latency.stream={firstByteMs:first-started,totalMs:ended-started};
  const tools=[{type:'function',function:{name:'local_echo',parameters:{type:'object',properties:{text:{type:'string'}}}}}];
  const tool=call({tools}),toolValue=await(await tool.promise).json();check(toolValue.choices[0].message.tool_calls[0].function.arguments==='{"text":"上海"}','non-stream tool arguments and reasoning survive Higress');
  const toolResult=call({tools,messages:[{role:'user',content:'POC_TOOL'},toolValue.choices[0].message,{role:'tool',tool_call_id:'call-local',content:'上海'}]});check((await(await toolResult.promise).json()).choices[0].message.content==='POC_OK','tool result and reasoning history complete a second round trip');
  const toolStream=call({tools,stream:true}),toolText=await(await toolStream.promise).text();const args=toolText.split('\n\n').filter(event=>event.startsWith('data: {')).flatMap(event=>JSON.parse(event.slice(6)).choices??[]).flatMap(choice=>choice.delta?.tool_calls??[]).map(tool=>tool.function?.arguments??'').join('');check(args==='{"text":"上海"}','fragmented UTF-8 SSE tool arguments remain intact');
  for(const input of [tool,toolResult,toolStream])check(normalUsage(await waitLog(input.requestId)),'tool call uses the same authoritative usage and price calculation');
  const missing=call({stream:true,scenario:'POC_INCOMPLETE'});await(await missing.promise).text();check((await waitLog(missing.requestId)).billableState==='pending_review','missing final SSE usage retains its original reservation for review');
  const cancelled=call({stream:true,scenario:'POC_CANCEL'}),cancelResponse=await cancelled.promise,cancelReader=cancelResponse.body.getReader();await cancelReader.read();await cancelReader.cancel();const cancelLog=await waitLog(cancelled.requestId);check(cancelLog.outcome==='client_cancelled'&&cancelLog.billableState==='pending_review','client cancellation remains distinct from upstream failure and preserves unknown cost');
  await eventually(async()=>(await modelRequests()).find(entry=>entry.requestId===cancelled.requestId)?.closed,{label:'cancellation propagation'});check(true,'client cancellation closes the model connection through Higress');
  const failed=call({scenario:'POC_ERROR'});check((await failed.promise).status===500,'upstream HTTP failure is returned');await waitLog(failed.requestId);check((await modelRequests()).filter(entry=>entry.requestId===failed.requestId).length===1,'Higress does not retry a failed generation or perform fallback');
  const timed=call({scenario:'POC_TIMEOUT'});check((await timed.promise).status===504,'first-byte timeout remains enforced around Higress');check((await waitLog(timed.requestId)).billableState==='pending_review','timeout with unknown generation cost retains its hold');
  const invalid=call({apiKey:'invalid'});check((await invalid.promise).status===401,'invalid platform key is refused before Higress');check(!(await modelRequests()).some(entry=>entry.requestId===invalid.requestId),'invalid platform key never reaches the model');

  phase='configuration versions and rollback';console.log('CHECK observed configuration versions, failure and rollback');
  const publisher=new IsolatedFilePublisher({write:resource=>copyJson('ingresses/atlas-poc.yaml',resource),probe});
  check((await publisher.publish(ingress(),{idempotencyKey:'v1'})).status==='applied','publisher marks v1 applied only after a successful runtime probe');
  check((await publisher.publish(ingress('v2'),{idempotencyKey:'v2'})).appliedVersion==='v2','new desired version is observed at the real Higress data port');
  const failedPublish=await publisher.publish(ingress('v3',{unavailable:true}),{idempotencyKey:'bad-v3',timeoutMs:4500});check(failedPublish.status==='rejected'&&failedPublish.appliedVersion==='v2','unusable configuration is rejected without claiming a new applied version');
  check((await publisher.publish(ingress('v2'),{idempotencyKey:'rollback-v2'})).status==='applied','explicit rollback restores the last working Higress route');
  report.configOperations=publisher.operations;
  const afterRollback=call();await(await afterRollback.promise).text();check(normalUsage(await waitLog(afterRollback.requestId)),'normal authoritative settlement resumes after rollback');

  phase='durable journal recovery';console.log('CHECK settlement response loss, gateway restart and interrupted streams');
  blockSettlements=true;const queued=call();await(await queued.promise).text();check((await(await fetch(`${gw}/health`)).json()).outbox.queued>=1,'completed usage is durably queued while settlement delivery is unavailable');
  await stop(gateway);blockSettlements=false;await startGateway();check(normalUsage(await waitLog(queued.requestId)),'gateway restart replays the original complete usage into the real ledger');
  check((await state()).callLogs.filter(log=>log.requestId===queued.requestId).length===1,'durable replay produces one authoritative call record');
  loseSettlementResponse=true;const lost=call();await(await lost.promise).text();check(normalUsage(await waitLog(lost.requestId)),'control plane retains settlement when its response is lost');
  await stop(gateway);await startGateway();await eventually(async()=>(await(await fetch(`${gw}/health`)).json()).outbox.queued===0,{label:'response-loss replay'});check((await state()).callLogs.filter(log=>log.requestId===lost.requestId).length===1,'replay after a lost settlement response does not charge twice');
  const crash=call({stream:true,scenario:'POC_CRASH'}),crashResponse=await crash.promise,crashReader=crashResponse.body.getReader();await crashReader.read();await stop(gateway);try{await crashReader.cancel();}catch{}await startGateway();const crashLog=await waitLog(crash.requestId);check(crashLog.outcome==='partial'&&crashLog.billableState==='pending_review'&&!crashLog.usageFinal,'forced gateway exit during a stream restores unknown usage as pending review');
  phase='quota and shared concurrency boundaries';
  const deniedMember=await command('save.member',{name:'Tiny quota',directoryId:'poc-tiny-quota',password:randomUUID(),organizationId:'department-engineering',category:'employee',roles:['employee'],tags:[]});
  const tinyPlan=await command('save.plan',{name:'Tiny PoC plan',range:{poolId:'pool-local-test',mode:'follow',definitionIds:[]},amount:0.000001,cadence:'once',quotaDays:30,entitlementDays:30});
  await command('distribution.execute',{planId:tinyPlan.id,memberIds:[deniedMember.id]});
  const tinyKey=await command('key.issue',{name:'Insufficient quota',purpose:'personal',memberId:deniedMember.id});secrets.push(tinyKey.secret);
  const empty=call({apiKey:tinyKey.secret});const emptyResponse=await empty.promise,emptyValue=await emptyResponse.json();check(emptyResponse.status===403&&emptyValue.error.code==='quota_insufficient','insufficient quota is refused by the real control plane');
  check(!(await modelRequests()).some(entry=>entry.requestId===empty.requestId),'quota refusal produces no model request');
  await configure(hg,'UPSTREAM_HIGRESS_POC',{limits:{mode:'custom',rpm:1000,concurrency:1,maxOutputTokens:128}});
  const held=call({stream:true,scenario:'POC_CANCEL'}),heldResponse=await held.promise,heldReader=heldResponse.body.getReader();await heldReader.read();
  const competing=call(),competingResponse=await competing.promise;check(competingResponse.status===429,'a live stream retains the shared service concurrency slot');
  check(!(await modelRequests()).some(entry=>entry.requestId===competing.requestId),'concurrent quota refusal happens before Higress inference');await heldReader.cancel();await waitLog(held.requestId);
  await configure(hg,'UPSTREAM_HIGRESS_POC',{active:false});const stopped=call();check([401,403].includes((await stopped.promise).status),'service deactivation denies new managed requests');check(!(await modelRequests()).some(entry=>entry.requestId===stopped.requestId),'deactivated service never reaches inference');await configure(hg,'UPSTREAM_HIGRESS_POC',{active:true});

  phase='small direct/proxy latency comparison';
  async function sample(){const durations=[];for(let i=0;i<8;i++){const begin=performance.now(),input=call();const response=await input.promise;await response.text();assert.equal(response.status,200);await waitLog(input.requestId);durations.push(performance.now()-begin);}const sorted=[...durations].sort((a,b)=>a-b);return {count:durations.length,p50Ms:sorted[3],maxMs:sorted.at(-1)};}
  await configure(model,'UPSTREAM_LOCAL_POC');report.latency.direct=await sample();await configure();report.latency.higress=await sample();
  const final=await state(),ownBatches=final.quotaBatches.filter(batch=>batch.sourceId===operator.id),ownLogs=final.callLogs.filter(log=>log.subjectId===operator.id);
  const total=ownBatches.reduce((sum,batch)=>sum+batch.totalAmount,0),available=ownBatches.reduce((sum,batch)=>sum+batch.availableAmount,0),spent=ownLogs.filter(log=>log.billableState==='confirmed').reduce((sum,log)=>sum+log.actualAmount,0),heldAmount=ownLogs.filter(log=>log.billableState==='pending_review').reduce((sum,log)=>sum+(log.admission?.reservedAmount??0),0);
  check(Math.abs(total-available-spent-heldAmount)<0.0000001,'original funded batch equals remaining funds plus confirmed charges and unknown holds');
  report.accounting={calls:final.callLogs.length,confirmed:final.callLogs.filter(log=>log.billableState==='confirmed').length,pendingReview:final.callLogs.filter(log=>log.billableState==='pending_review').length,modelRequests:(await modelRequests()).length,operator:{total,available,spent,heldAmount}};
  const logs=(await container('exec',`${name}-gateway`,'cat','/var/log/higress/gateway.log')).out;check(!/POC_(BEGIN|BASIC|TOOL|CANCEL|CRASH|DELAYED|ERROR|TIMEOUT|INCOMPLETE)/.test(logs)&&!secrets.some(secret=>logs.includes(secret)),'gateway access log records metadata without prompts, responses or credentials');
  report.sourceHashes={};for(const path of ['scripts/check-higress.mjs','scripts/higress/poc-config.mjs','scripts/higress/file-publisher.mjs','scripts/higress/model-fixture.cjs','services/gateway-sim/dist/server.js','apps/control-plane/dist/main.js'])report.sourceHashes[path]=createHash('sha256').update(await readFile(resolve(root,path))).digest('hex');
  report.success=true;
}catch(error){report.error={phase,message:redact(error.message)};console.error(`FAIL ${phase}: ${redact(error.message)}`);process.exitCode=1;
  if(ownedContainers.includes(`${name}-gateway`)){for(const file of ['controller','pilot','gateway','apiserver'])try{const result=await run(cli,['exec',`${name}-gateway`,'tail','-c','5000',`/var/log/higress/${file}.log`],{allowFailure:true});await mkdir(directory,{recursive:true});await writeFile(resolve(directory,`${file}.log`),redact(result.out+result.err));}catch{}}
}finally{
  for(const child of children.toReversed())await stop(child);
  if(shim){shim.closeAllConnections();await new Promise(resolve=>shim.close(resolve));}
  const containerCleanup=[];for(const owned of ownedContainers.toReversed())containerCleanup.push((await run(cli,['rm','--force',owned],{allowFailure:true})).code===0);
  const networkRemoved=!networkCreated||(await run(cli,['network','rm',name],{allowFailure:true})).code===0;
  report.cleanup={containersRemoved:containerCleanup.every(Boolean),networkRemoved,existingWorkspacesTouched:false};
  if(!report.cleanup.containersRemoved||!networkRemoved){report.success=false;process.exitCode=1;report.error??={phase:'cleanup',message:'some owned resources could not be removed'};}
  if(ownedContainers.length){
    const physical=await realpath(directory),parent=await realpath(runtime);assert.ok(physical.startsWith(parent+sep)&&basename(physical)===name);
    if(report.success)await rm(physical,{recursive:true,force:true});
    else {for(const item of ['config','defaults','known_hosts'])await rm(resolve(physical,item),{recursive:true,force:true});console.error(`Redacted diagnostics: ${directory}`);}
  }
  report.completedAt=new Date().toISOString();await writeReport();
  if(report.success)console.log(`PASS ${report.checks.length} real Higress PoC checks; owned resources removed`);
  console.log(`Report: ${output}`);
}
