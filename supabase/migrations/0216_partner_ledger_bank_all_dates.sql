-- 0216 — the owned-bank statement in partner_ledger() shows ALL transactions,
-- not just those inside the ledger's month range (a bank account's full history
-- is always relevant). Only the pbank CTE drops its date filter; every other
-- source stays period-bound.
create or replace function public.partner_ledger(
  p_partner_id uuid, p_start date default null, p_end date default null
) returns table (
  entry_date date, particulars text, cash_paid numeric, remuneration numeric,
  balance numeric, source text, entry_id uuid
) language plpgsql stable security definer set search_path = public as $$
declare v_opening numeric; v_from date; v_to date; v_coa uuid; v_company uuid;
begin
  select coalesce(pr.opening_balance, 0),
         coalesce(p_start, pr.opening_balance_date, pr.start_month, date_trunc('month', now())::date),
         coalesce(p_end, (date_trunc('month', now()) + interval '1 month - 1 day')::date),
         pr.coa_account_id, pr.company_id
    into v_opening, v_from, v_to, v_coa, v_company
    from public.partners pr where pr.id = p_partner_id;
  if v_opening is null then return; end if;
  return query
  with ploc as (
    select id from public.cash_locations
     where custodian_partner_id = p_partner_id and coalesce(company_id, v_company) = v_company
  ),
  months as (
    select generate_series(date_trunc('month', v_from), date_trunc('month', v_to), interval '1 month')::date as m
  ),
  remun as (
    select (m + interval '1 month - 1 day')::date as x_date,
           'BAL TILL ' || upper(to_char(m, 'DDth "OF" MON YYYY')) as x_part, 0::numeric as x_cash,
           coalesce((select a.amount from public.partnership_allocation(
               m, (m + interval '1 month - 1 day')::date, 'revenue') a
              where a.partner_id = p_partner_id limit 1), 0) as x_remun,
           'ALLOCATION'::text as x_src, null::uuid as x_eid
      from months
  ),
  cash as (
    select e.date as x_date,
           case e.payment_method when 'FUEL_CARD' then 'FUEL CARD' when 'BANK_TRANSFER' then 'BANK TRANSFER'
             when 'CHEQUE' then 'CHEQUE' else 'CASH PAID' end
           || case when e.description is null or e.description = '' then '' else ' — ' || e.description end as x_part,
           case when e.type = 'CONTRIBUTION' then -e.amount else e.amount end as x_cash,
           0::numeric as x_remun, e.type as x_src, e.id as x_eid
      from public.partner_account_entries e
     where e.partner_id = p_partner_id and e.type in ('DRAWING','CONTRIBUTION')
       and e.date between v_from and v_to
  ),
  other as (
    select je.entry_date as x_date,
           coalesce(nullif(je.description, ''), initcap(replace(coalesce(je.source_table, 'manual'), '_', ' '))) as x_part,
           (coalesce(jl.debit, 0) - coalesce(jl.credit, 0)) as x_cash,
           0::numeric as x_remun, 'GL:' || upper(coalesce(je.source_table, 'MANUAL')) as x_src, null::uuid as x_eid
      from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_entry_id
     where v_coa is not null and jl.account_id = v_coa
       and coalesce(je.source_table, '') <> 'partner_account_entries'
       and je.entry_date between v_from and v_to
  ),
  custody as (
    select ip.payment_date::date, 'CLIENT CASH — ' || coalesce(c.name, 'client'),
           -ip.amount, 0::numeric, 'CUSTODY:CLIENT_CASH'::text, null::uuid
      from public.invoice_payments ip join ploc on ploc.id = ip.custodian_location_id
      left join public.clients c on c.id = ip.client_id
     where ip.payment_date between v_from and v_to
    union all
    select e.expense_date::date, 'EXPENSE — ' || coalesce(nullif(e.description,''), 'expense'),
           e.amount, 0::numeric, 'CUSTODY:EXPENSE'::text, null::uuid
      from public.expenses e join ploc on ploc.id = e.custodian_location_id
     where e.expense_date between v_from and v_to
    union all
    select a.advance_date::date, 'ADVANCE', a.amount, 0::numeric, 'CUSTODY:ADVANCE'::text, null::uuid
      from public.advances a join ploc on ploc.id = a.custodian_location_id
     where a.advance_date between v_from and v_to
    union all
    select ch.cheque_date::date, 'CHEQUE #' || coalesce(ch.cheque_number,''),
           -ch.amount, 0::numeric, 'CUSTODY:CHEQUE'::text, null::uuid
      from public.cheques ch join ploc on ploc.id = ch.custodian_location_id
     where ch.cheque_type = 'cash' and ch.status = 'cleared' and ch.cheque_date between v_from and v_to
    union all
    select t.date::date, 'TRANSFER IN', -t.amount, 0::numeric, 'CUSTODY:TRANSFER_IN'::text, null::uuid
      from public.custody_transfers t join ploc on ploc.id = t.to_location_id where t.date between v_from and v_to
    union all
    select t.date::date, 'TRANSFER OUT', t.amount, 0::numeric, 'CUSTODY:TRANSFER_OUT'::text, null::uuid
      from public.custody_transfers t join ploc on ploc.id = t.from_location_id where t.date between v_from and v_to
    union all
    select bt.created_at::date, coalesce(nullif(bt.description,''), 'Bank / cash movement'),
           -bt.cash_delta, 0::numeric, 'CUSTODY:BANK'::text, null::uuid
      from public.bank_transactions bt join ploc on ploc.id::text = bt.reference_id
     where bt.kind in ('withdraw_to_cash','payroll') and bt.created_at::date between v_from and v_to
  ),
  pbank as (
    -- Full statement of a bank account the partner OWNS — ALL dates, unfiltered.
    select bt.created_at::date,
           upper(bt.kind) || case when bt.description is null or bt.description = '' then '' else ' — ' || bt.description end
             || ' (' || ba.bank_name || ')',
           -bt.account_delta, 0::numeric, 'BANK:' || upper(bt.kind), null::uuid
      from public.bank_accounts ba join public.bank_transactions bt on bt.bank_account_id = ba.id
     where ba.owner_partner_id = p_partner_id
  ),
  merged as (
    select x_date, x_part, x_cash, x_remun, x_src, x_eid from remun where x_remun <> 0
    union all select x_date, x_part, x_cash, x_remun, x_src, x_eid from cash
    union all select x_date, x_part, x_cash, x_remun, x_src, x_eid from other
    union all select * from custody
    union all select * from pbank
  ),
  ordered as ( select m.*, row_number() over (order by m.x_date, m.x_src desc) as rn from merged m )
  select o.x_date, o.x_part, o.x_cash, o.x_remun,
         v_opening + sum(o.x_remun - o.x_cash) over (order by o.rn rows between unbounded preceding and current row),
         o.x_src, o.x_eid
    from ordered o order by o.rn;
end $$;
grant execute on function public.partner_ledger(uuid, date, date) to authenticated;
