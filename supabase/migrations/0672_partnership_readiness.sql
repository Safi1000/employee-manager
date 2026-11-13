-- 0672 — a partnership run is posted only when the month is accounted for.
--
-- WHY (13 Nov 2026, Shayan: "add safeguards so I can confidently post the run
-- … everything has been accounted for … nothing is missing"). Posting already
-- refused a stale draft and named un-invoiced clients. Nothing asked whether
-- the month's SOURCE was complete: a receipt with no client, money still in
-- transit on iNet, an unreconciled bank, salaries paid but not marked — each
-- changes a client's net cash, so each changes every partner's share (A9: the
-- regional share is taken client by client from net cash; equity takes the rest).
--
-- partnership_readiness(company, month) — one row per check, in order:
--   ok     nothing to do
--   check  look at it; posting needs the reviewer's confirmation
--   block  cannot be posted until it is fixed
--
--   1 prev_posted        the month before is posted (months go in order)        block
--   2 draft_current      a draft exists and equals a fresh computation          block
--   3 cash_ties_out      the month's net (client P&L) = what the run divides
--                        + regions outside the partnership (e.g. Lahore)         block
--   4 partner_setup      regional ≤ 100% per region, client rates 0–100%,
--                        equity partners = 100%                                  block
--   5 receipts_no_client a receipt in the month belongs to no client            block
--   6 inet_in_transit    an iNet batch initiated by month end not yet released  block
--   7 uninvoiced         a client live in the month has no primary invoice      check
--   8 banks_reconciled   an active bank not reconciled to month end             check
--   9 unpaid_payslips    an earlier month's payslip still unpaid (paid but not
--                        marked, the cost is missing from net cash)              check
--  10 expense_requests   an expense request still waiting                       check
--  11 open_cheques       a cheque out dated by month end not yet cleared        check
--  12 ledger_checks      a nightly check that touches profit is failing         check
--
-- post_profit_allocation now refuses while any block stands (draft_current
-- excepted: posting re-drafts and refuses a moved figure itself, with the
-- movement named), and needs p_confirm_incomplete while any check stands —
-- the same confirmation it already asked for un-invoiced clients.
-- The Partnership screen shows the list above the Post button (same commit).

