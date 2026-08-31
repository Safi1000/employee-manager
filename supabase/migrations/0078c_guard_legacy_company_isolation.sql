-- Drop the legacy `company_isolation` policy from any table that has already
-- moved to `company_members`. Same block now guarding the tail of
-- 0078b_missing_base_tables.sql.
--
-- Dev carries three of these — cash_locations, custody_transfers,
-- partner_account_entries — because 0078b, a recovery migration written long
-- after 0136 and 0211, was applied to dev out of order and reintroduced a policy
-- those two had already dropped. Prod does not have them.
do $legacy_rls$
declare r record;
begin
  for r in
    select p.tablename
      from pg_policies p
     where p.schemaname = 'public'
       and p.policyname = 'company_isolation'
       and exists (
         select 1 from pg_policies m
          where m.schemaname = 'public'
            and m.tablename = p.tablename
            and m.policyname = 'company_members')
  loop
    execute format('drop policy if exists company_isolation on public.%I', r.tablename);
    raise notice '0078b guard: dropped legacy company_isolation on %', r.tablename;
  end loop;
end
$legacy_rls$;