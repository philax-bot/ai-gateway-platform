import type { PoolClient } from 'pg';
import {monitorEventLoopDelay} from 'node:perf_hooks';

const OPERATIONS=['authorize','settle','resolve_credential','workspace_write','workspace_view','workspace_read','query_calls'] as const;
type Operation=typeof OPERATIONS[number];
export type DiagnosticContext='business_command'|'approval_failure'|'service_verification'|'online_credential'|'auth_setup'|'auth_login'|'auth_logout'|'auth_session'|'maintenance_read'|'periodic_grant'|'monitoring_commit'|'retention';
interface Step {stage:string;command:string;lock:string|null;elapsedMs:number;startedAt:number;endedAt:number|null}
interface Sample { operation:Operation; context:DiagnosticContext|null; backendPid:number|null; sequence:number; startedAt:number; elapsedMs:number; poolWaitMs:number; queries:number; sqlMs:number; stages:Record<string,number>; failed:boolean; steps:Step[] }
interface Active {sample:Sample;began:number;pooledAt:number|null;current:Step|null}
const round=(n:number)=>Math.round(n*100)/100;
function distribution(values:number[]){
  const sorted=[...values].sort((a,b)=>a-b);
  const at=(p:number)=>sorted.length?round(sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)]):null;
  return {p50:at(.5),p95:at(.95),max:sorted.length?round(sorted[sorted.length-1]):null};
}

// Fixed labels only: SQL, bind values, request IDs and credentials are never retained.
function stage(sql:unknown):string {
  if(typeof sql!=='string')return 'other';
  if(/pg_advisory_xact_lock|gateway_lock_keys/.test(sql))return 'advisory_lock';
  for(const table of ['platform_workspace','authorization_records','credentials','quota_batches','reservation_limit_scopes','admission_windows','reservations','settlement_records','usage_ledger_entries','call_logs']){
    if(new RegExp(`\\b${table}\\b`).test(sql))return table;
  }
  if(/^(begin|commit|rollback)\b/i.test(sql))return 'transaction';
  return 'other';
}
function statement(sql:unknown){
  const value=typeof sql==='string'?sql:'';
  const first=/^\s*(\w+)/.exec(value)?.[1].toLowerCase();
  const command=['begin','commit','rollback'].includes(first??'')?first!:first==='select'?'read':['insert','update','delete'].includes(first??'')?'write':'other';
  const lock=/pg_advisory_xact_lock|gateway_lock_keys/.test(value)?'advisory':/\bfor\s+share\b/i.test(value)?'share':/\bfor\s+update\b/i.test(value)?'update':null;
  return {stage:stage(sql),command,lock};
}

