alter table quota_batches add column if not exists accounting boolean not null default false;
alter table quota_batches drop constraint if exists quota_closed_balance_check;
alter table quota_batches add constraint quota_closed_balance_check check (
  closed_amount>=0 and (accounting or available_amount>=0) and available_amount+closed_amount<=total_amount
);
alter table quota_batches add constraint application_accounting_scope check (
  not accounting or (source_type='application_wallet' and purpose='application' and project_id is null and total_amount=0)
);
create unique index if not exists application_accounting_source on quota_batches(source_id) where accounting;
