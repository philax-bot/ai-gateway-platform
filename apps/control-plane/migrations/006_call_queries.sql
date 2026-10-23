alter table call_logs add column if not exists forwarded boolean;
create index if not exists call_logs_time_request_idx on call_logs(completed_at desc, request_id desc);
create index if not exists call_logs_subject_time_idx on call_logs(subject_type,subject_id,completed_at desc,request_id desc);
create index if not exists call_logs_pending_time_idx on call_logs(completed_at desc,request_id desc) where billable_state='pending_review';
create index if not exists call_logs_service_time_idx on call_logs((admission->'route'->>'serviceId'),completed_at desc);
