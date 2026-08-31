-- 0226 — Surface revenue-earning clients filed on the head-office branch.
--
-- Head office is a cost centre, not a delivery unit. A client receiving a
-- service is served from somewhere and someone is accountable for it, so a
-- billing client sitting on the head-office branch is a filing error, not a
-- shape the model should support.
--
-- It matters to the apportionment specifically: 0225 lets head office enter the
-- revenue base as a receiver so that direct billing still absorbs overhead
-- (otherwise the services-only failure simply relocates from "no guards" to "no
-- region"). That handles the general case correctly, but a client parked at head
-- office by mistake still distorts every regional figure below it — its revenue
-- never reaches a region, so no regional partner's share reflects it.
--
-- Found: `Ironclad Munitions`, 180,000 across 4 invoices, branch = Head Office.
-- Rather than fix that single row and move on, this makes the invariant a
-- standing check so the next one surfaces on its own.
--
-- This is a data-quality check, not an accounting identity: it reports the COUNT
-- of offending clients and expects zero. It will fail today, by design, until
-- Ironclad is assigned to the region that actually serves it.

create or replace function public.ledger_checks(p_company_id uuid)
returns table(check_name text, expected numeric, actual numeric,
              difference numeric, passed boolean)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with tb as (
    select coalesce(sum(jl.debit), 0) dr, coalesce(sum(jl.credit), 0) cr
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
     where je.company_id = p_company_id
  ),
  onesided as (
    select count(*)::numeric n
      from public.journal_entries je
      join lateral (
        select coalesce(sum(debit), 0) dr, coalesce(sum(credit), 0) cr
          from public.journal_lines where journal_entry_id = je.id
      ) x on true
     where je.company_id = p_company_id and x.dr <> x.cr
  ),
  bal as (
    select a.system_key, coalesce(sum(jl.debit - jl.credit), 0) net
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.company_id = p_company_id
     group by a.system_key
  ),
  ar_sub as (
    select coalesce((select sum(i.invoice_amount) from public.invoices i
                      where i.company_id = p_company_id
                        and coalesce(i.status, '') <> 'Written-Off'), 0)
         - coalesce((select sum(p.amount + coalesce(p.withholding_amount, 0))
                       from public.invoice_payments p
                      where p.company_id = p_company_id), 0) bal
  ),
  adv_sub as (
    select coalesce((select sum(a.amount) from public.advances a
                      where a.company_id = p_company_id), 0)
         - coalesce((select sum(ps.advance) from public.payslips ps
                      where ps.company_id = p_company_id), 0) bal
  ),
  wht_sub as (
    select coalesce((select sum(coalesce(p.withholding_amount, 0))
                       from public.invoice_payments p
                      where p.company_id = p_company_id), 0) bal
  ),
  payroll_owed as (
    select coalesce(sum(ps.net_salary) filter (where not ps.disbursed), 0) owed
      from public.payslips ps where ps.company_id = p_company_id
  ),
  ho_clients as (
    select count(distinct i.client_id)::numeric n
      from public.invoices i
      join public.branches b on b.id = i.branch_id
     where i.company_id = p_company_id and b.is_head_office
  )
  select 'trial_balance_debits_equal_credits'::text, tb.dr, tb.cr, tb.dr - tb.cr, tb.dr = tb.cr from tb
  union all
  select 'no_one_sided_entries', 0, onesided.n, onesided.n, onesided.n = 0 from onesided
  union all
  select 'ar_control_equals_open_invoices', ar_sub.bal,
         coalesce((select net from bal where system_key = 'ar'), 0),
         coalesce((select net from bal where system_key = 'ar'), 0) - ar_sub.bal,
         coalesce((select net from bal where system_key = 'ar'), 0) = ar_sub.bal
    from ar_sub
  union all
  select 'employee_advances_control_not_in_client_ar', adv_sub.bal,
         coalesce((select net from bal where system_key = 'employee_advances_receivable'), 0),
         coalesce((select net from bal where system_key = 'employee_advances_receivable'), 0) - adv_sub.bal,
         coalesce((select net from bal where system_key = 'employee_advances_receivable'), 0) = adv_sub.bal
    from adv_sub
  union all
  select 'wht_receivable_equals_deductions_less_cprs', wht_sub.bal,
         coalesce((select net from bal where system_key = 'wht_receivable'), 0),
         coalesce((select net from bal where system_key = 'wht_receivable'), 0) - wht_sub.bal,
         coalesce((select net from bal where system_key = 'wht_receivable'), 0) = wht_sub.bal
    from wht_sub
  union all
  select 'salaries_payable_equals_undisbursed_net_pay', payroll_owed.owed,
         coalesce((select -net from bal where system_key = 'salaries_payable'), 0),
         coalesce((select -net from bal where system_key = 'salaries_payable'), 0) - payroll_owed.owed,
         coalesce((select -net from bal where system_key = 'salaries_payable'), 0) = payroll_owed.owed
    from payroll_owed
  union all
  -- Head office bills nobody directly by design; a client here needs assigning
  -- to the region that actually serves it.
  select 'no_billing_clients_on_head_office', 0, ho_clients.n, ho_clients.n, ho_clients.n = 0
    from ho_clients;
$function$;

-- Names the specific clients so the check is actionable, not just a count.
create or replace function public.billing_clients_on_head_office(p_company_id uuid)
returns table(client_id uuid, client_name text, invoices bigint, invoiced numeric)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select c.id, c.name, count(distinct i.id), coalesce(sum(il.amount), 0)
    from public.invoices i
    join public.branches b on b.id = i.branch_id
    join public.clients c on c.id = i.client_id
    left join public.invoice_lines il on il.invoice_id = i.id
   where i.company_id = p_company_id and b.is_head_office
   group by c.id, c.name
   order by 4 desc;
$function$;

comment on function public.billing_clients_on_head_office(uuid) is
  'Clients invoiced against the head-office branch. Head office is a cost centre, not a delivery unit — each of these needs assigning to the region that serves it.';
