import {BadRequestException,ConflictException} from '@nestjs/common';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import type {WebhookChannel,WebhookDelivery,WorkspaceState} from '@ai-gateway/contracts';
import type {WorkspaceRepository} from './workspace.repository';
import {newId} from './domain';
import {pick,text} from './validation';

export function saveWebhookChannel(state:WorkspaceState,payload:Record<string,unknown>):WebhookChannel {
  const monitoring=state.monitoring??={rules:[],events:[],evaluations:{}};
  const channels=monitoring.channels??=[];
  const existing=payload.id?pick(channels,payload.id,'notification channel'):null;
  let url:URL;
  try{url=new URL(text(payload.url,'url',2000));}catch{throw new BadRequestException('invalid webhook URL');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new BadRequestException('webhook requires HTTP(S) without embedded credentials, query or fragment');
  const signingKeyRef=text(payload.signingKeyRef,'signingKeyRef',120);
  if(!/^NOTIFICATION_[A-Z0-9_]+$/.test(signingKeyRef))throw new BadRequestException('signing key must reference a controlled NOTIFICATION_ environment variable');
  const channel:WebhookChannel={id:existing?.id??newId('channel'),name:text(payload.name,'name',100),url:url.toString(),signingKeyRef,active:payload.active!==false,version:(existing?.version??0)+1};
  if(existing)Object.assign(existing,channel);else channels.push(channel);
  return channel;
}

/** The outbox and the alert transition commit in the same workspace transaction. */
export function enqueueAlertWebhooks(state:WorkspaceState,eventId:string,eventType:string,occurredAt:string,ruleId:string|null,title:string,message:string):void {
  const monitoring=state.monitoring;
  if(!monitoring)return;
  const deliveries=monitoring.deliveries??=[];
  const queuedAt=new Date().toISOString();
  for(const channel of monitoring.channels??[]){
    if(!channel.active)continue;
    const id=createHash('sha256').update(JSON.stringify([eventId,eventType,channel.id])).digest('hex');
    if(deliveries.some(delivery=>delivery.id===id))continue;
    const stableEventId=`${eventId}:${eventType}`;
    deliveries.push({id,eventId:stableEventId,eventType,ruleId,channel:structuredClone(channel),payload:{eventId:stableEventId,type:eventType,occurredAt,alert:{id:eventId,ruleId,title,message}},
      status:'pending',attempts:0,createdAt:queuedAt,lastAttemptAt:null,completedAt:null,nextAttemptAt:queuedAt,lastError:null,httpStatus:null,leaseOwner:null,leaseUntil:null});
  }
}

export function enqueueMediaWebhook(state:WorkspaceState,job:import('@ai-gateway/contracts').MediaJob):boolean {
  const monitoring=state.monitoring;
  const channel=monitoring?.channels?.find(channel=>channel.id===job.callbackChannelId&&channel.active);
  if(!monitoring||!channel)return false;
  const eventType=`media.${job.status}`,eventId=`${job.id}:${eventType}`;
  const id=createHash('sha256').update(JSON.stringify([job.id,eventType,channel.id])).digest('hex');
  const deliveries=monitoring.deliveries??=[];
  if(deliveries.some(delivery=>delivery.id===id))return true;
  const at=new Date().toISOString();
  deliveries.push({id,eventId,eventType,ruleId:null,channel:structuredClone(channel),
    payload:{eventId,type:eventType,occurredAt:job.finishedAt,task:{id:job.id,requestId:job.requestId,modelId:job.modelId,status:job.status,errorCode:job.errorCode,billingState:job.reservationStatus??'recorded',statusPath:`/v1/videos/${job.id}`,contentPath:job.status==='completed'?`/v1/videos/${job.id}/content`:null}},
    status:'pending',attempts:0,createdAt:at,lastAttemptAt:null,completedAt:null,nextAttemptAt:at,lastError:null,httpStatus:null,leaseOwner:null,leaseUntil:null});
  return true;
}

export function retryWebhook(state:WorkspaceState,id:unknown):WebhookDelivery {
  const delivery=pick(state.monitoring?.deliveries??[],id,'notification delivery');
  if(delivery.status!=='failed')throw new ConflictException('only failed deliveries may be retried');
  const channel=state.monitoring?.channels?.find(channel=>channel.id===delivery.channel.id);
  if(!channel?.active||channel.version!==delivery.channel.version)throw new ConflictException('delivery destination changed or disabled');
  Object.assign(delivery,{status:'pending',attempts:0,nextAttemptAt:new Date().toISOString(),leaseOwner:null,leaseUntil:null,lastError:null});
  return delivery;
}

export async function deliverWebhooks(repository:WorkspaceRepository,send:typeof fetch=fetch):Promise<number> {
  const snapshot=await repository.readNotifications(),now=Date.now();
  const due=(snapshot.monitoring?.deliveries??[]).some(delivery=>delivery.status==='pending'&&Date.parse(delivery.nextAttemptAt??delivery.createdAt)<=now||delivery.status==='sending'&&Date.parse(delivery.leaseUntil??'1970-01-01')<=now);
  if(!due)return 0;
  const owner=randomUUID();
  const claimed=await repository.transact(async tx=>{
    const monitoring=tx.state.monitoring,claimed:WebhookDelivery[]=[];
    if(!monitoring)return claimed;
    for(const delivery of monitoring.deliveries??[]){
      if(claimed.length>=4)break;
      if(!(delivery.status==='pending'&&Date.parse(delivery.nextAttemptAt??delivery.createdAt)<=Date.now()||delivery.status==='sending'&&Date.parse(delivery.leaseUntil??'1970-01-01')<=Date.now()))continue;
      const channel=monitoring.channels?.find(channel=>channel.id===delivery.channel.id);
      const rule=monitoring.rules.find(rule=>rule.id===delivery.ruleId);
      if(!channel?.active||channel.version!==delivery.channel.version||rule?.silencedUntil&&Date.parse(rule.silencedUntil)>Date.now()){
        Object.assign(delivery,{status:'suppressed',lastError:'channel_changed_disabled_or_silenced',completedAt:new Date().toISOString()});continue;
      }
      Object.assign(delivery,{status:'sending',leaseOwner:owner,leaseUntil:new Date(Date.now()+45000).toISOString(),attempts:delivery.attempts+1,lastAttemptAt:new Date().toISOString()});
      claimed.push(structuredClone(delivery));
    }
    return claimed;
  },{runtimeOnly:true,incrementRevision:false,diagnosticContext:'monitoring_commit'});
  for(const delivery of claimed){
    let httpStatus:number|null=null,error:string|null=null;
    try{
      const secret=process.env[delivery.channel.signingKeyRef];
      if(!secret||Buffer.byteLength(secret)<32)throw new Error('signing_key_unavailable');
      const body=JSON.stringify(delivery.payload),timestamp=String(Math.floor(Date.now()/1000));
      const signature=createHmac('sha256',secret).update(`${timestamp}.${body}`).digest('hex');
      const response=await send(delivery.channel.url,{method:'POST',body,headers:{'Content-Type':'application/json','X-Gateway-Event-Id':delivery.eventId,'X-Gateway-Timestamp':timestamp,'X-Gateway-Signature':`sha256=${signature}`},signal:AbortSignal.timeout(5000),redirect:'error'});
      httpStatus=response.status;await response.body?.cancel();
      if(!response.ok)error=`http_${response.status}`;
    }catch(cause){error=cause instanceof Error&&cause.message==='signing_key_unavailable'?'signing_key_unavailable':'transport_error';}
    await repository.transact(async tx=>{
      const current=tx.state.monitoring?.deliveries?.find(item=>item.id===delivery.id);
      if(current?.status!=='sending'||current.leaseOwner!==owner)return;
      const terminal=!error||current.attempts>=8;
      Object.assign(current,{status:!error?'succeeded':terminal?'failed':'pending',httpStatus,lastError:error,
        completedAt:terminal?new Date().toISOString():null,leaseOwner:null,leaseUntil:null,
        nextAttemptAt:terminal?null:new Date(Date.now()+Math.min(3600000,60000*2**(current.attempts-1))).toISOString()});
    },{runtimeOnly:true,incrementRevision:false,diagnosticContext:'monitoring_commit'});
  }
  return claimed.length;
}
