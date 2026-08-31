-- 0283 — Expose the recorded SQL of a migration, so "the recorded SQL must
-- equal the file" can actually be checked.
--
-- CLAUDE.md states the rule and says ledger_checks() flags a mismatch.
-- scripts/check-migrations.mjs fetches digests from applied_migration_digests()
-- and **never compares them to anything**. It counts how many rows carry SQL and
-- prints a note. So the digest half of the rule has never run: the script that
-- enforces it computes nothing to compare against.
--
-- That is the fifth defect found in that script, and the most consequential,
-- because it is the one that made the rule feel enforced. Four migrations in the
-- 0262-0282 range were found to differ from their recorded SQL only by reading
-- the ledger by hand.
--
-- This function is the missing half. It returns the SQL as recorded, so a caller
-- can hash it against the file on disk. SECURITY DEFINER because
-- supabase_migrations is not readable by the API roles, and STABLE + read-only:
-- it exposes migration text, which is already in the repository, and nothing
-- else.
--
-- Granted to service_role ONLY. The migration ledger is not application data and
-- an anon or authenticated caller has no business reading it.

create or replace function public.recorded_migration_sql(p_name text)
returns text
language sql
stable
security definer
set search_path to 'public'
as $function$
  select array_to_string(m.statements, E'\n')
    from supabase_migrations.schema_migrations m
   where m.name = p_name
   limit 1;
$function$;

revoke all on function public.recorded_migration_sql(text) from public;
revoke all on function public.recorded_migration_sql(text) from anon;
revoke all on function public.recorded_migration_sql(text) from authenticated;
grant execute on function public.recorded_migration_sql(text) to service_role;

comment on function public.recorded_migration_sql(text) is
  'The SQL as recorded in supabase_migrations for one migration, so a caller can compare it to the repo file. service_role only. See 0283 — the digest comparison scripts/check-migrations.mjs was believed to perform and does not.';

do $$
begin
  if public.recorded_migration_sql('0283_recorded_migration_sql') is null
     and public.recorded_migration_sql('0282_profit_allocation_run_and_posting') is null then
    raise exception '0283: the function returns null for a migration that exists';
  end if;
end $$;