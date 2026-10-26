-- 0560 — Nova's September payroll goes back to Review
--
-- DECIDED 2026-10-26 (Shayan): "before that i approved payroll of nova
-- (finance verify) make it unverify and go back to payroll run".
--
-- Nova Group's September 2026 scope was moved to Finance Verify and finance-
-- verified at 10:50 UTC today, the same morning its August payslips were
-- overwritten (0559) — so it was signed off on figures read in that state
-- (Muhammad Abid showing 56 of a 26,000 advance to recover).
--
-- Finance Verify is PERMANENT by design (0330, enforce_finance_verify_lock).
-- This is one named exception, not a change to that rule: a maintenance
-- session (which the lock admits, and which is still audited) returns THIS one
-- scope to Review — phase 'review', finance stamp cleared. The lock itself is
-- untouched and applies to it again the moment it is re-verified.
--
-- Payslips are NOT touched. Its 11 September payslips stay as saved; Review
-- recomputes the unpaid ones. The 3 marked paid at PKR 0 (advance covering the
-- whole salary) stay paid — 0559 forbids un-paying by any path but a reversal.

do $mig$
declare
  c_nova constant uuid := 'e4132398-09b8-429d-86d8-5ae4787e7cf0';
  v_row public.payroll_run_phases; v_n int;
begin
  select * into v_row from public.payroll_run_phases
   where client_id = c_nova and period_month = '2026-09-01';
  if v_row.id is null then raise exception '0560 REFUSED: Nova has no September phase row.'; end if;
  if (select name from public.clients where id = c_nova) <> 'Nova Group' then
    raise exception '0560 REFUSED: the client is not Nova Group.';
  end if;

  if v_row.phase = 'review' and v_row.finance_verified_at is null then
    raise notice '0560: Nova September is already in Review.';
  else
    if v_row.finance_verified_at is distinct from '2026-10-26 10:50:07.003+00'::timestamptz then
      raise exception '0560 REFUSED: Nova September was not the verification of 10:50:07 today (it reads %).', v_row.finance_verified_at;
    end if;
    perform set_config('app.ledger_maintenance', 'on', true);
    if not public.is_maintenance_session() then
      raise exception '0560 REFUSED: not a maintenance session; the finance lock would refuse.';
    end if;
    update public.payroll_run_phases
       set phase = 'review', finance_verified_at = null, finance_verified_by = null, moved_at = now()
     where id = v_row.id;
    get diagnostics v_n = row_count;
    if v_n <> 1 then raise exception '0560 REFUSED: moved % rows.', v_n; end if;
    perform set_config('app.ledger_maintenance', 'off', true);
  end if;

  -- The lock is still in force for everything else.
  if not exists (select 1 from pg_trigger where tgname = 'trg_finance_verify_lock' and tgrelid = 'public.payroll_run_phases'::regclass) then
    raise exception '0560 REFUSED: the finance-verify lock is missing.';
  end if;
  if (select phase from public.payroll_run_phases where client_id = c_nova and period_month = '2026-09-01') <> 'review' then
    raise exception '0560 REFUSED: Nova September is not in Review.';
  end if;
end $mig$;
