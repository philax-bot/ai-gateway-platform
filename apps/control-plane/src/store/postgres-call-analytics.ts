import type { PoolClient } from 'pg';
import type { UsageAnalytics, UsageAnalyticsQuery, UsageBucket } from '@ai-gateway/contracts';
import type { CallScope } from './call-query';
import { emptyCost, normalizeUsageQuery } from './call-analytics';

interface AnalyticsRow {
  comparableRequests:number|string;
  dimension: string;
  knownCost:number|string; unknownCost:number|string; comparableBilled:number|string; comparableCost:number|string;
  key: string;
  requests: string | number;
  unknownUsage: string | number;
  inputTokens: string | number;
  outputTokens: string | number;
  cachedInputTokens: string | number;
  confirmedAmount: string | number;
  pendingReview: string | number;
  pendingAmount: string | number;
  errors: string | number;
  forwarded: string | number;
  upstreamFailures: string | number;
  lastActiveAt: Date | string | null;
}

/**
 * One static statement, one scan. Every narrowing (window, model, organization,
 * purpose, caller scope) is a bind parameter, including the caller-scope switch:
 * nothing from the request is ever interpolated into SQL.
 *
 * Denominators match `summarizeCalls`: only finalized usage contributes tokens,
 * only confirmed calls contribute money, and upstream failures are counted over
 * forwarded calls.
 */
const usageSql = `
with window_rows as materialized (
  select *, case
    when forwarded is false then 0::numeric
    when forwarded is true and usage_final=true and admission->'costPrice'->'meter' is not null and metered_usage is not null and metered_usage->>'unit'=admission->'costPrice'->'meter'->>'unit' then
      ceil((metered_usage->>'quantity')::numeric * (admission->'costPrice'->'meter'->>'price')::numeric * 1000000 / case when metered_usage->>'unit'='per_1000_characters' then 1000 else 1 end)/1000000
    when forwarded is true and usage_final = true and jsonb_typeof(admission->'costPrice') = 'object' then
      ceil(((input_tokens-cached_input_tokens)::numeric * (admission->'costPrice'->>'inputPrice')::numeric
        + output_tokens::numeric * (admission->'costPrice'->>'outputPrice')::numeric
        + cached_input_tokens::numeric * (admission->'costPrice'->>'cachedInputPrice')::numeric)) / 1000000
    else null end as request_cost
  from call_logs
  where completed_at >= $1::timestamptz
    and completed_at < $2::timestamptz
    and ($3::text is null or model_id = $3::text)
    and ($4::text is null or coalesce(admission->>'attributionOrganizationId',organization_id) = $4::text)
    and ($5::text is null or purpose = $5::text)
    and ($11::text is null or project_id = $11::text)
    and ($12::text is null or (subject_type = 'application' and subject_id = $12::text))
    and ($13::text is null or admission->'route'->>'serviceId' = $13::text)
    and ($6::boolean is false or (subject_type = 'employee' and subject_id = $7::text)
         or (subject_type = 'application' and subject_id = any($8::text[]))
         or (purpose = 'project' and project_id = any($10::text[])))
)
select dimension, key,
  count(*) filter (where billable_state = 'confirmed' and request_cost is not null) as "comparableRequests",
  coalesce(sum(request_cost),0) as "knownCost",
  count(*) filter (where request_cost is null) as "unknownCost",
  coalesce(sum(actual_amount) filter (where billable_state = 'confirmed' and request_cost is not null),0) as "comparableBilled",
  coalesce(sum(request_cost) filter (where billable_state = 'confirmed' and request_cost is not null),0) as "comparableCost",
  count(*) as "requests",
  count(*) filter (where usage_final is distinct from true) as "unknownUsage",
  coalesce(sum(input_tokens) filter (where usage_final = true),0) as "inputTokens",
  coalesce(sum(output_tokens) filter (where usage_final = true),0) as "outputTokens",
  coalesce(sum(cached_input_tokens) filter (where usage_final = true),0) as "cachedInputTokens",
  coalesce(sum(actual_amount) filter (where billable_state = 'confirmed'),0) as "confirmedAmount",
  count(*) filter (where billable_state = 'pending_review') as "pendingReview",
  coalesce(sum(actual_amount) filter (where billable_state = 'pending_review'),0) as "pendingAmount",
  count(*) filter (where outcome not in ('completed','client_cancelled')) as "errors",
  count(*) filter (where forwarded = true) as "forwarded",
  count(*) filter (where forwarded = true and outcome = 'upstream_error') as "upstreamFailures",
  max(completed_at) as "lastActiveAt"
from (
  select 'people' as dimension, subject_id as key, window_rows.* from window_rows where subject_type = 'employee'
  union all
  select 'applications', subject_id, window_rows.* from window_rows where subject_type = 'application'
  union all
  select 'projects', coalesce(project_id,''), window_rows.* from window_rows
  union all
  select 'models', model_id, window_rows.* from window_rows
  union all
  select 'organizations', coalesce(admission->>'attributionOrganizationId',organization_id,''), window_rows.* from window_rows
  union all
  select 'days', to_char(completed_at at time zone $9::text,'YYYY-MM-DD'), window_rows.* from window_rows
  union all
  select 'services', coalesce(admission->'route'->>'serviceId',''), window_rows.* from window_rows
  union all
  select 'totals', '', window_rows.* from window_rows
) grouped
group by dimension, key
`;

