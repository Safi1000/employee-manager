-- 0231b: drop public.partnership_allocation so 0232_drop_partners_basis can redefine it.
--
-- 0232 redefines it once more after partners.basis goes. Postgres refuses `create or replace function` across a change of
-- return type ("cannot change return type of existing function"), so replaying
-- this repo into an empty database dies at 0232_drop_partners_basis. Production never hit it
-- because the old function was dropped by hand in the SQL editor at the time —
-- a step that was never written down.
--
-- WHY THE GUARD
--   On a database that is already fully migrated, 0232_drop_partners_basis will NOT run again: the
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

-- GUARD. This tests the condition it actually means: has 0232 already run?
--
-- The previous guard compared max(schema_migrations.version) against the string
-- '0231b'. That worked on production only by accident — production's versions
-- are timestamps ('20260831063626'), and '2' > '0' in a string comparison, so it
-- returned early for the wrong reason. Had production's versioning scheme ever
-- changed, the guard would have dropped partnership_allocation with nothing left
-- to recreate it, because 0232 is skipped on an already-migrated database.
--
-- partners.basis is the exact marker: 0232 drops it, and 0232 is the only thing
-- that recreates partnership_allocation afterwards. If the column is gone, 0232
-- has run and there is nothing here to clear. If it is present, we are genuinely
-- before 0232 and the drop is both safe and necessary.
do $drop_pa$
declare
  r record;
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public'
                    and table_name = 'partners'
                    and column_name = 'basis') then
    raise notice '0231b: partners.basis already dropped — 0232 has run, leaving partnership_allocation alone';
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
