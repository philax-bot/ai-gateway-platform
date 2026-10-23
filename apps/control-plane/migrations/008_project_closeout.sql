alter table quota_batches add column if not exists closed_at timestamptz;
alter table quota_batches add column if not exists closed_amount numeric(18,6) not null default 0;
alter table project_budget_batches add column if not exists closed_at timestamptz;
alter table project_budget_batches add column if not exists closed_amount numeric(18,6) not null default 0;
do $$ begin
  if not exists(select 1 from pg_constraint where conname='quota_closed_balance_check' and conrelid='quota_batches'::regclass) then
    alter table quota_batches add constraint quota_closed_balance_check check(closed_amount>=0 and available_amount>=0 and available_amount+closed_amount<=total_amount);
  end if;
  if not exists(select 1 from pg_constraint where conname='budget_closed_balance_check' and conrelid='project_budget_batches'::regclass) then
    alter table project_budget_batches add constraint budget_closed_balance_check check(closed_amount>=0 and available_amount+closed_amount<=total_amount);
  end if;
end $$;
