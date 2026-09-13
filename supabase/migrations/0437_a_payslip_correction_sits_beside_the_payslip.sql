-- 0437 — a payslip correction sits beside the payslip.
--
-- Around 8–10 of ~450 payslips a month are wrong and refined afterwards, and
-- there was no way to record the correction. The payslip said 35,000, 35,000
-- was paid, it later emerges he was owed 40,000 — nothing could record the
-- extra 5,000 against that guard, because the system refuses overpayment and
-- the reverse direction was never needed and never built.
--
-- AN ADJUSTMENT SITS BESIDE THE PAYSLIP AND DOES NOT REWRITE IT. The payslip
-- is the record of what was paid; the adjustment is the record that it was
-- wrong and what was done about it. With ~10 a month, that evidence is the
-- point: a guard who appears repeatedly is a signal about a site.
--
-- WHICH PERIOD BEARS THE COST — DECIDED: the accrual ALWAYS posts to the
-- current open accounting period, dated the day it is raised. A closed period
-- is never reopened for a correction. The payslip's own period is kept on the
-- row as original_period_month, FOR REFERENCE ONLY: it says which payslip was
-- wrong, and it is never a posting date anywhere in this file.
--
--   positive (owed to him)   Dr payroll expense / Cr 2100 Salaries Payable
--   negative (owed by him)   Dr 2100 Salaries Payable / Cr payroll expense
--
-- SETTLEMENT is a separate movement whenever it happens:
--
--   pay now        Dr 2100 / Cr cash or bank, dated when paid, through
--                  apply_money_delta() — nothing here writes a balance.
--   carry forward  the amount appears as its own line on the NEXT payslip,
--                  naming the period it corrects, and is paid (or deducted) with
--                  it. payslips.adjustment_carried holds that line; net_salary
--                  includes it; the disbursement's Dr 2100 clears the accrual.
--
-- ONE MECHANISM FOR BOTH SIGNS OF CARRY-FORWARD, and deliberately NOT the
-- overpayment advance. sync_overpayment_carry_forward records a different fact
-- — the payroll screen's own arithmetic found paid > net — and folds it into
-- the advance figure, which is exactly what the spec says an adjustment must
-- not be: "not folded silently into gross". An adjustment line names the period
-- it corrects. Routing a negative one through advances would put half the
-- adjustments in a different table under a different name.
--
-- THE KEY is payroll.adjust, its own key, not payroll.edit: raising an
-- adjustment is correcting a disbursement after the fact and should be
-- grantable to someone who cannot run payroll. It is in permission_keys here
-- and in PERMISSION_GROUPS in the same commit.

insert into public.permission_keys (key, grp, label)
select v.key, v.grp, v.label from (values
  ('payroll.adjust', 'Finance', 'Payroll — raise and settle adjustments')
) v(key, grp, label)
where not exists (select 1 from public.permission_keys k where k.key = v.key);

-- ---------------------------------------------------------------------------
-- 1. THE TABLE.
-- ---------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_type where typname = 'adjustment_settlement') then
    create type public.adjustment_settlement as enum ('pay_now', 'carry_forward');
  end if;
  if not exists (select 1 from pg_type where typname = 'adjustment_status') then
    create type public.adjustment_status as enum ('open', 'settled', 'cancelled');
  end if;
end $$;

create table if not exists public.payroll_adjustments (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies(id) on delete cascade,
  payslip_id         uuid not null references public.payslips(id),
  employee_id        uuid not null references public.employees(id),
  -- the payslip's period, copied so it is on the row people read. REFERENCE
  -- ONLY — never a posting date (DECIDED: corrections post to the open period).
  original_period_month date not null,
  -- SIGNED. Positive = owed to the guard. Negative = owed by him.
  amount             numeric(14,2) not null,
  reason             text not null,
  settlement         public.adjustment_settlement not null,
  status             public.adjustment_status not null default 'open',
  raised_by          uuid,
  raised_at          timestamptz not null default now(),
  settled_at         timestamptz,
  settled_by         uuid,
  -- carry_forward: the payslip the line landed on. pay_now: null.
  settled_payslip_id uuid references public.payslips(id),
  accrual_entry_id   uuid,
  settlement_entry_id uuid,
  cancelled_reason   text,
  constraint adjustment_amount_nonzero check (amount <> 0),
  constraint adjustment_reason_present check (length(trim(reason)) > 0)
);

