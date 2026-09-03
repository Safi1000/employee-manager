-- 0355 — regional cash hunger. Management information, not a charge.
--
-- Per region, for a period: cash actually IN from client receipts, cash actually
-- OUT for payroll, expenses and advances, and the head office allocation the
-- region absorbed. Net. A region consistently negative is being carried.
--
-- WHAT THIS IS NOT, stated because the temptation is obvious. It does not
-- charge anybody, it does not touch partners, and nothing about it changes what
-- anyone is paid. Who funds a cash-hungry region is a separate question and
-- this report does not answer it.
--
-- ---------------------------------------------------------------------------
-- THREE DECISIONS, EACH OF WHICH COULD REASONABLY HAVE GONE THE OTHER WAY.
--
-- 1. CASH IN IS RECEIPTS, NOT INVOICES. The whole point is cash, so a region
--    that invoiced 10m and collected nothing reads as hungry — which is true,
--    and is the thing worth seeing. This is the ONE place invoiced revenue is
--    deliberately not used, and it does not contradict 0349: 0349 governs how
--    COST IS APPORTIONED, not what counts as cash in a cash report.
--
-- 2. THE HO ALLOCATION IS SHOWN BUT NOT SUBTRACTED FROM CASH. It is an
--    apportioned cost, not a cash movement — head office's own rent left head
--    office's bank, not the region's. Subtracting it would produce a number
--    that is neither cash nor profit. It is a separate column, and `net_cash`
--    excludes it while `net_after_ho` includes it, so both questions are
--    answerable and neither is implied.
--
-- 3. A RECEIPT'S REGION COMES FROM THE INVOICE, FALLING BACK TO THE CLIENT.
--    An unallocated receipt has no invoice, so without the fallback every
--    client-only receipt — the path unblocked earlier this month — would land
--    in "Unassigned" and the region that actually collected the money would
--    read as having collected nothing.

create or replace function public.regional_cash_hunger(
  p_company_id uuid, p_start date, p_end date)
returns table (
  branch_id      uuid,
  region_name    text,
  cash_in        numeric,
  payroll_out    numeric,
  expenses_out   numeric,
  advances_out   numeric,
  cash_out       numeric,
  net_cash       numeric,
  ho_absorbed    numeric,
  net_after_ho   numeric
)
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
begin
  -- tenant guard [claimed, 0287]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  return query
  with br as (
    select b.id, b.name::text as nm
      from public.branches b
     where b.company_id = p_company_id and b.active
  ),
  -- Cash IN. Region from the invoice, else the client (see decision 3).
  cin as (
    select coalesce(i.branch_id, cl.branch_id) as b, sum(ip.amount)::numeric as amt
      from public.invoice_payments ip
      left join public.invoices i on i.id = ip.invoice_id
      left join public.clients  cl on cl.id = coalesce(ip.client_id, i.client_id)
     where ip.company_id = p_company_id
       and ip.payment_date between p_start and p_end
     group by 1
  ),
  -- Cash OUT: payroll actually disbursed, on the same cash definition the
  -- client statement uses (cheques count when they clear).
  pay as (
    -- payslips carries its own branch_id; the employee's is the fallback for
    -- rows written before it did.
    select coalesce(ps.branch_id, e.branch_id) as b, sum(ps.net_salary)::numeric as amt
      from public.payslips ps
      join public.employees e on e.id = ps.employee_id
      left join public.cheques ch on ch.id = ps.cheque_id
     where e.company_id = p_company_id
       and ps.disbursed
       and coalesce(
             case when ps.payment_mode = 'Cheque'
                  then case when ch.status = 'cleared' then ch.cleared_at::date end
                  else coalesce(ps.disbursed_at::date, ps.period_month) end,
             ps.period_month) between p_start and p_end
     group by 1
  ),
  exp as (
    select x.branch_id as b, sum(x.amount)::numeric as amt
      from public.expenses x
      left join public.cheques ch on ch.id = x.cheque_id
     where x.company_id = p_company_id
       and case when x.payment_mode in ('Cash','Bank') then x.expense_date
                when x.payment_mode = 'Cheque'
                  then case when ch.status = 'cleared' then ch.cleared_at::date end
                when x.payment_mode = 'Payable' and x.payable_status = 'Paid'
                  then x.paid_at::date end
           between p_start and p_end
     group by 1
  ),
  adv as (
    select a.branch_id as b, sum(a.amount)::numeric as amt
      from public.advances a
     where a.company_id = p_company_id
       and a.advance_date between p_start and p_end
     group by 1
  ),
  -- What each region absorbed of head office, summed over the months touched.
  -- Read from the ledger, not recomputed: 6800 Allocated Head Office Cost is
  -- where run_ho_cost_allocation puts it.
  ho as (
    select jl.branch_id as b, sum(jl.debit - jl.credit)::numeric as amt
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.company_id = p_company_id
       and a.system_key = 'allocated_ho_cost'
       and je.entry_date between p_start and p_end
     group by 1
  )
  select br.id, br.nm,
         round(coalesce(cin.amt, 0), 2),
         round(coalesce(pay.amt, 0), 2),
         round(coalesce(exp.amt, 0), 2),
         round(coalesce(adv.amt, 0), 2),
         round(coalesce(pay.amt, 0) + coalesce(exp.amt, 0) + coalesce(adv.amt, 0), 2),
         round(coalesce(cin.amt, 0)
             - (coalesce(pay.amt, 0) + coalesce(exp.amt, 0) + coalesce(adv.amt, 0)), 2),
         round(coalesce(ho.amt, 0), 2),
         round(coalesce(cin.amt, 0)
             - (coalesce(pay.amt, 0) + coalesce(exp.amt, 0) + coalesce(adv.amt, 0))
             - coalesce(ho.amt, 0), 2)
    from br
    left join cin on cin.b is not distinct from br.id
    left join pay on pay.b is not distinct from br.id
    left join exp on exp.b is not distinct from br.id
    left join adv on adv.b is not distinct from br.id
    left join ho  on ho.b  is not distinct from br.id
   order by br.nm;
