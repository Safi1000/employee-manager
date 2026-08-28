-- 0207 — partner_ledger(): one partner's running account in the shape the owner
-- keeps it on paper — Date | Particulars | Cash Paid | Remuneration | Balance,
-- where Balance = previous - Cash Paid + Remuneration, so a NEGATIVE balance
-- means the company owes the partner.
--
-- Two sources, interleaved by date:
--   • Remuneration — the partner's monthly allocation, computed live from
--     partnership_allocation so it always reflects their basis (Net Cash vs
--     Total Income) and any per-client share overrides. Dated month-end and
--     labelled "BAL TILL <month>", matching the paper ledger.
--   • Cash Paid — partner_account_entries of type DRAWING, labelled by payment
--     method (CASH PAID / FUEL CARD / BANK TRANSFER / CHEQUE). CONTRIBUTION
--     rows are money coming the other way, so they carry a negative Cash Paid.
create or replace function public.partner_ledger(
  p_partner_id uuid,
  p_start      date default null,
  p_end        date default null
) returns table (
  entry_date   date,
  particulars  text,
  cash_paid    numeric,
  remuneration numeric,
  balance      numeric,
  source       text,
  entry_id     uuid
) language plpgsql stable security definer set search_path = public as $$
declare
  v_opening numeric;
  v_from    date;
  v_to      date;
begin
  select coalesce(pr.opening_balance, 0),
         coalesce(p_start, pr.opening_balance_date, pr.start_month, date_trunc('month', now())::date),
         coalesce(p_end, (date_trunc('month', now()) + interval '1 month - 1 day')::date)
    into v_opening, v_from, v_to
    from public.partners pr where pr.id = p_partner_id;

  if v_opening is null then
    return;  -- unknown partner
  end if;

  return query
  with months as (
    select generate_series(date_trunc('month', v_from), date_trunc('month', v_to), interval '1 month')::date as m
  ),
  remun as (
    select (m + interval '1 month - 1 day')::date as d,
           'BAL TILL ' || upper(to_char(m, 'DDth "OF" MON YYYY')) as particulars,
           0::numeric as cash_paid,
           coalesce((
             select a.amount from public.partnership_allocation(
               m, (m + interval '1 month - 1 day')::date, 'revenue') a
              where a.partner_id = p_partner_id
              limit 1), 0) as remuneration,
           'ALLOCATION'::text as source,
           null::uuid as entry_id
      from months
  ),
  cash as (
    select e.date as d,
           case e.payment_method
             when 'FUEL_CARD'     then 'FUEL CARD'
             when 'BANK_TRANSFER' then 'BANK TRANSFER'
             when 'CHEQUE'        then 'CHEQUE'
             else 'CASH PAID'
           end || case when e.description is null or e.description = '' then ''
                       else ' — ' || e.description end as particulars,
           case when e.type = 'CONTRIBUTION' then -e.amount else e.amount end as cash_paid,
           0::numeric as remuneration,
           e.type as source,
           e.id as entry_id
      from public.partner_account_entries e
     where e.partner_id = p_partner_id
       and e.type in ('DRAWING','CONTRIBUTION')
       and e.date between v_from and v_to
  ),
  merged as (
    select * from remun where remuneration <> 0
    union all
    select * from cash
  ),
  ordered as (
    select m.*, row_number() over (order by m.d, m.source desc) as rn from merged m
  )
  select o.d, o.particulars, o.cash_paid, o.remuneration,
         v_opening + sum(o.remuneration - o.cash_paid) over (order by o.rn
                       rows between unbounded preceding and current row) as balance,
         o.source, o.entry_id
    from ordered o
   order by o.rn;
end $$;

grant execute on function public.partner_ledger(uuid, date, date) to authenticated;