comment on table public.payroll_adjustments is
  '0437: a correction beside a payslip, never a rewrite of it. Signed amount, the period it corrects, how it settles. The accrual posts to the CURRENT OPEN period, dated the day it is raised; original_period_month is reference only. Carry-forward lands as its own line on the next payslip via payslips.adjustment_carried.';

create index if not exists payroll_adjustments_employee_idx on public.payroll_adjustments (employee_id, original_period_month);
create index if not exists payroll_adjustments_open_idx on public.payroll_adjustments (company_id, status) where status = 'open';

alter table public.payroll_adjustments enable row level security;
drop policy if exists company_members on public.payroll_adjustments;
create policy company_members on public.payroll_adjustments for all to public
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());
drop policy if exists ssa_all on public.payroll_adjustments;
create policy ssa_all on public.payroll_adjustments for all to public
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
-- Writes go through the RPCs below, which are the only way the accrual posts
-- with the row. The screen reads; it never inserts.
grant select on public.payroll_adjustments to authenticated;

-- The carried line on the next payslip. Signed; included in net_salary.
alter table public.payslips
  add column if not exists adjustment_carried numeric(14,2) not null default 0;
comment on column public.payslips.adjustment_carried is
  '0437: the sum of open carry-forward adjustments from EARLIER periods that this payslip settles. Signed. Included in net_salary, NOT in final_salary — the expense was accrued in the period the adjustment corrects. Written by the payroll screen from payroll_adjustments; settled by trg_payslip_settles_adjustments when this payslip is disbursed.';

-- ---------------------------------------------------------------------------
-- 2. RAISE. The row and its accrual, one transaction.
-- ---------------------------------------------------------------------------
create or replace function public.raise_payroll_adjustment(
  p_payslip_id uuid,
  p_amount     numeric,
  p_reason     text,
  p_settlement public.adjustment_settlement)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  ps      record;
  v_id    uuid;
  v_cat   text;
  v_key   text;
  v_lines jsonb := '[]'::jsonb;
  v_emp   jsonb;
  v_entry uuid;
  sp      record;
  v_rows  int; v_i int := 0; v_alloc numeric; v_running numeric := 0;
  v_abs   numeric;
