import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,realpath,rm} from 'node:fs/promises';
import {resolve,dirname,sep,join} from 'node:path';
import {createRequire} from 'node:module';
import {estimateChatInput} from '../packages/contracts/dist/index.js';

const root=process.cwd(),require=createRequire(resolve(root,'apps/control-plane/package.json')),{parse}=require('dotenv'),{Pool}=require('pg');
// Explicit opt-in before reading private configuration, spawning services or calling an upstream.
if(process.argv[2]!=='--allow-upstream'||!process.argv[3])throw new Error('Usage: check-live-deepseek.mjs --allow-upstream <absolute Pi CLI path>; at most 8 upstream requests / CNY 0.10 conservative configured-price estimate');
const piCli=resolve(process.argv[3]);
const id=randomUUID(),runtime=resolve(root,'.runtime'),directory=resolve(runtime,`live-core-${id}`),output=resolve(root,process.env.LIVE_REPORT_PATH??`.runtime/live-results/${new Date().toISOString().replace(/[:.]/g,'-')}-deepseek.json`);
const children=[],pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));let proxy,proxyBase;
const report={success:false,createdAt:new Date().toISOString(),model:'deepseek-flash',provider:'DeepSeek official',scope:'isolated memory workspace; current gateway build; real upstream; original Pi and CC Switch files are read-only',budget:{maxRequests:8,maxEstimatedAmount:.1,attempts:0,estimatedUpperBound:0},checks:[],calls:[]};
const originals=[join(process.env.USERPROFILE,'.pi','agent','models.json'),join(process.env.USERPROFILE,'.cc-switch','cc-switch.db')];
async function hash(file){try{return createHash('sha256').update(await readFile(file)).digest('hex');}catch(error){if(error.code==='ENOENT')return null;throw error;}}
const originalHashes=await Promise.all(originals.map(hash));
async function port(){const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const value=server.address().port;await new Promise(resolve=>server.close(resolve));return value;}
const baseEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('UPSTREAM_')&&!key.startsWith('GATEWAY_')));
function start(file,env,args=[],cwd=root){const child=spawn(process.execPath,[file,...args],{cwd,env:{...baseEnv,...env},windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',data=>output=(output+data).slice(-2000000));child.stderr.on('data',data=>output=(output+data).slice(-2000000));child.output=()=>output;children.push(child);return child;}
async function ready(url,child){for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error('isolated service startup failed');try{if((await fetch(url)).ok)return;}catch{}await pause(100);}throw Error('isolated service readiness timeout');}
async function readJson(request){let body='';for await(const chunk of request){body+=chunk;if(Buffer.byteLength(body)>1048576)throw new Error('request too large');}return JSON.parse(body);}
try{
  await mkdir(directory,{mode:0o700});assert.ok((await realpath(directory)).startsWith((await realpath(root))+sep));
  await realpath(piCli);
  const pi=JSON.parse(await readFile(originals[0])),selected=pi.providers?.['token-run-test'];
  assert.ok(selected&&typeof selected.api==='string'&&selected.models?.some(model=>model.id==='deepseek-flash'),'the existing token-run-test DeepSeek definition is required');
  const local=parse(await readFile(resolve(root,'.env'))),dbConfig=parse(await readFile(resolve(root,'apps/control-plane/.env'))),review=JSON.parse(await readFile(resolve(runtime,'review-postgres.json')));
  assert.match(review.schema,/^agp_review_[a-f0-9]{32}$/);const db=new Pool({connectionString:dbConfig.DATABASE_URL,connectionTimeoutMillis:5000});let definition,service,mapping;
  try{const value=(await db.query(`select payload->'services' as services,payload->'definitions' as definitions from "${review.schema}".platform_workspace where id=$1`,['org-demo'])).rows[0];definition=value.definitions.find(d=>d.modelId==='deepseek-flash');service=value.services.find(s=>s.mappings.some(m=>m.definitionId===definition.id)&&new URL(s.baseUrl).hostname==='api.deepseek.com');mapping=service.mappings.find(m=>m.definitionId===definition.id);}finally{await db.end();}
  assert.ok(local[service.credentialRef]);report.priceSnapshot={input:mapping.inputPrice,output:mapping.outputPrice,cached:mapping.cachedInputPrice,currency:'CNY',unit:'per_million_tokens'};
  const [cpPort,gwPort]=await Promise.all([port(),port()]),cp=`http://127.0.0.1:${cpPort}`,gw=`http://127.0.0.1:${gwPort}`,token=`core-${randomUUID()}`;
  const common={PLATFORM_MODE:'development',STORE_MODE:'memory',DATABASE_URL:'',DATABASE_SCHEMA:'',PGOPTIONS:'',REDIS_URL:'',BOOTSTRAP_TOKEN:'',HOST:'127.0.0.1',DOTENV_CONFIG_PATH:resolve(directory,'unused.env'),SERVICE_TOKEN:token,MAINTENANCE_DISABLED:'true',[service.credentialRef]:local[service.credentialRef]};
  const control=start('apps/control-plane/dist/main.js',{...common,PORT:String(cpPort),ALLOW_UPSTREAM_VALIDATION:'true',UPSTREAM_VALIDATION_TIMEOUT_MS:'120000'});await ready(`${cp}/health`,control);
  const gateway=start('services/gateway-sim/dist/server.js',{...common,PORT:String(gwPort),CONTROL_PLANE_URL:cp,GATEWAY_JOURNAL_DIR:resolve(directory,'journal'),ALLOW_UPSTREAM_REQUESTS:'true',UPSTREAM_TIMEOUT_MS:'180000',UPSTREAM_FIRST_BYTE_TIMEOUT_MS:'120000',UPSTREAM_IDLE_TIMEOUT_MS:'60000'});await ready(`${gw}/health`,gateway);
  let cookie='';async function api(path,body){const response=await fetch(cp+path,{method:body?'POST':'GET',headers:{cookie,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(150000)});const value=await response.json();if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];assert.equal(response.status,200,`fixture API failed (${response.status})`);return value;}
  async function command(type,payload){const c={type,payload,idempotencyKey:randomUUID()},preview=await api('/api/v1/platform/preview',c);return (await api('/api/v1/platform/commands',{...c,previewToken:preview.previewToken})).result;}
  const password=`live-${randomUUID()}`;await api('/api/v1/auth/setup',{directoryId:'core-live',name:'隔离真实验证',password});await api('/api/v1/auth/login',{directoryId:'core-live',password});
  const state=await api('/api/v1/platform/state');
  const model=await command('save.definition',{...definition,id:undefined});
  const source=await command('save.service',{name:'隔离 DeepSeek 实接',active:true,baseUrl:service.baseUrl,credentialRef:service.credentialRef,limits:{mode:'custom',maxOutputTokens:2048},mappings:[{...mapping,definitionId:model.id}]});
  report.budget.attempts=1;report.budget.estimatedUpperBound=.001;
  const verification=await api(`/api/v1/platform/services/${source.id}/verify`,{});assert.equal(verification.verification,'passed');report.verification=verification.verificationRun?.results?.map(result=>({outcome:result.outcome,usage:result.usage,cost:result.cost}));
  const pool=await command('save.pool',{name:'隔离真实模型池',entries:[{definitionId:model.id,serviceId:source.id,open:true}]});
  const plan=await command('save.plan',{name:'隔离实接预算',range:{poolId:pool.id,mode:'follow',definitionIds:[]},amount:.1,cadence:'once',quotaDays:1,entitlementDays:1});
  await command('distribution.execute',{planId:plan.id,memberIds:[state.actor.id]});
  const key=await command('key.issue',{name:'本轮隔离实接',purpose:'personal'});
  proxy=createServer(async(request,response)=>{
    const controller=new AbortController(),closed=()=>{if(!response.writableEnded)controller.abort();};response.on('close',closed);
    try{
      if(request.headers.authorization!==`Bearer ${key.secret}`){response.writeHead(401);response.end();return;}
      if(!(request.method==='GET'&&request.url==='/v1/models')&&!(request.method==='POST'&&request.url==='/v1/chat/completions')){response.writeHead(404);response.end();return;}
      let body;if(request.method==='POST')body=await readJson(request);
      if(body){const max=body.max_completion_tokens??body.max_tokens??2048,upper=(estimateChatInput(body)*Math.max(mapping.inputPrice,mapping.cachedInputPrice)+max*mapping.outputPrice)/1e6;
        if(!Number.isSafeInteger(max)||max<1||max>2048||!Number.isFinite(upper)||upper<0){response.writeHead(400);response.end();return;}
        if(report.budget.attempts>=report.budget.maxRequests||report.budget.estimatedUpperBound+upper>report.budget.maxEstimatedAmount){response.writeHead(429,{'content-type':'application/json'});response.end('{"error":{"type":"local_validation_budget_exceeded"}}');return;}
        report.budget.attempts++;report.budget.estimatedUpperBound+=upper;
      }
      const requestId=`live-${id}-${report.budget.attempts}`;
      const upstream=await fetch(gw+request.url,{method:request.method,headers:{authorization:`Bearer ${key.secret}`,'content-type':'application/json','x-request-id':requestId,'idempotency-key':requestId},body:body?JSON.stringify(body):undefined,signal:controller.signal,redirect:'error'});
      response.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json'});if(upstream.body)for await(const chunk of upstream.body){if(response.destroyed)break;response.write(chunk);}response.end();
    }catch{if(!response.destroyed){response.writeHead(502);response.end('{"error":{"type":"validation_proxy_error"}}');}}finally{response.off('close',closed);}
  });await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));proxyBase=`http://127.0.0.1:${proxy.address().port}`;
  async function call(body,signal){return fetch(proxyBase+'/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${key.secret}`,'content-type':'application/json'},body:JSON.stringify({model:'deepseek-flash',...body}),signal});}
  const piDir=resolve(directory,'agent'),work=resolve(directory,'work');await mkdir(piDir);await mkdir(work);await writeFile(resolve(work,'fixture.txt'),'CORE_TOOL_OK\n');
  await writeFile(resolve(piDir,'models.json'),JSON.stringify({providers:{'core-live':{api:selected.api,baseUrl:proxyBase+'/v1',apiKey:key.secret,models:selected.models.filter(m=>m.id==='deepseek-flash').map(m=>({...m,maxTokens:1024}))}}}),{mode:0o600});
  const piArgs=['--provider','core-live','--model','deepseek-flash','--mode','json','--print','--no-session','--offline','--no-extensions','--no-mcp','--no-skills','--no-prompt-templates','--no-context-files','--no-themes','--tools','read','--system-prompt','You are a deterministic validation assistant. Read only the single requested fixture file. After reading it, reply exactly with its contents.','Read fixture.txt using the read tool, then return its content. Do not guess its content and do not read any other file.'];
  const piChild=start(piCli,{PI_CODING_AGENT_DIR:piDir,PI_OFFLINE:'1'},piArgs,work);
  const piDeadline=setTimeout(()=>piChild.kill(),180000);const code=await new Promise(resolve=>piChild.once('exit',resolve));clearTimeout(piDeadline);
  const events=piChild.output().split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
  const starts=events.filter(event=>event.type==='tool_execution_start'),messages=events.filter(event=>event.type==='message_end').map(event=>event.message),last=messages.filter(message=>message?.role==='assistant').at(-1),answer=last?.content?.filter(item=>item.type==='text').map(item=>item.text).join('')??'';
  report.pi={exitCode:code,version:spawnSync(process.execPath,[piCli,'--version'],{cwd:work,env:{...baseEnv,PI_CODING_AGENT_DIR:piDir,PI_OFFLINE:'1'},encoding:'utf8',windowsHide:true}).stdout.trim(),toolNames:starts.map(event=>event.toolName),finalMarkerMatched:answer.trim()==='CORE_TOOL_OK',eventTypes:[...new Set(events.map(event=>event.type))]};
  assert.equal(code,0,'Pi CLI exited with an error');assert.ok(starts.some(event=>event.toolName==='read'),'Pi must actually call read');assert.equal(answer.trim(),'CORE_TOOL_OK','Pi must complete the tool round trip');report.checks.push('actual Pi CLI tool call and result round trip');
  const prefix=Array.from({length:144},(_,i)=>`Reference ${String(i).padStart(4,'0')}: deterministic cache validation, keep this prefix unchanged.`).join('\n');
  const cacheBody={max_tokens:256,messages:[{role:'developer',content:[{type:'text',text:'Answer exactly CACHE_OK.'}]},{role:'user',content:prefix+'\nReturn CACHE_OK.'}]};
  for(let i=0;i<2;i++){const response=await call(cacheBody);assert.equal(response.status,200,'cache validation HTTP');const value=await response.json();report.checks.push({cacheSample:i+1,usage:value.usage});}
  let began=Date.now();const stream=await call({stream:true,max_completion_tokens:1024,messages:[{role:'developer',content:[{type:'text',text:'Follow the user exactly.'}]},{role:'user',content:'Write the numbers 1 through 100, one per line, followed by a short English sentence about careful testing for each number.'}]});assert.equal(stream.status,200);const streamRaw=await stream.text();assert.ok(streamRaw.endsWith('data: [DONE]\n\n'));report.stream={durationMs:Date.now()-began,completed:true,overThirtySeconds:Date.now()-began>30000};
  const controller=new AbortController();const cancel=await call({stream:true,max_tokens:1024,messages:[{role:'user',content:'Write a long numbered list of tips for careful testing.'}]},controller.signal);assert.equal(cancel.status,200);const reader=cancel.body.getReader();await reader.read();controller.abort();await pause(1200);
  const after=await api('/api/v1/platform/state');report.calls=after.callLogs.map(log=>({requestId:log.requestId,outcome:log.outcome,inputTokens:log.inputTokens,outputTokens:log.outputTokens,cachedInputTokens:log.cachedInputTokens,amount:log.actualAmount,billableState:log.billableState,usageFinal:log.usageFinal,forwarded:log.forwarded,latencyMs:log.latencyMs,ttftMs:log.ttftMs,errorCode:log.errorCode}));
  const cancelled=report.calls.find(log=>log.outcome==='client_cancelled');assert.ok(cancelled&&cancelled.billableState==='pending_review'&&cancelled.usageFinal===false,'real cancellation must remain pending without final usage');
  report.confirmedAmount=Number(report.calls.filter(log=>log.billableState==='confirmed').reduce((sum,log)=>sum+log.amount,0).toFixed(6));report.remainingAmount=after.quotaBatches.filter(batch=>batch.sourceId===state.actor.id).reduce((sum,batch)=>sum+batch.availableAmount,0);report.outbox=await fetch(gw+'/health').then(response=>response.json()).then(value=>value.outbox);
  const held=Number((.1-report.confirmedAmount-report.remainingAmount).toFixed(6));assert.ok(held>=0);report.accounting={initialAmount:.1,confirmedAmount:report.confirmedAmount,pendingReservedAmount:held,remainingAmount:report.remainingAmount,conserved:Math.round((report.confirmedAmount+held+report.remainingAmount)*1e6)===100000};
  report.success=true;
}catch(error){report.failure=error instanceof assert.AssertionError?error.message.split('\n')[0]:error?.name??'live verification failed';process.exitCode=1;}
finally{
  if(proxy){proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}
  for(const child of children.reverse())if(child.exitCode===null){child.kill();await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(3000)]);}
  report.originalConfigurationsUnchanged=(await Promise.all(originals.map(hash))).every((value,index)=>value===originalHashes[index]);
  await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  const physical=await realpath(directory),parent=await realpath(runtime);assert.ok(physical===resolve(parent,`live-core-${id}`)&&physical.startsWith(parent+sep));await rm(physical,{recursive:true,force:true});console.log(JSON.stringify({success:report.success,output,budget:report.budget,pi:report.pi,stream:report.stream,confirmedAmount:report.confirmedAmount,originalConfigurationsUnchanged:report.originalConfigurationsUnchanged,failure:report.failure},null,2));
}
