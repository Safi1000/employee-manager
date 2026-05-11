-- ============================================================================
-- Feature-based permissions (ADDITIVE migration; no data loss possible).
-- - Adds profiles.permissions text[] with default '{}'.
-- - Backfills existing HR/accounting users with sensible role-matching defaults
--   so they keep working after the panel-based access model is removed.
-- - super_super_admin and super_admin retain implicit "all permissions" via
--   frontend logic (not modified here).
-- ============================================================================

alter table public.profiles
  add column if not exists permissions text[] not null default '{}';

update public.profiles
set permissions = array[
  'employees.view','employees.edit',
  'attendance.view','attendance.edit',
  'documents.view','documents.edit'
]
where role = 'hr' and (permissions is null or array_length(permissions, 1) is null);

update public.profiles
set permissions = array[
  'attendance.view',
  'payroll.view','payroll.edit',
  'expenses.view','expenses.edit',
  'cashflow.view',
  'accounting.view','accounting.edit',
  'invoices.view','invoices.edit'
]
where role = 'accounting' and (permissions is null or array_length(permissions, 1) is null);
