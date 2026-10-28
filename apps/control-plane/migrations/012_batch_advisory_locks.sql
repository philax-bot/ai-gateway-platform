-- The caller supplies the same sorted, deduplicated keys as earlier releases.
-- FOREACH preserves that order without a client/server round trip per lock.
create or replace function gateway_lock_keys(keys text[]) returns void
language plpgsql as $$
declare lock_key text;
begin
  foreach lock_key in array keys loop
    perform pg_advisory_xact_lock(hashtextextended(lock_key,0));
  end loop;
end;
$$;
