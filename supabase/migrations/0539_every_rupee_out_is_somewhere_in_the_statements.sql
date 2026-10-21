-- 0539 — every rupee out is somewhere in the statements
--
-- Asked 2026-10-21 (Shayan): a second set of checks the accountant can open
-- for any month, proving that the client-wise statement and the partnership
-- account for every receipt and every rupee that went out — and, where some
-- cost has nowhere to land, saying what it is and where it should go. "No
-- money out should be left unattended."
--
-- Each check is an IDENTITY: the same total reached two independent ways, so
-- a difference is a defect, never a judgement. Read-only; cash basis (the
-- basis the partnership runs on). Nothing here is advisory.
--
--   statement_tieout(company, month)
--     receipts                 invoice_payments in the month = statement revenue
--     money out                payroll paid + advances + expenses + kit issued
--                              = direct payroll + direct expenses + regional
--                                overhead + head-office share, over every row
--     client expenses          expenses carrying a client (+ kit to a client)
--                              = statement direct expenses (so none is ALSO in
--                                an overhead — the double-count question)
--     head office              ho_pool = head-office share charged to clients +
--                              HEAD OFFICE - UNALLOCATED (all of it lands)
--     three readers            source net = client statement net = region
--                              profit (regional_pl_range, which the partnership
--                              is built from). Kit is a client cost the region
--                              P&L does not carry; the note says so if any.
--     partnership pool         regional + equity shares = profit to divide
--     equity by region         the equity partner's region lines = his total
--     head office kept         head office's profit in the partnership = 0
--                              while any region takes head-office cost
--     no client to carry       a region with costs and no client to spread
--                              them over (money that would vanish)
--     unassigned               money landing in "Unassigned" (no region): it
--                              counts for the company but for no partner
--   unplaced_money(company, month)
--     each item behind "unassigned", with the fix: which client, employee or
--     expense has no region, and what to give it.
--
-- Both SECURITY DEFINER (they read every table a statement reads), tenant-
-- guarded, gated on the keys that may read the money (0531): accounting.edit,
-- reports.view, accountant.view.

create or replace function public.statement_tieout(p_company_id uuid, p_month date)
returns table(sort int, section text, check_name text, source_amount numeric, statement_amount numeric,
              difference numeric, ok boolean, note text)
