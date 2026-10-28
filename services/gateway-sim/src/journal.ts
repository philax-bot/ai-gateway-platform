import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AuthorizeRequest, AuthorizeResponse, SettlementRequest } from '@ai-gateway/contracts';
import { AuthorizationJournal, type AuthorizationResolver } from './authorization-journal.js';
import { replaceJournalFile } from './journal-file.js';

type Phase='admitted'|'dispatched'|'queued'|'blocked';
interface Entry {phase:Phase;settlement:SettlementRequest;attempts:number;nextAttemptAt:number;lastStatus:number|null;queuedAt?:string;manualRetryCount?:number;lastManualRetry?:{at:string;reason:string}}
export type SettlementSender=(event:SettlementRequest)=>Promise<number>;
const runtimeToken=randomUUID();
const activeDirectories=new Set<string>();

/** Durable local data-plane journal. It deliberately contains neither API keys nor request/response text. */
export class SettlementJournal {
  private sender:SettlementSender|undefined;
  private timer:ReturnType<typeof setInterval>|undefined;
  private readonly sending=new Map<string,Promise<boolean>>();
  private readonly retrying=new Map<string,Promise<boolean>>();
  private readonly pendingWrites=new Map<string,SettlementRequest>();
  private readonly persisting=new Map<string,Promise<void>>();
  private flushing:Promise<void>|undefined;
  private ownedLock=false;
  private closed=false;
  readonly directory:string;
  private readonly authorizations:AuthorizationJournal;
  constructor(directory:string){this.directory=resolve(directory);this.authorizations=new AuthorizationJournal(join(this.directory,'authorizations'),(input,response)=>this.releaseAuthorization(input,response));}
  private key(requestId:string){return createHash('sha256').update(requestId).digest('hex');}
  private path(key:string){if(!/^[a-f0-9]{64}$/.test(key))throw new Error('invalid journal key');return join(this.directory,`${key}.json`);}

