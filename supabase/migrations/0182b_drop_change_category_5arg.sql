-- 0182b — drop the superseded 5-argument change_category overload
--
-- RECOVERED from supabase_migrations.schema_migrations on 2026-08-31.
-- This migration was applied directly to the database (SQL editor / MCP) and
-- never written back to the repo. Committed verbatim so the repo records what
-- actually ran. See docs/MIGRATION_DIVERGENCE.md.

drop function if exists public.change_category(uuid,text,uuid,uuid,date);
