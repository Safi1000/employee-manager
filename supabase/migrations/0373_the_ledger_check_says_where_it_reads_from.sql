-- 0373 — migration_ledger_matches_repo says WHERE it reads from, so nobody
--        waits for a green that committing cannot produce.
--
-- I waited for it myself. Having written seven migration files and committed
-- them, I predicted the check would clear and it did not, because it does not
-- read the working tree: 0364 has the database FETCH the repo's file list from
-- GitHub on a schedule — request 04:30, ingest 04:45, suite reads 05:00 — and
-- compares schema_migrations against that ingested manifest.
--
-- So a local commit changes nothing at all. A PUSH and the next ingest clear it.
-- That is not a defect; it is the whole point of 0364 (the check must not
-- depend on a human doing a later optional thing). But it is invisible from the
-- check's name, and the name is what a person reads at 05:00.
--
-- Nothing about the logic changes here. Only the sentence it carries.

comment on function public.migration_ledger_drift() is
  '0364/0373: rows where supabase_migrations.schema_migrations and the repo disagree, in both directions. READS public.migration_manifest — the file list FETCHED FROM THE REMOTE at 04:30 and ingested at 04:45 — NOT the working tree. A local commit therefore never clears this check; a PUSH and the next ingest do. Reports a missing or stale manifest as a finding in its own right rather than reading green on a broken fetch. Name-level only: a file edited after it was applied is digest drift, which npm run check:migrations catches locally.';

do $$
declare v_c text;
begin
  select obj_description(p.oid, 'pg_proc') into v_c
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'migration_ledger_drift';
  if v_c is null or v_c not like '%PUSH and the next ingest%' then
    raise exception '0373 FAILED: the description did not take.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The tail required of every migration (scripts/migration-template.sql).
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0373 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
