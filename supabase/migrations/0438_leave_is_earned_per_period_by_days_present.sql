-- 0438 — leave is earned per period, by days present.
--
-- Effective 1 September 2026, and ONLY from there: the gate is inside the
-- earning function (leave_periods_all), not in its callers, so no recompute
-- path can retrofit the rule onto an earlier month. September is RECALCULATED,
-- not skipped — its attendance is already recorded, and this derives from it.
--
-- THIS CHANGES ONE FIGURE: the number of leaves a guard is ALLOWED for the
-- period. No rate, deduction, posting, accrual or other payroll behaviour is
-- touched. The payroll screen reads "allowed" from leave_period_summary from
-- September on, exactly where it read the contract figure before.
--
-- NOTHING HERE STORES A BALANCE. Every balance reads zero at 1 September 2026
-- (DECIDED: no opening balances). Everything after — earned, lost at the cap,
-- taken, unpaid, closing — is derived from attendance every time it is read,
-- so a balance can always be shown with its derivation. A balance with no
-- derivation is a number people dispute.
--
-- THE QUOTA Q is the contract's allowed_leaves_per_month (DECIDED). Some
-- contracts carry 4, some 2, some none; none means ZERO earned, and that is
-- correct — not a data gap. No client fallback, no category default, no gate
-- on the run. Office staff and relievers have no contract and earn zero by
-- design. THE ONE EXCEPTION IS A NAMED HUMAN DECISION: a per-guard override
-- (employees.leave_quota_override) replaces the contract's figure entirely,
-- and it is AUDITABLE — who, when, why — and NEVER BLANK: an override without
-- a reason cannot exist, and null means "no override", not zero.
-- On a MID-PERIOD TRANSFER Q is the average
-- over DAYS PRESENT of the contract in force on each present day, not by
-- majority — majority ties at 11/11 and hands a guard a whole contract's
-- quota for half a period on it.
--
-- SERVICE DAYS = DAYS PRESENT. Leave marks and absences are not present.
--
-- TIERS, on days present:   1–8 → 1   9–16 → 2   17–24 → 3   25+ → 4
-- earned = (t = 1) ? 0 : floor(Q × t / 4), ROUNDED DOWN TO WHOLE DAYS
-- explicitly (leave_earned). A 2-leave contract earns 1 at tier 3 and 0 at
-- tier 1. No half days exist anywhere.
--
-- CONSUMPTION (DECIDED): only LEAVE MARKS are paid from the balance. An
-- ABSENCE IS UNPAID AND DOES NOT TOUCH THE BALANCE; it only lowers the tier
-- through days present. Leave marks past the balance are unpaid.
--
-- CARRY-FORWARD, CAPPED AT 15. At the cap EARNING STOPS rather than accruing
-- and being discarded: a guard at 14 who earns 4 banks 1 and LOSES 3, and the
-- 3 are shown as lost on the ledger rather than vanishing.
--
-- PAYROLL PERIODS ARE CALENDAR MONTHS until payroll cycles land. DEFERRED on
-- leave_periods_all: when contract_periods(..., 'payroll') is consumed, the
-- walk uses those periods instead.

-- ---------------------------------------------------------------------------
-- 0. THE PER-GUARD OVERRIDE. Set through set_leave_quota_override() only, so
-- who/when/why are always stamped together; the constraint makes a half-set
-- override impossible either way round.
-- ---------------------------------------------------------------------------
alter table public.employees
  add column if not exists leave_quota_override        integer,
  add column if not exists leave_quota_override_reason text,
  add column if not exists leave_quota_override_by     uuid,
  add column if not exists leave_quota_override_at     timestamptz;
alter table public.employees drop constraint if exists leave_quota_override_complete;
-- EVERY TERM IS NULL-SAFE, deliberately. A CHECK passes when it evaluates to
-- NULL, not only to true: written as length(trim(reason)) > 0, a null reason made
-- the second arm NULL and the row was ACCEPTED — an override with no reason, the
-- one thing this constraint exists to refuse. The probe below caught it. Each
-- term here is is [not] null or guarded by one, so the check is true or false.
alter table public.employees add constraint leave_quota_override_complete check (
  (leave_quota_override is null and leave_quota_override_reason is null
     and leave_quota_override_by is null and leave_quota_override_at is null)
  or
  (leave_quota_override is not null and leave_quota_override between 0 and 31
     and leave_quota_override_reason is not null and length(trim(leave_quota_override_reason)) > 0
     and leave_quota_override_by is not null and leave_quota_override_at is not null)
);
comment on column public.employees.leave_quota_override is
  '0438: this guard''s monthly leave quota, replacing the contract''s entirely when set (including the weighting on a mid-period transfer). NULL = no override, use the contract. Cannot exist without reason/by/at (leave_quota_override_complete); set via set_leave_quota_override().';