begin
  -- THE GUARD COMES FIRST. DEFINER because it writes journal rows and the
  -- payslip's client split the way post_payslip_accrual does; the boundary is
  -- asserted here.
  perform public.require_perm('payroll.adjust');
  -- tenant guard [resolved]: owning company looked up from p_payslip_id via public.payslips (0437)
  if p_payslip_id is not null then perform public.assert_same_company((select company_id from public.payslips where id = p_payslip_id)); end if;

  select * into ps from public.payslips where id = p_payslip_id;
  if not found then raise exception 'Payslip not found.'; end if;
  if p_amount is null or p_amount = 0 then raise exception 'An adjustment needs an amount. Positive if he is owed, negative if he owes.'; end if;
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'An adjustment needs a reason — it is the record that the payslip was wrong.'; end if;

  -- No closed-period test here. DECIDED: the correction posts to the current
  -- open period whatever the payslip's period is; the period lock on
  -- journal_entries is the only thing that can refuse the date, and today's
  -- period is open by construction.
  insert into public.payroll_adjustments
    (company_id, payslip_id, employee_id, original_period_month, amount, reason, settlement, raised_by)
  values (ps.company_id, ps.id, ps.employee_id, ps.period_month, p_amount, trim(p_reason), p_settlement, auth.uid())
  returning id into v_id;

  -- THE ACCRUAL, dated TODAY (the current open period), split across the
  -- payslip's clients the way the payslip's own accrual was.
  select e.category into v_cat from public.employees e where e.id = ps.employee_id;
  v_key := case when v_cat = 'office_staff' then 'opex_office_payroll' else 'cos_payroll' end;
  v_emp := jsonb_build_object('employee_id', ps.employee_id);
  v_abs := abs(p_amount);

  select count(*) into v_rows from public.payslip_client_split(ps.id);
  if v_rows > 0 then
    for sp in select * from public.payslip_client_split(ps.id) order by weight desc, client_id nulls last loop
      v_i := v_i + 1;
      if v_i = v_rows then v_alloc := v_abs - v_running;
      else v_alloc := round(v_abs * sp.weight, 2); v_running := v_running + v_alloc; end if;
      if v_alloc <> 0 then
        v_lines := v_lines || jsonb_build_array(v_emp || jsonb_build_object(
          'key', v_key,
          'debit',  case when p_amount > 0 then v_alloc else 0 end,
          'credit', case when p_amount < 0 then v_alloc else 0 end,
          'client_id', sp.client_id));
      end if;
    end loop;
  else
    v_lines := v_lines || jsonb_build_array(v_emp || jsonb_build_object(
      'key', v_key,
      'debit',  case when p_amount > 0 then v_abs else 0 end,
      'credit', case when p_amount < 0 then v_abs else 0 end));
  end if;
  v_lines := v_lines || jsonb_build_array(v_emp || jsonb_build_object(
    'key', 'salaries_payable',
    'debit',  case when p_amount < 0 then v_abs else 0 end,
    'credit', case when p_amount > 0 then v_abs else 0 end));

  v_entry := public.post_journal(
    ps.company_id, current_date,
    'Payroll adjustment — corrects ' || to_char(ps.period_month, 'Mon YYYY') || ' — ' || trim(p_reason),
    'payroll_adjustments', v_id, false, v_lines, ps.branch_id);

  update public.payroll_adjustments set accrual_entry_id = v_entry where id = v_id;
  return v_id;
end;
$fn$;

revoke execute on function public.raise_payroll_adjustment(uuid, numeric, text, public.adjustment_settlement) from anon, public;
grant  execute on function public.raise_payroll_adjustment(uuid, numeric, text, public.adjustment_settlement) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. SETTLE NOW. Money moves in one place.
-- ---------------------------------------------------------------------------
create or replace function public.settle_payroll_adjustment(
  p_adjustment_id        uuid,
  p_payment_mode         text,
  p_bank_account_id      uuid,
  p_custodian_location_id uuid,
  p_paid_on              date default current_date)
returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  a       record;
  v_acct  uuid;
  v_entry uuid;
  v_abs   numeric;
  v_name  text;
