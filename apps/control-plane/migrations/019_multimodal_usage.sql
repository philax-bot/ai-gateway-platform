alter table call_logs add column if not exists metered_usage jsonb;
create index if not exists call_service_recent on call_logs((admission->'route'->>'serviceId'),completed_at desc) where forwarded=true;
