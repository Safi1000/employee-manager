-- 0210 — partner_ledger: rename every CTE column to x_* to end the ambiguity
--
-- RECOVERED from supabase_migrations.schema_migrations on 2026-08-31.
-- This migration was applied directly to the database (SQL editor / MCP) and
-- never written back to the repo. Committed verbatim so the repo records what
-- actually ran. See docs/MIGRATION_DIVERGENCE.md.
--
-- NOTE: superseded by 0214 and then repo 0215/0216/0218. Kept so a fresh
-- environment replays the same sequence the live database did.

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
    return;
  end if;

  return query
  with months as (
    select generate_series(date_trunc('month', v_from), date_trunc('month', v_to), interval '1 month')::date as m
  ),
  remun as (
    select (m + interval '1 month - 1 day')::date as x_date,
           'BAL TILL ' || upper(to_char(m, 'DDth "OF" MON YYYY')) as x_part,
           0::numeric as x_cash,
           coalesce((
             select a.amount from public.partnership_allocation(
               m, (m + interval '1 month - 1 day')::date, 'revenue') a
              where a.partner_id = p_partner_id
              limit 1), 0) as x_remun,
           'ALLOCATION'::text as x_src,
           null::uuid as x_eid
      from months
  ),
  cash as (
    select e.date as x_date,
           case e.payment_method
             when 'FUEL_CARD'     then 'FUEL CARD'
             when 'BANK_TRANSFER' then 'BANK TRANSFER'
             when 'CHEQUE'        then 'CHEQUE'
             else 'CASH PAID'
           end || case when e.description is null or e.description = '' then ''
                       else ' — ' || e.description end as x_part,
           case when e.type = 'CONTRIBUTION' then -e.amount else e.amount end as x_cash,
           0::numeric as x_remun,
           e.type as x_src,
           e.id as x_eid
      from public.partner_account_entries e
     where e.partner_id = p_partner_id
       and e.type in ('DRAWING','CONTRIBUTION')
       and e.date between v_from and v_to
  ),
  other as (
    select je.entry_date as x_date,
           coalesce(nullif(je.description, ''),
                    initcap(replace(coalesce(je.source_table, 'manual'), '_', ' '))) as x_part,
           (coalesce(jl.debit, 0) - coalesce(jl.credit, 0)) as x_cash,
           0::numeric as x_remun,
           'GL:' || upper(coalesce(je.source_table, 'MANUAL')) as x_src,
           null::uuid as x_eid
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
     where v_coa is not null
       and jl.account_id = v_coa
       and coalesce(je.source_table, '') <> 'partner_account_entries'
       and je.entry_date between v_from and v_to
  ),
  merged as (
    select x_date, x_part, x_cash, x_remun, x_src, x_eid from remun where x_remun <> 0
    union all
    select x_date, x_part, x_cash, x_remun, x_src, x_eid from cash
    union all
    select x_date, x_part, x_cash, x_remun, x_src, x_eid from other
  ),
  ordered as (
    select m.*, row_number() over (order by m.x_date, m.x_src desc) as rn from merged m
  )
  select o.x_date, o.x_part, o.x_cash, o.x_remun,
         v_opening + sum(o.x_remun - o.x_cash) over (order by o.rn
                       rows between unbounded preceding and current row),
         o.x_src, o.x_eid
    from ordered o
   order by o.rn;
end $$;

grant execute on function public.partner_ledger(uuid, date, date) to authenticated;
