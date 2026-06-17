-- Opening leaves are an OVERRIDE of the accumulated leave balance (they replace
-- whatever the carry-forward accrual had built up), effective from the month the
-- value is entered. We record that effective month so payroll has a stable
-- anchor: from this month forward the balance is
--   available = opening + monthly_allowed − leaves_taken   (then rolled forward)
-- and months before it keep their original accrual.
--
-- Set together with employees.opening_leaves on the one-time save; null when no
-- opening has been set.
alter table public.employees
  add column if not exists opening_leaves_month date;
