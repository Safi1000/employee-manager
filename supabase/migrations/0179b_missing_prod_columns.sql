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
