import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {randomUUID} from 'node:crypto';
import {mkdir,open,readdir,readFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {checkGuardrail,defaultGuardrailPolicy,modelEndpoint,meteredQuantity,readUpstreamRequestId,type AuthorizeRequest,type AuthorizeResponse,type GuardrailPolicy,type MediaJob,type MediaJobReceipt,type ModelKind,type RouteSnapshot,type SettlementRequest} from '@ai-gateway/contracts';
import type {SettlementJournal} from './journal.js';
import type {RequestTrace} from './request-trace.js';
import {replaceJournalFile} from './journal-file.js';
import {UpstreamDeadline,gatewayTimeouts} from './upstream-timeout.js';
import {readMediaInput,mediaTokenUsage,validMediaResponse} from './media-input.js';
type Credential={identity:AuthorizeRequest['identity'];purpose:AuthorizeRequest['purpose'];guardrailPolicy?:GuardrailPolicy};
type Rpc=<T>(path:string,body:unknown)=>Promise<{status:number;value:T}>;
interface Context {activeUpstreams:Set<AbortController>;rpc:Rpc;journal:SettlementJournal;trace:(r:IncomingMessage)=>RequestTrace|undefined;send:(r:ServerResponse,status:number,value:unknown,origin?:string)=>void;cors:(origin?:string)=>Record<string,string>}
const zero={inputTokens:0,outputTokens:0,cachedInputTokens:0};
export function controlledMediaTarget(route:RouteSnapshot,kind:ModelKind,upstreamId?:string,content=false,managedSecret?:string){
  const url=modelEndpoint(route.baseUrl,kind,route.adapter,route.modalityPaths?.[kind],upstreamId,content),target=new URL(url);
  if(!['127.0.0.1','localhost','[::1]'].includes(target.hostname)&&process.env.ALLOW_UPSTREAM_REQUESTS!=='true')throw Error('external upstream access is disabled');
  const ref=route.credentialRef,secret=route.credential?managedSecret:ref?process.env[ref]:null;
  if(route.credential&&!secret)throw Error('managed upstream credential unavailable');
  if(ref&&(!/^UPSTREAM_[A-Z0-9_]+$/.test(ref)||!secret))throw Error('upstream credential reference is not configured');
  const headers:Record<string,string>=secret?{authorization:`Bearer ${secret}`}:{ };return {url,headers};
}
async function bytes(response:Response,onBytes?:()=>void){const chunks:Uint8Array[]=[];let size=0;const reader=response.body?.getReader();try{if(reader)for(;;){const c=await reader.read();if(c.done)break;onBytes?.();size+=c.value.length;if(size>32*1048576){await reader.cancel();throw Error('upstream response exceeds 32 MiB');}chunks.push(c.value);}}finally{reader?.releaseLock();}return Buffer.concat(chunks);}
function videoState(value:Record<string,unknown>):Pick<MediaJob,'status'|'result'>{
  const v=value.video&&typeof value.video==='object'?value.video as Record<string,unknown>:value;
  const state=String(value.status??(value.video?'completed':'in_progress')).toLowerCase();
  const status=['completed','succeeded','success','done'].includes(state)?'completed':['cancelled','canceled'].includes(state)?'cancelled':['failed','expired'].includes(state)?'failed':['queued','pending','submitted'].includes(state)?'queued':'in_progress';
  const seconds=v.duration??v.seconds??value.duration??value.seconds,url=v.url??(value.content as Record<string,unknown>|undefined)?.video_url;
  return {status,result:{...(typeof seconds==='number'&&Number.isFinite(seconds)&&seconds>=0?{seconds:Number(seconds.toFixed(6))}:{}),...(typeof url==='string'&&/^https?:\/\//.test(url)?{url}:{}),...(typeof value.progress==='number'?{progress:value.progress}:{})}};
}
export class MediaGateway {
  private readonly workerId=randomUUID();private timer:ReturnType<typeof setInterval>|undefined;private running:Promise<void>|undefined;private stopped=false;
  private readonly receipts:string;private workerFailures=0;
  async status(){return {pendingReceipts:(await readdir(this.receipts)).filter(f=>f.endsWith('.json')||f.endsWith('.tmp')).length,workerFailures:this.workerFailures};}
  constructor(private readonly c:Context){this.receipts=join(c.journal.directory,'media-receipts');}
  private async rpc<T>(action:string,body:unknown):Promise<T>{const r=await this.c.rpc<T>('/internal/v1/media/jobs/'+action,body);if(r.status!==200)throw Error('media job persistence unavailable');return r.value;}
  private async credential(request:IncomingMessage){const r=await this.c.rpc<Credential|null>('/internal/v1/policy/credentials/resolve',{apiKey:String(request.headers.authorization??'').replace(/^Bearer\s+/i,'')});if(r.status!==200)throw Error('authorization unavailable');return r.value;}
  private async saveReceipt(receipt:MediaJobReceipt){const path=join(this.receipts,receipt.id+'.json'),temporary=join(this.receipts,receipt.id+'.tmp');const f=await open(temporary,'w',0o600);try{await f.writeFile(JSON.stringify(receipt));await f.sync();}finally{await f.close();}await replaceJournalFile(temporary,path);}
  private async flushReceipts(){for(const file of await readdir(this.receipts)){if(!/^[a-f0-9-]{36}\.(json|tmp)$/.test(file))continue;const path=join(this.receipts,file);try{const receipt=JSON.parse(await readFile(path,'utf8')) as MediaJobReceipt;if(file!==receipt.id+'.json'&&file!==receipt.id+'.tmp')throw Error('invalid receipt');await this.rpc('receipt',receipt);await unlink(path);}catch{/* Durable receipt remains for retry; never resubmit generation. */}}}
  async initialize(){await mkdir(this.receipts,{recursive:true,mode:0o700});await this.flushReceipts();this.timer=setInterval(()=>{if(!this.running&&!this.stopped)this.running=this.tick().catch(()=>{this.workerFailures++;}).finally(()=>{this.running=undefined;});},3000);this.timer.unref();}
  async close(){this.stopped=true;if(this.timer)clearInterval(this.timer);await this.running;}
  private async target(route:RouteSnapshot,kind:ModelKind,requestId:string,reservationId:string,jobId?:string,upstreamId?:string,content=false){
    let secret:string|undefined;
    if(route.credential){
      const result=await this.c.rpc<{secret:string}>('/internal/v1/upstream/resolve',{requestId,reservationId,jobId});
      if(result.status!==200)throw Error('managed upstream credential unavailable');
      secret=result.value.secret;
    }
    return controlledMediaTarget(route,kind,upstreamId,content,secret);
  }
  private async finish(job:MediaJob){
    const priceUnit=job.route.kind==='video'?job.result?.seconds:undefined;
    // Persisted terminal timestamp and result make settlement retries byte-for-byte stable.
    const settlement:SettlementRequest={requestId:job.requestId,idempotencyKey:job.requestId+':media-final',reservationId:job.reservationId,outcome:job.status==='completed'?'completed':job.status==='cancelled'?'client_cancelled':job.errorCode==='video_submission_uncertain'?'partial':'upstream_error',forwarded:true,usageFinal:job.status==='cancelled'?false:job.status==='failed'?job.errorCode!=='video_submission_uncertain':typeof priceUnit==='number',...zero,completedAt:job.finishedAt!,modelId:job.modelId,purpose:job.purpose,subjectId:job.identity.subjectId,errorCode:job.errorCode??undefined};
    // The unit is frozen in the job at admission, not supplied by the polling client.
    if(job.meterUnit){const quantity=job.status==='cancelled'?null:job.status==='failed'?(!job.upstreamId&&job.errorCode!=='video_submission_uncertain'?0:job.meterUnit==='per_second'&&typeof priceUnit==='number'?priceUnit:null):job.meterUnit==='per_request'?1:typeof priceUnit==='number'?priceUnit:null;settlement.usageFinal=quantity!==null&&job.errorCode!=='video_submission_uncertain';if(quantity!==null)settlement.meteredUsage={unit:job.meterUnit,quantity};}
    if(await this.c.journal.finalize(settlement))await this.rpc('update',{id:job.id,status:job.status,result:job.result,errorCode:job.errorCode,settled:true});
  }
  private async tick(){
    await this.flushReceipts();const jobs=await this.rpc<MediaJob[]>('claim',{workerId:this.workerId});
    const results=await Promise.allSettled(jobs.map(async claimed=>{
      const job=await this.rpc<MediaJob>('get',{id:claimed.id});
      if(job.reservationFinalized&&(!job.upstreamId||job.reservationStatus==='released')){await this.rpc('update',{id:job.id,status:job.finishedAt?job.status:'failed',result:job.finishedAt?job.result:null,errorCode:job.reservationStatus==='released'?'video_reservation_released':'video_submission_uncertain',settled:true});return;}
      if(['completed','failed','cancelled'].includes(job.status)){await this.finish(job);return;}
      await this.c.rpc('/internal/v1/usage/leases/renew',{requestId:job.requestId,reservationId:job.reservationId});
      if(!job.upstreamId){if(Date.now()-Date.parse(job.createdAt)<300000)return;await this.rpc('update',{id:job.id,status:'failed',result:null,errorCode:'video_submission_uncertain'});await this.finish((await this.rpc<MediaJob>('get',{id:job.id})));return;}
      if(Date.now()-Date.parse(job.createdAt)>86400000){await this.rpc('update',{id:job.id,status:'failed',result:null,errorCode:'video_submission_uncertain'});await this.finish(await this.rpc<MediaJob>('get',{id:job.id}));return;}
      const target=await this.target(job.route,'video',job.requestId,job.reservationId,job.id,job.upstreamId);
      const response=await fetch(target.url,{headers:target.headers,redirect:'error',signal:AbortSignal.timeout(15000)});if(!response.ok)return;
      const value=JSON.parse((await bytes(response)).toString()) as Record<string,unknown>,state=videoState(value);
      if(['completed','failed','cancelled'].includes(state.status)){const updated=await this.rpc<{recorded:boolean}>('update',{id:job.id,...state,result:state.result,expectedRevision:job.revision??0,errorCode:state.status==='cancelled'?'video_cancelled':state.status==='failed'?'video_generation_failed':null});if(updated.recorded)await this.finish(await this.rpc<MediaJob>('get',{id:job.id}));}
      else await this.rpc('update',{id:job.id,...state,result:state.result,expectedRevision:job.revision??0});
    }));this.workerFailures=results.filter(r=>r.status==='rejected').length;
  }
  async get(request:IncomingMessage,response:ServerResponse,id:string,content:boolean){
    const reply=(s:number,v:unknown)=>this.c.send(response,s,v,request.headers.origin);
    if(!/^[a-f0-9-]{36}$/.test(id)){reply(404,{error:{type:'not_found'}});return;}
    const credential=await this.credential(request);if(!credential){reply(401,{error:{type:'authentication_error'}});return;}
    const job=await this.rpc<MediaJob|null>('get',{id});
    if(!job||job.identity.subjectId!==credential.identity.subjectId||job.identity.subjectType!==credential.identity.subjectType||job.identity.organizationId!==credential.identity.organizationId||job.identity.projectId!==credential.identity.projectId||job.purpose!==credential.purpose){reply(404,{error:{type:'not_found'}});return;}
    await this.c.trace(request)?.mark('authenticated',{identity:credential.identity,purpose:credential.purpose,modelId:job.modelId});
    if(content){if(job.status!=='completed'||!job.upstreamId){reply(409,{error:{type:'video_not_ready'}});return;}
      if(job.route.adapter==='xai'||job.route.adapter==='volcengine'){const url=job.result?.url;if(typeof url!=='string'||!/^https?:\/\//.test(url)){reply(404,{error:{type:'content_unavailable'}});return;}response.writeHead(302,{location:url,...this.c.cors(request.headers.origin)});response.end();return;}
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),600000);
      this.c.activeUpstreams.add(controller);const cancel=()=>controller.abort();response.on('close',cancel);
      try{
        const target=await this.target(job.route,'video',job.requestId,job.reservationId,job.id,job.upstreamId,true);
        const upstream=await fetch(target.url,{headers:target.headers,redirect:'error',signal:controller.signal});
        if(!upstream.ok||!upstream.body){reply(502,{error:{type:'upstream_error'}});return;}
        response.writeHead(200,{'content-type':upstream.headers.get('content-type')??'video/mp4','cache-control':'private, no-store',...this.c.cors(request.headers.origin)});
        await pipeline(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream),response);
      }finally{clearTimeout(timer);response.off('close',cancel);this.c.activeUpstreams.delete(controller);}
      return;
    }
    reply(200,this.publicJob(job));
  }
  async cancel(request:IncomingMessage,response:ServerResponse,id:string){
    const reply=(status:number,value:unknown)=>this.c.send(response,status,value,request.headers.origin);
    const credential=await this.credential(request);if(!credential){reply(401,{error:{type:'authentication_error'}});return;}
    const job=await this.rpc<MediaJob|null>('get',{id});
    if(!job||job.identity.subjectId!==credential.identity.subjectId||job.identity.subjectType!==credential.identity.subjectType||job.identity.organizationId!==credential.identity.organizationId||job.identity.projectId!==credential.identity.projectId||job.purpose!==credential.purpose){reply(404,{error:{type:'not_found'}});return;}
    if(job.finishedAt||!job.upstreamId){reply(409,{error:{type:'video_not_cancellable'}});return;}
    const operation=job.route.videoCancellation;
    if(!operation){reply(409,{error:{type:'video_cancellation_unsupported'}});return;}
    if(job.result?.cancel_requested===true&&job.result.cancel_uncertain===false){reply(200,{requested:true,status:job.status});return;}
    let target:Awaited<ReturnType<MediaGateway['target']>>;
    try{target=await this.target({...job.route,modalityPaths:{...job.route.modalityPaths,video:operation.path}},'video',job.requestId,job.reservationId,job.id,job.upstreamId);}
    catch{reply(503,{error:{type:'video_cancellation_unavailable'}});return;}
    const cancelToken=randomUUID(),claim=await this.rpc<{claimed:boolean;job:MediaJob|null}>('cancel/claim',{id:job.id,token:cancelToken});
    if(!claim.claimed){if(claim.job?.result?.cancel_requested===true&&claim.job.result.cancel_uncertain===false)reply(200,{requested:true,status:claim.job.status});else reply(409,{error:{type:'video_cancellation_in_progress'}});return;}
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);this.c.activeUpstreams.add(controller);
    try{
      const upstream=await fetch(target.url,{method:operation.method,headers:{...target.headers,...(operation.method==='POST'?{'content-type':'application/json'}:{})},body:operation.method==='POST'?'{}':undefined,redirect:'error',signal:controller.signal});
      if(!upstream.ok){await upstream.body?.cancel();await this.rpc('update',{id:job.id,status:job.status,cancelToken,result:{cancel_requested:false,cancel_uncertain:false}});reply(502,{error:{type:'video_cancellation_rejected'}});return;}
      const data=await bytes(upstream);let value:Record<string,unknown>={};try{value=JSON.parse(data.toString());}catch{/* Some vendors acknowledge cancellation with an empty body. */}
      const state=videoState(value);
      await this.rpc('update',{id:job.id,status:state.status,cancelToken,result:{...state.result,cancel_requested:true,cancel_uncertain:false},errorCode:state.status==='cancelled'?'video_cancelled':null});
      reply(200,{requested:true,status:state.status});
    }catch{reply(503,{error:{type:'video_cancellation_unknown'}});}
    finally{clearTimeout(timer);this.c.activeUpstreams.delete(controller);}
  }
  private publicJob(job:MediaJob){return {id:job.id,object:'video',model:job.modelId,status:job.status,created_at:Math.floor(Date.parse(job.createdAt)/1000),...job.result,...(job.errorCode?{error:{code:job.errorCode}}:{})};}
  async post(request:IncomingMessage,response:ServerResponse,kind:ModelKind){
    const trace=this.c.trace(request),requestId=trace?.row.requestId??randomUUID(),reply=(s:number,v:unknown)=>this.c.send(response,s,v,request.headers.origin);
    const mark=async(stage:Parameters<RequestTrace['mark']>[0],patch:Parameters<RequestTrace['mark']>[1]={})=>{try{await trace?.mark(stage,patch);}catch{/* Trace delivery failure is surfaced by the trace journal. */}};
    let input:Awaited<ReturnType<typeof readMediaInput>>;try{input=await readMediaInput(request,kind);}catch(e){reply(400,{error:{type:'invalid_request_error',message:e instanceof Error?e.message:'invalid body'}});return;}
    const credential=await this.credential(request);if(!credential){reply(401,{error:{type:'authentication_error'}});return;}
    const model=String(input.body.model);await mark('authenticated',{identity:credential.identity,purpose:credential.purpose,modelId:model});
    const attempt=randomUUID(),idempotencyKey=String(request.headers['idempotency-key']??requestId);
    const authorization:AuthorizeRequest={identity:credential.identity,purpose:credential.purpose,requestId,idempotencyKey,admissionAttemptId:attempt,modelId:model,mode:kind,estimatedInputTokens:input.tokens,maxInputTokens:input.maxInputTokens,estimatedUnits:input.units,requestFingerprint:input.fingerprint,policyVersion:'policy-local-1',guardrail:checkGuardrail(credential.guardrailPolicy??defaultGuardrailPolicy(),model,{messages:[{role:'user',content:JSON.stringify(input.body)}]}),...(typeof request.headers['x-price-version']==='string'?{expectedPriceVersion:request.headers['x-price-version']}:{})};
    await this.c.journal.beginAuthorization(authorization);let decision:AuthorizeResponse;
    try{const r=await this.c.rpc<AuthorizeResponse>('/internal/v1/policy/authorize',authorization);if(r.status!==200){if(r.status===400||r.status===409)await this.c.journal.forgetAuthorization(attempt);else await this.c.journal.deferAuthorization(attempt);reply(r.status===400||r.status===409?r.status:503,{error:{type:'authorization_error'}});return;}decision=r.value;}catch{await this.c.journal.deferAuthorization(attempt);reply(503,{error:{type:'control_plane_unavailable'}});return;}
    if(decision.decision!=='allow'||!decision.reservation){await this.c.journal.forgetAuthorization(attempt);reply(decision.reasonCode==='rate_limited'?429:decision.reasonCode==='price_unconfigured'?503:403,{error:{type:'policy_denied',code:decision.reasonCode,message:decision.reasonMessage}});return;}
    if(decision.replayed&&trace)trace.row.replayed=true;
    if(decision.replayed||decision.requestId!==requestId||decision.admissionAttemptId&&decision.admissionAttemptId!==attempt){await this.c.journal.forgetAuthorization(attempt);if(kind==='video'){const old=await this.rpc<MediaJob|null>('find',{requestId:decision.requestId});if(old&&old.identity.subjectId===credential.identity.subjectId&&old.identity.subjectType===credential.identity.subjectType&&old.identity.projectId===credential.identity.projectId&&old.purpose===credential.purpose){reply(200,{...this.publicJob(old),request_id:old.requestId});return;}}reply(409,{error:{type:'request_already_authorized'}});return;}
    const admission=decision.admission,route=admission?.route;
    await mark('admitted',{route:route?{serviceId:route.serviceId,poolId:route.poolId,upstreamModel:route.upstreamModel,audit:route.audit}:null});
    const base:SettlementRequest={requestId,idempotencyKey:idempotencyKey+':settlement',reservationId:decision.reservation.reservationId,modelId:model,purpose:credential.purpose,subjectId:credential.identity.subjectId,outcome:'rejected_before_upstream',forwarded:false,usageFinal:true,...zero,completedAt:new Date().toISOString()};
    let dispatched=false,job:MediaJob|undefined;
    try{
      if(!route||admission?.kind!=='configured'||route.kind!==kind)throw Error('configured media route required');
      const target=await this.target(route,kind,requestId,decision.reservation.reservationId);
      if(kind==='video')job=await this.rpc<MediaJob>('create',{id:randomUUID(),requestId,reservationId:base.reservationId});
      else await this.c.journal.admitted(base);
      await this.c.journal.forgetAuthorization(attempt);
      const forwarded:Record<string,unknown>={...input.body,model:route.upstreamModel};
      if(kind==='video'&&route.adapter==='xai'&&input.units!==undefined){forwarded.duration=input.units;delete forwarded.seconds;}
      if(kind==='video'&&route.adapter==='volcengine'){Object.assign(forwarded,{content:[{type:'text',text:input.body.prompt}],duration:input.units});delete forwarded.prompt;delete forwarded.seconds;}
      if(kind==='video'&&route.adapter==='openai'){input.form=new FormData();for(const [key,value]of Object.entries(forwarded))if(value!==undefined&&value!==null)input.form.set(key,typeof value==='object'?JSON.stringify(value):String(value));}
      if(input.form)input.form.set('model',route.upstreamModel);
      if(!job)await this.c.journal.dispatched(requestId);dispatched=true;await mark('dispatched');
      const controller=new AbortController(),deadline=new UpstreamDeadline(controller,gatewayTimeouts(process.env));this.c.activeUpstreams.add(controller);
      const cancel=()=>{if(kind!=='video'&&!response.writableEnded)controller.abort();};response.on('close',cancel);
      const renew=setInterval(()=>{void this.c.rpc('/internal/v1/usage/leases/renew',{requestId,reservationId:base.reservationId}).catch(()=>undefined);},30000);renew.unref();
      let upstream:Response,data:Buffer;try{upstream=await fetch(target.url,{method:'POST',headers:{...target.headers,...(!input.form?{'content-type':'application/json'}:{}),'x-request-id':requestId,...(trace?{traceparent:trace.traceparent}:{})},body:input.form??JSON.stringify(forwarded),redirect:'error',signal:controller.signal});await mark('upstream_response',{upstreamRequestId:readUpstreamRequestId(upstream.headers)});data=await bytes(upstream,()=>deadline.receivedBytes());}finally{clearInterval(renew);deadline.stop();this.c.activeUpstreams.delete(controller);response.off('close',cancel);}
      let value:unknown;try{value=JSON.parse(data.toString());}catch{value=null;}
      if(job&&upstream.ok){const v=value as Record<string,unknown>|null,id=v?.id??v?.request_id;if(typeof id!=='string'||!id)throw Error('video receipt missing');const state=videoState(v!),receipt:MediaJobReceipt={id:job.id,upstreamId:id,status:state.status==='queued'?'queued':'in_progress',result:state.result};await this.saveReceipt(receipt);try{await this.rpc('receipt',receipt);await unlink(join(this.receipts,job.id+'.json'));}catch{/* Receipt outbox owns retry. */}reply(200,{...this.publicJob({...job,...receipt}),request_id:requestId});return;}
      if(job){await this.rpc('update',{id:job.id,status:'failed',result:null,errorCode:upstream.status>=500?'video_submission_uncertain':'video_generation_failed'});await this.finish(await this.rpc<MediaJob>('get',{id:job.id}));reply(upstream.status,{error:{type:'upstream_error'},job_id:job.id,requestId});return;}
      if(upstream.ok&&!validMediaResponse(kind,value,upstream.headers.get('content-type')??'',data.length))throw Error('invalid media response');
      const meter=admission.price?.meter,tokenUsage=mediaTokenUsage(value),quantity=meter?(upstream.ok?meteredQuantity(meter.unit,kind,value,input.units):upstream.status<500?0:null):null;
      const event:SettlementRequest={...base,outcome:upstream.ok?'completed':'upstream_error',forwarded:true,usageFinal:meter?quantity!==null:tokenUsage!==null||!upstream.ok&&upstream.status<500,...(tokenUsage??zero),...(meter&&quantity!==null?{meteredUsage:{unit:meter.unit,quantity}}:{}),upstreamRequestId:readUpstreamRequestId(upstream.headers),completedAt:new Date().toISOString(),...(!upstream.ok?{errorCode:'upstream_http_'+upstream.status}:{})};
      await mark('generation_finished');const settled=await this.c.journal.finalize(event);if(settled)await mark('settled');
      if(!settled){reply(503,{error:{type:'settlement_pending'},requestId});return;}
      if(!upstream.ok){reply(upstream.status,{error:{type:'upstream_error',message:'upstream model request failed'},requestId});return;}
      response.writeHead(200,{'content-type':upstream.headers.get('content-type')??'application/json',...this.c.cors(request.headers.origin)});response.end(data);
    }catch{
      if(job&&dispatched){await this.rpc('update',{id:job.id,status:'failed',result:null,errorCode:'video_submission_uncertain'}).catch(()=>undefined);try{await this.finish(await this.rpc<MediaJob>('get',{id:job.id}));}catch{/* Persisted job owns recovery. */}}
      else{await this.c.journal.finalize({...base,outcome:dispatched?response.destroyed&&!response.writableEnded?'client_cancelled':'partial':'rejected_before_upstream',forwarded:dispatched,usageFinal:!dispatched,completedAt:new Date().toISOString()}).catch(()=>undefined);await this.c.journal.forgetAuthorization(attempt).catch(()=>undefined);}
      reply(503,{error:{type:dispatched?'upstream_interrupted':'controlled_configuration_unavailable'},requestId,...(job?{job_id:job.id}:{})});
    }
  }
}
