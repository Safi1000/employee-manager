-- 0205b: drop public.partnership_allocation so 0206_partnership_allocation_client_overrides can redefine it.
--
-- 0206 changes it again for client overrides. Postgres refuses `create or replace function` across a change of
-- return type ("cannot change return type of existing function"), so replaying
-- this repo into an empty database dies at 0206_partnership_allocation_client_overrides. Production never hit it
-- because the old function was dropped by hand in the SQL editor at the time —
-- a step that was never written down.
--
-- WHY THE GUARD
--   On a database that is already fully migrated, 0206_partnership_allocation_client_overrides will NOT run again: the
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
  r record;
begin
  -- GUARD. Tests the condition it actually means: has 0206 already run?
  --
  -- This previously compared max(schema_migrations.version) against the string
  -- '0205b'. That is a proxy, not a test, and it was correct on production only
  -- by accident: production's versions are timestamps, so '2' > '0' returned
  -- early for the right reason by the wrong logic. Change the versioning scheme
  -- — or run this against a ledger using the short numbered format, as dev does
  -- — and the guard inverts, dropping partnership_allocation with nothing left
  -- to recreate it, because 0206 is skipped on an already-migrated database.
  --
  -- Asking the ledger for the successor BY NAME compares no versions at all
  -- and works on both ledger formats: production records the migration with a
  -- numeric prefix, dev records the stripped name, and removing the prefix
  -- reduces the two to the same key.
  --
  -- Two spellings because the repo filename and the name production actually
  -- recorded it under differ; see scripts/migration-aliases.txt. Matching only
  -- one of them would silently fall through to the drop.
  if exists (
    select 1 from supabase_migrations.schema_migrations m
     where regexp_replace(coalesce(nullif(m.name, ''), m.version), '^[0-9]{4}[a-z]?_', '')
           = any (array['partnership_allocation_client_overrides',
                       'partnership_allocation_honours_client_overrides'])
  ) then
    raise notice '0205b: 0206 already applied — leaving partnership_allocation alone';
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
