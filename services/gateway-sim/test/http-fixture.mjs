import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../../../',import.meta.url));
export const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function json(request){let raw='';for await(const chunk of request)raw+=chunk;return JSON.parse(raw||'{}');}
export function send(response,value,status=200){response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(value));}
async function listen(server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${server.address().port}`;}

/** Local protocol stand-ins. Ledger correctness is checked separately against the real control plane. */
export async function gatewayFixture(work,modelHandler,env={}){
  const directory=await mkdtemp(join(tmpdir(),'agp-http-')),settlements=[],requests=[],authorizations=[];
  let settlementStatus=200;
  const model=createServer(async(request,response)=>{
    try{const body=await json(request);requests.push(body);await modelHandler(body,response,request);}catch{if(!response.destroyed)response.destroy();}
  });
  let child,output='';
  const control=createServer(async(request,response)=>{
    const body=await json(request);
    if(request.url.endsWith('/credentials/resolve'))return send(response,body.apiKey==='http-test-key'?{credentialId:'test-key',identity:{subjectType:'employee',subjectId:'test-user',credentialId:'test-key',organizationId:'test-org'},purpose:'personal',modelIds:['logical-model']}:null);
    if(request.url.endsWith('/authorize')){authorizations.push(body);return send(response,{requestId:body.requestId,admissionAttemptId:body.admissionAttemptId,decision:'allow',reasonCode:'none',reasonMessage:'',policyVersion:'test',reservation:{reservationId:`hold-${body.requestId}`,sourceType:'personal_batch',sourceId:'test-batch',reservedAmount:1,currency:'CNY',expiresAt:new Date(Date.now()+300000).toISOString()},admission:{kind:'configured',route:{serviceId:'test-service',poolId:'test-pool',definitionId:'test-model',baseUrl:modelUrl,upstreamModel:'physical-model',credentialRef:null,maxOutputTokens:32},price:{version:'test',currency:'CNY',unit:'per_million_tokens',inputPrice:2,outputPrice:8,cachedInputPrice:0.1},reservedAmount:1,estimatedTokens:100,scopes:[]}});}
    if(request.url.endsWith('/settlements')){settlements.push(body);return send(response,{requestId:body.requestId,status:body.usageFinal?'settled':'pending_review',billableState:body.usageFinal?'confirmed':'pending_review'},settlementStatus);}
    if(request.url.endsWith('/leases/renew'))return send(response,{renewed:true});
    send(response,{},404);
  });
  const modelUrl=await listen(model),controlUrl=await listen(control);
  const portServer=createServer();const portUrl=await listen(portServer);await new Promise(resolve=>portServer.close(resolve));
  const base=portUrl,port=new URL(base).port;
  try{
    const clean=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('UPSTREAM_')&&!key.startsWith('GATEWAY_')));
    // IPC emits the same shutdown signal handler on Windows, where OS SIGTERM forcibly terminates Node.
    child=spawn(process.execPath,['--input-type=module','-e',"process.on('message',m=>{if(m==='terminate')process.emit('SIGTERM')});await import('./services/gateway-sim/dist/server.js')"],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],env:{...clean,PLATFORM_MODE:'development',HOST:'127.0.0.1',PORT:port,CONTROL_PLANE_URL:controlUrl,SERVICE_TOKEN:'http-service-token',MODEL_URL:modelUrl,ALLOW_UPSTREAM_REQUESTS:'false',GATEWAY_JOURNAL_DIR:directory,UPSTREAM_TIMEOUT_MS:'5000',UPSTREAM_FIRST_BYTE_TIMEOUT_MS:'1500',UPSTREAM_IDLE_TIMEOUT_MS:'1500',...env}});
    child.stdout.on('data',chunk=>output=(output+chunk).slice(-4000));child.stderr.on('data',chunk=>output=(output+chunk).slice(-4000));
    for(let i=0;;i++){try{if((await fetch(`${base}/health`)).ok)break;}catch{}if(child.exitCode!==null||i>100)throw new Error(`gateway did not start: ${output}`);await pause(30);}
    const call=(body={},signal,headers={})=>fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{authorization:'Bearer http-test-key','content-type':'application/json',...headers},body:JSON.stringify({model:'logical-model',messages:[{role:'user',content:'local test'}],...body}),signal});
    const waitSettlement=async()=>{for(let i=0;i<100;i++){if(settlements.length)return settlements.at(-1);await pause(30);}throw new Error(`missing settlement: ${output}`);};
    const stop=()=>new Promise((resolve,reject)=>{child.once('exit',code=>code===0?resolve():reject(new Error(`shutdown exited ${code}: ${output}`)));child.send('terminate');});
    await work({base,call,requests,authorizations,settlements,waitSettlement,stop,directory,child,setSettlementStatus:status=>{settlementStatus=status;}});
  }finally{
    if(child&&child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}
    control.closeAllConnections();model.closeAllConnections();
    await Promise.all([new Promise(resolve=>control.close(resolve)),new Promise(resolve=>model.close(resolve))]);
    const physical=await realpath(directory),parent=await realpath(tmpdir());assert.ok(physical.startsWith(parent+sep)&&basename(physical).startsWith('agp-http-'));await rm(physical,{recursive:true,force:true});
  }
}

export const usage={prompt_tokens:13,completion_tokens:14,prompt_tokens_details:{cached_tokens:4}};
export function streamStart(response){response.writeHead(200,{'content-type':'text/event-stream'});}
export function streamEvent(response,value){response.write(`data: ${JSON.stringify(value)}\n\n`);}