  private async write(key:string,entry:Entry){
    const temporary=join(this.directory,`${key}.${randomUUID()}.tmp`);
    const handle=await open(temporary,'wx',0o600);
    try{await handle.writeFile(JSON.stringify(entry));await handle.sync();}finally{await handle.close();}
    await replaceJournalFile(temporary,this.path(key));
  }
  private async entries(){return (await readdir(this.directory)).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).map(name=>name.slice(0,-5));}
  private async read(key:string):Promise<Entry>{
    const entry=JSON.parse(await readFile(this.path(key),'utf8')) as Entry;
    if(!['admitted','dispatched','queued','blocked'].includes(entry.phase)||!entry.settlement?.requestId||this.key(entry.settlement.requestId)!==key)throw new Error('invalid journal record; operator inspection required');
    return entry;
  }
  private async recoverFinalWrites(){
    for(const file of await readdir(this.directory)){
      if(!/^[a-f0-9]{64}\.[a-f0-9-]{36}\.tmp$/.test(file))continue;
      let entry:Entry;try{entry=JSON.parse(await readFile(join(this.directory,file),'utf8')) as Entry;}catch{continue;}
      if(entry.phase!=='queued')continue;
      const key=file.slice(0,64);if(!entry.settlement?.requestId||this.key(entry.settlement.requestId)!==key)throw new Error('invalid final journal write; operator inspection required');
      let existing:Entry|undefined;try{existing=await this.read(key);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      if(existing){
        if(existing.settlement.reservationId!==entry.settlement.reservationId||existing.settlement.idempotencyKey!==entry.settlement.idempotencyKey)throw new Error('conflicting final journal identity; operator inspection required');
        if(existing.phase==='queued'||existing.phase==='blocked'){
          if(!isDeepStrictEqual(existing.settlement,entry.settlement))throw new Error('conflicting final journal events; operator inspection required');
          await unlink(join(this.directory,file));continue;
        }
        if(existing.phase==='dispatched'&&entry.settlement.forwarded!==true)throw new Error('conflicting dispatch evidence; operator inspection required');
      }
      // A complete queued temporary file was written after generation. Keep its
      // final usage instead of converting the older dispatch record to unknown.
      await replaceJournalFile(join(this.directory,file),this.path(key));
    }
  }
  async initialize(sender:SettlementSender,resolver?:AuthorizationResolver){
    if(activeDirectories.has(this.directory))throw new Error('journal directory is owned by a running process');
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const lock=join(this.directory,'writer.lock');
    try{
      const previous=JSON.parse(await readFile(lock,'utf8')) as {pid:number};
      if(!Number.isSafeInteger(previous.pid)||previous.pid<1)throw new Error('invalid journal lock; operator inspection required');
      let alive=!(previous.pid===process.pid&&(previous as {runtimeToken?:string}).runtimeToken!==runtimeToken);
      if(alive)try{process.kill(previous.pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')alive=false;else throw error;}
      if(alive)throw new Error('journal directory is owned by a running process');
      await unlink(lock);
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const handle=await open(lock,'wx',0o600);await handle.writeFile(JSON.stringify({pid:process.pid,runtimeToken}));await handle.sync();await handle.close();this.ownedLock=true;activeDirectories.add(this.directory);
    this.sender=sender;
    await this.recoverFinalWrites();
    for(const key of await this.entries()){
      const entry=await this.read(key);
      if(entry.phase==='admitted'||entry.phase==='dispatched'){
        entry.settlement={...entry.settlement,outcome:entry.phase==='admitted'?'rejected_before_upstream':'partial',forwarded:entry.phase==='dispatched',usageFinal:entry.phase==='admitted',inputTokens:0,outputTokens:0,cachedInputTokens:0,actualAmount:0,completedAt:new Date().toISOString()};
        entry.phase='queued';entry.queuedAt=new Date().toISOString();entry.nextAttemptAt=0;await this.write(key,entry);
      }
    }
    // Complete final writes have already been promoted or deduplicated above.
    for(const file of await readdir(this.directory))if(/^[a-f0-9]{64}\.[a-f0-9-]{36}\.tmp$/.test(file))await unlink(join(this.directory,file));
    await this.authorizations.initialize(resolver);
    await this.flush();
    this.timer=setInterval(()=>{void this.flush().catch(()=>undefined);},1000);this.timer.unref();
  }
  async admitted(settlement:SettlementRequest){await this.write(this.key(settlement.requestId),{phase:'admitted',settlement,attempts:0,nextAttemptAt:0,lastStatus:null});}
  async beginAuthorization(input:AuthorizeRequest){if(this.closed)throw new Error('journal is closed');await this.authorizations.begin(input);}
  async forgetAuthorization(attemptId:string){await this.authorizations.forget(attemptId);}
  async deferAuthorization(attemptId:string){await this.authorizations.defer(attemptId);}
  private async releaseAuthorization(input:AuthorizeRequest,response:AuthorizeResponse){
    const key=this.key(input.requestId);let existing:Entry|undefined;
    try{existing=await this.read(key);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(existing){
      if(existing.settlement.reservationId!==response.reservation!.reservationId)throw new Error('reservation journal conflict');
      // A dispatch/final record has stronger evidence and owns its settlement. Never replace it with zero usage.
      if(existing.phase!=='admitted'||existing.settlement.forwarded===true)return false;
    }
    return this.finalize({requestId:input.requestId,idempotencyKey:`${input.idempotencyKey}:settlement`,reservationId:response.reservation!.reservationId,
      outcome:'rejected_before_upstream',forwarded:false,usageFinal:true,inputTokens:0,outputTokens:0,cachedInputTokens:0,actualAmount:0,currency:'CNY',completedAt:new Date().toISOString(),
      modelId:input.modelId,purpose:input.purpose,subjectId:input.identity.subjectId,errorCode:'authorization_response_lost'});
  }
  async dispatched(requestId:string){const key=this.key(requestId),entry=await this.read(key);entry.phase='dispatched';await this.write(key,entry);}
  async finalize(settlement:SettlementRequest){
    const key=this.key(settlement.requestId);
    this.pendingWrites.set(key,settlement);await this.persistFinalization(key,settlement);
    return this.deliver(key);
  }
  private persistFinalization(key:string,settlement:SettlementRequest):Promise<void>{
    const existing=this.persisting.get(key);if(existing)return existing;
    const work=(async()=>{await this.write(key,{phase:'queued',settlement,attempts:0,nextAttemptAt:0,lastStatus:null,queuedAt:new Date().toISOString()});if(this.pendingWrites.get(key)===settlement)this.pendingWrites.delete(key);})();
    this.persisting.set(key,work);void work.finally(()=>this.persisting.delete(key)).catch(()=>undefined);return work;
  }
  private deliver(key:string):Promise<boolean>{
    const existing=this.sending.get(key);if(existing)return existing;
    if(this.closed)return Promise.resolve(false);
    const work=(async()=>{
      const entry=await this.read(key);if(entry.phase!=='queued')return false;
      let status=503;try{status=await this.sender!(entry.settlement);}catch{/* keep the fsynced event for retry */}
      if(status===200){await unlink(this.path(key));return true;}
      entry.attempts++;entry.lastStatus=status;entry.nextAttemptAt=Date.now()+Math.min(60000,1000*2**Math.min(entry.attempts,6));
      if(status>=400&&status<500)entry.phase='blocked';
      await this.write(key,entry);return false;
    })();
    this.sending.set(key,work);void work.finally(()=>this.sending.delete(key)).catch(()=>undefined);return work;
  }
  flush():Promise<void>{
    if(this.flushing)return this.flushing;
    if(!this.sender||this.closed)return Promise.resolve();
    const work=(async()=>{
      for(const [key,settlement] of [...this.pendingWrites].slice(0,8)){
        try{await this.persistFinalization(key,settlement);}catch{/* Keep the original complete usage for the next storage retry. */}
      }
      await this.authorizations.flush();
      const candidates=[];
      for(const key of await this.entries()){let entry:Entry;try{entry=await this.read(key);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}if(entry.phase==='queued'&&entry.nextAttemptAt<=Date.now())candidates.push(key);if(candidates.length===8||this.closed)break;}
      await Promise.all(candidates.map(key=>this.deliver(key)));
    })();
    this.flushing=work;void work.finally(()=>{this.flushing=undefined;}).catch(()=>undefined);return work;
  }
  async inspect(requestId?:string){
    const items=[];
    for(const key of requestId?[this.key(requestId)]:await this.entries()){
      let entry:Entry;try{entry=await this.read(key);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
      const pending=this.pendingWrites.get(key);if(pending)entry={...entry,settlement:pending};
      items.push({requestId:entry.settlement.requestId,reservationId:entry.settlement.reservationId,phase:pending?'write_pending':entry.phase,outcome:entry.settlement.outcome,usageFinal:entry.settlement.usageFinal,attempts:entry.attempts,lastStatus:entry.lastStatus,queuedAt:entry.queuedAt??entry.settlement.completedAt,nextAttemptAt:entry.phase==='queued'?new Date(entry.nextAttemptAt).toISOString():null,manualRetryCount:entry.manualRetryCount??0,lastManualRetry:entry.lastManualRetry??null});
      if(items.length===100)break;
    }
    return [...items,...await this.authorizations.inspect(requestId)].slice(0,100);
  }
  retryBlocked(requestId:string,reason:string):Promise<boolean>{
    const key=this.key(requestId),existing=this.retrying.get(key);if(existing)return existing;
    const work=(async()=>{
      if(this.closed)throw new Error('journal is closed');
      const entry=await this.read(key);
      if(entry.phase!=='blocked')throw Object.assign(new Error('only blocked settlements can be manually retried'),{code:'OUTBOX_NOT_BLOCKED'});
      entry.phase='queued';entry.nextAttemptAt=0;entry.manualRetryCount=(entry.manualRetryCount??0)+1;entry.lastManualRetry={at:new Date().toISOString(),reason};
      await this.write(key,entry);
      console.error(JSON.stringify({event:'outbox_manual_retry',actor:'service-token',requestId,reason,retryCount:entry.manualRetryCount}));
      return this.deliver(key);
    })();
    this.retrying.set(key,work);void work.finally(()=>this.retrying.delete(key)).catch(()=>undefined);return work;
  }
  retryAuthorization(requestId:string,attemptId:string,reason:string):Promise<boolean>{
    const key=`authorization:${this.key(attemptId)}`,existing=this.retrying.get(key);if(existing)return existing;
    if(this.closed)return Promise.reject(new Error('journal is closed'));
    const work=this.authorizations.retry(requestId,attemptId,reason);this.retrying.set(key,work);void work.finally(()=>this.retrying.delete(key)).catch(()=>undefined);return work;
  }
  async status(){
    const summary={queued:0,blocked:0,active:0,oldestQueuedAgeMs:0,oldestBlockedAgeMs:0,retryAttempts:0,authorizing:0,authorizationPending:0,authorizationBlocked:0,writePending:this.pendingWrites.size};
    const observed=new Set<string>();
    for(const key of await this.entries()){
      let entry:Entry;try{entry=await this.read(key);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
      observed.add(key);if(this.pendingWrites.has(key))entry={...entry,phase:'queued',settlement:this.pendingWrites.get(key)!};
      const age=Math.max(0,Date.now()-Date.parse(entry.queuedAt??entry.settlement.completedAt));summary.retryAttempts+=entry.attempts;
      if(entry.phase==='blocked'){summary.blocked++;if(Number.isFinite(age))summary.oldestBlockedAgeMs=Math.max(summary.oldestBlockedAgeMs,age);}
      else if(entry.phase==='queued'){summary.queued++;if(Number.isFinite(age))summary.oldestQueuedAgeMs=Math.max(summary.oldestQueuedAgeMs,age);}
      else summary.active++;
    }
    for(const [key,settlement] of this.pendingWrites)if(!observed.has(key)){summary.queued++;summary.oldestQueuedAgeMs=Math.max(summary.oldestQueuedAgeMs,Date.now()-Date.parse(settlement.completedAt));}
    for(const intent of await this.authorizations.inspect()){
      const age=Math.max(0,Date.now()-Date.parse(intent.queuedAt));summary.retryAttempts+=intent.attempts;
      if(intent.phase==='authorization_blocked'){summary.blocked++;summary.authorizationBlocked++;if(Number.isFinite(age))summary.oldestBlockedAgeMs=Math.max(summary.oldestBlockedAgeMs,age);}
      else if(intent.phase==='authorization_recovering'){summary.queued++;summary.authorizationPending++;if(Number.isFinite(age))summary.oldestQueuedAgeMs=Math.max(summary.oldestQueuedAgeMs,age);}
      else{summary.active++;summary.authorizing++;}
    }
    return summary;
  }
  async close(){
    this.closed=true;
    if(this.timer)clearInterval(this.timer);
    await Promise.allSettled([this.flushing,...this.retrying.values(),...this.sending.values(),...this.persisting.values()]);await this.authorizations.close();
    if(this.ownedLock){await unlink(join(this.directory,'writer.lock'));this.ownedLock=false;activeDirectories.delete(this.directory);}
  }
}
