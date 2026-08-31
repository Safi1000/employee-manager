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

-- 0179b: Three columns that exist in production but were added directly in the
-- SQL editor and never captured as a migration.
--
-- Recovered while rebuilding the database from scratch (see
-- docs/MIGRATION_DIVERGENCE.md for the wider story). These are a category the
-- name-based check in scripts/check-migrations.mjs cannot see: they were never
-- migrations at all, so no `schema_migrations` row exists to go looking for.
-- They surface only when the repo is replayed into an empty database — 0195's
-- company-scoped unique index needs group_key, and the expense screens read
-- expenses.expense_by.
--
-- The rest of what this file originally carried turned out to be covered
-- already: clients.workout_account / credit_ceiling / receivable_owner_branch_id
-- / attendance_billing and the finance_settings columns come from 0109b,
-- employees.physical_copy_present from 0112, ho_allocation_runs.unallocated
-- from 0225.

alter table public.attendance_confirmations
  add column if not exists category text,
  add column if not exists group_key text;

-- Prod has group_key NOT NULL. Every insert path sets it, and on a fresh
-- database the table is empty, so the constraint can go on immediately. The
-- backfill covers the case where rows already exist.
update public.attendance_confirmations set group_key = id::text where group_key is null;
alter table public.attendance_confirmations alter column group_key set not null;

alter table public.expenses
  add column if not exists expense_by uuid references public.employees(id);
