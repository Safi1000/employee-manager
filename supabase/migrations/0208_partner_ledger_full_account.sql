-- 0208 — partner_ledger(): show the partner's COMPLETE account, not just their
-- own drawings/contributions. Anything posted to the partner's GL account
-- (coa_account_id) — expenses booked against the partner, wire transfers into
-- the account, manual journal entries — is part of their running account and
-- must appear in the ledger.
--
-- Sources, interleaved by date:
--   • Remuneration — live monthly allocation (unchanged).
--   • Cash Paid — partner_account_entries DRAWING/CONTRIBUTION (unchanged,
--     nicely labelled by payment method).
--   • GL activity — every OTHER journal line on the partner's coa_account_id
--     (source_table <> 'partner_account_entries', so no double count), shown
--     with cash_paid = debit − credit, matching the existing sign convention
--     (a debit to the partner account is cash paid out for them; a credit is
--     money coming in). This is what pulls in expenses + transfers.
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
  v_coa     uuid;
begin
  select coalesce(pr.opening_balance, 0),
         coalesce(p_start, pr.opening_balance_date, pr.start_month, date_trunc('month', now())::date),
         coalesce(p_end, (date_trunc('month', now()) + interval '1 month - 1 day')::date),
         pr.coa_account_id
    into v_opening, v_from, v_to, v_coa
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
  other as (
    select je.entry_date as d,
           coalesce(nullif(je.description, ''),
                    initcap(replace(coalesce(je.source_table, 'manual'), '_', ' '))) as particulars,
           (coalesce(jl.debit, 0) - coalesce(jl.credit, 0)) as cash_paid,
           0::numeric as remuneration,
           'GL:' || upper(coalesce(je.source_table, 'MANUAL')) as source,
           null::uuid as entry_id
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
     where v_coa is not null
       and jl.account_id = v_coa
       and coalesce(je.source_table, '') <> 'partner_account_entries'
       and je.entry_date between v_from and v_to
  ),
  merged as (
    select * from remun where remuneration <> 0
    union all
    select * from cash
    union all
    select * from other
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
