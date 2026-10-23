import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SettlementRequest } from '@ai-gateway/contracts';

type Phase='admitted'|'dispatched'|'queued'|'blocked';
interface Entry {phase:Phase;settlement:SettlementRequest;attempts:number;nextAttemptAt:number;lastStatus:number|null}
export type SettlementSender=(event:SettlementRequest)=>Promise<number>;
const runtimeToken=randomUUID();
const activeDirectories=new Set<string>();

/** Durable local data-plane journal. It deliberately contains neither API keys nor request/response text. */
export class SettlementJournal {
  private sender:SettlementSender|undefined;
  private timer:ReturnType<typeof setInterval>|undefined;
  private readonly sending=new Map<string,Promise<boolean>>();
  private flushing=false;
  private ownedLock=false;
  private closed=false;
  readonly directory:string;
  constructor(directory:string){this.directory=resolve(directory);}
  private key(requestId:string){return createHash('sha256').update(requestId).digest('hex');}
  private path(key:string){if(!/^[a-f0-9]{64}$/.test(key))throw new Error('invalid journal key');return join(this.directory,`${key}.json`);}

  private async write(key:string,entry:Entry){
    const temporary=join(this.directory,`${key}.${randomUUID()}.tmp`);
    const handle=await open(temporary,'wx',0o600);
    try{await handle.writeFile(JSON.stringify(entry));await handle.sync();}finally{await handle.close();}
    await rename(temporary,this.path(key));
  }
  private async entries(){return (await readdir(this.directory)).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).map(name=>name.slice(0,-5));}
  private async read(key:string):Promise<Entry>{
    const entry=JSON.parse(await readFile(this.path(key),'utf8')) as Entry;
    if(!['admitted','dispatched','queued','blocked'].includes(entry.phase)||!entry.settlement?.requestId||this.key(entry.settlement.requestId)!==key)throw new Error('invalid journal record; operator inspection required');
    return entry;
  }
  async initialize(sender:SettlementSender){
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
    for(const key of await this.entries()){
      const entry=await this.read(key);
      if(entry.phase==='admitted'||entry.phase==='dispatched'){
        entry.settlement={...entry.settlement,outcome:entry.phase==='admitted'?'rejected_before_upstream':'partial',forwarded:entry.phase==='dispatched',usageFinal:entry.phase==='admitted',inputTokens:0,outputTokens:0,cachedInputTokens:0,actualAmount:0,completedAt:new Date().toISOString()};
        entry.phase='queued';entry.nextAttemptAt=0;await this.write(key,entry);
      }
    }
    // An interrupted temporary write cannot replace the last fsynced record.
    for(const file of await readdir(this.directory))if(/^[a-f0-9]{64}\.[a-f0-9-]{36}\.tmp$/.test(file))await unlink(join(this.directory,file));
    await this.flush();
    this.timer=setInterval(()=>{void this.flush().catch(()=>undefined);},1000);this.timer.unref();
  }
  async admitted(settlement:SettlementRequest){await this.write(this.key(settlement.requestId),{phase:'admitted',settlement,attempts:0,nextAttemptAt:0,lastStatus:null});}
  async dispatched(requestId:string){const key=this.key(requestId),entry=await this.read(key);entry.phase='dispatched';await this.write(key,entry);}
  async finalize(settlement:SettlementRequest){
    const key=this.key(settlement.requestId);
    await this.write(key,{phase:'queued',settlement,attempts:0,nextAttemptAt:0,lastStatus:null});
    return this.deliver(key);
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
  async flush(){
    if(this.flushing||!this.sender||this.closed)return;this.flushing=true;
    try{
      const candidates=[];
      for(const key of await this.entries()){let entry:Entry;try{entry=await this.read(key);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}if(entry.phase==='queued'&&entry.nextAttemptAt<=Date.now())candidates.push(key);if(candidates.length===8||this.closed)break;}
      await Promise.all(candidates.map(key=>this.deliver(key)));
    }finally{this.flushing=false;}
  }
  async status(){
    const summary={queued:0,blocked:0,active:0};
    for(const key of await this.entries()){let entry:Entry;try{entry=await this.read(key);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}if(entry.phase==='blocked')summary.blocked++;else if(entry.phase==='queued')summary.queued++;else summary.active++;}
    return summary;
  }
  async close(){
    this.closed=true;
    if(this.timer)clearInterval(this.timer);
    await Promise.allSettled([...this.sending.values()]);
    if(this.ownedLock){await unlink(join(this.directory,'writer.lock'));this.ownedLock=false;activeDirectories.delete(this.directory);}
  }
}
