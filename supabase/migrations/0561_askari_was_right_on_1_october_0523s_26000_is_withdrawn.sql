-- 0561 — Askari was right on 1 October; 0523's +26,000 is withdrawn
--
-- WHAT THE STATEMENT SAYS. Askari's statement (AskariNexCash, 1–26 Oct 2026,
-- read 2026-10-26) opens October at 3,767,902.00 (row 1: 60,000 out, leaving
-- 3,707,902.00 on 2 Oct). Bastion's stored Askari balance before its October
-- entries was 3,897,902.00; its first four entries on 1 Oct — Zamir's advance
-- 55,000, fuel 15,000 and 20,000, Shujaat's fuel-card drawing 40,000, all
-- September money — total 130,000 and bring it to 3,767,902.00. EXACT.
--
-- So on 1 October the stored balance was right. 0523 (17 Oct) then added
-- +26,000 on the reasoning that the 30 Aug advance to Bismillah Jan had been
-- counted twice — "DECIDED on the entry dates (the user is checking the
-- statement)". The statement says it was not: the stored balance had it once.
-- 0523's +26,000 was wrong, and so was 0544's Askari opening of 3,645,821
-- (= 3,619,821 + 26,000, from the same reasoning): the ledger's Askari reads
-- 3,793,902 at 30 September against the bank's 3,767,902.
--
-- Why nobody saw it: Muhammad Wali's duplicate advance of 26,000 (9 Oct; the
-- same transfer is Muhammad Abid's advance of 10 Oct, "SALARY OF MUHAMMAD ABID
-- NOV") took 26,000 off and hid it. Both balances agreed with the bank on
-- 22 Oct (6,957,115.42) with two errors cancelling. Shayan deleted the
-- duplicate today at 11:07 UTC — correctly — and the +26,000 showed.
--
-- THE FIX — withdrawing a correction, not a new money entry:
--   1. stored balance: one 'adjustment' of -26,000 through apply_money_delta,
--      referencing 0523's movement (9010aa0b);
--   2. ledger: the Askari opening corrected to 3,619,821 — Dr 3200 Opening
--      Balance Equity / Cr Askari 26,000, dated 1 August 2026 like 0544's
--      batch. One posted opening batch is allowed per company, so it is a
--      journal entry of its own, sourced on the step-1 movement: the two
--      halves of one correction carry one id.
-- ASSERTED: the ledger's Askari at 30 September equals the bank's closing that
-- day, 3,767,902.00; stored and ledger each moved by exactly -26,000; and the
-- ledger still exceeds the stored balance by the one residual 0544 named —
-- Shayan's September payslip, 114,500.

do $mig$
declare
  c_co   constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  c_bank constant uuid := '1df9eaa6-afdb-48d1-8f8e-8c69ba867787';
  c_0523 constant text := '9010aa0b-1a2c-4b73-80e3-5a1cf3ea23c6';
  v_gl uuid; v_obe uuid; v_ho uuid; v_tx uuid; v_entry uuid;
  v_stored_before numeric; v_gl_before numeric; v_diff numeric;
begin
  if exists (select 1 from public.bank_transactions where reference_id = c_0523 and kind = 'adjustment' and account_delta = -26000) then
    raise notice '0561: already applied.';
  else
    if (select bank_name from public.bank_accounts where id = c_bank) is distinct from 'Askari Bank' then
      raise exception '0561 REFUSED: the account is not Askari.';
    end if;
    if not exists (select 1 from public.bank_transactions where id = c_0523::uuid and kind = 'adjustment' and account_delta = 26000) then
      raise exception '0561 REFUSED: 0523''s +26,000 adjustment is not there as expected.';
    end if;
    if exists (select 1 from public.advances where id = 'b2b299aa-31af-4bef-a9b3-2115dad41449') then
      raise exception '0561 REFUSED: Muhammad Wali''s duplicate advance is still recorded; this fix assumes it is deleted.';
    end if;
    v_gl  := public.bank_account_gl(c_co, c_bank);
    select id into v_obe from public.chart_of_accounts where company_id = c_co and system_key = 'opening_balance_equity';
    v_ho  := public.head_office_region(c_co);
    select balance into v_stored_before from public.bank_accounts where id = c_bank;
    select coalesce(sum(debit - credit), 0) into v_gl_before from public.journal_lines where account_id = v_gl;

    -- 1. stored balance
    perform public.apply_money_delta(c_co, 'Bank', c_bank, -26000, 'adjustment',
      'Withdrawn (0561): 0523''s +26,000 was wrong — the statement shows the stored balance right on 1 Oct (3,767,902). Wali''s duplicate advance had hidden it.',
      c_0523);

    select id into v_tx from public.bank_transactions
     where reference_id = c_0523 and kind = 'adjustment' and account_delta = -26000;
    if v_tx is null then raise exception '0561 REFUSED: the withdrawal movement was not recorded.'; end if;

    -- 2. ledger opening
    v_entry := public.post_journal(c_co, '2026-08-01', '0561: Askari opening corrected to 3,619,821 (0544 was 26,000 high)',
      'bank_transactions', v_tx, false,
      jsonb_build_array(
        jsonb_build_object('account_id', v_obe, 'debit', 26000, 'credit', 0, 'region', v_ho),
        jsonb_build_object('account_id', v_gl,  'debit', 0, 'credit', 26000, 'region', v_ho)),
      v_ho);

    if (select balance from public.bank_accounts where id = c_bank) - v_stored_before <> -26000 then
      raise exception '0561 REFUSED: the stored balance did not move by exactly -26,000.';
    end if;
    if (select coalesce(sum(debit - credit), 0) from public.journal_lines where account_id = v_gl) - v_gl_before <> -26000 then
      raise exception '0561 REFUSED: the ledger did not move by exactly -26,000.';
    end if;
  end if;

  -- The bank's own figure for 30 September, and the one named residual.
  v_gl := public.bank_account_gl(c_co, c_bank);
  if (select coalesce(sum(jl.debit - jl.credit), 0) from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_entry_id
       where jl.account_id = v_gl and je.entry_date <= '2026-09-30') <> 3767902.00 then
    raise exception '0561 REFUSED: the ledger''s Askari at 30 Sep is not the bank''s 3,767,902.00.';
  end if;
  select difference into v_diff from public.bank_held_operational(c_co) where account_name = 'Askari Bank';
  if abs(v_diff - 114500) > 0.005 then
    raise exception '0561 REFUSED: Askari ledger minus stored is %, not the 114,500 of Shayan''s September payslip.', v_diff;
  end if;
end $mig$;
