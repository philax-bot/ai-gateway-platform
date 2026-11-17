-- Access attempts are separate from logical billable calls, including anonymous failures and replays.
create table if not exists gateway_request_traces (
  attempt_id uuid primary key,
  request_id text not null,
  trace_id text not null,
  started_at timestamptz not null,
  revision integer not null,
  payload jsonb not null
);
create index if not exists gateway_trace_recent on gateway_request_traces(started_at desc,attempt_id desc);
create index if not exists gateway_trace_request on gateway_request_traces(request_id);
create index if not exists gateway_trace_trace on gateway_request_traces(trace_id);
create index if not exists gateway_trace_service on gateway_request_traces((payload #>> '{route,serviceId}'),started_at desc);
create index if not exists gateway_trace_pool on gateway_request_traces((payload #>> '{route,poolId}'),started_at desc);
