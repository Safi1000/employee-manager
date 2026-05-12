-- ============================================================================
-- ADDITIVE migration. No data loss.
-- - profiles.title: freeform display label for a user ("CEO", "CFO", "HR Lead", …)
--   The 'role' enum column is kept for the special super_super_admin /
--   super_admin distinctions used by RLS helpers and routing.
-- - employees.bank_name: custom bank name to accompany bank_account (account #).
-- ============================================================================

alter table public.profiles
  add column if not exists title text;

alter table public.employees
  add column if not exists bank_name text;
