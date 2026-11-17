import type {CapacitySnapshot} from '@ai-gateway/contracts';
export function capacityPrometheus(snapshot:CapacitySnapshot){
  const lines=['# HELP atlas_capacity_collection_success Whether capacity collection succeeded.','# TYPE atlas_capacity_collection_success gauge',`atlas_capacity_collection_success ${snapshot.quality==='collected'?1:0}`];
  if(snapshot.quality!=='collected')return lines.join('\n')+'\n';
  const escape=(s:string)=>s.replace(/\\/g,'\\\\').replace(/\n/g,'\\n').replace(/"/g,'\\"');
  for(const metric of ['rpm','tpm','concurrency'] as const){
    for(const suffix of ['used','limit','ratio'])lines.push(`# TYPE atlas_capacity_${metric}_${suffix} gauge`);
    for(const row of snapshot.rows){const value=row[metric],labels=`kind="${row.kind}",resource_id="${escape(row.resourceId)}",model="${escape(row.modelId??'')}"`;
      lines.push(`atlas_capacity_${metric}_used{${labels}} ${value.used}`);
      if(value.limit!==null)lines.push(`atlas_capacity_${metric}_limit{${labels}} ${value.limit}`);
      if(value.percent!==null)lines.push(`atlas_capacity_${metric}_ratio{${labels}} ${value.percent/100}`);
    }
  }
  lines.push('# TYPE atlas_capacity_collected_at_seconds gauge',`atlas_capacity_collected_at_seconds ${Date.parse(snapshot.collectedAt)/1000}`);
  return lines.join('\n')+'\n';
}
