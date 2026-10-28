import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuthorizeRequest, AuthorizeResponse } from '@ai-gateway/contracts';
import { isRequestReference } from '@ai-gateway/contracts';
import { replaceJournalFile } from './journal-file.js';

export type AuthorizationResolver=(input:AuthorizeRequest)=>Promise<{status:number;value:AuthorizeResponse}>;
type Phase='authorizing'|'recovering'|'blocked';
interface Intent {phase:Phase;input:AuthorizeRequest;createdAt:string;attempts:number;nextAttemptAt:number;lastStatus:number|null;errorCode?:string;manualRetryCount?:number;lastManualRetry?:{at:string;reason:string}}
type Release=(input:AuthorizeRequest,response:AuthorizeResponse)=>Promise<boolean>;

/** Writer ownership is provided by SettlementJournal. No keys, prompts or upstream replay. */
export class AuthorizationJournal {
  private resolver:AuthorizationResolver|undefined;
  private readonly recovering=new Set<string>();
  private readonly running=new Map<string,Promise<boolean>>();
  constructor(private readonly directory:string,private readonly release:Release){}
  private key(id:string){return createHash('sha256').update(id).digest('hex');}
  private path(key:string){if(!/^[a-f0-9]{64}$/.test(key))throw new Error('invalid authorization journal key');return join(this.directory,`${key}.json`);}
  private async keys(){return (await readdir(this.directory)).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).map(name=>name.slice(0,-5));}
  private async read(key:string):Promise<Intent>{
    const intent=JSON.parse(await readFile(this.path(key),'utf8')) as Intent;
    if(!['authorizing','recovering','blocked'].includes(intent.phase)||!isRequestReference(intent.input?.admissionAttemptId)||this.key(intent.input.admissionAttemptId)!==key||!intent.input.requestId||!intent.input.identity?.subjectId)throw new Error('invalid authorization intent; operator inspection required');
    return intent;
  }
  private async write(key:string,intent:Intent){
    const temporary=join(this.directory,`${key}.${randomUUID()}.tmp`),handle=await open(temporary,'wx',0o600);
    try{await handle.writeFile(JSON.stringify(intent));await handle.sync();}finally{await handle.close();}
    await replaceJournalFile(temporary,this.path(key));
  }
  async initialize(resolver?:AuthorizationResolver){
    this.resolver=resolver;await mkdir(this.directory,{recursive:true,mode:0o700});
    // No handler from the prior process is alive. Every unfinished intent is safe to resolve.
    for(const key of await this.keys()){
      const intent=await this.read(key);
      if(intent.phase==='authorizing'){intent.phase='recovering';intent.nextAttemptAt=0;await this.write(key,intent);}
    }
    for(const file of await readdir(this.directory))if(/^[a-f0-9]{64}\.[a-f0-9-]{36}\.tmp$/.test(file))await unlink(join(this.directory,file));
  }
  async begin(input:AuthorizeRequest){
    if(!isRequestReference(input.admissionAttemptId))throw new Error('authorization attempt ID is required');
    await this.write(this.key(input.admissionAttemptId),{phase:'authorizing',input,createdAt:new Date().toISOString(),attempts:0,nextAttemptAt:0,lastStatus:null});
  }
  async forget(attemptId:string){
    const key=this.key(attemptId);await unlink(this.path(key)).catch(error=>{if(error.code!=='ENOENT')throw error;});this.recovering.delete(key);
  }
  async defer(attemptId:string){
    const key=this.key(attemptId);this.recovering.add(key);
    const intent=await this.read(key);intent.phase='recovering';intent.nextAttemptAt=0;await this.write(key,intent);
  }
  private recover(key:string):Promise<boolean>{
    const existing=this.running.get(key);if(existing)return existing;
    const work=(async()=>{
      const intent=await this.read(key);if(intent.phase!=='recovering'&&!this.recovering.has(key))return false;
      let status=503,errorCode='authorization_recovery_unavailable';
      try{
        const result=await this.resolver!(intent.input);status=result.status;
        if(status===200){
          const response=result.value;
          if(response?.decision==='deny'&&!response.reservation){await this.forget(intent.input.admissionAttemptId!);return true;}
          if(response?.decision==='allow'&&response.reservation){
            if(response.admissionAttemptId&&response.admissionAttemptId!==intent.input.admissionAttemptId){
              // Another physical attempt owns the hold. It may already be forwarding.
              await this.forget(intent.input.admissionAttemptId!);return true;
            }
            if(response.admissionAttemptId===intent.input.admissionAttemptId&&response.requestId===intent.input.requestId){
              const delivered=await this.release(intent.input,response);await this.forget(intent.input.admissionAttemptId!);return delivered;
            }
            errorCode='authorization_owner_unverified';
          }else errorCode='authorization_response_invalid';
        }else if(status>=400&&status<500&&status!==429)errorCode='authorization_recovery_rejected';
      }catch{status=503;/* Persist retry metadata only, never exception text or response bodies. */}
      intent.attempts++;intent.lastStatus=status;intent.errorCode=errorCode;
      intent.phase=status===200||(status>=400&&status<500&&status!==429)?'blocked':'recovering';
      intent.nextAttemptAt=Date.now()+Math.min(60000,1000*2**Math.min(intent.attempts,6));
      this.recovering.delete(key);await this.write(key,intent);return false;
    })();
    this.running.set(key,work);void work.finally(()=>this.running.delete(key)).catch(()=>undefined);return work;
  }
  async flush(){
    if(!this.resolver)return;
    const candidates=[];
    for(const key of await this.keys()){
      let intent:Intent;try{intent=await this.read(key);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
      if((intent.phase==='recovering'||this.recovering.has(key))&&intent.nextAttemptAt<=Date.now())candidates.push(key);
      if(candidates.length===8)break;
    }
    await Promise.all(candidates.map(key=>this.recover(key)));
  }
  async inspect(requestId?:string){
    const items=[];
    for(const key of await this.keys()){
      let intent:Intent;try{intent=await this.read(key);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
      if(requestId&&intent.input.requestId!==requestId)continue;
      items.push({requestId:intent.input.requestId,admissionAttemptId:intent.input.admissionAttemptId,phase:`authorization_${this.recovering.has(key)?'recovering':intent.phase}`,attempts:intent.attempts,lastStatus:intent.lastStatus,errorCode:intent.errorCode??null,queuedAt:intent.createdAt,nextAttemptAt:intent.phase==='recovering'?new Date(intent.nextAttemptAt).toISOString():null,manualRetryCount:intent.manualRetryCount??0,lastManualRetry:intent.lastManualRetry??null});
    }
    return items;
  }
  async retry(requestId:string,attemptId:string,reason:string){
    const key=this.key(attemptId),intent=await this.read(key);
    if(intent.input.requestId!==requestId)throw Object.assign(new Error('authorization intent not found'),{code:'ENOENT'});
    if(intent.phase!=='blocked')throw Object.assign(new Error('only blocked authorizations can be retried'),{code:'OUTBOX_NOT_BLOCKED'});
    intent.phase='recovering';intent.nextAttemptAt=0;intent.manualRetryCount=(intent.manualRetryCount??0)+1;intent.lastManualRetry={at:new Date().toISOString(),reason};await this.write(key,intent);
    console.error(JSON.stringify({event:'authorization_manual_retry',actor:'service-token',requestId,admissionAttemptId:attemptId,reason,retryCount:intent.manualRetryCount}));
    return this.resolver?this.recover(key):false;
  }
  async close(){await Promise.allSettled([...this.running.values()]);}
}