create or replace function public.partnership_readiness(p_company_id uuid, p_period date)
returns table(seq int, key text, status text, title text, figure text, detail text)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_start date := date_trunc('month', p_period)::date;
  v_end   date := (date_trunc('month', p_period) + interval '1 month - 1 day')::date;
  v_run   record;
  v_prev  record;
  v_basis text;
  v_fresh numeric;
  v_pl    numeric;
  v_out   numeric;
  v_n     int;
  v_amt   numeric;
  v_txt   text;
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  select * into v_run from public.profit_allocation_runs r
   where r.company_id = p_company_id and r.period_month = v_start and r.status <> 'REVERSED'
   order by r.created_at desc limit 1;
  v_basis := coalesce(v_run.basis, public.partner_basis_for_report(null, p_company_id));

  -- 1. The month before is posted.
  select * into v_prev from public.profit_allocation_runs r
   where r.company_id = p_company_id and r.period_month = (v_start - interval '1 month')::date and r.status <> 'REVERSED'
   order by r.created_at desc limit 1;
  if not exists (select 1 from public.profit_allocation_runs r where r.company_id = p_company_id and r.period_month < v_start) then
    return query select 1, 'prev_posted', 'ok', 'First month of the partnership', null::text, 'No earlier month to post first.';
  elsif v_prev.status = 'POSTED' then
    return query select 1, 'prev_posted', 'ok', to_char(v_start - interval '1 month', 'FMMonth') || ' is posted', null::text, null::text;
  else
    return query select 1, 'prev_posted', 'block', to_char(v_start - interval '1 month', 'FMMonth YYYY') || ' is not posted',
      coalesce(lower(v_prev.status), 'no run'), 'Months are posted in order: post the month before first.';
  end if;

  -- 2. A draft that equals a fresh computation.
  select coalesce(sum(a.base_amount) filter (where a.row_kind = 'REGION'), 0) into v_fresh
    from public.partnership_allocation(v_start, v_end, v_basis, p_company_id) a;
  if v_run is null then
    return query select 2, 'draft_current', 'block', 'No draft for ' || to_char(v_start, 'FMMonth'), null::text, 'Draft the month, then review it.';
  elsif v_run.status = 'POSTED' then
    return query select 2, 'draft_current', 'ok', 'Posted', to_char(coalesce(v_run.total_profit, 0), 'FM999,999,990'),
      'Posted ' || to_char(v_run.posted_at, 'DD Mon YYYY') || '.';
  elsif abs(coalesce(v_run.total_profit, 0) - v_fresh) > 0.005 then
    return query select 2, 'draft_current', 'block', 'The draft is out of date',
      to_char(coalesce(v_run.total_profit, 0), 'FM999,999,990') || ' → ' || to_char(v_fresh, 'FM999,999,990'),
      'Something changed since it was drafted. Re-draft and review the new figures.';
  else
    return query select 2, 'draft_current', 'ok', 'The draft is current', to_char(v_fresh, 'FM999,999,990'),
      'Drafted ' || to_char(v_run.created_at, 'DD Mon') || '; a fresh computation gives the same profit.';
  end if;

  -- 3. Every rupee of the month's net is either divided by the run or sits in a
  --    region outside the partnership.
  select coalesce(sum(s.net), 0),
         coalesce(sum(s.net) filter (where s.client_id is not null and public.region_outside_partnership(s.branch_id, v_start)), 0)
    into v_pl, v_out
    from public.client_statement_loaded(v_start, v_end, v_basis, p_company_id) s;
  if abs(v_pl - v_out - v_fresh) > 5 then
    return query select 3, 'cash_ties_out', 'block', 'The run does not add up to the month',
      to_char(v_pl, 'FM999,999,990') || ' vs ' || to_char(v_fresh + v_out, 'FM999,999,990'),
      'Client P&L net ' || to_char(v_pl, 'FM999,999,990') || ' should equal the run (' || to_char(v_fresh, 'FM999,999,990')
        || ') plus regions outside the partnership (' || to_char(v_out, 'FM999,999,990') || ').';
  else
    return query select 3, 'cash_ties_out', 'ok', 'The run adds up to the month', to_char(v_pl, 'FM999,999,990'),
      'Net ' || to_char(v_pl, 'FM999,999,990') || ' = run ' || to_char(v_fresh, 'FM999,999,990')
        || case when abs(v_out) > 0.5 then ' + outside the partnership ' || to_char(v_out, 'FM999,999,990') else '' end || '.';
  end if;

  -- 4. Partner rates are coherent.
  select string_agg(x, '; ') into v_txt from (
    select coalesce(b.name, 'a region') || ' regional partners ' || sum(p.profit_share_percent) || '%' as x
      from public.partners p left join public.branches b on b.id = p.branch_id
     where p.company_id = p_company_id and p.is_active and p.scope = 'BRANCH'
     group by b.name having sum(p.profit_share_percent) > 100
    union all
    select 'equity partners ' || coalesce(sum(p.profit_share_percent), 0) || '%'
      from public.partners p where p.company_id = p_company_id and p.is_active and p.scope = 'COMPANY'
    having coalesce(sum(p.profit_share_percent), 0) <> 100
    union all
    select pt.name || ' on ' || c.name || ' ' || s.share_percent || '%'
      from public.partner_client_shares s join public.partners pt on pt.id = s.partner_id join public.clients c on c.id = s.client_id
     where s.company_id = p_company_id and (s.share_percent < 0 or s.share_percent > 100)
  ) q;
  if v_txt is not null then
    return query select 4, 'partner_setup', 'block', 'A partner rate does not add up', null::text, v_txt;
  else
    select string_agg(p.name || ' ' || p.profit_share_percent || '%', ', ' order by p.scope, p.name) into v_txt
      from public.partners p where p.company_id = p_company_id and p.is_active;
    return query select 4, 'partner_setup', 'ok', 'Partner rates add up', null::text, v_txt;
  end if;

  -- 5. Receipts that belong to no client.
  select count(*), coalesce(sum(ip.amount), 0) into v_n, v_amt
    from public.invoice_payments ip left join public.invoices i on i.id = ip.invoice_id
   where ip.company_id = p_company_id and ip.payment_date between v_start and v_end
     and coalesce(ip.client_id, i.client_id) is null;
  return query select 5, 'receipts_no_client', case when v_n > 0 then 'block' else 'ok' end,
    case when v_n > 0 then v_n || ' receipt(s) belong to no client' else 'Every receipt belongs to a client' end,
    case when v_n > 0 then to_char(v_amt, 'FM999,999,990') end,
    case when v_n > 0 then 'Revenue no client carries reaches no partner. Put each on its client.' end;

  -- 6. iNet money still in transit.
  select count(*), coalesce(sum(b.inet_total), 0) into v_n, v_amt
    from public.inet_batches b
   where b.company_id = p_company_id and b.status not in ('released', 'rejected')
     and coalesce(b.transaction_date, b.initiated_at::date) <= v_end;
  return query select 6, 'inet_in_transit', case when v_n > 0 then 'block' else 'ok' end,
    case when v_n > 0 then v_n || ' iNet batch(es) still in transit' else 'Nothing in transit on iNet' end,
    case when v_n > 0 then to_char(v_amt, 'FM999,999,990') end,
    case when v_n > 0 then 'Release or reject them first — the bank may already have paid.' end;

  -- 7. Live clients never billed.
  select count(*), string_agg(u.client_name, ', ' order by u.client_name) into v_n, v_txt
    from public.partnership_uninvoiced_clients(p_company_id, v_start) u;
  return query select 7, 'uninvoiced', case when v_n > 0 then 'check' else 'ok' end,
    case when v_n > 0 then v_n || ' live client(s) have no invoice' else 'Every live client is billed' end,
    null::text, case when v_n > 0 then v_txt || '. Their cost is in, their revenue is not.' end;

  -- 8. Banks reconciled to month end.
  select count(*), string_agg(b.bank_name || ' (' || coalesce(to_char(r.last_date, 'DD Mon'), 'never') || ')', ', ' order by b.bank_name)
    into v_n, v_txt
    from public.bank_accounts b
    left join lateral (select max(statement_date) last_date from public.bank_reconciliations x where x.bank_account_id = b.id) r on true
   where b.company_id = p_company_id and coalesce(b.active, true) and coalesce(r.last_date, '1900-01-01') < v_end;
  return query select 8, 'banks_reconciled', case when v_n > 0 then 'check' else 'ok' end,
    case when v_n > 0 then v_n || ' bank(s) not reconciled to ' || to_char(v_end, 'DD Mon') else 'Every bank reconciled to ' || to_char(v_end, 'DD Mon') end,
    null::text, case when v_n > 0 then v_txt || '. A payment or receipt missing from Bastion would not show until reconciled.' end;

  -- 9. Earlier payslips still unpaid.
  select count(*), coalesce(sum(p.net_salary - coalesce(p.amount_paid, 0)), 0),
         string_agg(distinct to_char(p.period_month, 'Mon'), ', ')
    into v_n, v_amt, v_txt
    from public.payslips p
   where p.company_id = p_company_id and p.period_month < v_start
     and not p.disbursed and round(p.net_salary) > round(coalesce(p.amount_paid, 0));
  return query select 9, 'unpaid_payslips', case when v_n > 0 then 'check' else 'ok' end,
    case when v_n > 0 then v_n || ' earlier payslip(s) still unpaid' else 'No earlier payslip left unpaid' end,
    case when v_n > 0 then to_char(v_amt, 'FM999,999,990') end,
    case when v_n > 0 then v_txt || '. If any was paid, mark it paid first — otherwise its cost is missing from net cash.' end;

  -- 10. Expense requests waiting.
  select count(*), coalesce(sum(x.amount), 0) into v_n, v_amt
    from public.expense_requests x
   where x.company_id = p_company_id and x.requested_at::date <= v_end
     and coalesce(x.status, '') not in ('approved', 'rejected', 'cancelled', 'paid', 'converted');
  return query select 10, 'expense_requests', case when v_n > 0 then 'check' else 'ok' end,
    case when v_n > 0 then v_n || ' expense request(s) waiting' else 'No expense request waiting' end,
    case when v_n > 0 then to_char(v_amt, 'FM999,999,990') end,
    case when v_n > 0 then 'Approve or refuse them — an approved one paid in the month is a cost.' end;

  -- 11. Cheques out not cleared.
  select count(*), coalesce(sum(c.amount), 0) into v_n, v_amt
    from public.cheques c
   where c.company_id = p_company_id and coalesce(c.direction, 'out') = 'out' and c.cheque_date <= v_end
     and coalesce(c.status, '') not in ('cleared', 'bounced', 'cancelled', 'void');
  return query select 11, 'open_cheques', case when v_n > 0 then 'check' else 'ok' end,
    case when v_n > 0 then v_n || ' cheque(s) out not cleared' else 'No cheque out left uncleared' end,
    case when v_n > 0 then to_char(v_amt, 'FM999,999,990') end,
    case when v_n > 0 then 'On the cash basis a cheque counts when it clears. Mark any that have.' end;

  -- 12. Nightly checks that touch profit.
  select count(*), string_agg(replace(lc.check_name, '_', ' ') || ' (' || lc.actual || ')', '; ' order by lc.check_name) into v_n, v_txt
    from public.ledger_checks(p_company_id) lc
   where not lc.passed and lc.check_name in (
     'no_payroll_booked_as_expense', 'every_billed_client_carries_cost', 'client_cost_has_an_invoice',
     'cash_per_location_gl_equals_operational', 'no_negative_custodian_balance', 'payroll_accrual_matches_attendance',
     'no_stale_prepaid_balance', 'every_receipt_has_a_client');
  return query select 12, 'ledger_checks', case when v_n > 0 then 'check' else 'ok' end,
    case when v_n > 0 then v_n || ' nightly check(s) that touch profit are failing' else 'Nightly checks that touch profit pass' end,
    null::text, v_txt;
