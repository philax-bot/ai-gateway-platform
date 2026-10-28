import type { PoolClient } from 'pg';

type Operation = 'authorize' | 'settle' | 'resolve_credential' | 'workspace_write' | 'workspace_view';
interface Sample { operation:Operation; elapsedMs:number; poolWaitMs:number; queries:number; sqlMs:number; stages:Record<string,number>; failed:boolean }
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

/** Opt-in, bounded, process-local timing for controlled diagnosis, not an accounting store. */
export class HotPathDiagnostics {
  private samples:Sample[]=[];
  private completed=0;
  constructor(readonly enabled=false,private readonly capacity=2048){}
  start(operation:Operation){
    const began=performance.now();
    const sample:Sample={operation,elapsedMs:0,poolWaitMs:0,queries:0,sqlMs:0,stages:{},failed:false};
    let pooledAt=began;
    let finished=false;
    return {
      acquired:(raw:PoolClient):PoolClient=>{
        if(!this.enabled)return raw;
        pooledAt=performance.now();sample.poolWaitMs=pooledAt-began;
        return new Proxy(raw,{get(target,property){
          if(property!=='query')return Reflect.get(target,property,target);
          return (...args:unknown[])=>{
            const started=performance.now(),label=stage(args[0]);
            const result=Reflect.apply(target.query,target,args) as Promise<unknown>;
            return result.finally(()=>{const ms=performance.now()-started;sample.queries++;sample.sqlMs+=ms;sample.stages[label]=(sample.stages[label]??0)+ms;});
          };
        }});
      },
      finish:(failed=false)=>{
        if(!this.enabled||finished)return;finished=true;
        sample.failed=failed;sample.elapsedMs=performance.now()-began;
        // A pool acquisition failure has no client, so all elapsed time was waiting.
        if(pooledAt===began)sample.poolWaitMs=sample.elapsedMs;
        this.completed++;if(this.samples.length===this.capacity)this.samples.shift();this.samples.push(sample);
      },
    };
  }
  snapshot(){
    return {enabled:this.enabled,capacity:this.capacity,completed:this.completed,retained:this.samples.length,dropped:Math.max(0,this.completed-this.samples.length),operations:Object.fromEntries((['authorize','settle','resolve_credential','workspace_write','workspace_view'] as Operation[]).map(operation=>{
      const samples=this.samples.filter(s=>s.operation===operation),labels=new Set(samples.flatMap(s=>Object.keys(s.stages)));
      return [operation,{samples:samples.length,failures:samples.filter(s=>s.failed).length,elapsedMs:distribution(samples.map(s=>s.elapsedMs)),poolWaitMs:distribution(samples.map(s=>s.poolWaitMs)),queries:distribution(samples.map(s=>s.queries)),sqlMs:distribution(samples.map(s=>s.sqlMs)),localMs:distribution(samples.map(s=>Math.max(0,s.elapsedMs-s.poolWaitMs-s.sqlMs))),stages:Object.fromEntries([...labels].sort().map(label=>[label,distribution(samples.map(s=>s.stages[label]??0))]))}];
    }))};
  }
}

export const hotPathDiagnostics=new HotPathDiagnostics(process.env.CONTROL_PLANE_DIAGNOSTICS==='true');
