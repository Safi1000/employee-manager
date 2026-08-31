-- 0227 — Expose applied migration names so drift can be detected.
--
-- The loop-closer for docs/MIGRATION_DIVERGENCE.md. Ten migrations were applied
-- straight to the database and never written back to the repo; five of them were
-- follow-up patches written minutes after an apply, which is precisely when
-- nobody is thinking about committing a file. That drift is invisible until
-- someone builds a fresh environment and gets a different schema than
-- production.
--
-- `scripts/check-migrations.mjs` (npm run check:migrations) calls this and fails
-- if the database has applied anything the repo does not carry.
--
-- Reads only the `name` column of a system table — no SQL bodies, no data — and
-- is restricted to the service role, which is what a CI or maintainer check runs
-- as. `authenticated` and `anon` are explicitly revoked.

create or replace function public.applied_migration_names()
returns text[]
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(array_agg(m.name order by m.version), '{}')
    from supabase_migrations.schema_migrations m;
$function$;

revoke all on function public.applied_migration_names() from public, anon, authenticated;
grant execute on function public.applied_migration_names() to service_role;

comment on function public.applied_migration_names() is
  'Names of applied migrations, for scripts/check-migrations.mjs. Service role only — it reads a system schema.';
