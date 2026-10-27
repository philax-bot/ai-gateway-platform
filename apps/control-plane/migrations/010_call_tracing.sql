-- Explicit call tracing. Older rows stay null: history is never backfilled or inferred.
alter table reservations add column if not exists retry_of_request_id text;
alter table call_logs add column if not exists upstream_request_id text;
alter table call_logs add column if not exists retry_of_request_id text;
create index if not exists call_logs_retry_of_request_id_idx on call_logs(retry_of_request_id) where retry_of_request_id is not null;
