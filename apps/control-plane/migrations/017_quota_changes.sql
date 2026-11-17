alter table quota_batches add column if not exists returned_amount numeric(18,6) not null default 0;
alter table quota_batches add constraint quota_returned_balance_check
  check (returned_amount >= 0 and (accounting or available_amount + closed_amount + returned_amount <= total_amount));
