import type {PoolClient} from 'pg';
import type {WorkspaceState} from '@ai-gateway/contracts';

const POLICY_FIELDS=['tenantId','keys','members','organizations','projects','applications','entitlements','pools','services','definitions','settings'] as const satisfies readonly (keyof WorkspaceState)[];
export type AdmissionWorkspace=Pick<WorkspaceState,typeof POLICY_FIELDS[number]>;
// Every identifier here is a code constant. Keep unrelated operational/history
// payloads off the per-request database response while retaining one policy snapshot.
export const ADMISSION_POLICY_SQL=`jsonb_build_object(${POLICY_FIELDS.map(field=>`'${field}',payload->'${field}'`).join(',')})`;

/** Separate the admission policy fence from the workspace JSON row's operational writes. */
export async function lockAdmissionPolicy(client:PoolClient,shared:boolean){
  const lock=shared?'pg_advisory_xact_lock_shared':'pg_advisory_xact_lock';
  await client.query(`select ${lock}(hashtextextended(current_database()||':'||current_schema()||':admission-policy-v2:'||$1,0))`,['org-demo']);
}

/** Only these runtime records can change without taking the policy writer fence. */
export function admissionPolicyState(state:WorkspaceState){
  const {monitoring,notifications,sessions,audit,retention,...policy}=state;
  return JSON.stringify(policy);
}
