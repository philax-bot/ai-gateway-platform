create table if not exists credentials (
  credential_id text primary key,
  api_key text unique not null,
  identity jsonb not null,
  purpose text not null,
  active boolean not null default true,
  model_ids jsonb not null
);

create table if not exists quota_batches (
  id text primary key,
  source_type text not null,
  source_id text not null,
  purpose text not null,
  total_amount numeric(18,6) not null,
  available_amount numeric(18,6) not null,
  model_ids jsonb not null,
  expires_at timestamptz not null
);

create table if not exists reservations (
  reservation_id text primary key,
  request_id text unique not null,
  idempotency_key text unique not null,
  fingerprint text not null,
  amount numeric(18,6) not null,
  batch_id text not null references quota_batches(id),
  identity jsonb not null,
  purpose text not null,
  model_id text not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  finalized boolean not null default false
);

create table if not exists authorization_records (
  request_id text primary key,
  response jsonb not null
);

create table if not exists settlement_records (
  request_id text primary key,
  idempotency_key text,
  response jsonb not null
);

alter table settlement_records add column if not exists idempotency_key text;
create unique index if not exists settlement_records_idempotency_key_idx
  on settlement_records (idempotency_key) where idempotency_key is not null;

create table if not exists call_logs (
  request_id text primary key,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  subject_type text not null,
  subject_id text not null,
  credential_id text not null,
  purpose text not null,
  model_id text not null,
  outcome text not null,
  input_tokens integer not null,
  output_tokens integer not null,
  cached_input_tokens integer not null,
  actual_amount numeric(18,6) not null,
  billable_state text not null,
  reservation_id text
);
