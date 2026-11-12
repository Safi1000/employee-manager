-- 0668 — one guard's October 2026 pay corrected to the figure he was paid.
--
-- Employee 2171026a-56dc-46cf-960f-718701f89e0f (named in the approval, not
-- here — R2: no name beside a salary in git).
--
-- WHAT HAPPENED. He worked October at one client and moved to another on
-- 2 Nov (0629 repaired the move). He was hired with no salary. On 10 Nov a base
-- was entered on Assignments & Pay, EFFECTIVE 1 OCT, at the rate of the post he
-- had just moved INTO. The October payslip was generated from it. Accounts paid
-- the October rate on 11 Nov (one bank part), so the payslip read part-paid
-- with a balance that was never owed.
--
-- DECIDED 12 Nov 2026 (Shayan): October = the paid figure. From 1 Nov the
-- entered rate stands (it is the new post's), so employees.base_salary is NOT
-- touched.
--
-- WHAT THIS CHANGES — and what it does not:
--   1. employee_salary_history: the 10 Nov row now takes effect 1 Nov, and a
--      row for October is added. (History is display-only: nothing computes
--      from it.)
--   2. The October payslip: base / per-day / final / net set to the paid
--      figure; marked disbursed at the time of the payment already recorded,
--      status Cleared.
--   NO MONEY MOVES. The bank was debited on 11 Nov by disburse_payslip. The
--   journal trigger re-posts the accrual at the corrected figure and posts the
--   disbursement crediting the same bank from the recorded part, while the part
--   entry is retired — the bank's ledger movement is unchanged. Asserted below.

do $$
declare
  v_emp  constant uuid := '2171026a-56dc-46cf-960f-718701f89e0f';
  v_ps   constant uuid := '6e0fe8ae-1389-43f8-93a9-225439f127b3';
  v_pay  constant uuid := 'a5919e9f-39c0-42df-88a3-06cd21943d7a';
  v_oct  constant numeric := 34000;
  v_nov  constant numeric := 37000;
  v_n    int;
  v_bank_before numeric;
  v_bank_after  numeric;
  v_payable     numeric;
  v_exp         numeric;
begin
  -- Preconditions: exactly the state found on 12 Nov, or refuse.
  if not exists (select 1 from public.payslips
                  where id = v_ps and employee_id = v_emp and period_month = '2026-10-01'
                    and net_salary = v_nov and final_salary = v_nov and base_salary = v_nov
                    and amount_paid = v_oct and not disbursed and payroll_run_id is null
                    and coalesce(advance,0) = 0 and coalesce(deductions,0) = 0
                    and coalesce(bonus,0) = 0 and coalesce(allowance,0) = 0
                    and coalesce(eobi,0) = 0 and coalesce(income_tax,0) = 0
                    and coalesce(loan_recovery,0) = 0) then
    raise exception '0668 REFUSED: the October payslip is not in the state this correction expects.';
  end if;
  if (select count(*) from public.payslip_payments where payslip_id = v_ps) <> 1
     or not exists (select 1 from public.payslip_payments where id = v_pay and payslip_id = v_ps and amount = v_oct) then
    raise exception '0668 REFUSED: expected exactly one recorded payment part of the October figure.';
  end if;
  if (select count(*) from public.employee_salary_history where employee_id = v_emp) <> 1
     or not exists (select 1 from public.employee_salary_history
                     where employee_id = v_emp and effective_date = '2026-10-01' and base_salary = v_nov) then
    raise exception '0668 REFUSED: salary history is not the single 10 Nov row this expects.';
  end if;
  if not exists (select 1 from public.employees where id = v_emp and base_salary = v_nov) then
    raise exception '0668 REFUSED: current base salary is not the figure expected to stand from 1 Nov.';
  end if;

  -- The bank's ledger movement for this payslip, before.
  select coalesce(sum(jl.credit - jl.debit), 0) into v_bank_before
    from public.journal_entries je join public.journal_lines jl on jl.journal_entry_id = je.id
   where je.source_id in (v_ps, v_pay)
     and jl.account_id = public.settlement_account(je.company_id, 'Bank',
           '1df9eaa6-afdb-48d1-8f8e-8c69ba867787'::uuid, null, true);
  if v_bank_before <> v_oct then
    raise exception '0668 REFUSED: the bank shows % credited for this payslip, expected %.', v_bank_before, v_oct;
  end if;

  -- 1. Salary history.
  update public.employee_salary_history
     set effective_date = '2026-11-01',
         reason = reason || ' — effective 1 Nov 2026, the new post''s rate (0668; was entered effective 1 Oct)'
   where employee_id = v_emp and effective_date = '2026-10-01' and base_salary = v_nov;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception '0668 REFUSED: expected to move one history row, moved %.', v_n; end if;

  insert into public.employee_salary_history (company_id, employee_id, effective_date, base_salary, allowance, per_day_salary, reason)
  select company_id, v_emp, '2026-10-01', v_oct, 0, round(v_oct / 31, 2),
         'October 2026 rate, as paid — DECIDED 12 Nov 2026 by Shayan (0668)'
    from public.employees where id = v_emp;

  -- 2. The payslip.
  update public.payslips
     set base_salary = v_oct, per_day_salary = round(v_oct / 31),
         final_salary = v_oct, net_salary = v_oct,
         disbursed = true,
         disbursed_at = (select paid_at from public.payslip_payments where id = v_pay),
         status = 'Cleared',
         notes = coalesce(notes || E'\n', '') || 'October corrected to the rate paid (0668, 12 Nov 2026).'
   where id = v_ps and amount_paid = v_oct and not disbursed;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception '0668 REFUSED: expected to correct one payslip, changed %.', v_n; end if;

  -- Assert on what can break: the bank must still show exactly one movement of
  -- the paid figure (no second payment posted, none lost) ...
  select coalesce(sum(jl.credit - jl.debit), 0) into v_bank_after
    from public.journal_entries je join public.journal_lines jl on jl.journal_entry_id = je.id
   where je.source_id in (v_ps, v_pay)
     and jl.account_id = public.settlement_account(je.company_id, 'Bank',
           '1df9eaa6-afdb-48d1-8f8e-8c69ba867787'::uuid, null, true);
  if v_bank_after <> v_oct then
    raise exception '0668 FAILED: bank movement for this payslip is % after, expected %.', v_bank_after, v_oct;
  end if;

  -- ... salaries payable for it must net to zero (accrued = paid) ...
  select coalesce(sum(jl.credit - jl.debit), 0) into v_payable
    from public.journal_entries je join public.journal_lines jl on jl.journal_entry_id = je.id
   where je.source_id in (v_ps, v_pay)
     and jl.account_id = (select a.id from public.chart_of_accounts a
                           where a.company_id = je.company_id and a.system_key = 'salaries_payable');
  if v_payable <> 0 then
    raise exception '0668 FAILED: salaries payable for this payslip nets to %, expected 0.', v_payable;
  end if;

  -- ... and the October expense must be the corrected figure.
  select coalesce(sum(jl.debit - jl.credit), 0) into v_exp
    from public.journal_entries je join public.journal_lines jl on jl.journal_entry_id = je.id
   where je.source_table = 'payslips' and je.source_id = v_ps
     and jl.account_id <> (select a.id from public.chart_of_accounts a
                            where a.company_id = je.company_id and a.system_key = 'salaries_payable');
  if v_exp <> v_oct then
    raise exception '0668 FAILED: October salary expense for this payslip is %, expected %.', v_exp, v_oct;
  end if;
end $$;