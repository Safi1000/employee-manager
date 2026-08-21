-- 0187: outstanding advance balance per employee, so a partly-recovered advance
-- carries forward instead of being lost.
--
-- Payroll used to look only at advances DATED in the current month. When a
-- month's pay could not cover the advance, the payslip still recorded the full
-- advance as "recovered", so the shortfall (e.g. a 50k advance against 35k pay =
-- 15k left) vanished and never appeared in the next month.
--
-- The balance is the same figure the clearance module already uses:
--   Σ advances taken  −  Σ advance recovered on payslips.
-- Recovery counts only payslips of months BEFORE the one being run, so the
-- current month starts from the true opening balance and then recovers against
-- it (the caller caps recovery at what the month's pay can bear and writes the
-- ACTUAL amount to payslips.advance, which becomes next month's recovered sum).
create or replace function public.employee_advance_outstanding(p_period_start date)
returns table(employee_id uuid, outstanding numeric)
language sql
stable security definer
set search_path to 'public'
as $function$
  with cid as (select public.current_company_id() as company_id),
  adv as (
    select a.employee_id, sum(a.amount)::numeric as total
      from public.advances a cross join cid
     where a.company_id = cid.company_id
       and a.advance_date < (p_period_start + interval '1 month')
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

revoke execute on function public.employee_advance_outstanding(date) from public, anon;
grant execute on function public.employee_advance_outstanding(date) to authenticated;
