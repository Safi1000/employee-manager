-- 0111 — close the anon-readable employee_branch_realign backup table
--
-- RECOVERED from supabase_migrations.schema_migrations on 2026-08-31.
-- This migration was applied directly to the database (SQL editor / MCP) and
-- never written back to the repo. Committed verbatim so the repo records what
-- actually ran. See docs/MIGRATION_DIVERGENCE.md.

-- Non-destructive: keep the rows, but restrict reads to unscoped
-- super-super-admins only.
do $$ begin
  if exists (select 1 from information_schema.tables
             where table_schema='public' and table_name='employee_branch_realign_backup_20260618') then
    execute 'alter table public.employee_branch_realign_backup_20260618 enable row level security';
    execute 'drop policy if exists "ssa_only" on public.employee_branch_realign_backup_20260618';
    execute 'create policy "ssa_only" on public.employee_branch_realign_backup_20260618 for all
             using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped())';
  end if;
end $$;
