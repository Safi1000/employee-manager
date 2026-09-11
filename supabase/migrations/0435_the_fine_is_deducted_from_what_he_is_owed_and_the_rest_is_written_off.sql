-- 0435 — the fine is deducted from what he is owed, and the rest is written off.
--
-- 0432 assessed the kit and produced a figure. Nothing spent it. This closes
-- that: finance releases the dues, the fine comes out of what the final payment
-- covers, and whatever the payment cannot cover is WRITTEN OFF to 5320 rather
-- than forgotten, so the annual cost of kit that never came back is a line
-- somebody can read.
--
-- THE ENTRY, and why it is shaped this way. The deduction goes into the
-- payslip's own `deductions` column, which is the only place a payslip deduction
-- survives — PayrollManagement re-derives final_salary and net_salary from it on
-- every render, so anything written straight into net_salary is overwritten the
-- next time somebody saves the row. Reducing `deductions` also reduces the
-- payroll expense the accrual posted, which is NOT what happened: the company
-- still incurred that salary, it simply kept part of it. So the settlement
-- entry puts the expense back and books the recovery against it:
--
--   Dr 5000 Guard Payroll & Salaries   R   (his client — same tag as the accrual)
--   Dr 5320 Unrecovered Kit Fines      W
--   Cr 5310 Kit Recovered from Guards  F   (= R + W)
--
-- Payroll expense ends at its true figure, 2100 Salaries Payable ends at what he
-- is actually owed, 5310 carries the whole fine as a credit against cost of
-- services, and 5320 carries the part that was never collected.
--
-- TWO OTHER THINGS THIS FIXES, both created by the 0429–0434 rebuild:
--
--  · employee_clearance_gates() still counted outstanding kit out of
--    `public.issuances`, which the rebuild left behind. That table is empty and
--    nothing writes it any more, so the kit gate has been permanently green
--    since 0430 and assess_clearance() would go on minting 'cleared'
--    certificates for guards holding kit. Repointed at kit_holdings.
--
--  · 5310 Kit Recovered from Guards was created with normal_side 'debit'. It is
--    a recovery and is only ever credited — 6850 Head Office Cost Recovery is
--    the precedent for an expense account whose normal side is credit. It is
--    corrected through the app.ledger_maintenance protocol, behind an assertion
--    that nothing has posted to it yet.

-- ---------------------------------------------------------------------------
-- 1. 5310 IS A RECOVERY. Its normal side is credit.
--
-- enforce_chart_of_accounts_edit() refuses this, and it is right to: a system
-- account's normal side is fixed because other objects read it, and moving it
-- under a posted balance flips the sign of everything already there. The escape
-- is the app.ledger_maintenance protocol, which is the deliberate route rather
-- than a way around the trigger.
--
-- WHAT MAKES IT SAFE IS ASSERTED, NOT ASSUMED: the account carries no posted
-- journal lines. 0429 created it four days ago and nothing has been fined yet,
-- so there is no balance to flip. If that ever stops being true this migration
-- refuses rather than silently reversing a sign.
-- ---------------------------------------------------------------------------
do $$
declare v_n int;
begin
  select count(*) into v_n
    from public.journal_lines jl
    join public.chart_of_accounts a on a.id = jl.account_id
   where a.system_key = 'kit_recovered';
  if v_n <> 0 then
    raise exception
      '0435 REFUSED: 5310 already carries % posted journal line(s). Changing its normal side now would flip the sign of a balance with no entry behind the move.', v_n;
  end if;

  perform set_config('app.ledger_maintenance', 'on', true);
  update public.chart_of_accounts
     set normal_side = 'credit'::public.account_normal_side, updated_at = now()
   where system_key = 'kit_recovered'
     and normal_side <> 'credit'::public.account_normal_side;
  perform set_config('app.ledger_maintenance', 'off', true);

  if exists (select 1 from public.chart_of_accounts
              where system_key = 'kit_recovered'
                and normal_side <> 'credit'::public.account_normal_side) then
    raise exception '0435 FAILED: 5310 is still debit-sided. The maintenance session did not take.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. THE KIT GATE READS THE LOG THAT REPLACED issuances.
