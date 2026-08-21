-- 0188: one-time correction of over-recorded advance recovery on existing payslips.
--
-- Before the carry-forward fix, a month whose pay could not cover the advance
-- still recorded the FULL advance as recovered (e.g. a 50k advance against a
-- 42,161 payable month stored advance = 50,000, not 42,161). That overstates
-- how much was recovered, so employee_advance_outstanding sees nothing left and
-- the remainder never appears the next month.
--
-- A payslip can never have recovered more than the pay it had to give:
--   recoverable = final_salary − income_tax − eobi   (never below 0).
-- Capping the stored advance at that turns every historical payslip into the
-- amount that was ACTUALLY recovered, so the outstanding balance — and next
-- month's deduction — become correct for everyone, with no manual re-run.
--
-- Idempotent: payslips already at or below their recoverable amount are left
-- untouched, and re-running changes nothing. Only the recorded `advance` moves;
-- net_salary is unaffected (a clamped month already netted the same figure).

update public.payslips p
   set advance = least(
         p.advance,
         greatest(p.final_salary - coalesce(p.income_tax, 0) - coalesce(p.eobi, 0), 0)
       ),
       updated_at = now()
 where p.advance > greatest(p.final_salary - coalesce(p.income_tax, 0) - coalesce(p.eobi, 0), 0);