end;
$function$;
revoke all on function public.partnership_readiness(uuid, date) from public, anon;
grant execute on function public.partnership_readiness(uuid, date) to authenticated;
comment on function public.partnership_readiness(uuid, date) is
  '0672: is a partnership month accounted for? One row per check — ok / check (confirm) / block (cannot post). post_profit_allocation enforces it.';

-- post_profit_allocation enforces it. SURGERY against the live definition at
-- one anchor, asserted to appear exactly once.
do $mig$
declare
  v_src    text := pg_get_functiondef('public.post_profit_allocation(uuid,boolean)'::regprocedure);
  v_anchor text := '  -- ---- completeness: name them, then let the reviewer decide ---------------';
  v_add    text := $b$  -- ---- 0672: readiness. A block refuses; a check needs the confirmation. ----
  select string_agg(r.title || coalesce(' (' || r.figure || ')', ''), chr(10) || '  - ' order by r.seq) into v_names
    from public.partnership_readiness(v_run.company_id, v_run.period_month) r
   where r.status = 'block' and r.key <> 'draft_current';
  if v_names is not null then
    raise exception '%', 'This month cannot be posted yet:' || chr(10) || '  - ' || v_names
      || chr(10) || chr(10) || 'Fix these on the Partnership screen, re-draft, then post.' using errcode = 'P0001';
  end if;
  select string_agg(r.title || coalesce(' (' || r.figure || ')', ''), chr(10) || '  - ' order by r.seq) into v_names
    from public.partnership_readiness(v_run.company_id, v_run.period_month) r
   where r.status = 'check';
  if v_names is not null and not p_confirm_incomplete then
    raise exception '%', 'Before posting, confirm you have looked at each of these:' || chr(10) || '  - ' || v_names
      using errcode = 'P0001', hint = 'Confirm to proceed.';
  end if;
  v_names := null;

