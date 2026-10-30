alter table call_logs add column safety jsonb;
create table safety_events (
  id text primary key,
  request_id text not null unique,
  subject_id text not null,
  purpose text not null,
  project_id text,
  model_id text not null,
  policy_version integer not null,
  action text not null check(action in ('observe','block')),
  matches jsonb not null,
  created_at timestamptz not null
);
create index safety_events_time_idx on safety_events(created_at desc,id desc);
