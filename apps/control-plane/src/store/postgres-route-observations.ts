import type {Pool,PoolClient} from 'pg';
import type {RouteObservation} from './pool-routing';

export async function postgresRouteObservations(client:Pool|PoolClient,serviceIds:string[]):Promise<RouteObservation[]>{
  if(!serviceIds.length)return [];
  const recent=await client.query(`select admission->'route'->>'serviceId' as service_id,
    admission->'route'->>'definitionId' as definition_id,outcome,completed_at,latency_ms,ttft_ms
    from call_logs where forwarded=true and completed_at>clock_timestamp()-interval '10 minutes'
    and admission->'route'->>'serviceId'=any($1::text[])
    and outcome in ('completed','upstream_error','timeout','partial')
    order by completed_at desc limit 10000`,[serviceIds]);
  const groups=new Map<string,typeof recent.rows>();
  for(const row of recent.rows){
    const key=JSON.stringify([row.service_id,row.definition_id]);
    const group=groups.get(key);
    if(group)group.push(row);else groups.set(key,[row]);
  }
  return [...groups.values()].map(rows=>{
    let failures=0;
    for(const row of rows){if(row.outcome==='completed')break;failures++;}
    const samples=rows.filter(row=>row.outcome==='completed'&&row.latency_ms!==null);
    return {
      serviceId:rows[0].service_id,definitionId:rows[0].definition_id,
      failures,recent:rows.length,failedAt:rows[0].completed_at.getTime(),samples:samples.length,
      latency:samples.length?samples.reduce((sum,row)=>sum+Number(row.ttft_ms??row.latency_ms),0)/samples.length:null,
    };
  });
}
