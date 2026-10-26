-- 0565 — Shayan's September fuel allowance is salary, not an expense
--
-- DECIDED 2026-10-26 (Shayan): "my allowance is 30k" — the 15,000 fuel
-- allowance is INSIDE the 30,000 allowance on his employee record, not on top.
--
-- His September payslip (EMP-0178): 100,000 + 30,000 − 500 tax = net 129,500,
-- of which 114,500 was paid from Askari on 15 Oct. The other 15,000 left
-- Askari on 30 Sep as the expense "head office fuel allowance" — the same
-- 15,000 booked a second time as office cost, and the payslip left showing
-- 15,000 owed. Because a payslip posts its disbursement only when fully paid,
-- the ledger has also carried Askari 114,500 above its stored balance (0544
-- named that residual).
--
-- The repair moves no money: the expense is deleted through delete_expense
-- (its 15,000 comes back to Askari's stored balance and its journal reverses),
-- and the same 15,000 is paid on the payslip through disburse_payslip from
-- Askari, dated 30 Sep as the money left. Askari's stored balance ends where it
-- started; the payslip is paid in full; office cost falls by 15,000.
--
-- From October his allowance card loads go through the payslip's Card channel
-- (0542), which already exists — not as an expense.
--
-- ASSERTED on what can break: Askari's stored balance is unchanged, and its
-- ledger now equals its stored balance (the 114,500 residual is gone).

do $mig$
declare
  c_co    constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  c_exp   constant uuid := 'f69ac926-bbfd-437e-8a21-f3c6e4b24ac4';
  c_slip  constant uuid := '0cf30c73-066b-437d-bdb6-e646af88a0fe';
  c_bank  constant uuid := '1df9eaa6-afdb-48d1-8f8e-8c69ba867787';
  v_before numeric; v_diff numeric;
begin
  if (select amount_paid from public.payslips where id = c_slip) = 129500 and not exists (select 1 from public.expenses where id = c_exp) then
    raise notice '0565: already applied.';
    return;
  end if;
  if (select amount from public.expenses where id = c_exp) is distinct from 15000
     or (select description from public.expenses where id = c_exp) is distinct from 'head office fuel allowance' then
    raise exception '0565 REFUSED: the 30 Sep fuel expense is not as expected.';
  end if;
  if (select amount_paid from public.payslips where id = c_slip) <> 114500
     or (select net_salary from public.payslips where id = c_slip) <> 129500 then
    raise exception '0565 REFUSED: Shayan''s September payslip is not 114,500 paid of 129,500.';
  end if;
  select balance into v_before from public.bank_accounts where id = c_bank;

  -- 1. the expense goes, its money back to Askari's stored balance
  update public.expenses set approved_at = null where id = c_exp and approved_at is not null;
  perform public.delete_expense(c_exp);

  -- 2. the same 15,000 pays the payslip, from Askari, as it left on 30 Sep
  perform public.disburse_payslip(c_slip, 114500, 129500, 'Bank', c_bank, null, null,
    '2026-09-30 12:00:00+05'::timestamptz,
    'Payroll September 2026 · EMP-0178 Shayan Ahmed (fuel allowance, was booked as an expense — 0565)');

  if (select amount_paid from public.payslips where id = c_slip) <> 129500
     or not (select disbursed from public.payslips where id = c_slip) then
    raise exception '0565 REFUSED: the payslip is not paid in full.';
  end if;
  if (select balance from public.bank_accounts where id = c_bank) <> v_before then
    raise exception '0565 REFUSED: Askari''s stored balance moved (% → %).', v_before, (select balance from public.bank_accounts where id = c_bank);
  end if;
  select difference into v_diff from public.bank_held_operational(c_co) where account_name = 'Askari Bank';
  if abs(v_diff) > 0.005 then
    raise exception '0565 REFUSED: Askari''s ledger still differs from its stored balance by %.', v_diff;
  end if;
end $mig$;
