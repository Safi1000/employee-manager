-- 0203b: drop public.partnership_allocation so 0204_partnership_revenue_basis_total_income can redefine it.
--
-- 0204 changes it again for the total-income basis. Postgres refuses `create or replace function` across a change of
-- return type ("cannot change return type of existing function"), so replaying
-- this repo into an empty database dies at 0204_partnership_revenue_basis_total_income. Production never hit it
-- because the old function was dropped by hand in the SQL editor at the time —
-- a step that was never written down.
--
-- WHY THE GUARD
--   On a database that is already fully migrated, 0204_partnership_revenue_basis_total_income will NOT run again: the
--   runner skips it as already applied. An unguarded drop here would therefore
--   remove partnership_allocation and leave nothing to recreate it, breaking
--   partner allocation reporting on prod and dev alike.
--
--   So this only acts during a genuine forward replay. If the ledger already
--   contains a migration that sorts after this file, the database is past this
--   point in history and the drop is skipped.
--
-- Dropping is safe: no view or table depends on the function (only
-- partner_ledger calls it, from inside its body, which is not a hard dependency).

do $drop_pa$
declare
  v_max text;
  r     record;
begin
  select max(version) into v_max from supabase_migrations.schema_migrations;

  if v_max is not null and v_max > '0203b' then
    raise notice '0203b: later migrations already applied (max=%) — leaving partnership_allocation alone', v_max;
    return;
  end if;

  for r in
    select oid::regprocedure as sig
      from pg_proc
     where pronamespace = 'public'::regnamespace
       and proname = 'partnership_allocation'
  loop
    execute 'drop function if exists ' || r.sig;
  end loop;
end
$drop_pa$;
