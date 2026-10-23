create table if not exists platform_installation (
  singleton boolean primary key default true check(singleton),
  mode text not null check(mode in ('development','production')),
  created_at timestamptz not null default now()
);
