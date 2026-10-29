-- Configuration operations contain references and fingerprints, never upstream credentials.
create table gateway_sync_state (
  resource_id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
