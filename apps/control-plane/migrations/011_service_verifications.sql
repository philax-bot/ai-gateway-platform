-- Platform diagnostic verification runs. One row per service verification; each
-- mapping result lives inside the run so a partial run stays explainable.
create table if not exists service_verification_runs (
  id text primary key,
  idempotency_key text unique not null,
  service_id text not null,
  service_name text not null,
  operator_id text not null,
  config_version integer not null,
  state text not null check(state in ('running','completed','interrupted')),
  mappings jsonb not null,
  results jsonb not null default '[]'::jsonb,
  note text,
  started_at timestamptz not null,
  completed_at timestamptz,
  lease_expires_at timestamptz not null
);
create unique index if not exists service_verification_runs_one_active
  on service_verification_runs(service_id) where state='running';
create index if not exists service_verification_runs_service_time
  on service_verification_runs(service_id, started_at desc, id desc);