language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  v_s date := date_trunc('month', p_month)::date;
  v_e date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  v_rcp numeric; v_pay numeric; v_adv numeric; v_exp numeric; v_exp_client numeric; v_kit numeric;
  v_cs_rev numeric; v_cs_cost numeric; v_cs_dexp numeric; v_cs_ho numeric; v_cs_net numeric;
  v_rp_net numeric; v_pool numeric; v_pa_profit numeric; v_pa_shares numeric; v_eq numeric; v_eqr numeric;
  v_ho_kept numeric; v_any_ho boolean; v_unassigned numeric; v_orphan text; v_orphan_amt numeric;
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  if auth.uid() is not null and not (public.has_perm('accounting.edit') or public.has_perm('reports.view') or public.has_perm('accountant.view')) then
    raise exception 'These checks need accounting, reports or accountant access.' using errcode = '42501';
  end if;

  -- ── the sources, each read once, on the cash dates the statements use ──────
  select coalesce(sum(p.amount), 0) into v_rcp from public.invoice_payments p
   where p.company_id = p_company_id and p.payment_date between v_s and v_e;
  select coalesce(sum(ps.net_salary), 0) into v_pay
    from public.payslips ps join public.employees e on e.id = ps.employee_id
    left join public.cheques ch on ch.id = ps.cheque_id
   where e.company_id = p_company_id and ps.disbursed
     and (case when ps.payment_mode = 'Cheque' then case when ch.status = 'cleared' then ch.cleared_at::date end
               else coalesce(ps.disbursed_at::date, ps.period_month) end) between v_s and v_e;
  select coalesce(sum(a.amount), 0) into v_adv
    from public.advances a left join public.cheques ch on ch.id = a.cheque_id
   where a.company_id = p_company_id and coalesce(a.payment_mode, '') <> 'Carry-forward'
     and (case when a.payment_mode = 'Cheque' then case when ch.status = 'cleared' then ch.cleared_at::date end
               else a.advance_date end) between v_s and v_e;
  select coalesce(sum(x.amount), 0), coalesce(sum(x.amount) filter (where x.client_id is not null), 0)
    into v_exp, v_exp_client
    from public.expenses x left join public.cheques ch on ch.id = x.cheque_id
   where x.company_id = p_company_id
     and (case when x.payment_mode in ('Cash','Bank') then x.expense_date
               when x.payment_mode = 'Cheque' then case when ch.status = 'cleared' then ch.cleared_at::date end
               when x.payment_mode = 'Payable' and x.payable_status = 'Paid' then x.paid_at::date end) between v_s and v_e;
  select coalesce(sum(jl.debit - jl.credit), 0) into v_kit
    from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_entry_id
   where je.company_id = p_company_id and je.source_table = 'kit_issuance'
     and je.entry_date between v_s and v_e and jl.client_id is not null;

  select coalesce(sum(revenue), 0),
         coalesce(sum(direct_payroll + direct_expenses + regional_overhead + ho_share), 0),
         coalesce(sum(direct_expenses), 0),
         coalesce(sum(ho_share), 0),
         coalesce(sum(net), 0),
         coalesce(sum(direct_payroll + direct_expenses + regional_overhead + ho_share) filter (where region_name = 'Unassigned'), 0)
    into v_cs_rev, v_cs_cost, v_cs_dexp, v_cs_ho, v_cs_net, v_unassigned
    from public.client_statement_loaded(v_s, v_e, 'cash', p_company_id);

  select coalesce(sum(profit_cash), 0) into v_rp_net from public.regional_pl_range(v_s, v_e, p_company_id);
  v_pool := public.ho_pool(p_company_id, v_s, v_e, 'cash');
  v_any_ho := public.ho_any_apportioned(p_company_id, v_s);

  select coalesce(sum(base_amount) filter (where row_kind = 'REGION'), 0),
         coalesce(sum(amount) filter (where row_kind in ('REGIONAL_PARTNER', 'EQUITY_PARTNER')), 0),
         coalesce(sum(amount) filter (where row_kind = 'EQUITY_PARTNER'), 0),
         coalesce(sum(amount) filter (where row_kind = 'EQUITY_REGION'), 0)
    into v_pa_profit, v_pa_shares, v_eq, v_eqr
    from public.partnership_allocation(v_s, v_e, 'cash', p_company_id);
  select coalesce(sum(pa.base_amount), 0) into v_ho_kept
    from public.partnership_allocation(v_s, v_e, 'cash', p_company_id) pa
    join public.branches b on b.id = pa.branch_id and b.is_head_office
   where pa.row_kind = 'REGION';

  -- A region with money out but no client in the statement to carry it.
  select string_agg(r.region_name, ', '), coalesce(sum(r.payroll_cash + r.expenses_cash), 0)
    into v_orphan, v_orphan_amt
    from public.regional_pl_range(v_s, v_e, p_company_id) r
    left join public.branches b on b.id = r.branch_id
   where coalesce(b.is_head_office, false) = false and r.branch_id is not null
     and (r.payroll_cash + r.expenses_cash) <> 0
     and not exists (select 1 from public.clients c where c.company_id = p_company_id and c.branch_id = r.branch_id);

  return query values
    (1, 'Money', 'Receipts', v_rcp, v_cs_rev, v_cs_rev - v_rcp, abs(v_cs_rev - v_rcp) <= 1,
        'Every receipt dated in the month reaches a client''s revenue.'),
    (2, 'Money', 'Money out', v_pay + v_adv + v_exp + v_kit, v_cs_cost, v_cs_cost - (v_pay + v_adv + v_exp + v_kit),
        abs(v_cs_cost - (v_pay + v_adv + v_exp + v_kit)) <= 1,
        format('Salaries paid %s, advances %s, expenses %s, kit issued %s — all of it inside some client''s costs.',
               to_char(v_pay, 'FM999,999,999'), to_char(v_adv, 'FM999,999,999'), to_char(v_exp, 'FM999,999,999'), to_char(v_kit, 'FM999,999,999'))),
    (3, 'Money', 'Client expenses', v_exp_client + v_kit, v_cs_dexp, v_cs_dexp - (v_exp_client + v_kit), abs(v_cs_dexp - (v_exp_client + v_kit)) <= 1,
        'An expense with a client is that client''s cost only — never also in a regional overhead.'),
    (4, 'Money', 'Head office', v_pool, v_cs_ho, v_cs_ho - v_pool, abs(v_cs_ho - v_pool) <= 1,
        case when v_any_ho then 'Head-office cost is spread over the regions that take it; whatever cannot be placed is named "Head office - unallocated".'
             else 'No region takes head-office cost this month; the whole pool stays named at head office.' end),
    (5, 'Agreement', 'Client statement = sources', v_rcp - (v_pay + v_adv + v_exp + v_kit), v_cs_net,
        v_cs_net - (v_rcp - (v_pay + v_adv + v_exp + v_kit)), abs(v_cs_net - (v_rcp - (v_pay + v_adv + v_exp + v_kit))) <= 1,
        'Receipts less money out, against the client-wise statement''s total net.'),
    (6, 'Agreement', 'Region profit = client statement', v_cs_net, v_rp_net, v_rp_net - v_cs_net,
        abs(v_rp_net - (v_cs_net + v_kit)) <= 1,
        case when v_kit <> 0 then format('Region profit (what the partnership is built from) does not carry kit issued (%s); the check allows exactly that.', to_char(v_kit, 'FM999,999,999'))
             else 'Region profit is what the partnership is built from; it must equal the statement.' end),
    (7, 'Partnership', 'Profit fully shared', v_pa_profit, v_pa_shares, v_pa_shares - v_pa_profit, abs(v_pa_shares - v_pa_profit) <= 0.05,
        'Regional partners plus equity partners take exactly the profit to divide.'),
    (8, 'Partnership', 'Equity share by region', v_eq, v_eqr, v_eqr - v_eq, abs(v_eqr - v_eq) <= 0.05,
        'The equity partner''s region lines add up to his share.'),
    (9, 'Partnership', 'Head office left in the partnership', 0::numeric, v_ho_kept, v_ho_kept,
        (not v_any_ho) or abs(v_ho_kept) <= 0.05,
        'While any region takes head-office cost, head office keeps nothing: a figure here is cost counted on one side only.'),
    (10, 'Unplaced', 'Region with costs and no client', 0::numeric, v_orphan_amt, v_orphan_amt, coalesce(v_orphan_amt, 0) = 0,
        coalesce('No client in ' || v_orphan || ' to carry its costs — they would drop out of every client statement.', 'Every region with costs has clients to carry them.')),
    (11, 'Unplaced', 'Money in "Unassigned"', 0::numeric, v_unassigned, v_unassigned, v_unassigned = 0,
        case when v_unassigned = 0 then 'Nothing lands without a region.'
             else 'Counts for the company but for no partner''s region. The list below names each item and what to give a region.' end);
