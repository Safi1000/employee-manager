-- 0540 — a reliever is paid for the days he stood
--
-- DECIDED 2026-10-16 (Shayan), built 2026-10-22:
--   * Relievers belong in payroll. Until now they were paid through advances
--     alone — no payslip, nothing for the advance to recover against.
--   * PAY BASIS on the employee, one of two:
--       monthly — base ÷ days_in_month × days worked (what attendance_payroll
--                 already does for everyone);
--       per_day — daily_rate × days worked.
--     The rate belongs to the MAN, never to the client he covers. Gaps are
--     unpaid on both bases. Per-day is the same payroll with a different rate
--     source, NOT a second payroll path: attendance_payroll is the one place.
--   * No reliever-type field. Site-specific versus pool is a deployment
--     pattern, not an attribute.
--   * Leave for a reliever is ZERO by default; a quota is given per man through
--     the existing set_leave_quota_override.
--
-- DEFERRED: the daily rate is current, not dated. A change of rate applies to
-- every payslip not yet generated. If a dated rate is wanted, the change is a
-- daily_rate column on employee_salary_history read through attendance_payroll's
-- `sal` CTE exactly as base_salary is.
--
-- attendance_payroll and leave_periods_all have each been edited by several
-- migrations: amended by surgery against the live definition, each anchor
-- asserted to appear exactly once.
--
-- Asserted on the things that can break: (1) no monthly-basis earning moves —
-- September's total earned is identical before and after; (2) a per-day man
-- earns daily_rate × worked shifts, proved on a real reliever inside a block
-- that is rolled back by a sentinel, and the sentinel's MESSAGE is checked so
-- an unrelated failure cannot pass as the rollback.

do $mig$
declare
  v_src text; v_cnt int; v_a text;
  v_co constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_before numeric; v_after numeric;
  v_emp uuid; v_shifts numeric; v_earned numeric;
