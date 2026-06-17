-- Task 1: per-employee allowance, always disbursed alongside salary regardless
-- of attendance (present/absent/leave). Added flat onto net salary, untaxed.
alter table public.employees
  add column if not exists allowance numeric(14,2) not null default 0;

-- Task 2: one-time opening leave balance, used to seed leave carry-forward
-- accrual for clients that roll leaves forward. Nullable on purpose so we can
-- distinguish "never set" (null → still editable in the form) from "set, incl.
-- 0" (locked, read-only). The payroll accrual walk starts from
-- base_allowed + opening_leaves at the carry anchor.
alter table public.employees
  add column if not exists opening_leaves integer;

-- Record the allowance actually paid on each payslip so a historical net salary
-- stays reproducible even if the employee's allowance changes later.
alter table public.payslips
  add column if not exists allowance numeric(14,2) not null default 0;