end $function$;

create or replace function public.unplaced_money(p_company_id uuid, p_month date)
returns table(kind text, item text, amount numeric, on_date date, why text, fix text)
language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  v_s date := date_trunc('month', p_month)::date;
  v_e date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  if auth.uid() is not null and not (public.has_perm('accounting.edit') or public.has_perm('reports.view') or public.has_perm('accountant.view')) then
    raise exception 'These checks need accounting, reports or accountant access.' using errcode = '42501';
  end if;

  return query
  -- receipts from a client with no region
  select 'Receipt'::text, c.name::text, p.amount, p.payment_date,
         'client has no region'::text, ('Give client "' || c.name || '" a region')::text
    from public.invoice_payments p join public.clients c on c.id = p.client_id
   where p.company_id = p_company_id and p.payment_date between v_s and v_e and c.branch_id is null
  union all
  -- salaries paid to someone whose home has no region
  select 'Salary', e.full_name || coalesce(' (' || ec.name || ')', ''), ps.net_salary,
         coalesce(ps.disbursed_at::date, ps.period_month),
         case when ec.id is not null then 'their client has no region' else 'no client and no region' end,
         case when ec.id is not null then 'Give client "' || ec.name || '" a region'
              else 'Give ' || e.full_name || ' a region (or a client)' end
    from public.payslips ps join public.employees e on e.id = ps.employee_id
    left join public.clients ec on ec.id = e.client_id
    left join public.cheques ch on ch.id = ps.cheque_id
   where e.company_id = p_company_id and ps.disbursed and ps.net_salary <> 0
     and (case when ps.payment_mode = 'Cheque' then case when ch.status = 'cleared' then ch.cleared_at::date end
               else coalesce(ps.disbursed_at::date, ps.period_month) end) between v_s and v_e
     and ((ec.id is not null and ec.branch_id is null) or (ec.id is null and e.branch_id is null))
  union all
  -- advances placed nowhere
  select 'Advance', e.full_name || coalesce(' (' || ac.name || ')', ''), a.amount, a.advance_date,
         case when ac.id is not null then 'the client it is charged to has no region' else 'no client and no region' end,
         case when ac.id is not null then 'Give client "' || ac.name || '" a region'
              else 'Give ' || e.full_name || ' a region (or a client)' end
    from public.advances a join public.employees e on e.id = a.employee_id
    left join public.clients ac on ac.id = coalesce(a.client_id, e.client_id)
    left join public.cheques ch on ch.id = a.cheque_id
   where a.company_id = p_company_id and coalesce(a.payment_mode, '') <> 'Carry-forward'
     and (case when a.payment_mode = 'Cheque' then case when ch.status = 'cleared' then ch.cleared_at::date end
               else a.advance_date end) between v_s and v_e
     and ((ac.id is not null and ac.branch_id is null) or (ac.id is null and e.branch_id is null))
  union all
  -- expenses placed nowhere
  select 'Expense', coalesce(nullif(x.description, ''), '(no description)') || coalesce(' — ' || xc.name, ''), x.amount, x.expense_date,
         case when xc.id is not null then 'its client has no region' else 'no client and no region' end,
         case when xc.id is not null then 'Give client "' || xc.name || '" a region'
              else 'Set this expense''s client or region' end
    from public.expenses x left join public.clients xc on xc.id = x.client_id
    left join public.cheques ch on ch.id = x.cheque_id
   where x.company_id = p_company_id
     and (case when x.payment_mode in ('Cash','Bank') then x.expense_date
               when x.payment_mode = 'Cheque' then case when ch.status = 'cleared' then ch.cleared_at::date end
               when x.payment_mode = 'Payable' and x.payable_status = 'Paid' then x.paid_at::date end) between v_s and v_e
     and ((xc.id is not null and xc.branch_id is null) or (xc.id is null and x.branch_id is null))
  order by 3 desc;
end $function$;

revoke all on function public.statement_tieout(uuid, date) from public, anon;
revoke all on function public.unplaced_money(uuid, date) from public, anon;
grant execute on function public.statement_tieout(uuid, date) to authenticated;
grant execute on function public.unplaced_money(uuid, date) to authenticated;

-- ── asserts ──────────────────────────────────────────────────────────────────
do $$
declare v_n int; v_fail text;
begin
  -- On September 2026 (reconciled by hand on 2026-10-21) the identities that
  -- were proven then must hold now: money, agreement, partnership.
  select count(*), string_agg(check_name, ', ') into v_n, v_fail
    from public.statement_tieout('7f7899a0-edd2-4491-a40d-f81b54c68d1e', '2026-09-01')
   where sort <= 9 and not ok;
  if v_n <> 0 then raise exception '0539 REFUSED: September fails % check(s) proven by hand: %', v_n, v_fail; end if;

  select count(*) into v_n from public.tenant_guard_gaps();
  if v_n <> 0 then raise exception '0539 REFUSED: tenant_guard_gaps() reports % gap(s).', v_n; end if;
end $$;