begin
  select coalesce(sum(earned), 0) into v_before
    from public.attendance_payroll('2026-09-01', '2026-09-30') a
    join public.employees e on e.id = a.employee_id where e.company_id = v_co;

  -- ── 1. the basis and the rate, on the man ───────────────────────────────────
  alter table public.employees
    add column if not exists pay_basis  text not null default 'monthly',
    add column if not exists daily_rate numeric(12,2),
    -- who set it and why, like the leave-quota override beside it
    add column if not exists pay_basis_reason text,
    add column if not exists pay_basis_set_by uuid,
    add column if not exists pay_basis_set_at timestamptz;

  if not exists (select 1 from pg_constraint where conname = 'employees_pay_basis_check') then
    alter table public.employees add constraint employees_pay_basis_check
      check (pay_basis in ('monthly', 'per_day'));
  end if;
  -- A per-day man with no rate would earn zero and look paid. Refused instead.
  if not exists (select 1 from pg_constraint where conname = 'employees_per_day_has_a_rate') then
    alter table public.employees add constraint employees_per_day_has_a_rate
      check (pay_basis <> 'per_day' or coalesce(daily_rate, 0) > 0);
  end if;

  comment on column public.employees.pay_basis is
    'DECIDED 2026-10-16 (0540). monthly = base ÷ days in month × days worked; per_day = daily_rate × days worked. '
    'The rate is the man''s, never the client''s. Gaps are unpaid on both. Read by attendance_payroll only.';
  comment on column public.employees.daily_rate is
    'PKR per day worked when pay_basis = per_day (0540). Set on Assignments & Pay → pay basis. '
    'DEFERRED: current, not dated — see 0540''s header for the change if a dated rate is wanted.';

  -- ── 2. attendance_payroll: the per-shift rate follows the basis ─────────────
  v_src := pg_get_functiondef('public.attendance_payroll(date,date)'::regprocedure);
  if position('0540' in v_src) = 0 then
    v_a := E'      coalesce(s.base_salary, e.base_salary, 0) as rate,\n';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0540 REFUSED: rate anchor found % times.', v_cnt; end if;
    v_src := replace(v_src, v_a, v_a
      || E'      -- 0540: per_day pays the man''s daily rate per shift; monthly pays rate ÷ days in month.\n'
      || E'      e.pay_basis, e.daily_rate,\n');

    v_a := E'then rate / nullif(dim,0) else 0 end) as earned';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0540 REFUSED: earned anchor found % times.', v_cnt; end if;
    v_src := replace(v_src, v_a,
      E'then case when pay_basis = ''per_day'' then daily_rate else rate / nullif(dim,0) end else 0 end) as earned');

    execute v_src;
  end if;

  -- ── 3. leave_periods_all: a reliever's quota is zero unless one is given ────
  v_src := pg_get_functiondef('public.leave_periods_all(uuid,date)'::regprocedure);
  if position('0540' in v_src) = 0 then
    v_a := E'coalesce(e.leave_quota_override::numeric, wq.q, 0) as q';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0540 REFUSED: quota anchor found % times.', v_cnt; end if;
    v_src := replace(v_src, v_a,
      E'coalesce(e.leave_quota_override::numeric,\n'
      || E'                      -- 0540 DECIDED: a reliever earns no leave unless a quota is set for him,\n'
      || E'                      -- even on a contract line that gives its guards one.\n'
      || E'                      case when e.category::text = ''reliever'' then 0 end,\n'
      || E'                      wq.q, 0) as q');
    execute v_src;
  end if;

  -- ── 4. setting it: one RPC, gated as a salary change is ─────────────────────
  execute $fn$
  create or replace function public.set_employee_pay_basis(
    p_employee_id uuid, p_pay_basis text, p_daily_rate numeric, p_reason text)
  returns void
  language plpgsql security definer set search_path to 'public'
  as $body$
  declare v_n int;
  begin
    -- 0540: the same gate as set_employee_salary — the basis is how the man is paid.
    if auth.uid() is not null and pg_trigger_depth() = 0 then
      if not (public.has_perm('employees.edit') or public.has_perm('assignments.accounts')) then
        raise exception 'permission denied: employees.edit or assignments.accounts required' using errcode = '42501';
      end if;
    end if;
    perform public.assert_branch_writable((select e.branch_id from public.employees e where e.id = p_employee_id));
    -- tenant guard [resolved]: owning company looked up from p_employee_id via public.employees (0540)
    if p_employee_id is not null then perform public.assert_same_company((select company_id from public.employees where id = p_employee_id)); end if;

    if p_pay_basis not in ('monthly', 'per_day') then
      raise exception 'Pay basis must be monthly or per day. Nothing has been changed.' using errcode = 'P0001';
    end if;
    if p_pay_basis = 'per_day' and coalesce(p_daily_rate, 0) <= 0 then
      raise exception 'A per-day basis needs a daily rate above zero. Nothing has been changed.' using errcode = 'P0001';
    end if;
    if p_reason is null or length(trim(p_reason)) = 0 then
      raise exception 'A change of pay basis needs a reason — it changes what a named man is paid.' using errcode = 'P0001';
    end if;

    update public.employees
       set pay_basis        = p_pay_basis,
           daily_rate       = case when p_pay_basis = 'per_day' then round(p_daily_rate, 2) else daily_rate end,
           pay_basis_reason = trim(p_reason),
           pay_basis_set_by = auth.uid(),
           pay_basis_set_at = now()
     where id = p_employee_id;
    get diagnostics v_n = row_count;
    if v_n <> 1 then
      raise exception 'That employee no longer exists. Nothing has been changed.' using errcode = 'P0001';
    end if;
  end;
  $body$
  $fn$;
  revoke all on function public.set_employee_pay_basis(uuid, text, numeric, text) from public, anon;
  grant execute on function public.set_employee_pay_basis(uuid, text, numeric, text) to authenticated;

  -- ── asserts ─────────────────────────────────────────────────────────────────
  select coalesce(sum(earned), 0) into v_after
    from public.attendance_payroll('2026-09-01', '2026-09-30') a
    join public.employees e on e.id = a.employee_id where e.company_id = v_co;
  if abs(v_after - v_before) > 0.005 then
    raise exception '0540 REFUSED: September earnings moved from % to % with nobody on a per-day basis.', v_before, v_after;
  end if;

  select a.employee_id, a.worked_shifts into v_emp, v_shifts
    from public.attendance_payroll('2026-09-01', '2026-09-30') a
    join public.employees e on e.id = a.employee_id
   where e.company_id = v_co and e.category::text = 'reliever' and a.worked_shifts > 0
   order by a.worked_shifts desc limit 1;
  if v_emp is null then
    raise exception '0540 REFUSED: no reliever worked in September, so the per-day arm cannot be proved.';
  end if;
  begin
    update public.employees set pay_basis = 'per_day', daily_rate = 1234 where id = v_emp;
    select earned into v_earned from public.attendance_payroll('2026-09-01', '2026-09-30') where employee_id = v_emp;
    if abs(v_earned - 1234 * v_shifts) > 0.005 then
      raise exception '0540 REFUSED: a per-day man earned %, expected % (1,234 × % shifts).', v_earned, 1234 * v_shifts, v_shifts;
    end if;
    raise exception '0540-SENTINEL';
  exception when others then
    if sqlerrm <> '0540-SENTINEL' then raise; end if;
  end;
  if (select pay_basis from public.employees where id = v_emp) <> 'monthly' then
    raise exception '0540 REFUSED: the per-day proof was not rolled back.';
  end if;

  if exists (select 1 from public.leave_periods_all(v_co, '2026-09-30') l
               join public.employees e on e.id = l.employee_id
              where e.category::text = 'reliever' and e.leave_quota_override is null and l.quota <> 0) then
    raise exception '0540 REFUSED: a reliever with no override still earns leave.';
  end if;

  raise notice '0540: September earned % (unchanged); per-day proved on % shifts.', v_after, v_shifts;
end $mig$;
