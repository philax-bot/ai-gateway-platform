alter table call_logs add column if not exists usage_final boolean;
create index if not exists reservations_unfinalized_expiry_idx on reservations(expires_at) where finalized=false;
create table if not exists reconciliation_records (
  request_id text primary key references reservations(request_id),
  idempotency_key text unique not null,
  fingerprint text not null,
  actor_id text not null,
  reason text not null,
  response jsonb not null,
  created_at timestamptz not null default now()
);