--
-- SURGERY, not restatement: employee_clearance_gates has been edited by more
-- than one migration (0242 added the tenant guard to a body that predates it),
-- so no file holds its true text. Two single-line anchors, each asserted to
-- appear exactly once.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text; v_new text; v_hits int;
  a_tab  text := 'public.issuances i';
  a_pred text := 'i.employee_id = p_employee_id and i.return_date is null';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'employee_clearance_gates';
  if v_def is null then raise exception '0435 REFUSED: employee_clearance_gates does not exist.'; end if;

  v_hits := (length(v_def) - length(replace(v_def, a_tab, ''))) / length(a_tab);
  if v_hits <> 1 then
    raise exception '0435 REFUSED: the issuances anchor appears % time(s), expected 1.', v_hits;
  end if;
  v_hits := (length(v_def) - length(replace(v_def, a_pred, ''))) / length(a_pred);
  if v_hits <> 1 then
    raise exception '0435 REFUSED: the return_date anchor appears % time(s), expected 1.', v_hits;
  end if;

  v_new := replace(v_def, a_tab,  'public.kit_holdings i');
  v_new := replace(v_new, a_pred, 'i.holder_employee_id = p_employee_id');
  execute v_new;
end $$;

comment on function public.employee_clearance_gates(uuid) is
  '0435: outstanding kit is counted from kit_holdings, the derived view over kit_events. It read public.issuances until 0435 — a table the 0429–0434 rebuild left empty, which made the kit gate green for everyone.';

-- ---------------------------------------------------------------------------
-- 3. FINANCE RELEASES THE DUES.
--
-- The other half of the stage gate: clearance.finance, after ops has cleared
-- him and after the printed certificate has come back signed. Neither of those
-- is advisory — a payment released on an unsigned certificate is a payment with
-- nothing behind it if he comes back and disputes the fine.
--
-- 0084 LEFT A release_final_dues(p_employee_id) BEHIND. Single-stage: it ran
-- assess_clearance and flipped dues_released if the status came back 'cleared'
-- — the same auto-assessment that minted the 242 certificates nobody performed.
-- No function, view, policy or screen calls it, which is asserted before it
-- goes, because a drop that silently removes a caller's target is the failure
-- mode this project exists to remove.
-- ---------------------------------------------------------------------------
do $$
declare v_callers text;
begin
  select string_agg(p.proname, ', ') into v_callers
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname <> 'release_final_dues'
     and p.prosrc ~ 'release_final_dues';
  if v_callers is not null then
    raise exception '0435 REFUSED: release_final_dues(p_employee_id) is still called by %. Retarget those first.', v_callers;
  end if;
  drop function if exists public.release_final_dues(uuid);
end $$;

create function public.release_final_dues(p_certificate_id uuid)
returns numeric
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  c         record;
  ps        record;
  v_client  uuid;
  v_branch  uuid;
  v_fine    numeric := 0;
  v_left    numeric := 0;
  v_take    numeric := 0;
  v_recov   numeric := 0;
  v_written numeric := 0;
  v_due     numeric := 0;
  v_cum     numeric := 0;
  v_lines   jsonb := '[]'::jsonb;
  v_dim     jsonb;
