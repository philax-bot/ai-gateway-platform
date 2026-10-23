alter table reservations add column if not exists admission jsonb;
alter table call_logs add column if not exists admission jsonb;
alter table call_logs add column if not exists error_code text;
alter table call_logs add column if not exists latency_ms integer;
alter table call_logs add column if not exists organization_id text;

create table if not exists admission_windows (
  scope_id text not null,
  window_start timestamptz not null,
  requests integer not null default 0,
  tokens bigint not null default 0,
  primary key(scope_id,window_start)
);
create table if not exists reservation_limit_scopes (
  reservation_id text not null references reservations(reservation_id),
  scope_id text not null,
  window_start timestamptz not null,
  estimated_tokens bigint not null,
  expires_at timestamptz not null,
  active boolean not null default true,
  primary key(reservation_id,scope_id)
);
create index if not exists reservation_limit_scope_active_idx on reservation_limit_scopes(scope_id,expires_at) where active=true;

create table if not exists usage_ledger_entries (
  id text primary key,
  request_id text not null,
  reservation_id text not null,
  batch_id text not null,
  kind text not null check(kind in ('settlement','release','reconciliation')),
  amount numeric(18,6) not null,
  created_at timestamptz not null default now(),
  detail jsonb not null,
  unique(request_id,kind)
);