const round=(value:number)=>Number(value.toFixed(6));

function mapBucket(row:AnalyticsRow,includeCost:boolean):UsageBucket{
  const lastActiveAt=row.lastActiveAt==null?null:(row.lastActiveAt instanceof Date?row.lastActiveAt.toISOString():new Date(row.lastActiveAt).toISOString());
  return {
    ...(includeCost?{cost:{comparableRequests:Number(row.comparableRequests),knownAmount:round(Number(row.knownCost)),unknownRequests:Number(row.unknownCost),comparableBilledAmount:round(Number(row.comparableBilled)),comparableCostAmount:round(Number(row.comparableCost)),differenceAmount:round(Number(row.comparableBilled)-Number(row.comparableCost))}}:{}),
    key:row.key,requests:Number(row.requests),unknownUsage:Number(row.unknownUsage),
    inputTokens:Number(row.inputTokens),outputTokens:Number(row.outputTokens),cachedInputTokens:Number(row.cachedInputTokens),
    confirmedAmount:round(Number(row.confirmedAmount)),pendingReview:Number(row.pendingReview),pendingAmount:round(Number(row.pendingAmount)),
    errors:Number(row.errors),forwarded:Number(row.forwarded),upstreamFailures:Number(row.upstreamFailures),lastActiveAt,
  };
}

const emptyBucket=():UsageBucket=>({key:'',requests:0,unknownUsage:0,inputTokens:0,outputTokens:0,cachedInputTokens:0,confirmedAmount:0,pendingReview:0,pendingAmount:0,errors:0,forwarded:0,upstreamFailures:0,lastActiveAt:null});
const byMoney=(a:UsageBucket,b:UsageBucket)=>b.confirmedAmount-a.confirmedAmount||b.requests-a.requests||a.key.localeCompare(b.key);

export async function queryPostgresUsage(client:PoolClient,input:UsageAnalyticsQuery|undefined,scope:CallScope,timezone:string):Promise<UsageAnalytics>{
  const query=normalizeUsageQuery(input,new Date(),timezone);
  const result=await client.query<AnalyticsRow>(usageSql,[
    query.from,query.to,query.modelId??null,query.organizationId??null,query.purpose??null,
    scope!==null,scope?.employeeId??null,scope?.applicationIds??[],timezone,scope?.projectIds??[],query.projectId??null,query.applicationId??null,query.serviceId??null,
  ]);
  const buckets=(dimension:string)=>result.rows.filter(row=>row.dimension===dimension).map(row=>mapBucket({...row,key:dimension==='totals'?'':row.key},scope===null));
  const totalRow=result.rows.find(row=>row.dimension==='totals');
  const total=totalRow?mapBucket(totalRow,scope===null):{...emptyBucket(),...(scope===null?{cost:emptyCost()}:{})};
  const {key:_unused,...totalFields}=total;
  const people=buckets('people').sort(byMoney),applications=buckets('applications').sort(byMoney),projects=buckets('projects').sort(byMoney);
  return {
    from:query.from,to:query.to,timezone,
    totals:{...totalFields,activePeople:people.length,activeApplications:applications.length},
    people,applications,projects,
    models:buckets('models').sort(byMoney),
    services:buckets('services').sort(byMoney),
    organizations:buckets('organizations').sort(byMoney),
    days:buckets('days').sort((a,b)=>a.key.localeCompare(b.key)),
    collectedAt:new Date().toISOString(),
  };
}
