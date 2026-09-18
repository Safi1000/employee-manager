-- 0458 — Stage C: payslip disbursement moves money in ONE transaction.
--
-- PayrollManagement disbursed a payslip in the browser as three steps: write the
-- figures, CAS-claim the payment columns (amount_paid, disbursed…), then move the
-- balance by hand (bank_accounts/treasury UPDATE + a bank_transactions row). The
-- claim and the money were not one transaction, so the failure the whole project
-- exists to kill was live here: the balance moves, a later step throws, and the
-- browser's manual rollback is itself a separate round trip that can fail — money
-- gone, payslip unmarked, nothing reconciles.
--
-- disburse_payslip() folds the CAS claim and the money into one SECURITY DEFINER
-- transaction. The claim is the SAME UPDATE the browser did — same columns, same
-- values — so every payslip trigger fires exactly as before: journal_on_payslip
-- (→ post_payslip_disbursement's GL entry), settle_carried_adjustments, the run
-- lock, the audit row. The money goes through apply_money_delta (0380/0453), the
-- one balance mover, which writes a bank_transactions row byte-identical to the
-- browser's. Nothing new posts; the two writes just can no longer half-happen.
--
-- CAS: a stale p_expected_paid matches zero rows and RAISES before any money
-- moves. apply_money_delta failing rolls the claim back with it. Either way the
-- balance and the payslip move together or not at all.
--
-- Key: payroll.edit — the same key disburse_payroll_run already requires. The
-- figure write (buildPayslipPayload) stays in the browser: it is a payslips write
-- gated by RLS, carries no money, and runs before this RPC, so its rejection
-- moves nothing.

create or replace function public.disburse_payslip(
  p_payslip_id            uuid,
  p_expected_paid         numeric,
  p_target_paid           numeric,
  p_payment_mode          text,
  p_bank_account_id       uuid,
  p_cheque_id             uuid,
  p_custodian_location_id uuid,
  p_disbursed_at          timestamptz,
  p_description           text
) returns void
  language plpgsql
  security definer
  set search_path to 'public'
as $function$
declare
  v_company   uuid;
  v_net       numeric;
  v_disbursed boolean;
  v_pay       numeric;
  v_n         int;
begin
  -- Permission: skip inside a trigger (the statement already passed RLS) and for
  -- trusted backend (auth.uid() null), exactly like every other gate here.
  if auth.uid() is not null and pg_trigger_depth() = 0 then
    perform public.require_perm('payroll.edit');
  end if;

  -- Tenant guard. DEFINER bypasses RLS, so assert every uuid arg's company. The
  -- param name appears literally inside each assert so tenant_guard_gaps() sees it.
  perform public.assert_same_company((select company_id from public.payslips where id = p_payslip_id));
  if p_bank_account_id is not null then
    perform public.assert_same_company((select company_id from public.bank_accounts where id = p_bank_account_id));
  end if;
  if p_cheque_id is not null then
    perform public.assert_same_company((select company_id from public.cheques where id = p_cheque_id));
  end if;
  if p_custodian_location_id is not null then
    perform public.assert_same_company((select company_id from public.cash_locations where id = p_custodian_location_id));
  end if;

  select company_id, net_salary into v_company, v_net
    from public.payslips where id = p_payslip_id;
  if v_company is null then
    raise exception 'That payslip no longer exists. Nothing has been recorded.' using errcode = 'P0001';
  end if;

  -- isSettled(paid, net): fully paid, or nothing to pay. Mirrors the browser.
  v_disbursed := (round(v_net) <= 0) or (round(p_target_paid) >= round(v_net));

  -- The claim: identical to the browser's CAS update, guarded on the baseline so a
  -- concurrent payment can never apply the same delta twice. Zero rows ⇒ the row
  -- moved under us; raise BEFORE any money moves. The marker lets the UI show its
  -- soft "reloading" notice instead of a hard error.
  update public.payslips set
    amount_paid           = p_target_paid,
    disbursed             = v_disbursed,
    disbursed_at          = case when v_disbursed then p_disbursed_at else null end,
    status                = case when v_disbursed then 'Cleared' else status end,
    payment_mode          = p_payment_mode,
    bank_account_id       = case when p_payment_mode in ('Bank','Cheque') then p_bank_account_id else null end,
    cheque_id             = case when p_payment_mode = 'Cheque' then p_cheque_id else null end,
    custodian_location_id = case when p_payment_mode = 'Cash' then p_custodian_location_id else null end,
    updated_at            = now()
  where id = p_payslip_id and amount_paid = p_expected_paid;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'PAYSLIP_STALE: this payslip was paid in another tab while you were working.' using errcode = 'P0001';
  end if;

  -- The money: the delta only, out of the company (negative). Cheque/Payable move
  -- no balance — apply_money_delta returns early for them, as the browser did.
  v_pay := round(p_target_paid) - round(p_expected_paid);
  perform public.apply_money_delta(
    v_company,
    p_payment_mode,
    p_bank_account_id,
    -v_pay,
    'payroll',
    p_description,
    case when p_payment_mode = 'Cash' then p_custodian_location_id::text else null end);
end;
$function$;

grant execute on function public.disburse_payslip(uuid, numeric, numeric, text, uuid, uuid, uuid, timestamptz, text) to authenticated;

-- ── tenant-guard assertion ───────────────────────────────────────────────────
do $mig$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0458 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $mig$;
