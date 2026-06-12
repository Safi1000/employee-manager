-- Items 8 & 9: leave carry-forward control.
--
-- Bug (item 8): the payroll carry-forward looked back a FIXED 12 months and
-- compounded the monthly allowance, so an employee with no recorded leave usage
-- accrued 13 × allowed_leaves_per_month (e.g. 13 × 5 = 65) out of nowhere — even
-- for months before carry-forward was ever switched on.
--
-- Fix (item 9): anchor accrual to an explicit start month per client. When a
-- user enables carry-forward they choose either to roll over employees' existing
-- reserve (anchor backdated) or to start accruing fresh from now (anchor = this
-- month). Payroll only accumulates unused leaves from this anchor forward.
alter table public.clients
  add column if not exists leave_carry_start date;
