-- 0422: un-disburse GGS-00287 Abdul Tanvir's August 2026 salary. It was paid
-- out of Askari Bank and should not have been.
--
-- Reported by the user as "MIU-001 Abdul Tanvir, salary disbursement wrong bank
-- selected, reverse this". MIU-001 is the client-prefixed display code; the
-- permanent code is GGS-00287, and this file resolves him by that plus the
-- period rather than by a uuid nobody can check by eye.
--
-- WHAT IS BEING REVERSED, AND WHAT IS NOT. The payslip carries two journal
-- entries and they are not equally wrong:
--
--   * ACCRUAL (2026-08-01) — Dr 5000 Guard Payroll 35,000 / Cr 2100 Salaries
--     Payable 35,000. CORRECT AND UNTOUCHED. He worked August and is owed the
--     money; that is true regardless of which account it was mistakenly paid
--     from. Reversing it would delete the liability and leave him owed nothing.
--   * DISBURSEMENT (2026-09-10) — Dr 2100 Salaries Payable 35,000 / Cr 1010.02
--     Askari Bank 35,000. THIS is the mistake, and only this.
--
-- After this runs the payslip is Pending again, the 35,000 is back in Askari,
-- and Salaries Payable carries the 35,000 he is still owed — which is exactly
-- the state the board was in before somebody picked the wrong bank.
--
-- THE GENERAL LEDGER IS REVERSED BY A TRIGGER, NOT BY THIS FILE. `journal_on_payslip`
-- carries an arm reading `if old.disbursed and not new.disbursed then
-- reverse_journal_for_source(..., 'payslips_disbursement', ...)`. So flipping
-- `disbursed` to false is the whole GL instruction. Calling
-- `reverse_journal_for_source` here as well would be harmless — it skips
-- entries that already have a reversal — but it would read as though the file
-- were doing the work, and the next person to change the trigger would not know
-- this file depended on it.
--
-- THE BANK BALANCE IS NOT. The trigger touches the ledger only; nothing in it
-- moves `bank_accounts.balance` or writes `bank_transactions`. That half is
-- done here, through `apply_money_delta` (0380) — the one definition of how a
-- balance moves — and not by adding 35,000 to the column directly.
--
-- OBSERVED IN PASSING, NOT FIXED HERE: the original disbursement's
-- bank_transactions row carries `reference_id = NULL`, so nothing links that
-- money movement back to the payslip that caused it. It had to be identified by
-- amount, account and description text. The reversal below DOES set
-- reference_id. DEFERRED — whoever writes the disbursement path should pass the
-- payslip id, and until they do, an audit of "which payslip moved this money"
-- is a string match.

do $$
declare
  v_payslip   uuid;
  v_company   uuid;
  v_bank      uuid;
  v_net       numeric;
  v_bal_before numeric;
  v_bal_after  numeric;
  v_tx_before  int;
  v_n          int;
  v_rev        int;
  v_payable    numeric;
