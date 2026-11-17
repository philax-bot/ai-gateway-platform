create table if not exists model_media_jobs (
  id uuid primary key,
  request_id text unique not null,
  payload jsonb not null,
  lease_until timestamptz,
  lease_owner text,
  updated_at timestamptz not null default now()
);
create index if not exists media_job_pending on model_media_jobs(updated_at) where payload->>'settled'='false';