begin
  perform public.require_perm('payroll.adjust');
  -- tenant guard [resolved]: owning company looked up from p_adjustment_id via public.payroll_adjustments (0437)
  if p_adjustment_id is not null then perform public.assert_same_company((select company_id from public.payroll_adjustments where id = p_adjustment_id)); end if;
  -- tenant guard [resolved]: owning company looked up from p_bank_account_id via public.bank_accounts (0437)
  if p_bank_account_id is not null then perform public.assert_same_company((select company_id from public.bank_accounts where id = p_bank_account_id)); end if;
  -- tenant guard [resolved]: owning company looked up from p_custodian_location_id via public.cash_locations (0437)
  if p_custodian_location_id is not null then perform public.assert_same_company((select company_id from public.cash_locations where id = p_custodian_location_id)); end if;

  select * into a from public.payroll_adjustments where id = p_adjustment_id;
  if not found then raise exception 'Adjustment not found.'; end if;
  if a.status <> 'open' then raise exception 'This adjustment is already %.', a.status; end if;
  if a.settlement <> 'pay_now' then
    raise exception 'This adjustment carries to the next payslip; it settles when that payslip is disbursed, not here.';
  end if;
  if p_payment_mode not in ('Cash', 'Bank') then
    raise exception 'An adjustment is settled in cash or by bank. For a cheque, pay it with the next payslip instead.';
  end if;
  if p_payment_mode = 'Cash' and p_custodian_location_id is null then
    raise exception 'A cash settlement needs the custodian who handed the cash over.';
  end if;
  if p_payment_mode = 'Bank' and p_bank_account_id is null then
    raise exception 'A bank settlement needs the bank account.';
  end if;

  v_abs  := abs(a.amount);
  v_acct := public.settlement_account(a.company_id, p_payment_mode, p_bank_account_id, p_custodian_location_id, a.amount > 0);
  select full_name into v_name from public.employees where id = a.employee_id;

  -- Positive: we pay him.  Dr 2100 / Cr cash-bank.   Negative: he pays us.  Dr cash-bank / Cr 2100.
  v_entry := public.post_journal(
    a.company_id, p_paid_on,
    'Payroll adjustment settled — ' || 'corrects ' || to_char(a.original_period_month, 'Mon YYYY') || ' — ' || coalesce(v_name, ''),
    'payroll_adjustment_settlement', a.id, false,
    jsonb_build_array(
      jsonb_build_object('key', 'salaries_payable', 'employee_id', a.employee_id,
                         'debit',  case when a.amount > 0 then v_abs else 0 end,
                         'credit', case when a.amount < 0 then v_abs else 0 end),
      jsonb_build_object('account_id', v_acct, 'employee_id', a.employee_id,
                         'debit',  case when a.amount < 0 then v_abs else 0 end,
                         'credit', case when a.amount > 0 then v_abs else 0 end)),
    (select branch_id from public.payslips where id = a.payslip_id));

  -- THE BALANCE, through the one function that moves one. reference_id is the
  -- custodian's cash location so Cash Custody attributes a cash payment to the
  -- person who handed it over, the way payroll's own disbursement does.
  perform public.apply_money_delta(
    a.company_id, p_payment_mode, p_bank_account_id,
    case when a.amount > 0 then -v_abs else v_abs end,
    'payroll',
    'Payroll adjustment ' || to_char(a.original_period_month, 'Mon YYYY') || ' · ' || coalesce(v_name, ''),
    case when p_payment_mode = 'Cash' then p_custodian_location_id::text else null end);

  update public.payroll_adjustments
     set status = 'settled', settled_at = now(), settled_by = auth.uid(), settlement_entry_id = v_entry
   where id = a.id;
end;
$fn$;

revoke execute on function public.settle_payroll_adjustment(uuid, text, uuid, uuid, date) from anon, public;
grant  execute on function public.settle_payroll_adjustment(uuid, text, uuid, uuid, date) to authenticated;

