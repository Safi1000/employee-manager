-- 0112 — physical copy present flag on employees
--
-- RECOVERED from supabase_migrations.schema_migrations on 2026-08-31.
-- This migration was applied directly to the database (SQL editor / MCP) and
-- never written back to the repo. Committed verbatim so the repo records what
-- actually ran. See docs/MIGRATION_DIVERGENCE.md.

alter table public.employees
  add column if not exists physical_copy_present boolean not null default false;
comment on column public.employees.physical_copy_present is
  'Ticked when the physical document copies for this employee are on file; drives the complete/incomplete profile status.';
