import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SettlementJournal } from '../services/gateway-sim/dist/journal.js';

export async function checkMetered({cp,gw,model,admin,employeeCookie,managerCookie,employee,manager,key,request,state,command,start,freePort,runtimeDirectory,expireReservation,inspectLedger}){
  let assertions=0;const check=(condition,message)=>{assert.ok(condition,message);assertions++;};
  const close=(actual,expected,message)=>check(Math.abs(actual-expected)<1e-8,`${message}: ${actual} != ${expected}`);
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const headers={authorization:'Bearer local-service-token','content-type':'application/json'};
  const initial=await state(admin);let service=initial.services[0];
  async function configure({prices=[2,3,0.5],limits={mode:'inherit'},upstreamModel='mapped-upstream',baseUrl=model}={}){
    service=(await command(admin,'save.service',{...service,baseUrl,limits,mappings:[{...service.mappings[0],upstreamModel,inputPrice:prices[0],outputPrice:prices[1],cachedInputPrice:prices[2]}]})).result;
    if(service.verification!=='passed'){const verification=await request(`/api/v1/platform/services/${service.id}/verify`,{},admin);check(verification.body.verification==='passed','configured alias source is HTTP-verified');service=verification.body;}
  }
  async function internal(path,body){const r=await fetch(`${cp}${path}`,{method:'POST',headers,body:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
  async function logs(){return (await state(admin)).callLogs;}
  async function waitLog(id){for(let i=0;i<100;i++){const log=(await logs()).find(c=>c.requestId===id);if(log)return log;await pause(80);}throw new Error(`metered log missing: ${id}`);}
  async function upstreamRequests(id){const r=await fetch(`${model}/_test/requests`);return (await r.json()).filter(entry=>entry.requestId===id);}
  function gatewayRequest({base=gw,apiKey=key.secret,id=`metered-${randomUUID()}`,scenario,stream=false,tools,signal}={}){
    return {id,promise:fetch(`${base}/v1/chat/completions`,{method:'POST',signal,headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json','x-request-id':id,'idempotency-key':id},body:JSON.stringify({model:'test-model',messages:[{role:'user',content:'metered isolated check'}],max_tokens:32,stream,test_scenario:scenario,tools})})};
  }
  await configure({baseUrl:`${model}/v1`});
  const quote=await request('/api/v1/platform/quote',{purpose:'personal',model:'test-model',messages:[{role:'user',content:'quote'}],max_tokens:32},employeeCookie);
  check(quote.body.decision==='allow'&&quote.body.reservedAmount>0,'quote uses configured prices before any key request');
  const overLimitId=`output-limit-${randomUUID()}`,overLimitBody={model:'test-model',messages:[{role:'user',content:'limit diagnostic'}],max_completion_tokens:1000000};
  const limitHeaders={authorization:`Bearer ${key.secret}`,'content-type':'application/json','x-request-id':overLimitId,'idempotency-key':overLimitId};
  const limitResponse=await fetch(`${gw}/v1/chat/completions`,{method:'POST',headers:limitHeaders,body:JSON.stringify(overLimitBody)}),limitValue=await limitResponse.json();
  check(limitResponse.status===400&&limitValue.error.code==='request_limit_exceeded','output bounds have a dedicated refusal');
  const limits=limitValue.error.details.requestLimits;
  check(limits.requestedOutputTokens===1000000&&limits.allowedOutputTokens>0&&limits.allowedOutputTokens<1000000&&limits.limitSources.length>0,'public refusal explains request, allowance and sources');
  check(!/baseUrl|credentialRef|UPSTREAM_/.test(JSON.stringify(limits)),'public limit details contain no connection metadata');
  const repeatLimit=await fetch(`${gw}/v1/chat/completions`,{method:'POST',headers:limitHeaders,body:JSON.stringify(overLimitBody)});
  assert.deepEqual((await repeatLimit.json()).error.details.requestLimits,limits,'stored refusal replays the same limit evidence');assertions++;
  const refusedLog=await waitLog(overLimitId);check(refusedLog.forwarded===false&&refusedLog.billableState==='not_billable'&&refusedLog.actualAmount===0&&(await upstreamRequests(overLimitId)).length===0,'limit refusal neither reserves billable usage nor forwards');
  const limitQuote=await request('/api/v1/platform/quote',{purpose:'personal',...overLimitBody},employeeCookie);
  check(limitQuote.body.reasonCode==='request_limit_exceeded'&&limitQuote.body.requestLimits.allowedOutputTokens===limits.allowedOutputTokens,'quote and gateway expose the same effective output allowance');
  const call=gatewayRequest({scenario:'cached'}),response=await call.promise,value=await response.json();
  check(response.status===200&&value.model==='test-model','configured logical model returned');
  const upstream=await upstreamRequests(call.id);check(upstream.length===1&&upstream[0].model==='mapped-upstream'&&upstream[0].maxOutput===32,'gateway used the selected upstream mapping and output allowance');
  const log=await waitLog(call.id);close(log.actualAmount,0.000062,'trusted price uses cached input as a subset');check(log.admission.price.inputPrice===2,'price snapshot retained in call log');
  check(!('baseUrl'in log.admission.route)&&!('credentialRef'in log.admission.route),'public log excludes upstream connection and credential reference');

  const identity={subjectType:'employee',subjectId:employee.id,credentialId:key.key.credentialId,organizationId:'org-demo',projectId:null};
  const pinnedId=`pinned-${randomUUID()}`;
  const admitted=await internal('/internal/v1/policy/authorize',{requestId:pinnedId,idempotencyKey:pinnedId,identity,purpose:'personal',modelId:'test-model',mode:'chat',estimatedInputTokens:100,maxOutputTokens:32,policyVersion:'metered-check'});
  check(admitted.body.decision==='allow','old price reservation authorized');
  await configure({prices:[9,10,1],upstreamModel:'mapped-upstream-v2'});
  const settled=await internal('/internal/v1/usage/settlements',{requestId:pinnedId,idempotencyKey:`settle-${pinnedId}`,reservationId:admitted.body.reservation.reservationId,outcome:'completed',inputTokens:13,outputTokens:14,cachedInputTokens:4,usageFinal:true,actualAmount:999,completedAt:new Date().toISOString()});
  check(settled.body.status==='settled','settlement accepts frozen authoritative calculation');close((await waitLog(pinnedId)).actualAmount,0.000062,'price changes and supplied amount cannot rewrite old reservation');
  const staleId=`stale-${randomUUID()}`;
  const stale=await fetch(`${gw}/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${key.secret}`,'content-type':'application/json','x-request-id':staleId,'idempotency-key':staleId,'x-price-version':quote.body.price.version},body:JSON.stringify({model:'test-model',messages:[],max_tokens:32})});
  check(stale.status===403&&(await stale.json()).error.code==='policy_stale','online price pin fails closed after a price change');check((await upstreamRequests(staleId)).length===0,'stale quote never reaches upstream');
  const tools=[{type:'function',function:{name:'local_weather',description:'local contract fixture',parameters:{type:'object',properties:{city:{type:'string'}}}}}];
  const tool=gatewayRequest({tools}),toolResponse=await tool.promise,toolValue=await toolResponse.json();
  check(toolValue.choices[0].message.tool_calls[0].function.arguments==='{"city":"Shanghai"}','non-stream tool call payload preserved');
  const streamTool=gatewayRequest({tools,stream:true}),streamToolResponse=await streamTool.promise,streamText=await streamToolResponse.text();
  check(streamText.includes('tool_calls')&&streamText.includes('local_weather')&&streamText.includes('[DONE]'),'streamed tool call and completion marker preserved');
  check(!streamText.includes('mapped-upstream-v2'),'streamed model metadata uses the logical identifier');

  // A service now belongs to one pool. A second entitlement/subject must reuse that owner pool.
  const pool=(await state(admin)).pools.find(p=>p.entries.some(e=>e.serviceId===service.id));assert.ok(pool,'service owner pool exists');
  const plan=(await command(admin,'save.plan',{name:'第二用途方案',range:{poolId:pool.id,mode:'follow',definitionIds:[]},amount:20,cadence:'once',quotaDays:30,entitlementDays:365})).result;
  await command(admin,'distribution.execute',{planId:plan.id,memberIds:[manager.id]});
  const managerKey=(await command(managerCookie,'key.issue',{name:'第二用途调用',purpose:'personal'})).result;
  await configure({limits:{mode:'custom',concurrency:1,rpm:100,maxOutputTokens:128}});
  // Hold an explicit admission until the competing gateway call ends. A 600 ms upstream
  // timeout is not a stable overlap barrier when control-plane requests cross a remote DB.
  const resolved=await internal('/internal/v1/policy/credentials/resolve',{apiKey:key.secret});
  const holdId=`shared-capacity-${randomUUID()}`,holdInput={requestId:holdId,idempotencyKey:holdId,identity:resolved.body.identity,purpose:'personal',modelId:'test-model',mode:'chat',estimatedInputTokens:100,maxOutputTokens:32,policyVersion:'shared-capacity-check'};
  const capacityHold=await internal('/internal/v1/policy/authorize',holdInput);check(capacityHold.status===200&&capacityHold.body.decision==='allow','explicit service-capacity admission is held until test release');
  const shared=gatewayRequest({apiKey:managerKey.secret}),sharedResponse=await shared.promise;
  const sharedBody=await sharedResponse.json();check(sharedResponse.status===429&&sharedBody.error.code==='rate_limited',`different entitlements and subjects share their service concurrency (HTTP ${sharedResponse.status})`);
  check((await upstreamRequests(shared.id)).length===0,'shared-capacity denial happens before inference');
  const released=await internal('/internal/v1/usage/settlements',{requestId:holdId,idempotencyKey:`${holdId}:release`,reservationId:capacityHold.body.reservation.reservationId,outcome:'rejected_before_upstream',forwarded:false,usageFinal:true,inputTokens:0,outputTokens:0,completedAt:new Date().toISOString()});check(released.body.status==='released','undispatched test admission is released explicitly');
  const abort=new AbortController(),held=gatewayRequest({stream:true,scenario:'cancel',signal:abort.signal}),heldResponse=await held.promise;
  const reader=heldResponse.body.getReader();await reader.read();abort.abort();try{await reader.cancel();}catch{}
  check((await waitLog(held.id)).billableState==='pending_review','interrupted priced generation retains its unknown hold');
  await configure({limits:{mode:'custom',tpm:20,maxOutputTokens:128}});
  const tpm=gatewayRequest(),tpmResponse=await tpm.promise;check(tpmResponse.status===429&&(await tpmResponse.json()).error.code==='rate_limited','TPM reserves estimated input plus output cap');
  await configure({prices:[2,null,0.5]});
  const unknown=gatewayRequest(),unknownResponse=await unknown.promise;check(unknownResponse.status===503&&(await unknownResponse.json()).error.code==='price_unconfigured','unknown price is not interpreted as free');
  await configure({prices:[0,0,0]});
  const free=gatewayRequest(),freeResponse=await free.promise;await freeResponse.text();close((await waitLog(free.id)).actualAmount,0,'explicit free price never falls back to the legacy fixed fee');
  await configure();

  const reviewPayload={requestId:held.id,mode:'confirm_usage',inputTokens:13,outputTokens:14,cachedInputTokens:0,reason:'已核对本地替身完整用量记录'},reviewKey=randomUUID();
  const deniedReview=await request('/api/v1/platform/preview',{type:'usage.reconcile',idempotencyKey:reviewKey,payload:reviewPayload},employeeCookie);check(deniedReview.status===403,'employees cannot reconcile their own charges');
  await command(admin,'usage.reconcile',reviewPayload,reviewKey);
  const reviewed=await waitLog(held.id);check(reviewed.billableState==='confirmed'&&reviewed.usageFinal,'operator review marks complete usage separately from interrupted outcome');close(reviewed.actualAmount,0.000068,'review uses original frozen pricing');
  const reviewReplay=await request('/api/v1/platform/commands',{type:'usage.reconcile',idempotencyKey:reviewKey,payload:reviewPayload},admin);check(reviewReplay.status===200&&reviewReplay.body.replayed,'repeated review command cannot double-charge or double-refund');
  const sparePlan=(await command(admin,'save.plan',{name:'核对隔离资金来源',range:{poolId:'pool-local-test',mode:'follow',definitionIds:[]},amount:10000,cadence:'once',quotaDays:30,entitlementDays:365})).result;
  await command(admin,'distribution.execute',{planId:sparePlan.id,memberIds:[employee.id]});
  const overId=`overrun-${randomUUID()}`,over=await internal('/internal/v1/policy/authorize',{requestId:overId,idempotencyKey:overId,identity,purpose:'personal',modelId:'test-model',mode:'chat',estimatedInputTokens:100,maxOutputTokens:32,policyVersion:'metered-check'});
  check(over.body.decision==='allow','overrun review binds one original batch');
  const beforeOver=(await state(admin)).quotaBatches.find(b=>b.id===over.body.reservation.sourceId).availableAmount;
  await internal('/internal/v1/usage/settlements',{requestId:overId,idempotencyKey:`${overId}:settlement`,reservationId:over.body.reservation.reservationId,outcome:'completed',inputTokens:1000000000,outputTokens:1000000000,cachedInputTokens:0,usageFinal:true,completedAt:new Date().toISOString()});
  const overCommand={type:'usage.reconcile',idempotencyKey:randomUUID(),payload:{requestId:overId,mode:'confirm_usage',inputTokens:1000000000,outputTokens:1000000000,cachedInputTokens:0,reason:'验证禁止从其他来源补扣'}};
  const overPreview=await request('/api/v1/platform/preview',overCommand,admin);
  const overReview=await request('/api/v1/platform/commands',{...overCommand,previewToken:overPreview.body.previewToken},admin);check(overReview.status===409,'review never borrows from another funded entitlement');
  close((await state(admin)).quotaBatches.find(b=>b.id===over.body.reservation.sourceId).availableAmount,beforeOver,'failed review leaves original hold unchanged');
  await command(admin,'usage.reconcile',{requestId:overId,mode:'release_hold',reason:'隔离验收明确确认不计费'});
  check((await waitLog(overId)).billableState==='not_billable','explicit review release remains distinct from unknown usage');
  close((await state(admin)).quotaBatches.find(b=>b.id===over.body.reservation.sourceId).availableAmount,beforeOver+over.body.reservation.reservedAmount,'release restores only the original hold');
  const beforeMaintenance=(await state(admin)).revision;
  const noOp=await request('/api/v1/platform/maintenance/run',{},admin);check(noOp.status===200&&noOp.body.issued===0,'monthly maintenance does not reissue an existing current cycle');check((await state(admin)).revision===beforeMaintenance,'no-op maintenance does not invalidate policy previews');
  if(expireReservation){
    const expiredId=`expired-${randomUUID()}`,expired=await internal('/internal/v1/policy/authorize',{requestId:expiredId,idempotencyKey:expiredId,identity,purpose:'personal',modelId:'test-model',mode:'chat',estimatedInputTokens:100,maxOutputTokens:32,policyVersion:'metered-check'});
    const renewed=await internal('/internal/v1/usage/leases/renew',{requestId:expiredId,reservationId:expired.body.reservation.reservationId});check(renewed.body.renewed,'live reservation lease can be renewed');
    await expireReservation(expiredId);const swept=await request('/api/v1/platform/maintenance/run',{},admin);check(swept.status===200&&swept.body.expired>=1,'expired unknown reservations become explicit review records');
    check((await waitLog(expiredId)).billableState==='pending_review','expiry does not release unknown cost');
    const lateEvent={requestId:expiredId,idempotencyKey:`${expiredId}:settlement`,reservationId:expired.body.reservation.reservationId,outcome:'completed',usageFinal:true,inputTokens:13,outputTokens:14,cachedInputTokens:4,completedAt:new Date().toISOString()};
    const late=await internal('/internal/v1/usage/settlements',lateEvent);check(late.status===200&&late.body.status==='settled','late complete usage automatically resolves an expiry review');close((await waitLog(expiredId)).actualAmount,0.000062,'late replay still uses the original price');
    check((await internal('/internal/v1/usage/settlements',lateEvent)).body.status==='already_finalized','late replay remains exactly-once');
    const financial=await inspectLedger(expiredId);check(financial.length===1&&financial[0].kind==='reconciliation'&&financial[0].actor==='system:data-plane-recovery','automatic recovery writes a durable attributed ledger entry');
  }

  let outage=true;
  const proxy=createServer(async(req,res)=>{
    if(outage&&req.url==='/internal/v1/usage/settlements'){res.writeHead(503,{'content-type':'application/json'});res.end('{"message":"isolated settlement outage"}');return;}
    try{const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);const r=await fetch(`${cp}${req.url}`,{method:req.method,headers:{authorization:req.headers.authorization??'','content-type':'application/json'},body:body.length?body:undefined});res.writeHead(r.status,{'content-type':'application/json'});res.end(await r.text());}catch{res.writeHead(503,{'content-type':'application/json'});res.end('{}');}
  });
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));const proxyUrl=`http://127.0.0.1:${proxy.address().port}`;
  const gatewayPort=await freePort(),base=`http://127.0.0.1:${gatewayPort}`,directory=resolve(runtimeDirectory,'metered-recovery');
  let gateway;
  async function launch(){gateway=start('services/gateway-sim/dist/server.js',{PORT:String(gatewayPort),CONTROL_PLANE_URL:proxyUrl,MODEL_URL:'http://127.0.0.1:1',SERVICE_TOKEN:'local-service-token',UPSTREAM_TIMEOUT_MS:'10000',GATEWAY_JOURNAL_DIR:directory});for(let i=0;i<100;i++){try{if((await fetch(`${base}/health`)).ok)return;}catch{}if(gateway.exitCode!==null)throw new Error(gateway.diagnostic());await pause(80);}throw new Error('recovery gateway did not start');}
  async function stop(){if(gateway.exitCode===null){gateway.kill();await new Promise(resolve=>gateway.once('exit',resolve));}}
  try{
    await launch();const durable=gatewayRequest({base,scenario:'cached'}),durableResponse=await durable.promise;check(durableResponse.status===503,'final settlement outage is visible to caller');await durableResponse.text();
    check((await fetch(`${base}/health`).then(r=>r.json())).outbox.queued===1,'failed usage event is durable and queued');
    const files=(await readdir(directory)).filter(file=>file.endsWith('.json'));const eventText=await readFile(resolve(directory,files[0]),'utf8');
    check(!eventText.includes(key.secret)&&!eventText.includes('metered isolated check'),'journal contains no API key or prompt text');
    await stop();outage=false;await launch();
    close((await waitLog(durable.id)).actualAmount,0.000062,'restart replays captured usage with frozen price');
    check((await upstreamRequests(durable.id)).length===1,'usage replay does not repeat inference');
    const repeat=gatewayRequest({base,scenario:'cached',id:durable.id}),repeatResponse=await repeat.promise;check(repeatResponse.status===409,'restart still rejects repeated forwarding of the same authorization');await repeatResponse.text();
    const crash=gatewayRequest({base,stream:true,scenario:'cancel'}),crashResponse=await crash.promise,crashReader=crashResponse.body.getReader();await crashReader.read();await stop();try{await crashReader.read();}catch{}
    await launch();check((await waitLog(crash.id)).billableState==='pending_review','crash after dispatch retains unknown usage for review');check((await upstreamRequests(crash.id)).length===1,'dispatch recovery does not rerun upstream');
    await stop();
    const admittedId=`not-dispatched-${randomUUID()}`,notDispatched=await internal('/internal/v1/policy/authorize',{requestId:admittedId,idempotencyKey:admittedId,identity,purpose:'personal',modelId:'test-model',mode:'chat',estimatedInputTokens:100,maxOutputTokens:32,policyVersion:'metered-check'});
    check(notDispatched.body.decision==='allow','pre-dispatch recovery reservation created');
    const journal=new SettlementJournal(directory);await journal.initialize(async()=>503);await journal.admitted({requestId:admittedId,idempotencyKey:`${admittedId}:settlement`,reservationId:notDispatched.body.reservation.reservationId,outcome:'rejected_before_upstream',usageFinal:true,inputTokens:0,outputTokens:0,cachedInputTokens:0,completedAt:new Date().toISOString()});await journal.close();
    await launch();const released=await waitLog(admittedId);check(released.billableState==='not_billable'&&released.outcome==='rejected_before_upstream','restart releases only durably undispatched admission');check((await upstreamRequests(admittedId)).length===0,'undispatched recovery never invokes upstream');
  }finally{await stop();proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}
  const archiveId=`archive-review-${randomUUID()}`,archive=await internal('/internal/v1/policy/authorize',{requestId:archiveId,idempotencyKey:archiveId,identity,purpose:'personal',modelId:'test-model',mode:'chat',estimatedInputTokens:100,maxOutputTokens:32,policyVersion:'metered-check'});
  check(archive.body.decision==='allow','historical pending-review fixture is authorized');
  // A synthetic historical event must be inside a closed minute even when the
  // in-memory check finishes in the current minute. No clock wait or inference.
  const historicalCompletedAt=new Date((Math.floor(Date.now()/60000)-2)*60000).toISOString();
  await internal('/internal/v1/usage/settlements',{requestId:archiveId,idempotencyKey:`${archiveId}:settlement`,reservationId:archive.body.reservation.reservationId,outcome:'partial',forwarded:true,usageFinal:false,completedAt:historicalCompletedAt});
  const deniedModel=`query-denied-${randomUUID()}`;
  const deniedInput=n=>({requestId:`query-${deniedModel}-${n}`,idempotencyKey:`query-${deniedModel}-${n}`,identity,purpose:'personal',modelId:deniedModel,mode:'chat',policyVersion:'metered-check'});
  for(let offset=0;offset<210;offset+=10){
    const results=await Promise.all(Array.from({length:10},(_,n)=>internal('/internal/v1/policy/authorize',deniedInput(offset+n))));
    const unexpected=results.flatMap((r,index)=>r.status===200&&r.body.decision==='deny'?[]:[{index:offset+index,status:r.status,decision:['allow','deny'].includes(r.body.decision)?r.body.decision:null,reason:typeof r.body.reasonCode==='string'?r.body.reasonCode.slice(0,80):null}]);
    assert.equal(unexpected.length,0,`refused-call fixture batch returned unexpected status/decision: ${JSON.stringify(unexpected)}`);
  }
  const replayDenial=await internal('/internal/v1/policy/authorize',deniedInput(0));check(replayDenial.body.replayed===true,'a policy refusal is immutable for that attempt and replays without another log');
  const first=await request('/api/v1/platform/calls/query',{modelId:deniedModel,limit:113},employeeCookie);
  const second=await request('/api/v1/platform/calls/query',{modelId:deniedModel,limit:113,cursor:first.body.nextCursor},employeeCookie);
  check(first.status===200&&first.body.items.length===113&&second.body.items.length===97&&!second.body.nextCursor,'SQL and memory keysets retrieve every historical request beyond 200');
  check(new Set([...first.body.items,...second.body.items].map(c=>c.requestId)).size===210,'keyset pages contain no repeated attempts');
  check(first.body.summary.ended===210&&first.body.summary.forwarded===0&&first.body.summary.upstreamFailures===0&&first.body.summary.rejected===210,'refusals are included in request denominator and excluded from upstream denominator');
  check(first.body.items.every(c=>c.errorCode&&c.billableState==='not_billable'&&c.actualAmount===0),'policy refusal logs retain reason and confirmed non-billable state');
  const hidden=await request('/api/v1/platform/calls/query',{subjectId:manager.id,scope:null},employeeCookie);
  check(hidden.body.items.length===0&&hidden.body.summary.ended===0,'employee filters and fake scope cannot expand access or leak counts');
  const old=await request('/api/v1/platform/calls/query',{requestId:call.id},employeeCookie);
  check(old.body.items.length===1&&old.body.items[0].requestId===call.id,'employee can retrieve their old request beyond the global recent list');
  check(!(await state(admin)).callLogs.some(c=>c.requestId===archiveId),'historical pending request is outside snapshot recent 200');
  const oldPending=await request('/api/v1/platform/calls/query',{billableState:'pending_review',requestId:archiveId},admin);
  check(oldPending.body.items.length===1&&oldPending.body.summary.unknownUsage===1,'pending review query includes old holds and marks unknown usage');
  check((await request('/api/v1/platform/calls/query',{limit:201},admin)).status===400,'oversized query pages are rejected');
  check((await request('/api/v1/platform/calls/query',{cursor:'broken-cursor'},admin)).status===400,'invalid page cursor is rejected');
  const breakdown=await request('/api/v1/platform/calls/errors',{modelId:deniedModel,limit:50},admin);
  check(breakdown.status===200&&breakdown.body.ended===210&&breakdown.body.errors===210&&breakdown.body.cancelled===0,'reason breakdown counts the same window and denominator as the call list');
  check(breakdown.body.buckets.reduce((n,b)=>n+b.calls,0)===breakdown.body.errors+breakdown.body.cancelled,'reason buckets sum to errors plus separately reported cancellations');
  const bucket=breakdown.body.buckets[0];
  const drill=await request('/api/v1/platform/calls/query',{modelId:deniedModel,outcome:bucket.outcome,limit:200,...(bucket.serviceId?{serviceId:bucket.serviceId}:{serviceMissing:'true'}),...(bucket.errorCode?{errorCode:bucket.errorCode}:{errorCodeMissing:'true'})},admin);
  check(drill.body.summary.ended===bucket.calls,`drilling a reason returns exactly the ${bucket.calls} calls the row counted`);
  const hiddenBreakdown=await request('/api/v1/platform/calls/errors',{subjectId:manager.id,scope:null},employeeCookie);
  check(hiddenBreakdown.body.ended===0&&hiddenBreakdown.body.buckets.length===0,'employee reason breakdown cannot expand scope or leak counts');
  check((await request('/api/v1/platform/calls/errors',{errorCode:'x',errorCodeMissing:'true'},admin)).status===400,'contradictory reason filters are rejected');
  check((await request('/api/v1/platform/calls/errors',{limit:201},admin)).status===400,'oversized reason bucket limits are rejected');
  check((await request('/api/v1/platform/monitoring',undefined,employeeCookie)).status===403,'monitoring is restricted to operators');
  const monitor=await request('/api/v1/platform/monitoring',undefined,admin),total=monitor.body.rows.find(r=>r.modelId==='*'),source=monitor.body.rows.find(r=>r.serviceId===service.id&&r.modelId==='test-model');
  check(monitor.status===200&&monitor.body.quality==='collected'&&total.summary.ended>=210,'monitoring summarizes persisted attempts without the recent-200 truncation');
  check(source.summary.ttftSamples>0&&source.summary.p95TtftMs>=0,'stream TTFT samples are recorded separately from full request latency');
  check(source.summary.rateLimited>0&&source.summary.upstreamFailures<=source.summary.forwarded,'monitoring keeps limit refusals separate from upstream-failure denominator');
  const rule=(await command(admin,'save.alert-rule',{name:'隔离检查请求错误率',metric:'request_error_rate',windowMinutes:60,threshold:1,minSamples:1,triggerCount:1,recoveryThreshold:0.5,recoveryCount:2})).result;
  let maintained=await request('/api/v1/platform/maintenance/run',{},admin);
  check(maintained.status===200,`maintenance completes: ${JSON.stringify(maintained.body)}`);
  let evaluated=await request('/api/v1/platform/monitoring',undefined,admin);
  // A manual request can join a background tick that sampled before this rule
  // was saved. Once that tick completes, a new tick must observe the new rule.
  if(!evaluated.body.evaluations[rule.id]){
    maintained=await request('/api/v1/platform/maintenance/run',{},admin);
    check(maintained.status===200,`new-rule maintenance completes: ${JSON.stringify(maintained.body)}`);
    evaluated=await request('/api/v1/platform/monitoring',undefined,admin);
  }
  check(evaluated.body.evaluations[rule.id]?.reading.to.endsWith(':00.000Z'),'maintenance evaluates a closed minute window');
  const denyRule=await request('/api/v1/platform/commands',{type:'save.alert-rule',idempotencyKey:randomUUID(),payload:{...rule,name:'forbidden'}},employeeCookie);check(denyRule.status===403,'employees cannot change alert thresholds');
  const event=evaluated.body.events.find(e=>e.ruleId===rule.id&&e.status==='active');
  check(event,'closed-minute historical failure must produce an active alert instead of skipping acknowledgement checks');
  await command(admin,'alert.ack',{id:event.id});const acknowledged=await request('/api/v1/platform/monitoring',undefined,admin);
  check(acknowledged.body.events.find(e=>e.id===event.id).acknowledgedBy===initial.actor.id&&acknowledged.body.events.find(e=>e.id===event.id).status==='active','acknowledgement records the operator without recovering the fault');
  check((await state(admin)).notifications.some(n=>n.objectType==='alert'&&n.objectId===event.id),'active event produces a linked site notification');
  console.log(`PASS ${assertions} routing, price, limits, queries, monitoring and recovery assertions`);
  return assertions;
}