end;
$fn$;

comment on function public.regional_cash_hunger(uuid, date, date) is
  '0355: per region — cash in from client receipts, cash out for payroll/expenses/advances, and the head office cost absorbed. net_cash EXCLUDES the head office allocation (it is an apportioned cost, not a cash movement); net_after_ho includes it. Management information only: it charges nobody, involves no partner, and changes nothing anyone is paid.';

revoke execute on function public.regional_cash_hunger(uuid, date, date) from public, anon;
grant execute on function public.regional_cash_hunger(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Probe: it must run, and its arithmetic must be self-consistent.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co uuid;
  r    record;
  v_n  int := 0;
begin
  select id into v_co from public.companies where name = 'GUARDS AND GUIDES (PVT) LTD';
  if v_co is null then select id into v_co from public.companies order by created_at limit 1; end if;
  if v_co is null then raise notice '0355: no company; probe skipped.'; return; end if;

  for r in
    select * from public.regional_cash_hunger(
      v_co, date_trunc('month', current_date)::date,
      (date_trunc('month', current_date) + interval '1 month - 1 day')::date)
  loop
    v_n := v_n + 1;
    if r.cash_out <> round(r.payroll_out + r.expenses_out + r.advances_out, 2) then
      raise exception '0355 FAILED: % — cash_out % does not equal its three components (% + % + %).',
        r.region_name, r.cash_out, r.payroll_out, r.expenses_out, r.advances_out;
    end if;
    if r.net_cash <> round(r.cash_in - r.cash_out, 2) then
      raise exception '0355 FAILED: % — net_cash % is not cash_in % less cash_out %.',
        r.region_name, r.net_cash, r.cash_in, r.cash_out;
    end if;
    if r.net_after_ho <> round(r.net_cash - r.ho_absorbed, 2) then
      raise exception '0355 FAILED: % — net_after_ho % is not net_cash % less ho_absorbed %.',
        r.region_name, r.net_after_ho, r.net_cash, r.ho_absorbed;
    end if;
  end loop;

  raise notice '0355: % region(s), every total consistent with its components.', v_n;
end $$;
