alter table quota_batches add column if not exists organization_id text;
alter table quota_batches add column if not exists project_id text;
update quota_batches set organization_id='org-demo'
  where id='personal-batch-demo-001' and organization_id is null;

alter table authorization_records add column if not exists idempotency_key text;
alter table authorization_records add column if not exists fingerprint text;
update authorization_records a set idempotency_key=r.idempotency_key, fingerprint=r.fingerprint
  from reservations r where a.request_id=r.request_id and a.idempotency_key is null;
create unique index if not exists authorization_records_idempotency_idx
  on authorization_records(idempotency_key) where idempotency_key is not null;

alter table call_logs add column if not exists project_id text;
create index if not exists quota_batches_scope_idx
  on quota_batches(organization_id, source_id, purpose, project_id, expires_at);