begin
  -- THE GUARD COMES FIRST, before any read. (CLAUDE.md)
  --
  -- DEFINER, deliberately. This is a stage-gated function and it writes
  -- payslips; under invoker the payslips table's own perm_write policy would add
  -- the payroll key back on top of clearance.finance and re-flatten the split
  -- 0432 made. So the boundary is asserted inside the body instead.
  perform public.require_perm('clearance.finance');
  -- tenant guard [resolved]: owning company looked up from p_certificate_id via public.clearance_certificates (0435)
  if p_certificate_id is not null then perform public.assert_same_company((select company_id from public.clearance_certificates where id = p_certificate_id)); end if;

  select * into c from public.clearance_certificates where id = p_certificate_id;
  if not found then raise exception 'Certificate not found.'; end if;

  if c.ops_cleared_at is null then
    raise exception 'Operations has not cleared this guard yet. Finance cannot release dues before the kit is assessed.';
  end if;
  if c.signed_at is null then
    raise exception 'The certificate has not been signed. Print it, have him sign it, record the signature, then release.';
  end if;
  if c.dues_released then
    raise exception 'The dues on this certificate were already released on %.', c.dues_released_on;
  end if;

  select e.client_id, e.branch_id into v_client, v_branch
    from public.employees e where e.id = c.employee_id;

  v_fine := coalesce(c.kit_fine_total, 0);
  v_left := v_fine;

  -- WHAT THE FINAL PAYMENT COVERS. Oldest undisbursed payslip first, so the
  -- deduction lands on money he has been owed longest rather than on whichever
  -- row happens to sort first.
  for ps in
    select * from public.payslips
     where employee_id = c.employee_id and not disbursed and coalesce(net_salary, 0) > 0
     order by period_month
  loop
    v_due := v_due + ps.net_salary;
    if v_left > 0 then
      v_take := least(v_left, ps.net_salary);
      update public.payslips
         set deductions   = coalesce(deductions, 0) + v_take,
             final_salary = final_salary - v_take,
             net_salary   = net_salary  - v_take,
             notes        = coalesce(notes || ' · ', '')
                            || 'Kit fine PKR ' || to_char(v_take, 'FM999,999,999.00') || ' (clearance)',
             updated_at   = now()
       where id = ps.id;
      v_left  := v_left  - v_take;
      v_recov := v_recov + v_take;
    end if;
  end loop;

  v_written := v_fine - v_recov;

  -- The recovery is not a reduction in payroll. Put the expense back where the
  -- accrual had it — tagged to the same client, so client profitability sees the
  -- salary it actually bore — and book the recovery and the write-off against it.
  if v_fine > 0 then
    v_dim := jsonb_build_object('employee_id', c.employee_id);
    if v_recov > 0 then
      v_lines := v_lines || jsonb_build_array(
        v_dim || jsonb_build_object('key', 'cos_payroll', 'debit', v_recov, 'credit', 0,
                                    'client_id', v_client));
    end if;
    if v_written > 0 then
      v_lines := v_lines || jsonb_build_array(
        v_dim || jsonb_build_object('key', 'kit_fines_written_off', 'debit', v_written, 'credit', 0));
    end if;
    v_lines := v_lines || jsonb_build_array(
      v_dim || jsonb_build_object('key', 'kit_recovered', 'debit', 0, 'credit', v_fine));

    perform public.post_journal(
      c.company_id, current_date,
      'Kit fine settled on clearance', 'kit_fine', c.id, false, v_lines, v_branch);
  end if;

  -- THE CUMULATIVE FIGURE THE CERTIFICATE PRINTS. Everything he has ever been
  -- paid, plus what this release pays him — not this payment on its own, which
  -- is the number a cumulative sentence contradicts.
  select coalesce(sum(coalesce(p.amount_paid, p.net_salary)), 0) into v_cum
    from public.payslips p
   where p.employee_id = c.employee_id and p.disbursed;

  update public.clearance_certificates
     set dues_released    = true,
         dues_released_on = current_date,
         fine_written_off = v_written,
         cumulative_paid  = v_cum + (v_due - v_recov),
         status           = 'cleared'::public.clearance_status,
         updated_at       = now()
   where id = p_certificate_id;

  return v_due - v_recov;
end;
$fn$;

revoke execute on function public.release_final_dues(uuid) from anon, public;
grant  execute on function public.release_final_dues(uuid) to authenticated;

comment on function public.release_final_dues(uuid) is
  '0435: finance''s half. Deducts the kit fine from the undisbursed payslips, writes the uncovered remainder off to 5320, and returns what is left to pay him.';

-- ---------------------------------------------------------------------------
-- 4. THE FINANCE QUEUE CARRIES WHAT THE SCREEN AND THE CERTIFICATE PRINT.
--
-- SURGERY is not needed: clearance_finance_queue has exactly one author (0432)
-- and its full text is in that file, so it is restated — behind the check that
-- the view it is replacing is the one 0432 left.
-- ---------------------------------------------------------------------------
do $$
declare v_cols int;
begin
  select count(*) into v_cols from information_schema.columns
   where table_schema = 'public' and table_name = 'clearance_finance_queue';
  if v_cols <> 14 then
    raise exception '0435 REFUSED: clearance_finance_queue has % columns, expected 0432''s 14. Somebody else has edited it.', v_cols;
  end if;
end $$;

-- DROP and recreate, not `create or replace`: the new columns belong beside the
-- ones they qualify, and replace can only append.
drop view if exists public.clearance_finance_queue;

create view public.clearance_finance_queue as
select c.id as certificate_id,
       c.company_id,
       c.employee_id,
       e.full_name,
       e.guard_code,
       e.display_number,
       e.last_working_day,
       e.separation_reason,
       c.covers_to,
       c.undisbursed_salary,
       c.outstanding_advance,
       -- THE OUTCOME ONLY. Not the items, not the conditions, not the per-item
       -- fines: those are ops's business and finance settles money.
       c.kit_fine_total,
       c.kit_summary,
       c.fine_written_off,
       c.cumulative_paid,
       c.signed_at,
       c.dues_released,
       c.dues_released_on,
       c.ops_cleared_at
  from public.clearance_certificates c
  join public.employees e on e.id = c.employee_id
 where c.ops_cleared_at is not null;