-- Cancel: only while open, only with a reason, and the accrual reverses.
create or replace function public.cancel_payroll_adjustment(p_adjustment_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare a record;
begin
  perform public.require_perm('payroll.adjust');
  -- tenant guard [resolved]: owning company looked up from p_adjustment_id via public.payroll_adjustments (0437)
  if p_adjustment_id is not null then perform public.assert_same_company((select company_id from public.payroll_adjustments where id = p_adjustment_id)); end if;
  select * into a from public.payroll_adjustments where id = p_adjustment_id;
  if not found then raise exception 'Adjustment not found.'; end if;
  if a.status <> 'open' then raise exception 'This adjustment is already %.', a.status; end if;
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'Cancelling needs a reason.'; end if;
  -- the reversal is dated today, like the accrual; original_period_month is not a posting date
  perform public.reverse_journal_for_source(a.company_id, 'payroll_adjustments', a.id, current_date);
  update public.payroll_adjustments
     set status = 'cancelled', cancelled_reason = trim(p_reason), settled_at = now(), settled_by = auth.uid()
   where id = a.id;
end;
$fn$;
revoke execute on function public.cancel_payroll_adjustment(uuid, text) from anon, public;
grant  execute on function public.cancel_payroll_adjustment(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. CARRY-FORWARD SETTLES WITH THE PAYSLIP IT LANDED ON.
--
-- What the next payslip should carry, and the trigger that marks the
-- adjustments settled when that payslip is disbursed. The screen writes
-- adjustment_carried from carried_adjustments_for(); the trigger settles the
-- rows whose sum it carried. Neither side computes the other's half.
-- ---------------------------------------------------------------------------
create or replace function public.carried_adjustments_for(p_period_month date)
returns table (employee_id uuid, carried numeric, detail text)
language sql
stable
security invoker
set search_path to 'public'
as $fn$
  select a.employee_id,
         sum(a.amount),
         string_agg(to_char(a.original_period_month, 'Mon YYYY') || ': ' || to_char(a.amount, 'FMS999,999,999') || ' — ' || a.reason,
                    ' · ' order by a.original_period_month)
    from public.payroll_adjustments a
   where a.status = 'open'
     and a.settlement = 'carry_forward'
     and a.original_period_month < date_trunc('month', p_period_month)::date
   group by a.employee_id
$fn$;
grant execute on function public.carried_adjustments_for(date) to authenticated;

create or replace function public.settle_carried_adjustments()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  if new.disbursed and not coalesce(old.disbursed, false) and new.adjustment_carried <> 0 then
    update public.payroll_adjustments a
       set status = 'settled', settled_at = now(), settled_payslip_id = new.id
     where a.employee_id = new.employee_id
       and a.status = 'open' and a.settlement = 'carry_forward'
       and a.original_period_month < new.period_month;
  end if;
  return new;
end;
$fn$;
drop trigger if exists trg_payslip_settles_adjustments on public.payslips;
create trigger trg_payslip_settles_adjustments
  after update of disbursed on public.payslips
  for each row execute function public.settle_carried_adjustments();

-- A carried line that was never paid: the payslip it should be on is disbursed
-- and does not carry it, or the period is about to close with it still open.
create or replace function public.unsettled_payroll_adjustments(p_company_id uuid)
returns table (adjustment_id uuid, employee_id uuid, original_period_month date, amount numeric, settlement text, days_open integer, reason text)
language plpgsql
stable security definer
set search_path to 'public'
as $fn$
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  return query
  select a.id, a.employee_id, a.original_period_month, a.amount, a.settlement::text,
         (current_date - a.raised_at::date)::int,
         case
           when a.settlement = 'carry_forward' and exists (
             select 1 from public.payslips p
              where p.employee_id = a.employee_id and p.period_month > a.original_period_month
                and p.disbursed and p.adjustment_carried = 0)
             then 'a later payslip was disbursed without carrying this'
           when a.settlement = 'pay_now' and a.raised_at < now() - interval '14 days'
             then 'pay-now, unpaid for two weeks'
         end::text
    from public.payroll_adjustments a
   where a.company_id = p_company_id and a.status = 'open'
     and (
       (a.settlement = 'carry_forward' and exists (
          select 1 from public.payslips p
           where p.employee_id = a.employee_id and p.period_month > a.original_period_month
             and p.disbursed and p.adjustment_carried = 0))
       or (a.settlement = 'pay_now' and a.raised_at < now() - interval '14 days'))
   order by a.original_period_month, a.raised_at;
end;
$fn$;

-- ledger_checks: SURGERY, canary counted then bumped.
do $$
declare
  v_def text; v_new text; v_hits int; v_co uuid; v_real int; v_passed boolean;
  a_ins text := 'select ''monthly_ledger_run_is_current''::text,';
  a_can text := 'from (select 38::numeric n) e (n);   -- expected_check_count';
begin
  select id into v_co from public.companies where active and archived_at is null order by created_at limit 1;
  if v_co is null then raise exception '0437 REFUSED: no company to count against.'; end if;
  select count(*) into v_real from public.ledger_checks(v_co) where check_name <> 'checks_evaluated';
  if v_real <> 38 then
    raise exception '0437 REFUSED: ledger_checks evaluates % real checks, not the 38 this was written against (0436 makes 38).', v_real;
  end if;
  select pg_get_functiondef(p.oid) into v_def from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'ledger_checks';
  v_hits := (length(v_def) - length(replace(v_def, a_ins, ''))) / length(a_ins);
  if v_hits <> 1 then raise exception '0437 REFUSED: ledger_checks insertion anchor appears % time(s).', v_hits; end if;
  v_hits := (length(v_def) - length(replace(v_def, a_can, ''))) / length(a_can);
  if v_hits <> 1 then raise exception '0437 REFUSED: the canary literal 38 appears % time(s).', v_hits; end if;
  v_new := replace(v_def, a_ins,
    'select ''no_adjustment_quietly_stops_existing''::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.unsettled_payroll_adjustments(p_company_id)
    union all
    ' || a_ins);
  v_new := replace(v_new, a_can, 'from (select 39::numeric n) e (n);   -- expected_check_count');
  execute v_new;
  select passed into v_passed from public.ledger_checks(v_co) where check_name = 'checks_evaluated';
  if v_passed is not true then raise exception '0437 FAILED: checks_evaluated is not green after the bump.'; end if;
  select passed into v_passed from public.ledger_checks(v_co) where check_name = 'no_adjustment_quietly_stops_existing';
  if v_passed is not true then raise exception '0437 FAILED: the new check is red on arrival.'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. THE PROBE. Rolled back. The 35,000 → 40,000 case on LAST month's payslip:
-- the accrual is dated TODAY (not last month), the payable moves by exactly
-- 5,000, and settling now moves cash by exactly 5,000 through the ledger and
-- the balance both.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co uuid; v_uid uuid; v_emp uuid; v_ps uuid; v_adj uuid; v_n int; v_d numeric; v_c numeric;
  v_cash_before numeric; v_cash_after numeric; v_bank uuid; v_bal_before numeric; v_bal_after numeric;
begin
  select id into v_co from public.companies where active and archived_at is null order by created_at limit 1;
  select p.id into v_uid from public.profiles p where p.company_id = v_co
   and p.role in ('super_admin','super_super_admin') order by p.role limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  -- A guard with NO payslip last month or this month, or the probe collides with
  -- payslips_employee_id_period_month_key on a real one.
  select e.id into v_emp from public.employees e
   where e.company_id = v_co and e.lifecycle_state = 'active'
     and not exists (select 1 from public.payslips p where p.employee_id = e.id
                      and p.period_month >= (date_trunc('month', current_date) - interval '1 month')::date)
   limit 1;
  if v_emp is null then raise exception '0437 PROBE FAILED: no active guard free of recent payslips to probe with.'; end if;
  select id, balance into v_bank, v_bal_before from public.bank_accounts where company_id = v_co limit 1;
  if v_bank is null then raise exception '0437 PROBE FAILED: no bank account to settle against.'; end if;
  -- Bank-paid, so the payslip's own disbursement needs no cash custodian.
  insert into public.payslips (company_id, employee_id, period_month, base_salary, final_salary, net_salary,
                               payment_mode, bank_account_id, disbursed, amount_paid, disbursed_at)
  values (v_co, v_emp, (date_trunc('month', current_date) - interval '1 month')::date, 35000, 35000, 35000,
          'Bank', v_bank, true, 35000, now())
  returning id into v_ps;

  -- RAISE. +5,000, pay now.
  v_adj := public.raise_payroll_adjustment(v_ps, 5000, 'Two night shifts missed from the sheet', 'pay_now');

  select count(*), sum(jl.debit), sum(jl.credit) into v_n, v_d, v_c
    from public.journal_entries je join public.journal_lines jl on jl.journal_entry_id = je.id
   where je.source_table = 'payroll_adjustments' and je.source_id = v_adj
     and je.entry_date = current_date;
  if v_n = 0 or v_d <> 5000 or v_c <> 5000 then
    raise exception '0437 PROBE FAILED: the accrual is % line(s), % / %, expected a balanced 5000 dated TODAY.', v_n, v_d, v_c;
  end if;
  if exists (select 1 from public.journal_entries je where je.source_table = 'payroll_adjustments' and je.source_id = v_adj
              and je.entry_date < date_trunc('month', current_date)::date) then
    raise exception '0437 PROBE FAILED: an accrual line was dated into the original period.';
  end if;
  if (select original_period_month from public.payroll_adjustments where id = v_adj)
     <> (date_trunc('month', current_date) - interval '1 month')::date then
    raise exception '0437 PROBE FAILED: original_period_month does not name the payslip''s period.';
  end if;
  select coalesce(sum(jl.credit - jl.debit), 0) into v_c
    from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_entry_id
    join public.chart_of_accounts a on a.id = jl.account_id
   where je.source_table = 'payroll_adjustments' and je.source_id = v_adj and a.system_key = 'salaries_payable';
  if v_c <> 5000 then raise exception '0437 PROBE FAILED: salaries payable moved by %, expected +5000.', v_c; end if;

  -- SETTLE NOW, by bank. The balance moves by exactly 5,000 and so does the ledger.
  select balance into v_bal_before from public.bank_accounts where id = v_bank;
  perform public.settle_payroll_adjustment(v_adj, 'Bank', v_bank, null, current_date);
  select balance into v_bal_after from public.bank_accounts where id = v_bank;
  if v_bal_after <> v_bal_before - 5000 then
    raise exception '0437 PROBE FAILED: the bank balance moved by %, expected -5000.', v_bal_after - v_bal_before;
  end if;
  select coalesce(sum(jl.debit - jl.credit), 0) into v_d
    from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_entry_id
    join public.chart_of_accounts a on a.id = jl.account_id
   where je.source_table = 'payroll_adjustment_settlement' and je.source_id = v_adj and a.system_key = 'salaries_payable';
  if v_d <> 5000 then raise exception '0437 PROBE FAILED: settlement debited salaries payable %, expected 5000.', v_d; end if;
  if (select status from public.payroll_adjustments where id = v_adj) <> 'settled' then
    raise exception '0437 PROBE FAILED: the adjustment is not marked settled.';
  end if;

  -- A second raise, negative, carried: the next period's payslip carries -2000
  -- and disbursing it settles the adjustment.
  v_adj := public.raise_payroll_adjustment(v_ps, -2000, 'Advance paid twice', 'carry_forward');
  select carried into v_d from public.carried_adjustments_for(date_trunc('month', current_date)::date) where employee_id = v_emp;
  if v_d <> -2000 then raise exception '0437 PROBE FAILED: carried_adjustments_for says %, expected -2000.', v_d; end if;

  insert into public.payslips (company_id, employee_id, period_month, base_salary, final_salary, net_salary, adjustment_carried,
                               payment_mode, bank_account_id, disbursed, amount_paid)
  values (v_co, v_emp, date_trunc('month', current_date)::date, 30000, 30000, 28000, -2000, 'Bank', v_bank, false, 0)
  returning id into v_ps;
  update public.payslips set disbursed = true, disbursed_at = now(), amount_paid = 28000 where id = v_ps;
  if (select status from public.payroll_adjustments where id = v_adj) <> 'settled'
     or (select settled_payslip_id from public.payroll_adjustments where id = v_adj) <> v_ps then
    raise exception '0437 PROBE FAILED: disbursing the carrying payslip did not settle the adjustment.';
  end if;

  raise exception 'ROLLBACK_PROBE';
exception
  when others then
    perform set_config('request.jwt.claims', null, true);
    perform set_config('request.jwt.claim.sub', null, true);
    if sqlerrm <> 'ROLLBACK_PROBE' then raise; end if;
    raise notice '0437 probe passed: +5000 accrued today against last month''s payslip, settled by bank; -2000 carried and settled by the next payslip.';
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
    raise exception '0437 REFUSED: tenant_guard_gaps() reports % gap(s): %.', v_n, v_who;
  end if;
end $$;
