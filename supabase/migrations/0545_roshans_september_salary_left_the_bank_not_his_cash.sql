-- 0545 — Roshan's September salary left the bank, not his cash
--
-- Found 2026-10-22 while closing the bank-to-ledger gap (0544). Roshan Khan's
-- September payslip (net 45,000) was paid on 21 October in two parts, before
-- 0541 recorded parts:
--
--   11:24:38  38,000 from BOAJK        (bank_transactions: payroll, BOAJK)
--   11:28:58   7,000 cash, by Roshan    (bank_transactions: payroll, cash)
--
-- The payslip kept the last channel (Cash, Roshan's own cash holding), so its
-- disbursement credited 1000.07 Roshan Khan with all 45,000. The ledger then
-- says BOAJK still holds 38,000 it paid out, and Roshan's cash is 38,000 below
-- what he holds (custodian_held_operational: −38,000). No money is wrong; the
-- posting is.
--
-- The change: record the two parts in payslip_payments exactly as the bank
-- transactions show them, then reverse and repost the payslip's disbursement,
-- which since 0541 credits each channel its own part — BOAJK 38,000, Roshan's
-- cash 7,000. The posting date (disbursed_at, 7 Oct) is unchanged. No balance
-- moves: apply_money_delta is not called.
--
-- Asserted on the things that can break: Roshan's cash agrees with the ledger
-- (difference 0); BOAJK's difference moves by exactly −38,000 (whether 0544 is
-- in yet or not); the repost has two credits — 38,000 to BOAJK, 7,000 to
-- 1000.07 — and balances.

do $mig$
declare
  v_co   constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_ps   constant uuid := 'e08e4291-0a45-4ce0-be92-e9d4fcc59de0';
  v_bank constant uuid := '4cf64182-3071-4c95-b1a6-988288b0cb72';   -- BOAJK
  v_loc  constant uuid := '73713157-4c27-492b-aa65-e3d7069f813b';   -- Roshan Khan's cash
  ps record; v_b0 numeric; v_b1 numeric; v_c1 numeric; v_n int; v_bank_cr numeric; v_cash_cr numeric; v_dr numeric; v_cr numeric;
begin
  if exists (select 1 from public.payslip_payments where payslip_id = v_ps) then
    raise notice '0545: already applied.';
    return;
  end if;

  select * into ps from public.payslips where id = v_ps;
  if ps.id is null or round(ps.net_salary) <> 45000 or round(ps.amount_paid) <> 45000 or not ps.disbursed
     or ps.payment_mode <> 'Cash' or ps.custodian_location_id <> v_loc then
    raise exception '0545 REFUSED: Roshan''s September payslip is not as found (net %, paid %, mode %).', ps.net_salary, ps.amount_paid, ps.payment_mode;
  end if;
  if (select count(*) from public.bank_transactions t
       where t.bank_account_id = v_bank and t.kind = 'payroll' and t.account_delta = -38000
         and t.description = 'Payroll September 2026 · EMP-0594 Roshan Khan') <> 1 then
    raise exception '0545 REFUSED: the 38,000 BOAJK payment is not on record as found.';
  end if;

  select difference into v_b0 from public.bank_held_operational(v_co) where bank_account_id = v_bank;

  insert into public.payslip_payments
    (company_id, payslip_id, amount, paid_at, payment_mode, bank_account_id, custodian_location_id, description)
  values
    (v_co, v_ps, 38000, '2026-10-21 11:24:38.165775+00', 'Bank', v_bank, null,
     '0545: Payroll September 2026 · EMP-0594 Roshan Khan (BOAJK)'),
    (v_co, v_ps, 7000, '2026-10-21 11:28:58.194367+00', 'Cash', null, v_loc,
     '0545: Payroll (cash) September 2026 · EMP-0594 Roshan Khan');

  perform public.reverse_journal_for_source(v_co, 'payslips_disbursement', v_ps, coalesce(ps.disbursed_at::date, ps.period_month));
  perform public.post_payslip_disbursement(v_ps);

  -- ── asserts ─────────────────────────────────────────────────────────────────
  select difference into v_b1 from public.bank_held_operational(v_co) where bank_account_id = v_bank;
  select difference into v_c1 from public.custodian_held_operational(v_co) where cash_location_id = v_loc;
  if abs((v_b1 - v_b0) + 38000) > 0.005 then
    raise exception '0545 REFUSED: BOAJK''s difference moved by %, expected −38,000.', v_b1 - v_b0;
  end if;
  if abs(v_c1) > 0.005 then
    raise exception '0545 REFUSED: Roshan''s cash is still % off the ledger.', v_c1;
  end if;

  select count(*) filter (where jl.credit > 0),
         sum(jl.credit) filter (where jl.account_id = public.bank_account_gl(v_co, v_bank)),
         sum(jl.credit) filter (where jl.account_id = public.cash_account_for(v_co, v_loc)),
         sum(jl.debit), sum(jl.credit)
    into v_n, v_bank_cr, v_cash_cr, v_dr, v_cr
    from public.journal_entries je join public.journal_lines jl on jl.journal_entry_id = je.id
   -- the repost: the one non-reversal disbursement entry written in this transaction
   where je.source_table = 'payslips_disbursement' and je.source_id = v_ps and not je.is_reversal
     and je.created_at = now();
  if v_n <> 2 or v_bank_cr <> 38000 or v_cash_cr <> 7000 or v_dr <> v_cr then
    raise exception '0545 REFUSED: the repost has % credit(s) — BOAJK %, cash %, debits % vs credits %.', v_n, v_bank_cr, v_cash_cr, v_dr, v_cr;
  end if;

  raise notice '0545: Roshan''s salary reposted — BOAJK 38,000, cash 7,000; his cash agrees.';
end $mig$;