/** Opt-in, bounded, process-local timing for controlled diagnosis, not an accounting store. */
export class HotPathDiagnostics {
  private samples:Sample[]=[];
  private completed=0;
  private started=0;
  private readonly active=new Map<number,Active>();
  private readonly loop:ReturnType<typeof monitorEventLoopDelay>|null;
  constructor(readonly enabled=false,private readonly capacity=2048){this.loop=enabled?monitorEventLoopDelay({resolution:20}):null;this.loop?.enable();}
  start(operation:Operation,context:DiagnosticContext|null=null){
    const began=performance.now();
    const sample:Sample={operation,context,backendPid:null,sequence:0,startedAt:Date.now(),elapsedMs:0,poolWaitMs:0,queries:0,sqlMs:0,stages:{},failed:false,steps:[]};
    const id=++this.started,active:Active={sample,began,pooledAt:null,current:null};
    if(this.enabled&&this.active.size<128)this.active.set(id,active);
    let pooledAt=began;
    let finished=false;
    return {
      acquired:(raw:PoolClient):PoolClient=>{
        if(!this.enabled)return raw;
        pooledAt=performance.now();sample.poolWaitMs=pooledAt-began;
        active.pooledAt=pooledAt;sample.backendPid=(raw as PoolClient&{processID?:number}).processID??null;
        return new Proxy(raw,{get(target,property){
          if(property!=='query')return Reflect.get(target,property,target);
          return (...args:unknown[])=>{
            const started=performance.now(),detail=statement(args[0]),step:Step={...detail,elapsedMs:0,startedAt:Date.now(),endedAt:null};active.current=step;
            const ended=()=>{const ms=performance.now()-started;sample.queries++;sample.sqlMs+=ms;sample.stages[detail.stage]=(sample.stages[detail.stage]??0)+ms;step.elapsedMs=round(ms);step.endedAt=Date.now();sample.steps.push(step);if(sample.steps.length>24)sample.steps.shift();active.current=null;};
            try{const result=Reflect.apply(target.query,target,args) as Promise<unknown>;return result.finally(ended);}catch(error){ended();throw error;}
          };
        }});
      },
      finish:(failed=false)=>{
        if(!this.enabled||finished)return;finished=true;
        this.active.delete(id);
        sample.failed=failed;sample.elapsedMs=performance.now()-began;
        // A pool acquisition failure has no client, so all elapsed time was waiting.
        if(pooledAt===began)sample.poolWaitMs=sample.elapsedMs;
        sample.sequence=++this.completed;if(this.samples.length===this.capacity)this.samples.shift();this.samples.push(sample);
      },
    };
  }
  snapshot(after=0){
    const window=this.samples.filter(sample=>sample.sequence>after),now=Date.now();
    const detail=(s:Sample)=>({operation:s.operation,context:s.context,backendPid:s.backendPid,sequence:s.sequence,startedAt:s.startedAt,elapsedMs:round(s.elapsedMs),poolWaitMs:round(s.poolWaitMs),queries:s.queries,failed:s.failed,omittedSteps:Math.max(0,s.queries-s.steps.length),steps:s.steps.map(step=>({...step}))});
    return {enabled:this.enabled,capacity:this.capacity,completed:this.completed,after,retained:window.length,dropped:Math.max(0,this.completed-this.samples.length),eventLoopDelayMs:this.loop?{p95:round(this.loop.percentile(95)/1e6),max:round(this.loop.max/1e6)}:null,active:[...this.active.values()].map(a=>({operation:a.sample.operation,context:a.sample.context,backendPid:a.sample.backendPid,startedAt:a.sample.startedAt,elapsedMs:round(performance.now()-a.began),phase:a.current?'query':a.pooledAt===null?'pool_wait':'local',idleMs:a.current?0:Math.max(0,now-(a.sample.steps.at(-1)?.endedAt??a.sample.startedAt)),currentQuery:a.current?{...a.current,elapsedMs:Math.max(0,now-a.current.startedAt)}:null,lastQuery:a.sample.steps.at(-1)?{...a.sample.steps.at(-1)}:null})),slowOperations:[...window].sort((a,b)=>b.elapsedMs-a.elapsedMs).slice(0,8).map(detail),operations:Object.fromEntries(OPERATIONS.map(operation=>{
      const samples=window.filter(s=>s.operation===operation),labels=new Set(samples.flatMap(s=>Object.keys(s.stages)));
      return [operation,{samples:samples.length,failures:samples.filter(s=>s.failed).length,elapsedMs:distribution(samples.map(s=>s.elapsedMs)),poolWaitMs:distribution(samples.map(s=>s.poolWaitMs)),queries:distribution(samples.map(s=>s.queries)),sqlMs:distribution(samples.map(s=>s.sqlMs)),localMs:distribution(samples.map(s=>Math.max(0,s.elapsedMs-s.poolWaitMs-s.sqlMs))),stages:Object.fromEntries([...labels].sort().map(label=>[label,distribution(samples.map(s=>s.stages[label]??0))]))}];
    }))};
  }
}

export const hotPathDiagnostics=new HotPathDiagnostics(process.env.CONTROL_PLANE_DIAGNOSTICS==='true');
