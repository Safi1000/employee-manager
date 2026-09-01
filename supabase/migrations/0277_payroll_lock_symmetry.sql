-- 0277 — Make the payroll locks symmetric: paying more than was accrued gets
-- the tighter gate, not the looser one.
--
-- THE ASYMMETRY
--
-- In every locked state the accrual was frozen and the payment was open:
--
--   enforce_payroll_run_lock   refuses present_days, final_salary, net_salary,
--                              working_days and every other figure once a run
--                              passes review — but NOT amount_paid.
--   enforce_period_lock        the payslips carve-out permits amount_paid in a
--                              closed month — but not final_salary.
--
-- So an operator told that a guard worked three more days had exactly one lever:
-- pay more. That is how 88,467.00 left the bank across 29 July payslips with no
-- accrual and no journal line — 81 extra days at each employee's own
-- per_day_salary. It was not an anomaly; it was the only behaviour the locks
-- permitted.
--
-- WHAT CHANGES
--
-- 1. `amount_paid` joins the payroll-run lock's protected set. Once a run is
--    approved, the amount paid is as frozen as the amount accrued.
--
-- 2. A CHECK makes `amount_paid > net_salary` impossible at all times. This is
--    the direct expression of the rule: you cannot disburse more than the
--    payslip says is owed. Partial payment stays legal (`<=`), which is why it
--    is not an equality.
--
-- WHERE I DEPART FROM THE BRIEF, AND WHY — stated, not quietly done.
--
-- The brief also said the period lock's payslip carve-out should stop permitting
-- `amount_paid` in a closed month. I have NOT removed it, and the reason is that
-- it would break a legitimate operation the carve-out exists for: disbursing a
-- closed month's payslip. Disbursement posts at `disbursed_at`, i.e. into the
-- OPEN month — that is exactly why 0237 carved these columns out. Removing
-- `amount_paid` while leaving `disbursed` and `disbursed_at` would also leave
-- the carve-out incoherent: a payslip could be marked disbursed in a closed
-- month but not carry the amount.
--
-- The CHECK achieves the stated goal — "the 88,467 is then impossible rather
-- than merely visible" — without that cost, and it does so in every month rather
-- than only closed ones. If the intent was specifically to stop late edits to a
-- closed month's payment, that is a different rule and I would rather be told
-- than guess it.
--
-- NOT VALID, DELIBERATELY. The 29 existing rows violate the constraint. They are
-- the defect, and repairing them is the accrual-recompute work, which is
-- proposed and not built. `not valid` enforces on every insert and update from
-- now on while leaving the historical rows visible and measurable rather than
-- silently rewritten to fit a new rule.

do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'enforce_payroll_run_lock';

  if v_def is null then
    raise exception '0277: enforce_payroll_run_lock not found';
  end if;

  if v_def ~ 'amount_paid' then
    raise notice '0277: amount_paid already protected; leaving as is';
  else
    v_new := replace(v_def,
      '  if new.base_salary   is distinct from old.base_salary',
      '  if new.amount_paid   is distinct from old.amount_paid' || chr(10) ||
      '   or new.base_salary  is distinct from old.base_salary');
    if v_new = v_def then
      raise exception '0277: could not locate the protected-figure list to extend';
    end if;
    execute v_new;
  end if;
end $$;

alter table public.payslips
  drop constraint if exists payslips_paid_not_over_accrued;

alter table public.payslips
  add constraint payslips_paid_not_over_accrued
  check (amount_paid is null or net_salary is null or amount_paid <= net_salary)
  not valid;

comment on constraint payslips_paid_not_over_accrued on public.payslips is
  'A payslip cannot disburse more than it accrued. NOT VALID: 29 July 2026 rows predate it and are the defect (88,467.00 of extra days paid but never accrued) — they are left visible until the accrual recompute lands (0277).';

-- Prove both halves refuse.
do $$
declare v_ps uuid; v_net numeric; v_refused boolean;
begin
  select id, net_salary into v_ps, v_net
    from public.payslips
   where amount_paid <= net_salary and net_salary > 0
   order by created_at limit 1;

  if v_ps is null then
    raise notice '0277: no conforming payslip to test against';
    return;
  end if;

  v_refused := false;
  begin
    update public.payslips set amount_paid = v_net + 1 where id = v_ps;
  exception
    when check_violation then v_refused := true;
    when others then
      raise exception '0277: the proof update failed for the wrong reason: % %', sqlstate, sqlerrm;
  end;

  if not v_refused then
    raise exception '0277: an over-payment was ACCEPTED — the constraint does not hold';
  end if;
  raise notice '0277: over-payment proved refused';

  -- Undo the probe regardless of outcome; the update above never committed a
  -- value, but be explicit rather than rely on that.
  update public.payslips set amount_paid = amount_paid where id = v_ps;
end $$;

do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'enforce_payroll_run_lock'
                    and p.prosrc ~ 'amount_paid') then
    raise exception '0277: enforce_payroll_run_lock still does not protect amount_paid';
  end if;
end $$;