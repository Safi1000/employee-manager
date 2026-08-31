-- 0224b: drop public.partnership_allocation so 0225_ho_allocation_revenue_driver can redefine it.
--
-- 0225 redefines it for the revenue driver. Postgres refuses `create or replace function` across a change of
-- return type ("cannot change return type of existing function"), so replaying
-- this repo into an empty database dies at 0225_ho_allocation_revenue_driver. Production never hit it
-- because the old function was dropped by hand in the SQL editor at the time —
-- a step that was never written down.
--
-- WHY THE GUARD
--   On a database that is already fully migrated, 0225_ho_allocation_revenue_driver will NOT run again: the
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

-- GUARD. This tests the condition it actually means: has 0225 already run?
--
-- The previous guard compared max(schema_migrations.version) against the string
-- '0224b'. That worked on production only by accident — production's versions are
-- timestamps ('20260831041236'), and '2' > '0' in a string comparison, so it
-- returned early for the wrong reason. Had production's versioning scheme ever
-- changed, the guard would have dropped partnership_allocation with nothing left
-- to recreate it, because 0225 is skipped on an already-migrated database.
--
-- branch_revenue_for_month is the exact marker: 0225 creates it, and 0225 is what
-- recreates partnership_allocation afterwards. If it exists, 0225 has run and
-- there is nothing here to clear.
do $drop_pa$
declare
  r record;
begin
  if exists (select 1 from pg_proc p
              join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'branch_revenue_for_month') then
    raise notice '0224b: branch_revenue_for_month exists — 0225 has run, leaving partnership_allocation alone';
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