begin
  -- ------------------------------------------------------------------------
  -- Resolve, and refuse anything that is not the single row described above.
  -- ------------------------------------------------------------------------
  select p.id, p.company_id, p.bank_account_id, p.net_salary
    into v_payslip, v_company, v_bank, v_net
    from public.payslips p
    join public.employees e on e.id = p.employee_id
   where e.employee_code = 'GGS-00287'
     and p.period_month = date '2026-08-01';
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception '0422: GGS-00287 has % payslip(s) for 2026-08, expected exactly 1', v_n;
  end if;

  -- Every precondition named separately, so a refusal says which assumption
  -- stopped being true rather than "something changed".
  if not exists (select 1 from public.payslips where id = v_payslip and disbursed) then
    raise exception '0422: that payslip is already not disbursed — someone has reversed it already';
  end if;
  if v_bank is null then
    raise exception '0422: the payslip names no bank account, so there is no bank movement to reverse';
  end if;
  if not exists (select 1 from public.bank_accounts
                  where id = v_bank and bank_name = 'Askari Bank'
                    and account_number = '03410420001645') then
    raise exception '0422: the payslip does not name Askari Bank 03410420001645 — the wrong-bank claim does not describe this row';
  end if;
  if v_net <> 35000 then
    raise exception '0422: net salary is %, expected 35000', v_net;
  end if;

  select balance into v_bal_before from public.bank_accounts where id = v_bank;
  select count(*) into v_tx_before from public.bank_transactions
   where bank_account_id = v_bank and account_delta = -35000 and kind = 'payroll';
  if v_tx_before < 1 then
    raise exception '0422: no -35,000 payroll movement stands against Askari — nothing to put back';
  end if;

  -- ------------------------------------------------------------------------
  -- 1. The money goes back.
  -- ------------------------------------------------------------------------
  -- Through apply_money_delta so the balance and its audit line move together
  -- under the row lock, which is the only sanctioned way a balance moves.
  -- reference_id names the payslip, which the original movement did not.
  perform public.apply_money_delta(
    v_company, 'Bank', v_bank, 35000,
    'payroll',
    'Reverse payroll disbursement — GGS-00287 Abdul Tanvir, August 2026, paid from the wrong bank (0422)',
    v_payslip::text);

  -- ------------------------------------------------------------------------
  -- 2. The payslip goes back to Pending, and the trigger reverses the GL.
  -- ------------------------------------------------------------------------
  -- bank_account_id is CLEARED deliberately. Leaving Askari selected is how the
  -- same wrong bank gets picked again on the re-disbursement — the complaint was
  -- not that the payment happened, it was which account it came out of, so the
  -- account is the field that must be chosen afresh. payment_mode stays 'Bank';
  -- nobody said the mode was wrong.
  -- amount_paid goes to 0 and NOT to null: the column is NOT NULL. Nothing has
  -- been paid on this payslip now, and 0 is how that is spelled here — which is
  -- also why `payslips_paid_not_over_accrued` (amount_paid <= net_salary) is
  -- satisfied rather than merely unexamined.
  update public.payslips
     set disbursed       = false,
         disbursed_at    = null,
         status          = 'Pending',
         amount_paid     = 0,
         bank_account_id = null
   where id = v_payslip;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception '0422: updated % payslip rows, expected 1', v_n;
  end if;

  -- ------------------------------------------------------------------------
  -- Assertions — on the things that can break, not on the update that obviously
  -- happened.
  -- ------------------------------------------------------------------------
  -- One: the bank is up by exactly 35,000. Not "the balance changed".
  select balance into v_bal_after from public.bank_accounts where id = v_bank;
  if v_bal_after <> v_bal_before + 35000 then
    raise exception '0422: Askari moved from % to %, expected exactly +35000',
      v_bal_before, v_bal_after;
  end if;

  -- Two: the GL reversal the TRIGGER was relied on to write actually exists.
  -- This is the assertion that matters most, because the whole file delegates
  -- that half to something it does not call. A trigger silently not firing
  -- looks identical to a trigger that did.
  select count(*) into v_rev
    from public.journal_entries
   where source_table = 'payslips_disbursement'
     and source_id = v_payslip
     and is_reversal;
  if v_rev <> 1 then
    raise exception '0422: expected 1 disbursement reversal entry, found % — journal_on_payslip did not fire', v_rev;
  end if;

  -- Three: the ACCRUAL survived. Reversing the wrong leg would leave him owed
  -- nothing and would look, from the bank balance alone, exactly like success.
  if not exists (
    select 1 from public.journal_entries
     where source_table = 'payslips' and source_id = v_payslip and not is_reversal
  ) or exists (
    select 1 from public.journal_entries
     where source_table = 'payslips' and source_id = v_payslip and is_reversal
  ) then
    raise exception '0422: the August accrual is missing or has been reversed — he must still be owed the 35,000';
  end if;

  -- Four: the liability is actually back on the books, read from the LINES
  -- rather than inferred from the entries existing. 2100 Salaries Payable must
  -- net to a 35,000 credit across this payslip's four entries.
  select coalesce(sum(jl.credit - jl.debit), 0) into v_payable
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.journal_entry_id
    join public.chart_of_accounts a on a.id = jl.account_id
   where je.source_id = v_payslip and a.account_code = '2100';
  if v_payable <> 35000 then
    raise exception '0422: Salaries Payable nets to % for this payslip, expected a 35000 credit', v_payable;
  end if;

  raise notice '0422: reversed — Askari % -> %, payslip % back to Pending with no bank selected',
    v_bal_before, v_bal_after, v_payslip;
end $$;

-- TENANT GUARD ASSERTION NOT APPLICABLE: this migration defines no function and
-- adds no parameter, so it introduces no guard to gap. The detector is asserted
-- anyway — a green run is evidence about the database, not only about this file.
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception 'REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
