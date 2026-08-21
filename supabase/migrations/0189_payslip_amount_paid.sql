-- 0189: track how much of each payslip was ACTUALLY paid, so a disbursed amount
-- no longer goes stale when attendance (and therefore Net Salary) is edited later.
--
-- Before this, `disbursed` was an all-or-nothing boolean tied to whatever
-- net_salary happened to be at the click. Edit attendance afterward and the row
-- still read "Disbursed" while the cash that moved was the old figure — the
-- shortfall/overpayment vanished.
--
-- amount_paid is the cumulative cash handed over for this payslip. Balance is
-- derived at read time (net_salary − amount_paid): positive = still owed,
-- negative = overpaid (carried to next month as an advance). It is only ever
-- moved by the disburse flow, which pays out the delta and records it here.
alter table public.payslips
  add column if not exists amount_paid numeric not null default 0;

-- Existing disbursed payslips were paid in full at their net_salary, so seed
-- amount_paid to net_salary. Any whose attendance has since changed will now
-- surface the correct non-zero balance instead of hiding it.
update public.payslips
   set amount_paid = net_salary
 where disbursed = true
   and amount_paid = 0;
