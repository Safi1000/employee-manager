-- 0649: payroll_client_shares — which clients each person worked for in a pay
-- month, and in what share. Read by the Payroll screen.
--
-- Why. The Payroll screen grouped every payslip under the guard's CURRENT
-- client (employees.client_id). Waqas Ahmed (GGS-00647) worked all 31 days of
-- October 2026 at Regent 1 and was transferred to Ms. Yasmin Yousaf on 1 Nov,
-- so his October pay showed under Ms. Yasmin Yousaf. The ledger already had
-- it right: post_payslip_accrual splits the cost by payslip_client_split(),
-- by days worked, and puts 100% on Regent 1. The screen was the odd one out.
--
-- DECIDED (11 Nov 2026): a person who worked for more than one client in a
-- month appears under EACH client, with that client's share of the pay — the
-- same split the accrual posts. Not "the client with the most days".
--
-- The rule is payslip_client_split()'s, stated per employee and month rather
-- than per payslip, because the screen needs it before payslips exist (the
-- Review step). Present / double_duty / relief_cover days, attributed to
-- worked_for_client_id, else the employee's current client; weights sum to 1.
-- A person with no such days returns NO row, and the caller falls back to the
-- current client at weight 1 — exactly payslip_client_split()'s fallback.
--
-- That makes this a second statement of one rule, which is where
-- disagreements live. payslip_client_split() has two authors (0223, 0242) and
-- is not restated here. Instead, the assertion at the end compares the two
-- over EVERY payslip on file and refuses the migration if any payslip's split
-- differs. If either is changed later, change both.
--
-- SECURITY INVOKER, like attendance_period_counts(): a read, scoped by the
-- caller's own RLS on attendance_records and employees. A row RLS hides is a
-- person the screen does not show either.
--
-- Not changed, and why: post_payslip_disbursement() tags the payout entry with
-- the current client, but no client figure reads that tag — the client P&L
-- reads cos_payroll / opex_office_payroll (accrual, already split) and
-- payroll_cash_by_client() splits by attendance itself.

create or replace function public.payroll_client_shares(p_period date)
returns table(employee_id uuid, client_id uuid, weight numeric)
language sql
stable
set search_path to 'public'
as $function$
  with m as (select date_trunc('month', p_period)::date as start),
  days as (
    select a.employee_id,
           coalesce(a.worked_for_client_id, e.client_id) as cid,
           count(*)::numeric as d
      from m
      join public.attendance_records a
        on a.attendance_date >= m.start
       and a.attendance_date <  (m.start + interval '1 month')
      join public.employees e on e.id = a.employee_id
     where lower(a.status) in ('present', 'double_duty', 'relief_cover')
     group by 1, 2
  )
  select days.employee_id, days.cid,
         days.d / sum(days.d) over (partition by days.employee_id)
    from days;
$function$;

comment on function public.payroll_client_shares(date) is
  '0649: per employee, the clients worked for in the pay month and each one''s share (weights sum to 1). '
  'No row = no present days: caller uses the current client at weight 1. '
  'SAME RULE as payslip_client_split(); 0649 asserted they agree on every payslip. Change both together.';

-- The two statements of the rule must agree on every payslip on file. This is
-- the failure being guarded against — a payslip whose screen split differs
-- from its posted split — and it is what the comparison measures.
do $$
declare v_n int; v_bad int; v_eg text;
begin
  select count(*) into v_n from public.payslips;
  if v_n = 0 then
    raise exception '0649 REFUSED: no payslips to compare against; the agreement check would be vacuous.';
  end if;

  with ps as (
    select p.id, p.employee_id, p.period_month from public.payslips p
  ),
  posted as (
    select ps.id, s.client_id, round(s.weight, 6) as w
      from ps cross join lateral public.payslip_client_split(ps.id) s
  ),
  months as (select distinct period_month from ps),
  sh as (
    select mo.period_month, s.employee_id, s.client_id, s.weight
      from months mo cross join lateral public.payroll_client_shares(mo.period_month) s
  ),
  screen as (
    select ps.id,
           case when sh.employee_id is null then e.client_id else sh.client_id end as client_id,
           round(coalesce(sh.weight, 1), 6) as w
      from ps
      join public.employees e on e.id = ps.employee_id
      left join sh on sh.employee_id = ps.employee_id and sh.period_month = ps.period_month
  ),
  diff as (
    (select * from posted except select * from screen)
    union all
    (select * from screen except select * from posted)
  )
  select count(distinct id), min(id::text) into v_bad, v_eg from diff;

  if v_bad <> 0 then
    raise exception '0649 REFUSED: payroll_client_shares disagrees with payslip_client_split on % of % payslip(s), e.g. %.',
      v_bad, v_n, v_eg;
  end if;
end $$;

-- Tenant guard assertion (scripts/migration-template.sql §2).
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;

  if v_n <> 0 then
    raise exception
      '0649 REFUSED: tenant_guard_gaps() reports % gap(s): %. Every uuid parameter that names a tenant-scoped row needs a guard the detector can see.',
      v_n, v_who;
  end if;
end $$;
