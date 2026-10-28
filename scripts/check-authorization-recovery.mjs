import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const gate=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};};
async function listen(server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${server.address().port}`;}

/** Real gateway/control-plane HTTP with response loss at a local proxy, never external traffic. */
export async function checkAuthorizationRecovery({controlPlaneUrl,modelUrl,start,freePort,runtimeDirectory,inspectLedger}){
  let assertions=0;const check=(value,message)=>{assert.ok(value,message);assertions++;};
  const headers={'content-type':'application/json',authorization:'Bearer local-service-token'},rules=new Map(),modelCounts=new Map(),settlementBodies=new Map();
  const servers=[];
  async function rpc(path,body){const response=await fetch(`${controlPlaneUrl}${path}`,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});assert.equal(response.status,200,`recovery fixture RPC ${path}`);return response.json();}
  const quota=async()=>(await rpc('/api/v1/calls/quota')).availableAmount;
  const money=async(expected,message)=>check(Math.abs((await quota())-expected)<1e-7,message);
  async function waitFor(work,message){for(let i=0;i<200;i++){if(await work())return;await pause(50);}throw new Error(message);}
  const readJson=async request=>{let body='';for await(const chunk of request)body+=chunk;return JSON.parse(body||'{}');};
  const proxy=createServer(async(request,response)=>{
    try{
      const body=await readJson(request),rule=rules.get(body.requestId),authorizing=request.url.endsWith('/authorize'),settling=request.url.endsWith('/settlements');
      if(rule&&authorizing){rule.authHits++;if(rule.mode==='late_commit'&&rule.authHits===1)await pause(6000);if(rule.recoveryGate&&rule.authHits>1)await rule.recoveryGate.promise;}
      const upstream=await fetch(`${controlPlaneUrl}${request.url}`,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(15000)}),value=await upstream.json();
      if(rule&&authorizing){
        rule.authorization=value;
        if(rule.mode==='crash'&&rule.authHits===1){await new Promise(resolve=>{if(response.destroyed)resolve();else response.once('close',resolve);});return;}
        if((['drop','late_commit','lease','legacy'].includes(rule.mode)&&rule.authHits===1)||(rule.mode==='duplicate'&&rule.authHits===2)){response.destroy();return;}
        if(rule.mode==='legacy'&&rule.hideOwner)delete value.admissionAttemptId;
      }
      if(settling){
        const bodies=settlementBodies.get(body.requestId)??[];bodies.push(body);settlementBodies.set(body.requestId,bodies);
        if(rule?.mode==='settlement_drop'&&bodies.length===1){response.destroy();return;}
      }
      response.writeHead(upstream.status,{'content-type':'application/json'});response.end(JSON.stringify(value));
    }catch{response.destroy();}
  });servers.push(proxy);
  const model=createServer(async(request,response)=>{
    const id=request.headers['x-request-id'];modelCounts.set(id,(modelCounts.get(id)??0)+1);
    try{
      const body=await readJson(request),rule=rules.get(id);if(rule?.modelGate)await rule.modelGate.promise;
      const upstream=await fetch(`${modelUrl}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
      response.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json'});response.end(await upstream.text());
    }catch{response.destroy();}
  });servers.push(model);
  const [proxyUrl,countedModel]=await Promise.all([listen(proxy),listen(model)]),[port1,port2]=await Promise.all([freePort(),freePort()]);
  const gateways=[{base:`http://127.0.0.1:${port1}`,port:port1,directory:resolve(runtimeDirectory,'authorization-gateway-1')},{base:`http://127.0.0.1:${port2}`,port:port2,directory:resolve(runtimeDirectory,'authorization-gateway-2')}];
  async function launch(gateway){
    gateway.child=start('services/gateway-sim/dist/server.js',{HOST:'127.0.0.1',PORT:String(gateway.port),CONTROL_PLANE_URL:proxyUrl,MODEL_URL:countedModel,SERVICE_TOKEN:'local-service-token',ALLOW_UPSTREAM_REQUESTS:'false',GATEWAY_JOURNAL_DIR:gateway.directory,UPSTREAM_TIMEOUT_MS:'15000'});
    await waitFor(async()=>{if(gateway.child.exitCode!==null)throw new Error('recovery gateway failed to start');try{return (await fetch(`${gateway.base}/health`,{signal:AbortSignal.timeout(500)})).ok;}catch{return false;}},'recovery gateway startup');
  }
  async function stop(gateway){if(gateway.child.exitCode===null){gateway.child.kill('SIGKILL');await new Promise(resolve=>gateway.child.once('exit',resolve));}}
  const request=(gateway,id,body={})=>fetch(`${gateway.base}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer local-employee-key','x-request-id':id,'idempotency-key':id},body:JSON.stringify({model:'test-model',messages:[{role:'user',content:'isolated authorization recovery'}],...body}),signal:AbortSignal.timeout(20000)});
  const health=async gateway=>(await fetch(`${gateway.base}/health`)).json();
  const empty=async gateway=>{await waitFor(async()=>{const s=(await health(gateway)).outbox;return s.active+s.queued+s.blocked===0;},'authorization/outbox did not converge');assertions++;};
  async function log(id){const records=(await rpc('/api/v1/calls')).data.filter(log=>log.requestId===id);check(records.length===1,'one call log per recovered request');return records[0];}
  const rule=mode=>{const id=`recovery-${randomUUID()}`,value={id,mode,authHits:0};rules.set(id,value);return value;};
  async function released(id,before){await empty(gateways[0]);await money(before,'known unforwarded hold refunded exactly once');check(!modelCounts.get(id),'authorization recovery never calls the model');check((await log(id)).billableState==='not_billable','recovered call is not billable');if(inspectLedger)check((await inspectLedger(id)).length===1,'one financial ledger entry for recovery');}
  try{
    await launch(gateways[0]);await launch(gateways[1]);
    check((await fetch(`${controlPlaneUrl}/internal/v1/diagnostics/hot-path`)).status===401,'diagnostics requires service token');
    check((await fetch(`${controlPlaneUrl}/internal/v1/diagnostics/hot-path`,{headers:{authorization:'Bearer local-employee-key'}})).status===401,'employee key cannot read diagnostics');
    check((await rpc('/internal/v1/diagnostics/hot-path')).enabled===false,'diagnostics is off by default');
    for(const mode of ['drop','late_commit']){
      const r=rule(mode),before=await quota(),response=await request(gateways[0],r.id);check(response.status===503,`${mode} returns unavailable without forwarding`);await response.text();await released(r.id,before);
      check(r.authHits>=2,'unknown authorization outcome is resolved by idempotent replay');
      const duplicate=await request(gateways[0],r.id);check(duplicate.status===409,'recovered request cannot later be forwarded');await duplicate.text();await money(before,'replay after recovery does not reserve again');
    }
    {
      const r=rule('drop'),before=await quota(),response=await request(gateways[0],r.id,{model:'not-open'});check(response.status===503,'lost denial response is resolved without forwarding');await response.text();await empty(gateways[0]);await money(before,'recovered denial creates no reservation or debit');
      check(!modelCounts.get(r.id),'denial recovery never calls the model');check((await log(r.id)).billableState==='not_billable','denied call stays non-billable');if(inspectLedger)check((await inspectLedger(r.id)).length===0,'denied authorization creates no financial ledger entry');
    }
    {
      const r=rule('crash'),before=await quota(),pending=request(gateways[0],r.id).catch(()=>null);await waitFor(()=>r.authorization,'authorization must commit before crash');await stop(gateways[0]);await pending;await launch(gateways[0]);await released(r.id,before);
    }
    {
      const r=rule('lease');r.recoveryGate=gate();const before=await quota(),response=await request(gateways[0],r.id);check(response.status===503,'lease test loses authorization response');await response.text();
      await rpc('/internal/v1/usage/settlements',{requestId:r.id,idempotencyKey:`${r.id}:lease-expired`,reservationId:r.authorization.reservation.reservationId,outcome:'partial',usageFinal:false,completedAt:new Date().toISOString()});
      r.recoveryGate.release();await released(r.id,before);check((await log(r.id)).usageFinal===true,'late release replaces unknown lease usage with durable no-forward evidence');
    }
    {
      const r=rule('duplicate');r.modelGate=gate();const before=await quota(),original=request(gateways[0],r.id);await waitFor(()=>modelCounts.get(r.id)===1,'original model request must be in flight');
      const duplicate=await request(gateways[1],r.id);check(duplicate.status===503,'second gateway loses replay response');await duplicate.text();await empty(gateways[1]);await money(before-.02,'non-owner recovery must leave the original in-flight hold untouched');
      check(modelCounts.get(r.id)===1,'two gateways forward at most once');r.modelGate.release();const response=await original;check(response.status===200,'original gateway finishes normally');await response.text();await empty(gateways[0]);await money(before-.02,'non-owner never refunds the original billed request');check((await log(r.id)).billableState==='confirmed','original call remains billable');
    }
    {
      const r=rule('legacy');r.hideOwner=true;const before=await quota(),response=await request(gateways[0],r.id);check(response.status===503,'legacy response loss is not forwarded');await response.text();
      await waitFor(async()=>(await health(gateways[0])).outbox.authorizationBlocked===1,'ownerless intent must block visibly');await money(before-.02,'ownerless response does not automatically release funds');
      const path=`${gateways[0].base}/internal/v1/outbox`,inspected=await fetch(`${path}?requestId=${r.id}`,{headers}).then(response=>response.json()),item=inspected.items[0];check(item.errorCode==='authorization_owner_unverified','operator receives an explicit ownership diagnostic');
      check(!/identity|credential|requestFingerprint|modelId/.test(JSON.stringify(item)),'inspection redacts authorization payload');
      r.hideOwner=false;
      const retry=await fetch(`${path}/retry`,{method:'POST',headers,body:JSON.stringify({requestId:r.id,admissionAttemptId:item.admissionAttemptId,reason:'恢复归属契约后按原意图重试'})});check(retry.status===200,'manual authorization recovery uses the exact attempt ID');await retry.text();await released(r.id,before);
    }
    {
      const r=rule('settlement_drop'),before=await quota(),response=await request(gateways[0],r.id);check(response.status===503,'lost settlement acknowledgement leaves durable backlog');await response.text();await empty(gateways[0]);
      await money(before-.02,'settlement acknowledgement loss charges once');check(modelCounts.get(r.id)===1,'settlement recovery never repeats model generation');check(settlementBodies.get(r.id).length>=2,'original settlement is retried');check(JSON.stringify(settlementBodies.get(r.id)[0])===JSON.stringify(settlementBodies.get(r.id)[1]),'settlement retry preserves its immutable payload');if(inspectLedger)check((await inspectLedger(r.id)).length===1,'lost settlement reply writes one ledger entry');
    }
    console.log(`PASS ${assertions} authorization ownership/recovery assertions (actual gateway/control-plane, local response-loss proxy)`);return assertions;
  }finally{
    for(const r of rules.values()){r.recoveryGate?.release();r.modelGate?.release();}
    for(const gateway of gateways)if(gateway.child)await stop(gateway);
    for(const server of servers)server.closeAllConnections();await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));
  }
}