create or replace function public.set_leave_quota_override(p_employee_id uuid, p_quota integer, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  perform public.require_perm('payroll.edit');
  -- tenant guard [resolved]: owning company looked up from p_employee_id via public.employees (0438)
  if p_employee_id is not null then perform public.assert_same_company((select company_id from public.employees where id = p_employee_id)); end if;
  if p_quota is null then
    -- Clearing leaves no override to explain: the row returns to "use the contract".
    update public.employees
       set leave_quota_override = null, leave_quota_override_reason = null,
           leave_quota_override_by = null, leave_quota_override_at = null
     where id = p_employee_id;
  else
    if p_reason is null or length(trim(p_reason)) = 0 then
      raise exception 'A quota override needs a reason — it is a decision recorded against a named guard, not a setting.';
    end if;
    update public.employees
       set leave_quota_override = p_quota, leave_quota_override_reason = trim(p_reason),
           leave_quota_override_by = auth.uid(), leave_quota_override_at = now()
     where id = p_employee_id;
  end if;
  if not found then raise exception 'Employee not found.'; end if;
end;
$fn$;
revoke execute on function public.set_leave_quota_override(uuid, integer, text) from anon, public;
grant  execute on function public.set_leave_quota_override(uuid, integer, text) to authenticated;

comment on column public.contracts.allowed_leaves_per_month is
  '0438: Q — the full-tier monthly leave quota for guards on this contract. Earned per payroll period by tier of days present: floor(Q × t / 4), nothing at tier 1. Null or 0 means zero earned — DECIDED, not a data gap; there is no client or category fallback.';

-- ---------------------------------------------------------------------------
-- 1. THE FORMULA, alone, so the test matrix can hit it.
-- ---------------------------------------------------------------------------
create or replace function public.leave_tier(p_present int)
returns int language sql immutable as $fn$
  select case when p_present >= 25 then 4 when p_present >= 17 then 3 when p_present >= 9 then 2 else 1 end
$fn$;

-- ROUNDS DOWN TO WHOLE DAYS, and says so: the division is numeric (4.0) so
-- nothing is truncated by accident, then floor() is the rounding, then ::int.
create or replace function public.leave_earned(p_quota numeric, p_tier int)
returns int language sql immutable as $fn$
  select case when p_tier <= 1 then 0
              else floor(coalesce(p_quota, 0) * p_tier / 4.0)::int end
$fn$;
comment on function public.leave_earned(numeric, int) is
  '0438: floor(Q × t / 4) — rounds DOWN to whole days explicitly; tier 1 earns nothing; null Q earns nothing.';

-- What can be banked against a 15-day cap. The rest is LOST — reported, not dropped.
create or replace function public.leave_banked(p_opening numeric, p_earned int)
returns int language sql immutable as $fn$
  select least(p_earned, greatest(15 - p_opening, 0))::int
$fn$;

-- THE TEST MATRIX FROM THE SPEC. All twenty cells, asserted, or the migration
-- refuses. floor not round is the cell (Q=2, t=3) = 1.
do $$
declare
  m int[][] := array[[1,0,0,0,1],[2,0,1,1,2],[3,0,1,2,3],[4,0,2,3,4],[6,0,3,4,6]];
  r int; t int; v int;
begin
  for r in 1..5 loop
    for t in 1..4 loop
      v := public.leave_earned(m[r][1], t);
      if v <> m[r][t+1] then
        raise exception '0438 REFUSED: leave_earned(Q=%, t=%) = %, expected %.', m[r][1], t, v, m[r][t+1];
      end if;
    end loop;
  end loop;
  if public.leave_earned(null, 4) <> 0 or public.leave_earned(0, 4) <> 0 then
    raise exception '0438 REFUSED: a null or zero quota must earn nothing.';
  end if;
  if public.leave_tier(8) <> 1 or public.leave_tier(9) <> 2 or public.leave_tier(16) <> 2
     or public.leave_tier(17) <> 3 or public.leave_tier(24) <> 3 or public.leave_tier(25) <> 4 then
    raise exception '0438 REFUSED: the tier bands are wrong.';
  end if;
  -- THE CAP-CROSSING CASE: 14 + 4 earned → banks 1, loses 3.
  if public.leave_banked(14, 4) <> 1 or public.leave_banked(15, 4) <> 0 or public.leave_banked(0, 4) <> 4 then
    raise exception '0438 REFUSED: leave_banked(14, 4) = %, expected 1.', public.leave_banked(14, 4);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. THE LEDGER. Every guard, every payroll period from September 2026,
-- derived. One walk; the readers below filter it.
-- ---------------------------------------------------------------------------
create or replace function public.leave_periods_all(p_company_id uuid, p_through date default current_date)
returns table (
  employee_id uuid, period_start date, period_end date,
  present_days int, leave_days int, absent_days int,
  tier int, quota numeric, earned int, lost int,
  opening numeric, taken int, unpaid int, closing numeric)
language plpgsql
stable security definer
set search_path to 'public'
as $fn$
-- the OUT column employee_id would otherwise shadow the CTE columns of the same name
#variable_conflict use_column
declare
  c_from  constant date := '2026-09-01';   -- DECIDED: effective 1 September 2026
  v_ms date; v_me date;
  v_bal jsonb := '{}'::jsonb;              -- employee_id → closing balance so far; opens empty (zero)
  r record; v_open numeric; v_q numeric; v_t int; v_earn int; v_lost int; v_take int; v_unpaid int; v_close numeric;
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  -- THE EFFECTIVE-DATE GATE LIVES HERE, not in any caller: nothing before
  -- 1 September 2026 is ever produced by this function, whoever asks.
  -- DEFENCE-IN-DEPTH: the load-bearing control is that no posting or recompute
  -- path calls this function at all (section 4). Keep both.
  if p_through < c_from then return; end if;

  v_ms := c_from;
  -- DEFERRED: calendar months until payroll cycles are consumed; then the
  -- contract's payroll periods via contract_periods(..., 'payroll').
  while v_ms <= date_trunc('month', p_through)::date loop
    v_me := (v_ms + interval '1 month - 1 day')::date;

    for r in
      with ap as (
        select a.employee_id, a.present_days, a.leave_days, a.absent_days
          from public.attendance_payroll(v_ms, v_me) a
          join public.employees e on e.id = a.employee_id
         where e.company_id = p_company_id
      ),
      -- Q from the CONTRACT in force on each present day (via the deployment;
      -- the employee's own contract when no deployment covers the day), then
      -- averaged over present days. No client or category fallback: none = 0.
      pd as (
        select distinct ar.employee_id, ar.attendance_date
          from public.attendance_records ar
         where ar.attendance_date between v_ms and v_me
           and lower(ar.status) in ('present', 'double_duty', 'relief_cover')
           and ar.employee_id in (select employee_id from ap)
      ),
      pq as (
        select pd.employee_id,
               coalesce(
                 (select k.allowed_leaves_per_month
                    from public.deployments d
                    join public.contract_lines l on l.id = d.contract_line_id
                    join public.contracts k on k.id = l.contract_id
                   where d.guard_id = pd.employee_id
                     and d.start_date <= pd.attendance_date
                     and coalesce(d.end_date, 'infinity'::date) >= pd.attendance_date
                   order by d.start_date desc limit 1),
                 (select k.allowed_leaves_per_month
                    from public.employees e
                    join public.contracts k on k.id = e.contract_id
                   where e.id = pd.employee_id),
                 0)::numeric as q
          from pd
      ),
      wq as (select employee_id, avg(q) as q from pq group by employee_id)
      -- the override, when set, replaces the whole weighted figure; null = no override
      select ap.employee_id, ap.present_days, ap.leave_days, ap.absent_days,
             coalesce(e.leave_quota_override::numeric, wq.q, 0) as q
        from ap
        join public.employees e on e.id = ap.employee_id
        left join wq on wq.employee_id = ap.employee_id
    loop
      v_open := coalesce((v_bal ->> r.employee_id::text)::numeric, 0);
      v_q    := r.q;
      v_t    := public.leave_tier(r.present_days);
      v_earn := public.leave_earned(v_q, v_t);
      -- THE CAP: earning stops at 15. What would have taken the balance past it
      -- is LOST, and reported as lost, not silently dropped.
      v_lost := v_earn - public.leave_banked(v_open, v_earn);
      v_earn := v_earn - v_lost;
      -- ONLY LEAVE MARKS consume the balance; an absence is unpaid and does
      -- not touch it (DECIDED). Leave marks past the balance are unpaid.
      v_take   := least(r.leave_days, floor(v_open + v_earn))::int;
      v_unpaid := r.leave_days - v_take;
      v_close  := v_open + v_earn - v_take;

      employee_id := r.employee_id; period_start := v_ms; period_end := v_me;
      present_days := r.present_days; leave_days := r.leave_days; absent_days := r.absent_days;
      tier := v_t; quota := round(v_q, 2); earned := v_earn; lost := v_lost;
      opening := v_open; taken := v_take; unpaid := v_unpaid; closing := v_close;
      return next;

      v_bal := v_bal || jsonb_build_object(r.employee_id::text, v_close);
    end loop;

    v_ms := (v_ms + interval '1 month')::date;
  end loop;
end;
$fn$;
comment on function public.leave_periods_all(uuid, date) is
  '0438: the leave ledger for every guard, derived from attendance from 1 Sep 2026 (the gate is INSIDE this function): tier, quota, earned, lost at the cap, taken by leave marks, unpaid, closing. Nothing stored; every balance opens at zero. DEFERRED: walks calendar months until contract_periods(...,''payroll'') is consumed.';

-- One guard's ledger, for his record and the drawer.
create or replace function public.leave_ledger(p_employee_id uuid)
returns table (
  period_start date, period_end date, present_days int, leave_days int, absent_days int,
  tier int, quota numeric, earned int, lost int, opening numeric, taken int, unpaid int, closing numeric)
language sql stable security invoker set search_path to 'public' as $fn$
  select l.period_start, l.period_end, l.present_days, l.leave_days, l.absent_days,
         l.tier, l.quota, l.earned, l.lost, l.opening, l.taken, l.unpaid, l.closing
    from public.leave_periods_all((select company_id from public.employees where id = p_employee_id)) l
   where l.employee_id = p_employee_id
   order by l.period_start
$fn$;
grant execute on function public.leave_ledger(uuid) to authenticated;

-- One period for everyone — what the payroll screen reads for "allowed".
-- Empty before September 2026, because leave_periods_all is.
create or replace function public.leave_period_summary(p_period_start date)
returns table (
  employee_id uuid, present_days int, tier int, quota numeric, earned int, lost int,
  opening numeric, available numeric, taken int, unpaid int, closing numeric)
language sql stable security invoker set search_path to 'public' as $fn$
  select l.employee_id, l.present_days, l.tier, l.quota, l.earned, l.lost,
         l.opening, l.opening + l.earned, l.taken, l.unpaid, l.closing
    from public.leave_periods_all(public.current_company_id(), (p_period_start + interval '1 month - 1 day')::date) l
   where l.period_start = date_trunc('month', p_period_start)::date
$fn$;
grant execute on function public.leave_period_summary(date) to authenticated;

-- Guards who lost leave at the cap this period — visible, not silent.
create or replace function public.leave_lost_at_cap(p_company_id uuid, p_period_start date)
returns table (employee_id uuid, full_name text, opening numeric, would_earn int, banked int, lost int)
language plpgsql stable security definer set search_path to 'public' as $fn$
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  return query
  select l.employee_id, e.full_name, l.opening, l.earned + l.lost, l.earned, l.lost
    from public.leave_periods_all(p_company_id, (p_period_start + interval '1 month - 1 day')::date) l
    join public.employees e on e.id = l.employee_id
   where l.period_start = date_trunc('month', p_period_start)::date and l.lost > 0
   order by l.lost desc, e.full_name;
end;
$fn$;
grant execute on function public.leave_lost_at_cap(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. THE PROBE, rolled back. A guard on a 4-leave contract with attendance
-- this block INSERTS: present 1–10 September, leave on the 11th, absent on
-- the 12th (the attendance window refuses future days). Present 10 → tier 2 →
-- earns 2; the leave mark takes 1; the ABSENCE TAKES NOTHING; closing 1.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co uuid; v_uid uuid; v_emp uuid; v_client uuid; v_con uuid; r record; d date;
begin
  select id into v_co from public.companies where active and archived_at is null order by created_at limit 1;
  select p.id into v_uid from public.profiles p where p.company_id = v_co
   and p.role in ('super_admin','super_super_admin') order by p.role limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  select id into v_client from public.clients where company_id = v_co limit 1;
  insert into public.contracts (company_id, client_id, contract_code, contract_type, start_date, is_infinite, status, allowed_leaves_per_month)
  values (v_co, v_client, '0438-PROBE', 'services', '2026-01-01', true, 'active', 4) returning id into v_con;
  insert into public.employees (company_id, full_name, category, client_id, contract_id, lifecycle_state, base_salary)
  values (v_co, '0438 Probe Guard', 'client', v_client, v_con, 'active', 1000) returning id into v_emp;

  d := '2026-09-01';
  while d <= '2026-09-12' loop
    insert into public.attendance_records (company_id, employee_id, attendance_date, status, worked_shift, worked_for_client_id, supervisor_override)
    values (v_co, v_emp, d, case when d = '2026-09-11' then 'leave' when d = '2026-09-12' then 'absent' else 'present' end, 'D', v_client, true);
    d := d + 1;
  end loop;

  select * into r from public.leave_periods_all(v_co, '2026-09-30') l where l.employee_id = v_emp and l.period_start = '2026-09-01';
  if r.employee_id is null then raise exception '0438 PROBE FAILED: no September row for the probe guard.'; end if;
  if r.present_days <> 10 or r.leave_days <> 1 or r.absent_days <> 1 then
    raise exception '0438 PROBE FAILED: attendance read back as present % leave % absent %, expected 10 / 1 / 1.', r.present_days, r.leave_days, r.absent_days;
  end if;
  if r.tier <> 2 or r.quota <> 4 or r.opening <> 0 or r.earned <> 2 or r.lost <> 0 or r.taken <> 1 or r.unpaid <> 0 or r.closing <> 1 then
    raise exception '0438 PROBE FAILED: tier % quota % opening % earned % lost % taken % unpaid % closing % — expected 2 / 4 / 0 / 2 / 0 / 1 / 0 / 1 (the absence must not consume the balance).',
      r.tier, r.quota, r.opening, r.earned, r.lost, r.taken, r.unpaid, r.closing;
  end if;

  -- THE OVERRIDE: a named decision, replaces the contract, and cannot be blank.
  perform public.set_leave_quota_override(v_emp, 2, 'Probe: site agreed 2');
  select * into r from public.leave_periods_all(v_co, '2026-09-30') l where l.employee_id = v_emp and l.period_start = '2026-09-01';
  if r.quota <> 2 or r.earned <> 1 then
    raise exception '0438 PROBE FAILED: with an override of 2 the quota reads % and earned %, expected 2 / 1.', r.quota, r.earned;
  end if;
  begin
    perform public.set_leave_quota_override(v_emp, 3, '');
    raise exception '0438 PROBE FAILED: an override without a reason was accepted.';
  exception when others then
    if sqlerrm not like '%needs a reason%' then raise; end if;
  end;
  begin
    update public.employees set leave_quota_override_reason = null where id = v_emp;
    raise exception '0438 PROBE FAILED: an override lost its reason and the row was accepted.';
  exception when others then
    if sqlerrm not like '%leave_quota_override_complete%' then raise; end if;
  end;
  perform public.set_leave_quota_override(v_emp, null, null);
  if (select leave_quota_override_at from public.employees where id = v_emp) is not null then
    raise exception '0438 PROBE FAILED: clearing the override left its audit stamp behind.';
  end if;

  -- THE EFFECTIVE-DATE GATE, asserted on something that can fail: August 2026
  -- has real confirmed attendance (asserted first, so the call had rows to
  -- find), and the September-rule functions return NOTHING for it. If the gate
  -- or c_from ever moves earlier, this is the line that goes red.
  -- Defence-in-depth, not the load-bearing control: no posting or recompute
  -- path calls these functions at all — see section 4.
  if not exists (select 1 from public.attendance_payroll('2026-08-01', '2026-08-31')) then
    raise exception '0438 PROBE FAILED: no August 2026 attendance to test the gate against.';
  end if;
  if exists (select 1 from public.leave_periods_all(v_co, '2026-08-31'))
     or exists (select 1 from public.leave_period_summary('2026-08-01'))
     or exists (select 1 from public.leave_lost_at_cap(v_co, '2026-08-01')) then
    raise exception '0438 PROBE FAILED: the earning function produced a row for August 2026, before the effective date.';
  end if;

  raise exception 'ROLLBACK_PROBE';
exception
  when others then
    perform set_config('request.jwt.claims', null, true);
    perform set_config('request.jwt.claim.sub', null, true);
    if sqlerrm <> 'ROLLBACK_PROBE' then raise; end if;
    raise notice '0438 probe passed: present 10 → tier 2 → earned 2; leave mark takes 1, absence takes nothing; nothing before September.';
end $$;

-- ---------------------------------------------------------------------------
-- 4. WHAT ACTUALLY KEEPS AUGUST SAFE, pinned. The leave rule is NOT ON ANY
-- POSTING OR RECOMPUTE PATH: repost_payslip_accruals_for_month reverses and
-- re-posts the STORED payslip figures, and nothing in the database recomputes
-- gross, deductions or net from attendance. That absence is the load-bearing
-- control; the gate in leave_periods_all is defence-in-depth behind it. Do not
-- remove the gate as redundant, and do not trust it as the only thing there.
-- This probe pins the repost: every real August 2026 payslip is reposted and,
-- for the one with the most leave days, gross, deductions, net and the journal
-- account by account are asserted identical. Rolled back.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co uuid; v_uid uuid; v_ps uuid; b record; a record; jb text; ja text; n int;
begin
  select id into v_co from public.companies where active and archived_at is null order by created_at limit 1;
  select p.id into v_uid from public.profiles p where p.company_id = v_co
   and p.role in ('super_admin','super_super_admin') order by p.role limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  select p.id into v_ps from public.payslips p
   where p.company_id = v_co and p.period_month = '2026-08-01' and p.disbursed
   order by p.leave_days desc, p.id limit 1;
  if v_ps is null then raise exception '0438 PROOF FAILED: no disbursed August 2026 payslip to repost.'; end if;

  select final_salary, deductions, net_salary, leave_days into b from public.payslips where id = v_ps;
  select string_agg(k || '=' || d || '/' || c, ' ' order by k) into jb from (
    select coa.system_key k, sum(jl.debit) d, sum(jl.credit) c
      from public.journal_entries je
      join public.journal_lines jl on jl.journal_entry_id = je.id
      join public.chart_of_accounts coa on coa.id = jl.account_id
     where je.source_table = 'payslips' and je.source_id = v_ps and not je.is_reversal
       and not exists (select 1 from public.journal_entries rv where rv.reversal_of_entry_id = je.id)
     group by 1) x;

  n := public.repost_payslip_accruals_for_month(v_co, '2026-08-01');

  select final_salary, deductions, net_salary, leave_days into a from public.payslips where id = v_ps;
  select string_agg(k || '=' || d || '/' || c, ' ' order by k) into ja from (
    select coa.system_key k, sum(jl.debit) d, sum(jl.credit) c
      from public.journal_entries je
      join public.journal_lines jl on jl.journal_entry_id = je.id
      join public.chart_of_accounts coa on coa.id = jl.account_id
     where je.source_table = 'payslips' and je.source_id = v_ps and not je.is_reversal
       and not exists (select 1 from public.journal_entries rv where rv.reversal_of_entry_id = je.id)
     group by 1) x;

  if a.final_salary <> b.final_salary or a.deductions <> b.deductions or a.net_salary <> b.net_salary or a.leave_days <> b.leave_days then
    raise exception '0438 PROOF FAILED: August payslip % moved on repost: gross %→%, deductions %→%, net %→%.',
      v_ps, b.final_salary, a.final_salary, b.deductions, a.deductions, b.net_salary, a.net_salary;
  end if;
  if ja is distinct from jb then
    raise exception '0438 PROOF FAILED: August payslip % journal changed on repost: [%] → [%].', v_ps, jb, ja;
  end if;
  if exists (select 1 from public.leave_period_summary('2026-08-01')) then
    raise exception '0438 PROOF FAILED: leave_period_summary has an August 2026 row.';
  end if;

  raise exception 'ROLLBACK_PROBE';
exception
  when others then
    perform set_config('request.jwt.claims', null, true);
    perform set_config('request.jwt.claim.sub', null, true);
    if sqlerrm <> 'ROLLBACK_PROBE' then raise; end if;
    raise notice '0438 proof passed: % August payslips reposted, figures and journal identical, no leave row.', n;
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
    raise exception '0438 REFUSED: tenant_guard_gaps() reports % gap(s): %.', v_n, v_who;
  end if;
end $$;