grant select on public.clearance_finance_queue to authenticated;

comment on view public.clearance_finance_queue is
  '0432/0435: what FINANCE sees — and only after ops has cleared him. Carries the outcome (kits recovered, or a fine of X), what the fine could not cover, and the cumulative figure the certificate prints. Never the per-item assessment, which is ops''s half.';

-- ---------------------------------------------------------------------------
-- THE PROBE. Rolled back — the exception inside the block is a subtransaction,
-- so every write above it is undone.
--
-- It asserts the thing that can break: that a fine LARGER than the dues splits
-- into a recovery and a write-off, that the ledger balances, and that 5320
-- carries the uncovered part. Asserting only "the function returned" would pass
-- with the whole fine silently vanishing.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co uuid; v_emp uuid; v_cert uuid; v_ps uuid; v_uid uuid;
  v_left numeric; v_d numeric; v_c numeric; v_5320 numeric; v_5310 numeric;
begin
  select id into v_co from public.companies order by created_at limit 1;
  -- require_perm('clearance.finance') is real here, so the probe needs a real
  -- identity that holds it rather than a bypass.
  select id into v_uid from public.profiles
   where role in ('super_admin', 'super_super_admin') order by role limit 1;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  select id into v_emp from public.employees
   where company_id = v_co and lifecycle_state = 'active' limit 1;

  insert into public.payslips (company_id, employee_id, period_month, base_salary,
                               final_salary, net_salary, deductions, disbursed)
  values (v_co, v_emp, date_trunc('month', current_date)::date, 4000, 4000, 4000, 0, false)
  returning id into v_ps;

  insert into public.clearance_certificates (company_id, employee_id, covers_to,
                                             ops_cleared_at, signed_at, kit_fine_total)
  values (v_co, v_emp, current_date, now(), now(), 10000)
  returning id into v_cert;

  v_left := public.release_final_dues(v_cert);

  if v_left <> 0 then
    raise exception '0435 PROBE FAILED: a 10000 fine against 4000 of dues left % to pay, expected 0.', v_left;
  end if;

  select net_salary into v_d from public.payslips where id = v_ps;
  if v_d <> 0 then
    raise exception '0435 PROBE FAILED: the payslip net is % after the deduction, expected 0.', v_d;
  end if;

  select coalesce(sum(jl.debit), 0), coalesce(sum(jl.credit), 0) into v_d, v_c
    from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_entry_id
   where je.source_table = 'kit_fine' and je.source_id = v_cert;
  if v_d <> v_c or v_d <> 10000 then
    raise exception '0435 PROBE FAILED: the settlement entry is % debit / % credit, expected 10000 each.', v_d, v_c;
  end if;

  select coalesce(sum(jl.debit - jl.credit), 0) into v_5320
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.journal_entry_id
    join public.chart_of_accounts a on a.id = jl.account_id
   where je.source_table = 'kit_fine' and je.source_id = v_cert
     and a.system_key = 'kit_fines_written_off';
  if v_5320 <> 6000 then
    raise exception '0435 PROBE FAILED: 5320 took %, expected the 6000 the payment could not cover.', v_5320;
  end if;

  select coalesce(sum(jl.credit - jl.debit), 0) into v_5310
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.journal_entry_id
    join public.chart_of_accounts a on a.id = jl.account_id
   where je.source_table = 'kit_fine' and je.source_id = v_cert
     and a.system_key = 'kit_recovered';
  if v_5310 <> 10000 then
    raise exception '0435 PROBE FAILED: 5310 was credited %, expected the whole 10000 fine.', v_5310;
  end if;

  select fine_written_off into v_5320 from public.clearance_certificates where id = v_cert;
  if v_5320 <> 6000 then
    raise exception '0435 PROBE FAILED: the certificate records % written off, expected 6000.', v_5320;
  end if;

  raise exception 'ROLLBACK_PROBE';
exception
  when others then
    perform set_config('request.jwt.claims', null, true);
    perform set_config('request.jwt.claim.sub', null, true);
    if sqlerrm <> 'ROLLBACK_PROBE' then raise; end if;
    raise notice '0435 probe passed: 10000 fine, 4000 recovered, 6000 written off to 5320.';
end $$;

-- ---------------------------------------------------------------------------
-- THE TENANT GUARD ASSERTION. NOT OPTIONAL.
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0435 REFUSED: tenant_guard_gaps() reports % gap(s): %.', v_n, v_who;
  end if;
end $$;
