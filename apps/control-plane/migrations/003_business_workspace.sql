create table if not exists platform_workspace (
  id text primary key,
  revision bigint not null default 0,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table quota_batches add column if not exists entitlement_id text;
alter table quota_batches add column if not exists source_batch_id text;
create index if not exists quota_batches_entitlement_idx on quota_batches(entitlement_id);

create table if not exists project_budget_batches (
  id text primary key,
  project_id text not null,
  total_amount numeric(18,6) not null check(total_amount >= 0),
  available_amount numeric(18,6) not null check(available_amount >= 0 and available_amount <= total_amount),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists project_budget_project_idx on project_budget_batches(project_id, expires_at);
