-- Lock protocol v2 needs a coordinated control-plane restart: existing writers
-- must stop before new admissions switch from the workspace row to the policy fence.
-- The migration ledger also makes older releases reject an upgraded schema at startup.
alter table platform_installation add column if not exists admission_lock_version integer not null default 2 check(admission_lock_version=2);
