import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function runStabilityChecks(ctx){
 const {id,schema,db,hg,gw,input,service,range,report,check,api,ok,state,command,sync,call,waitLog,pause,duration,secrets,databaseProxy,stopControl,startControl,controlAlive}=ctx;
 const requests=()=>fetch(hg.model+'/_poc/requests').then(r=>r.json());
 const health=()=>fetch(gw+'/health').then(r=>r.json());
 async function until(work,label,timeout=30000){const end=Date.now()+timeout;let last;do{try{const value=await work();if(value)return value;}catch(error){last=error;}await pause(200);}while(Date.now()<end);throw Error(label+(last?': '+last.message:''));}
 async function drain(reader,first){const chunks=first?.value?[first.value]:[];for(;;){const chunk=await reader.read();if(chunk.done)break;chunks.push(chunk.value);}return Buffer.concat(chunks).toString();}
 const release=requestId=>fetch(hg.model+'/_poc/release/'+requestId,{method:'POST',headers:{authorization:`Bearer ${hg.state.modelToken}`}});
 const ledgerCount=async requestId=>Number((await db.query(`select count(*) as count from "${schema}".usage_ledger_entries where request_id=$1 and kind='settlement'`,[requestId])).rows[0].count);
 report.faults={};

 console.log('CHECK real 35-second stream through Higress');
 if(ctx.onlyCase!=='route-change'){
 const long=call({stream:true,scenario:'POC_LONG_STREAM'}),longResponse=await long.promise,longReader=longResponse.body.getReader(),longFirst=await longReader.read(),longBegan=performance.now();
 const longRaw=await drain(longReader,longFirst),longDuration=performance.now()-longBegan;
 check(longResponse.ok&&longRaw.includes('data: [DONE]')&&longDuration>=34000,'Higress preserves a continuously active 35-second stream');
 check((await waitLog(long.requestId)).billableState==='confirmed','long stream settles final authoritative usage once');report.longStream={durationMs:Math.round(longDuration),model:'deterministic local HTTP fixture',inference:false};
 }

 console.log('CHECK route and price change while a stream is in flight');
 const inflight=call({stream:true,scenario:'POC_CONFIG_HOLD'}),inflightResponse=await inflight.promise,inflightReader=inflightResponse.body.getReader(),inflightFirst=await inflightReader.read();
 await command('save.service',{...service,mappings:[{...service.mappings[0],upstreamModel:'physical-model-v2',inputPrice:3,outputPrice:9,cachedInputPrice:1}]});
 check((await ok(`/api/v1/platform/services/${service.id}/verify`,{})).verification==='passed','replacement route is verified independently of an existing stream');
 await release(inflight.requestId);await drain(inflightReader,inflightFirst);const previous=await waitLog(inflight.requestId);
  const following=call(),followingResponse=await following.promise,followingBody=await followingResponse.text(),replacement=await waitLog(following.requestId);
  report.faults.routeChange={status:followingResponse.status,body:followingBody,transportErrors:await fetch(hg.model+'/_poc/transport-errors').then(r=>r.json()),old:{amount:previous.actualAmount,route:previous.admission?.route,price:previous.admission?.price},current:{amount:replacement.actualAmount,route:replacement.admission?.route,price:replacement.admission?.price,state:replacement.billableState,errorCode:replacement.errorCode}};
 check(previous.admission.route.upstreamModel==='physical-model'&&Math.abs(previous.actualAmount-.000132)<1e-9,'in-flight request retains its original physical model and price');
 check(followingResponse.ok&&replacement.admission.route.upstreamModel==='physical-model-v2'&&Math.abs(replacement.actualAmount-.000157)<1e-9,'new admissions use the replacement model and new price');
 const mapped=await requests();check(mapped.find(r=>r.requestId===inflight.requestId)?.model==='physical-model'&&mapped.find(r=>r.requestId===following.requestId)?.model==='physical-model-v2','actual model observations match both immutable route versions');
 await command('save.service',service);check((await ok(`/api/v1/platform/services/${service.id}/verify`,{})).verification==='passed','original route is restored after in-flight configuration test');
  if(ctx.onlyCase==='route-change')return;

 console.log('CHECK PostgreSQL TCP outage and durable settlement recovery');
 const dbCall=call({stream:true,scenario:'POC_CONFIG_HOLD'}),dbResponse=await dbCall.promise,dbReader=dbResponse.body.getReader(),dbFirst=await dbReader.read();
 databaseProxy.block();await release(dbCall.requestId);await drain(dbReader,dbFirst);
 await until(async()=>{const value=await health();return value.outbox.queued>0;},'database outage did not queue usage');check(controlAlive(),'a broken PostgreSQL connection does not crash the control plane');
 check((await api('/api/v1/platform/state')).response.status>=500,'control-plane queries fail visibly while its PostgreSQL path is disconnected');
 report.faults.database=databaseProxy.snapshot();databaseProxy.restore();
 const recovered=await until(async()=>{const log=await waitLog(dbCall.requestId);return log.billableState==='confirmed'?log:null;},'database recovery did not settle usage');
 check(Math.abs(recovered.actualAmount-.000132)<1e-9&&await ledgerCount(dbCall.requestId)===1,'database recovery writes exactly one original-price settlement');
 check((await requests()).filter(r=>r.requestId===dbCall.requestId).length===1,'database recovery never repeats model generation');
 await until(async()=>{const value=await health();return !value.outbox.queued&&!value.outbox.blocked&&!value.outbox.writePending;},'database recovery left outbox entries');

 console.log('CHECK Higress interruption of an admitted stream and runtime restart');
 const broken=call({stream:true,scenario:'POC_LONG_STREAM'}),brokenResponse=await broken.promise,brokenReader=brokenResponse.body.getReader();await brokenReader.read();
 await hg.run(['stop','--time','1',hg.name+'-management']);await hg.run(['stop','--time','1',hg.name+'-gateway']);try{await drain(brokenReader);}catch{}
 const unknown=await waitLog(broken.requestId);check(unknown.billableState==='pending_review'&&!unknown.usageFinal,'Higress loss preserves unknown in-flight usage as pending review');
 check((await requests()).filter(r=>r.requestId===broken.requestId).length===1,'Higress restart never replays an interrupted generation');
 await hg.run(['start',hg.name+'-gateway']);await hg.run(['start',hg.name+'-management']);
 await until(async()=>{const response=await fetch(hg.api+'/health',{headers:{authorization:`Bearer ${hg.state.apiToken}`},signal:AbortSignal.timeout(1000)});return response.ok;},'management relay did not recover');
 const runtime=await api('/internal/v1/gateway-sync/reconcile',{}, {internal:true});check(runtime.value.routes.every(r=>r.status==='applied'),'reconcile confirms preserved routes after a Higress restart');
 const resumed=call();check((await resumed.promise).ok,'new requests succeed after Higress restart');await waitLog(resumed.requestId);report.faults.higress={interruptedRequest:broken.requestId,billableState:unknown.billableState,recovered:true};

 console.log('CHECK control-plane crash with a pending configuration publication');
 const active=(await db.query(`select payload->'active' as active from "${schema}".gateway_sync_state where resource_id=$1`,[input.resourceId])).rows[0].active;
 await hg.run(['pause',hg.name+'-management']);
 const interrupted=sync({...input,desiredVersion:'interrupted-v4',previousVersion:active.version,idempotencyKey:'interrupted-publication'}).catch(()=>null);
 await until(async()=>{const row=(await db.query(`select payload from "${schema}".gateway_sync_state where resource_id=$1`,[input.resourceId])).rows[0].payload;return row.latest?.desiredVersion==='interrupted-v4'&&row.latest.status==='pending';},'publication intent was not durable',4000);
 await stopControl();await interrupted;await hg.run(['unpause',hg.name+'-management']);
 const pending=(await db.query(`select payload from "${schema}".gateway_sync_state where resource_id=$1`,[input.resourceId])).rows[0].payload;
 for(const operation of Object.values(pending.operations))if(operation.response.status==='pending')operation.leaseUntil=Date.now()-1;
 await db.query(`update "${schema}".gateway_sync_state set payload=$2 where resource_id=$1`,[input.resourceId,pending]);await startControl();
 const expired=(await api('/internal/v1/gateway-sync/'+input.resourceId,undefined,{internal:true})).value;
 check(expired.status==='rejected'&&expired.errorCode==='publication_interrupted','restart recovers the durably pending publication as interrupted after lease expiry');
 const after=await sync({...input,desiredVersion:'recovered-v5',previousVersion:active.version,idempotencyKey:'recovered-publication'});check(after.status==='applied','a new operation can publish after the interrupted lease is recovered');
 report.faults.controlPlane={killedAfterDurablePending:true,leaseExpiry:'test advanced the isolated operation lease after process termination',recovered:true};

 console.log(`CHECK ${duration}s Higress/PostgreSQL soak, 4 users / concurrency 8`);
 await command('settings.update',{limits:{mode:'custom',rpm:100000,tpm:1000000000,concurrency:16,maxOutputTokens:128}});
 const plan=await command('save.plan',{name:'Higress sustained-load plan',range,amount:10,cadence:'once',quotaDays:1,entitlementDays:1}),actors=[];
 for(let index=0;index<4;index++){
  const member=await command('save.member',{name:'Higress load '+index,directoryId:'higress-load-'+index,password:randomUUID(),organizationId:'department-engineering',category:'employee',roles:['employee'],tags:[]});await command('distribution.execute',{planId:plan.id,memberIds:[member.id]});const key=await command('key.issue',{name:'Higress load',purpose:'personal',memberId:member.id});actors.push({id:member.id,secret:key.secret});secrets.push(key.secret);
 }
 const balances=async()=>(await db.query(`select source_id,available_amount from "${schema}".quota_batches where source_id=any($1::text[]) and purpose='personal' order by source_id`,[actors.map(a=>a.id)])).rows;
 const requestLimit=Math.max(2000,duration*20),before=await balances(),started=performance.now(),latencies=[],ids=[],errors={},upstreamBefore=(await requests()).length;let next=0,successful=0,adminReads=0;
 const pulse=setInterval(()=>console.log(`SOAK ${Math.round((performance.now()-started)/1000)}/${duration}s; completed=${successful}; issued=${ids.length}`),30000);
 try{await Promise.all(Array.from({length:8},async()=>{
  while(performance.now()-started<duration*1000&&next<requestLimit){
   const number=next++,actor=actors[number%4],requestId=`soak-${id}-${number}`,began=performance.now();ids.push(requestId);
   try{if(number%24===0){await state();adminReads++;}
    const request=call({apiKey:actor.secret,requestId,stream:number%3===0,scenario:number%3===0?'POC_DELAYED':'POC_BASIC'}),response=await request.promise;await response.text();if(response.ok)successful++;else errors['http_'+response.status]=(errors['http_'+response.status]??0)+1;
   }catch(error){errors[error.name]=(errors[error.name]??0)+1;}
   latencies.push(performance.now()-began);
  }
 }));}finally{clearInterval(pulse);}
 const elapsed=performance.now()-started;
 await until(async()=>Number((await db.query(`select count(*) from "${schema}".call_logs where request_id=any($1::text[])`,[ids])).rows[0].count)===ids.length,'soak log drain incomplete',60000);
 const logs=(await db.query(`select request_id,subject_id,actual_amount,billable_state,usage_final from "${schema}".call_logs where request_id=any($1::text[])`,[ids])).rows,afterBalances=await balances();
 const idSet=new Set(ids),beforeMicros=before.reduce((sum,r)=>sum+Math.round(Number(r.available_amount)*1e6),0),afterMicros=afterBalances.reduce((sum,r)=>sum+Math.round(Number(r.available_amount)*1e6),0),modelRequests=(await requests()).slice(upstreamBefore).filter(r=>idSet.has(r.requestId));
 const counters=(await db.query(`select (select count(*) from "${schema}".usage_ledger_entries where request_id=any($1::text[]) and kind='settlement') as ledger,(select count(*) from "${schema}".reservations where request_id=any($1::text[]) and finalized=false) as unfinished,(select count(*) from "${schema}".reservation_limit_scopes s join "${schema}".reservations r on r.reservation_id=s.reservation_id where r.request_id=any($1::text[]) and s.active=true) as active`,[ids])).rows[0];
 const sorted=[...latencies].sort((a,b)=>a-b),outbox=(await health()).outbox;
 report.soak={durationSeconds:duration,durationMs:Math.round(elapsed),users:4,concurrency:8,requests:ids.length,successful,errors,adminReads,modelRequests:modelRequests.length,ledgerEntries:Number(counters.ledger),unfinished:Number(counters.unfinished),activeScopes:Number(counters.active),chargedMicros:beforeMicros-afterMicros,expectedMicros:ids.length*132,latencyMs:{p50:Math.round(sorted[Math.floor(sorted.length*.5)]),p95:Math.round(sorted[Math.floor(sorted.length*.95)]),max:Math.round(sorted.at(-1))},outbox};
 check(successful===ids.length&&elapsed>=duration*1000,'all requests complete during the requested sustained Higress load');
 check(modelRequests.length===ids.length&&new Set(modelRequests.map(r=>r.requestId)).size===ids.length,'sustained load reaches the model exactly once per request');
 check(logs.every(l=>l.billable_state==='confirmed'&&l.usage_final&&Math.round(Number(l.actual_amount)*1e6)===132)&&Number(counters.ledger)===ids.length,'sustained PostgreSQL usage has one authoritative ledger entry per request');
 check(beforeMicros-afterMicros===ids.length*132,'sustained charges equal original funded-batch deductions exactly');
 for(const actor of actors){const initial=Number(before.find(r=>r.source_id===actor.id).available_amount),final=Number(afterBalances.find(r=>r.source_id===actor.id).available_amount),count=logs.filter(l=>l.subject_id===actor.id).length;check(Math.round((initial-final)*1e6)===count*132,'each sustained-load user spends only its own original funds');}
 check(Number(counters.unfinished)===0&&Number(counters.active)===0,'sustained load leaves no unfinished reservations or active limit scopes');
 check(outbox.queued===0&&outbox.blocked===0&&outbox.writePending===0,'sustained settlement outbox drains after recovery');
}
