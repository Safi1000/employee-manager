-- ============================================================================
-- DESCRIBES PRODUCTION. It does not change it.
--
-- This file was reverse-engineered FROM production (crm-design,
-- mmkfpnshxjcyijhuydgr), which already had this state before the file existed.
-- It is here so a from-scratch replay reaches the same shape, not because it
-- introduced anything.
--
-- Consequences, all of which have bitten:
--   * Production has NO schema_migrations row for it and correctly never will.
--     scripts/check-migrations.mjs reports it as "in repo, NOT recorded"; that
--     is expected for this class of file, not a defect to alias away.
--   * It is NOT safe to assume it runs at the position its number implies. It
--     was written long after the migrations that follow it, so applying it to
--     an existing database can undo later work. Guard anything order-sensitive.
--   * It reflects production as of the date it was recovered. If prod has moved
--     since, this file is stale and reconciling it is the fix.
-- ============================================================================

-- 0079b: Columns on `partners` that exist in production but were added
-- directly in the SQL editor and never captured as a migration. 0080 onwards
-- reference partners.branch_id / scope / allocation_method, so a from-scratch
-- database needs them here. Types, defaults and CHECKs mirror production.

alter table public.partners
  add column if not exists scope text not null default 'COMPANY',
  add column if not exists branch_id uuid references public.branches(id),
  add column if not exists allocation_method text not null default 'MANUAL',
  add column if not exists default_share_pct numeric(5,2),
  add column if not exists linked_user_id uuid references public.profiles(id),
  add column if not exists opening_balance_date date,
  add column if not exists is_active boolean not null default true;

alter table public.partners drop constraint if exists partners_scope_check;
alter table public.partners add constraint partners_scope_check
  check (scope in ('COMPANY', 'BRANCH'));

alter table public.partners drop constraint if exists partners_allocation_method_check;
alter table public.partners add constraint partners_allocation_method_check
  check (allocation_method in ('FIXED_PCT', 'MANUAL'));
