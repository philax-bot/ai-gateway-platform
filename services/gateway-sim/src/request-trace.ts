import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,open,readdir,readFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {isRequestReference,type GatewayRequestTrace,type GatewayStage} from '@ai-gateway/contracts';
import {replaceJournalFile} from './journal-file.js';

type Sender=(row:GatewayRequestTrace)=>Promise<number>;
/** Local durable snapshots; an access attempt is distinct from a logical, billable request. */
export class TraceJournal {
  private timer:ReturnType<typeof setInterval>|undefined;
  private sender:Sender|undefined;
  private readonly writes=new Map<string,Promise<void>>();
  private readonly acknowledged=new Map<string,number>();
  private flushing:Promise<void>|undefined;
  private lastStatus:number|null=null;
  private lastFailureAt:string|null=null;
  constructor(readonly directory:string){}
  private path(id:string){if(!/^[a-f0-9-]{36}$/.test(id))throw Error('invalid trace attempt');return join(this.directory,id+'.json');}
  async initialize(sender:Sender){
    this.sender=sender;await mkdir(this.directory,{recursive:true,mode:0o700});
    // Promote a fully fsynced snapshot whose atomic replacement was interrupted.
    for(const file of await readdir(this.directory)){
      if(!/^[a-f0-9-]{36}\.[a-f0-9-]{36}\.tmp$/.test(file))continue;
      let row:GatewayRequestTrace;try{row=JSON.parse(await readFile(join(this.directory,file),'utf8'));}catch{continue;}
      if(row.attemptId!==file.slice(0,36)||!Number.isInteger(row.revision))throw Error('invalid temporary trace snapshot');
      let old:GatewayRequestTrace|undefined;try{old=JSON.parse(await readFile(this.path(row.attemptId),'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      if(!old||row.revision>old.revision)await replaceJournalFile(join(this.directory,file),this.path(row.attemptId));else await unlink(join(this.directory,file));
    }
    for(const file of await readdir(this.directory)){
      if(!/^[a-f0-9-]{36}\.json$/.test(file))continue;
      const row=JSON.parse(await readFile(join(this.directory,file),'utf8')) as GatewayRequestTrace;
      if(row.attemptId+'.json'!==file)throw Error('invalid trace journal');
      if(!row.completedAt){const at=new Date(Math.max(Date.now(),Date.parse(row.updatedAt))).toISOString();row.completedAt=at;row.updatedAt=at;row.status=503;row.errorCode='gateway_restarted';row.stages.push({stage:'interrupted',at});row.revision++;await this.persist(row);}
    }
    await this.flush();this.timer=setInterval(()=>void this.flush().catch(()=>undefined),2000);this.timer.unref();
  }
  persist(row:GatewayRequestTrace){
    const snapshot=structuredClone(row),id=row.attemptId;
    const prior=this.writes.get(id)??Promise.resolve();
    const work=prior.catch(()=>undefined).then(async()=>{
      const temporary=join(this.directory,`${id}.${randomUUID()}.tmp`),handle=await open(temporary,'wx',0o600);
      try{await handle.writeFile(JSON.stringify(snapshot));await handle.sync();}finally{await handle.close();}
      await replaceJournalFile(temporary,this.path(id));
    });
    this.writes.set(id,work);void work.finally(()=>{if(this.writes.get(id)===work)this.writes.delete(id);}).catch(()=>undefined);return work;
  }
  flush(){
    if(this.flushing)return this.flushing;
    const work=(async()=>{
      let sent=0;
      for(const file of await readdir(this.directory)){
        if(sent>=100)break;
        if(!/^[a-f0-9-]{36}\.json$/.test(file))continue;
        const id=file.slice(0,-5);await this.writes.get(id);
        let row:GatewayRequestTrace;try{row=JSON.parse(await readFile(this.path(id),'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
        if(this.acknowledged.get(id)===row.revision)continue;
        let status:number;sent++;try{status=await this.sender!(row);}catch{status=503;}
        this.lastStatus=status;
        if(status!==200){
          this.lastFailureAt=new Date().toISOString();
          if(status===400||status===409||status===422){
            if(row.completedAt){const rejected=join(this.directory,'rejected');await mkdir(rejected,{recursive:true,mode:0o700});await replaceJournalFile(this.path(id),join(rejected,`${id}.${row.revision}.json`));}
            else this.acknowledged.set(id,row.revision);
            continue;
          }
          break;
        }
        this.acknowledged.set(id,row.revision);
        // Final rows cannot be updated. Active rows remain on disk for crash recovery.
        if(row.completedAt){await unlink(this.path(id));this.acknowledged.delete(id);}
      }
    })();
    this.flushing=work;void work.finally(()=>{this.flushing=undefined;}).catch(()=>undefined);return work;
  }
  async status(){let rejected=0;try{rejected=(await readdir(join(this.directory,'rejected'))).length;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}return {deliveryFailed:rejected>0||this.lastStatus!==null&&this.lastStatus!==200,lastStatus:this.lastStatus,lastFailureAt:this.lastFailureAt,rejected,pending:(await readdir(this.directory)).filter(name=>/^[a-f0-9-]{36}\.json$/.test(name)).length};}
  async close(){if(this.timer)clearInterval(this.timer);await Promise.allSettled([...this.writes.values()]);await this.flush();}
}

export class RequestTrace {
  readonly row:GatewayRequestTrace;
  constructor(private readonly journal:TraceJournal,method:string,path:string,requestId:unknown,parent:unknown){
    const match=typeof parent==='string'?parent.match(/^00-([a-f0-9]{32})-([a-f0-9]{16})-(?:00|01)$/):null;
    const valid=match&&!/^0+$/.test(match[1])&&!/^0+$/.test(match[2]);
    const at=new Date().toISOString();
    this.row={attemptId:randomUUID(),requestId:isRequestReference(requestId)?requestId:`request-${randomUUID()}`,traceId:valid?match[1]:randomBytes(16).toString('hex'),spanId:randomBytes(8).toString('hex'),parentSpanId:valid?match[2]:null,revision:0,startedAt:at,updatedAt:at,completedAt:null,method,path,status:null,identity:null,purpose:null,modelId:null,route:null,upstreamRequestId:null,errorCode:null,replayed:false,stages:[]};
  }
  get traceparent(){return `00-${this.row.traceId}-${this.row.spanId}-01`;}
  async mark(stage:GatewayStage,patch:Partial<Pick<GatewayRequestTrace,'identity'|'purpose'|'modelId'|'route'|'upstreamRequestId'|'errorCode'|'replayed'|'status'>>={}){
    if(this.row.completedAt)return;
    Object.assign(this.row,patch);
    const at=stage==='accepted'?this.row.startedAt:new Date(Math.max(Date.now(),Date.parse(this.row.updatedAt))).toISOString();
    if(!this.row.stages.some(e=>e.stage===stage))this.row.stages.push({stage,at});
    this.row.updatedAt=this.row.stages.at(-1)!.at;this.row.revision++;
    if(stage==='completed'||stage==='interrupted')this.row.completedAt=this.row.updatedAt;
    await this.journal.persist(this.row);
  }
}