$b$;
  v_cnt int;
begin
  if position('0672: readiness' in v_src) > 0 then return; end if;
  v_cnt := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  if v_cnt <> 1 then raise exception '0672 REFUSED: post_profit_allocation anchor found % times.', v_cnt; end if;
  execute replace(v_src, v_anchor, v_add || v_anchor);
  if position('0672: readiness' in pg_get_functiondef('public.post_profit_allocation(uuid,boolean)'::regprocedure)) = 0 then
    raise exception '0672 FAILED: post_profit_allocation was not amended.';
  end if;
end $mig$;

-- Self-test: the list proves it ran — twelve checks, in order, each a known
-- status — and a month with no draft blocks on draft_current.
do $$
declare v_n int; v_bad int; v_keys text;
begin
  select count(*), count(*) filter (where status not in ('ok', 'check', 'block')), string_agg(key, ',' order by seq)
    into v_n, v_bad, v_keys
    from public.partnership_readiness('7f7899a0-edd2-4491-a40d-f81b54c68d1e', '2026-10-01');
  if v_n <> 12 or v_bad <> 0 then raise exception '0672 SELFTEST failed: % checks, % with an unknown status.', v_n, v_bad; end if;
  if v_keys <> 'prev_posted,draft_current,cash_ties_out,partner_setup,receipts_no_client,inet_in_transit,uninvoiced,banks_reconciled,unpaid_payslips,expense_requests,open_cheques,ledger_checks' then
    raise exception '0672 SELFTEST failed: checks out of order: %', v_keys;
  end if;
  if (select status from public.partnership_readiness('7f7899a0-edd2-4491-a40d-f81b54c68d1e', '2027-06-01') where key = 'draft_current') <> 'block' then
    raise exception '0672 SELFTEST failed: a month with no draft did not block.';
  end if;
end $$;