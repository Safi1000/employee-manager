-- 0500 — an advance is recovered from the payslip that has not been paid yet.
--
-- DECIDED (2026-10-07, Shayan): an advance paid on 7 October, while the
-- employee's SEPTEMBER payslip is still undisbursed, is deducted from
-- September. If September has already been disbursed, it is deducted from
-- October (its own month) as before.
--
-- Until now employee_advance_outstanding(p) counted only advances dated
-- before the end of p, so the 7 October advance could only ever reach
-- October — salary for September, paid in early October, went out in full
-- and the advance waited a month.
--
-- The rule for period p, per employee:
--   * every advance dated within or before p counts (unchanged);
--   * an advance dated in the month AFTER p also counts, when p's payslip is
--     not disbursed — or was disbursed after the advance was recorded, so a
--     disbursed payslip keeps exactly the advance it was paid against and its
--     figures never move afterwards;
--   * except the overpayment carry-forward rows (0391): those are dated next
--     month on purpose and are an overpayment OF p, so they never count in p.
-- Recovered stays Σ payslips.advance before p, so whatever a month did not
-- recover carries forward exactly as before.
--
-- employee_advance_outstanding has one author (0187), so it is restated here,
-- behind a check that the live body is still 0187's.

do $$
declare v_def text;
begin
  select pg_get_functiondef('public.employee_advance_outstanding(date)'::regprocedure) into v_def;
  if (length(v_def) - length(replace(v_def, 'a.advance_date < (p_period_start + interval ''1 month'')', '')))
       / length('a.advance_date < (p_period_start + interval ''1 month'')') <> 1 then
    raise exception '0500: employee_advance_outstanding is not the 0187 body this migration replaces. Nothing changed.';
  end if;
end $$;

create or replace function public.employee_advance_outstanding(p_period_start date)
returns table(employee_id uuid, outstanding numeric)
language sql
stable security definer
set search_path to 'public'
as $function$
  -- 0500: an advance dated next month counts in this one while this month's
  -- payslip is not yet disbursed (or was disbursed after it was recorded).
  with cid as (select public.current_company_id() as company_id),
  adv as (
    select a.employee_id, sum(a.amount)::numeric as total
      from public.advances a cross join cid
     where a.company_id = cid.company_id
       and (
         a.advance_date < (p_period_start + interval '1 month')
         or (
           a.advance_date < (p_period_start + interval '2 months')
           and coalesce(a.notes, '') not like 'Payroll overpayment carry-forward%'
           and not exists (
             select 1 from public.payslips p
              where p.employee_id = a.employee_id
                and p.period_month = p_period_start
                and p.disbursed
                and (p.disbursed_at is null or p.disbursed_at < a.created_at)
           )
         )
       )
     group by a.employee_id
  ),
  rec as (
    select p.employee_id, sum(p.advance)::numeric as recovered
      from public.payslips p
      join public.employees e on e.id = p.employee_id
     cross join cid
     where e.company_id = cid.company_id
       and p.period_month < p_period_start
     group by p.employee_id
  )
  select coalesce(adv.employee_id, rec.employee_id) as employee_id,
         greatest(coalesce(adv.total, 0) - coalesce(rec.recovered, 0), 0) as outstanding
    from adv
    full join rec on rec.employee_id = adv.employee_id;
$function$;

comment on function public.employee_advance_outstanding(date) is
  '0500: outstanding advance for payroll period p. Counts advances dated through p, plus those dated in p+1 while p''s payslip is undisbursed (or disbursed after the advance was recorded); overpayment carry-forwards never count back into p. DECIDED 2026-10-07.';

revoke execute on function public.employee_advance_outstanding(date) from public, anon;
grant execute on function public.employee_advance_outstanding(date) to authenticated;

-- Tenant guard assertion (scripts/migration-template.sql).
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0500 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
