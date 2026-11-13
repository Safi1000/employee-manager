-- 0671 — a statutory challan recorded per person (EOBI, PESSI, IESSI).
--
-- WHY. GGS pays EOBI for SOME of the people payroll deducted it from (October
-- 2026: 100 of 185 deducted + office staff + three who had left). The old path,
-- remit_statutory_liability, knows only an amount: it settles
-- least(amount, month's whole due), so a 244,200 challan would clear all
-- 75,295 withheld for October and show 85 unpaid guards' 407s as handed to EOBI.
-- DECIDED 22 Oct 2026 (Shayan): only the 407 of those actually paid is settled;
-- the rest stays owed; the employer share is a cost on each paid person's
-- client (office staff on head office).
--
-- WHAT.
--   1. statutory_remittance_lines — one row per person a challan pays for:
--      employee (or a named "other" not in Bastion), client, the withheld
--      amount it settles, its employee and employer share, and the cost.
--   2. record_statutory_challan(...) — the one writer. For each person:
--        settles = least(what payroll withheld from him that month, employee share)
--        cost    = employee share + employer share - settles
--      Writes the remittance (amount, liability_portion = sum settled,
--      cost_portion = the rest), its lines, ONE journal (Dr liability, Dr
--      statutory cost per client, Cr the bank/cash), and moves the money once
--      through apply_money_delta. Refuses: a total that is not the slip's, a
--      person already on a challan for that scheme and month, settling more
--      than is still owed. Requires accounting.edit (R5); asserts company and
--      branch.
--
-- The challan screen (Statutory → EOBI) calls it with the ticked people.
-- remit_statutory_liability stays for payments that are not per person.

create table if not exists public.statutory_remittance_lines (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id),
  remittance_id   uuid not null references public.statutory_remittances(id) on delete cascade,
  scheme          text not null,
  period_month    date not null,
  employee_id     uuid references public.employees(id),
  other_name      text,
  client_id       uuid references public.clients(id),
  withheld_settled numeric not null default 0,
  employee_share  numeric not null,
  employer_share  numeric not null,
  cost            numeric not null,
  created_at      timestamptz not null default now(),
  constraint statutory_remittance_lines_who check ((employee_id is not null) <> (nullif(btrim(coalesce(other_name, '')), '') is not null)),
  constraint statutory_remittance_lines_sums check (withheld_settled >= 0 and cost >= 0
    and round(withheld_settled + cost, 2) = round(employee_share + employer_share, 2))
);
create unique index if not exists statutory_remittance_lines_once
  on public.statutory_remittance_lines (company_id, scheme, period_month, employee_id) where employee_id is not null;
create index if not exists statutory_remittance_lines_remit_idx on public.statutory_remittance_lines (remittance_id);
comment on table public.statutory_remittance_lines is
  '0671: who a statutory challan paid for, one row per person (or a named other not in Bastion). Written only by record_statutory_challan.';

alter table public.statutory_remittance_lines enable row level security;
revoke all on public.statutory_remittance_lines from anon, authenticated;
grant select on public.statutory_remittance_lines to authenticated;
drop policy if exists company_members_read on public.statutory_remittance_lines;
create policy company_members_read on public.statutory_remittance_lines for select
  using (company_id = (select public.current_company_id()));
drop policy if exists ssa_read on public.statutory_remittance_lines;
create policy ssa_read on public.statutory_remittance_lines for select using ((select public.is_ssa_unscoped()));
drop policy if exists perm_read on public.statutory_remittance_lines;
create policy perm_read on public.statutory_remittance_lines as restrictive for select using (
  (select public.has_perm('accountant.view')) or (select public.has_perm('accounting.edit'))
  or (select public.has_perm('payables.view')) or (select public.has_perm('payroll.adjust'))
  or (select public.has_perm('payroll.approve')) or (select public.has_perm('payroll.edit'))
  or (select public.has_perm('payroll.view')) or (select public.has_perm('reports.view')));

create or replace function public.record_statutory_challan(
  p_company_id uuid, p_scheme text, p_period date, p_paid_via text,
  p_bank_account_id uuid, p_custodian_location_id uuid, p_paid_on date,
  p_reference text, p_employee_ids uuid[], p_others text[], p_expected_total numeric)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_m       date := date_trunc('month', p_period)::date;
  v_paid_on date := coalesce(p_paid_on, current_date);
  v_key     text := public.statutory_liability_key(p_scheme);
  v_rate    record;
  v_head    numeric;
  v_n       int;
  v_total   numeric;
  v_liab    numeric;
  v_due     numeric;
  v_branch  uuid;
  v_row     public.statutory_remittances%rowtype;
  v_lines   jsonb := '[]'::jsonb;
  v_cost_key text := 'cos_statutory';
  v_label   text;
  v_dup     text;
  c         record;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then
    perform public.require_perm('accounting.edit');
  end if;
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  -- tenant guard [resolved]: owning company of p_bank_account_id via public.bank_accounts
  if p_bank_account_id is not null then perform public.assert_same_company((select company_id from public.bank_accounts where id = p_bank_account_id)); end if;
  -- tenant guard [resolved]: owning company of p_custodian_location_id via public.cash_locations
  if p_custodian_location_id is not null then perform public.assert_same_company((select company_id from public.cash_locations where id = p_custodian_location_id)); end if;

  if p_scheme not in ('eobi', 'pessi', 'iessi') or v_key is null then
    raise exception 'A per-person challan is for EOBI, PESSI or IESSI. Nothing has been recorded.' using errcode = '22023';
  end if;
  if p_period is null then raise exception 'Say which month the challan is for. Nothing has been recorded.' using errcode = '22023'; end if;
  if v_paid_on > current_date then raise exception 'A challan cannot be dated in the future. Nothing has been recorded.' using errcode = '23514'; end if;
  if p_paid_via not in ('Cash', 'Bank') then
    raise exception 'A challan is paid in Cash or Bank, not %. Nothing has been recorded.', coalesce(p_paid_via, '—') using errcode = 'P0001';
  end if;
  if p_paid_via = 'Bank' and p_bank_account_id is null then raise exception 'Paying by bank needs a bank account. Nothing has been recorded.' using errcode = 'P0001'; end if;
  if p_paid_via = 'Cash' and p_custodian_location_id is null then raise exception 'Paying in cash needs the office-staff member who paid it. Nothing has been recorded.' using errcode = 'P0001'; end if;

  select r.employee_amount, r.employer_amount into v_rate
    from public.statutory_rates r
   where r.company_id = p_company_id and r.scheme = p_scheme and r.effective_from <= v_m
   order by r.effective_from desc limit 1;
  if v_rate is null then
    raise exception 'No % rate is set for %. Set it first. Nothing has been recorded.', upper(p_scheme), to_char(v_m, 'FMMonth YYYY') using errcode = 'P0001';
  end if;
  v_head := v_rate.employee_amount + v_rate.employer_amount;

  p_employee_ids := coalesce(p_employee_ids, '{}');
  p_others := array(select btrim(o) from unnest(coalesce(p_others, '{}')) o where btrim(o) <> '');
  if cardinality(p_employee_ids) <> (select count(distinct x) from unnest(p_employee_ids) x) then
    raise exception 'The same person is ticked twice. Nothing has been recorded.' using errcode = '23514';
  end if;
  v_n := cardinality(p_employee_ids) + cardinality(p_others);
  if v_n = 0 then raise exception 'Tick at least one person. Nothing has been recorded.' using errcode = '23514'; end if;
  if (select count(*) from public.employees e where e.id = any(p_employee_ids) and e.company_id = p_company_id) <> cardinality(p_employee_ids) then
    raise exception 'Someone ticked is not an employee of this company. Nothing has been recorded.' using errcode = '23514';
  end if;

  v_total := round(v_n * v_head, 2);
  if round(coalesce(p_expected_total, -1), 2) <> v_total then
    raise exception 'The challan total is % but % people at % a head make %. Check who is ticked. Nothing has been recorded.',
      to_char(coalesce(p_expected_total, 0), 'FM999,999,990'), v_n, to_char(v_head, 'FM999,990'), to_char(v_total, 'FM999,999,990')
      using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(hashtext('statutory_remit:' || p_company_id::text || ':' || p_scheme || ':' || v_m::text));

  select string_agg(e.full_name, ', ') into v_dup
    from public.statutory_remittance_lines l join public.employees e on e.id = l.employee_id
   where l.company_id = p_company_id and l.scheme = p_scheme and l.period_month = v_m and l.employee_id = any(p_employee_ids);
  if v_dup is not null then
    raise exception 'Already on a % challan for %: %. Nothing has been recorded.', upper(p_scheme), to_char(v_m, 'FMMonth YYYY'), v_dup using errcode = '23505';
  end if;

  -- What each person's line settles: what payroll withheld from him that month,
  -- up to the employee share. Only EOBI is withheld by payroll.
  create temporary table if not exists _chl (employee_id uuid, other_name text, client_id uuid, settled numeric) on commit drop;
  truncate _chl;
  insert into _chl
  select e.id, null, e.client_id,
         case when p_scheme = 'eobi'
              then least(coalesce((select sum(p.eobi) from public.payslips p where p.employee_id = e.id and p.period_month = v_m), 0), v_rate.employee_amount)
              else 0 end
    from public.employees e where e.id = any(p_employee_ids);
  insert into _chl select null, o, null, 0 from unnest(p_others) o;

  select coalesce(sum(settled), 0) into v_liab from _chl;
  select d.due into v_due from public.statutory_liability_due(p_company_id, p_scheme, v_m) d;
  if v_liab > coalesce(v_due, 0) + 0.005 then
    raise exception 'This challan would settle % withheld for %, but only % is still owed. Nothing has been recorded.',
      to_char(v_liab, 'FM999,999,990'), to_char(v_m, 'FMMonth YYYY'), to_char(coalesce(v_due, 0), 'FM999,999,990') using errcode = '23514';
  end if;

  v_branch := public.head_office_region(p_company_id);
  perform public.assert_branch_writable(v_branch);
  if p_scheme in ('pessi', 'iessi') then perform public.ensure_statutory_contributions_account(p_company_id); end if;
  v_label := case p_scheme when 'eobi' then 'EOBI' when 'pessi' then 'PESSI' else 'IESSI' end;

  insert into public.statutory_remittances
    (company_id, branch_id, scheme, period_month, amount, liability_portion, cost_portion,
     paid_on, paid_via, bank_account_id, custodian_location_id, reference, notes, created_by)
  values
    (p_company_id, v_branch, p_scheme, v_m, v_total, v_liab, v_total - v_liab, v_paid_on, p_paid_via,
     case when p_paid_via = 'Bank' then p_bank_account_id end,
     case when p_paid_via = 'Cash' then p_custodian_location_id end,
     nullif(btrim(coalesce(p_reference, '')), ''),
     v_n || ' insured — recorded per person (0671)', auth.uid())
  returning * into v_row;

  insert into public.statutory_remittance_lines
    (company_id, remittance_id, scheme, period_month, employee_id, other_name, client_id,
     withheld_settled, employee_share, employer_share, cost)
  select p_company_id, v_row.id, p_scheme, v_m, employee_id, other_name, client_id,
         settled, v_rate.employee_amount, v_rate.employer_amount, v_head - settled
    from _chl;

  if v_liab > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('key', v_key, 'debit', v_liab, 'credit', 0));
  end if;
  v_cost_key := case when public.ledger_cutover_date(p_company_id) is not null
                      and v_m <= date_trunc('month', public.ledger_cutover_date(p_company_id))::date
                     then 'opening_balance_equity' else 'cos_statutory' end;
  -- The cost, one line per client (office staff and others: no client = head office).
  for c in select client_id, sum(v_head - settled) amt from _chl group by client_id having sum(v_head - settled) > 0 loop
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('key', v_cost_key, 'debit', c.amt, 'credit', 0, 'client_id', c.client_id));
  end loop;
  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'account_id', public.settlement_account(p_company_id, p_paid_via, v_row.bank_account_id, v_row.custodian_location_id, true),
    'debit', 0, 'credit', v_total));

  perform public.post_journal(
    p_company_id, v_paid_on,
    v_label || ' challan for ' || to_char(v_m, 'FMMonth YYYY') || ' · ' || v_n || ' insured' || coalesce(' · ' || v_row.reference, ''),
    'statutory_remittances', v_row.id, false, v_lines, v_branch);

  perform public.apply_money_delta(
    p_company_id, p_paid_via, v_row.bank_account_id, -v_total,
    'expense', v_label || ' challan for ' || to_char(v_m, 'FMMonth YYYY'),
    case when p_paid_via = 'Cash' then p_custodian_location_id::text else v_row.id::text end);

  return jsonb_build_object('remittance_id', v_row.id, 'scheme', p_scheme, 'period', v_m, 'insured', v_n,
                            'amount', v_total, 'against_liability', v_liab, 'to_cost', v_total - v_liab);
end;
$function$;
revoke all on function public.record_statutory_challan(uuid, text, date, text, uuid, uuid, date, text, uuid[], text[], numeric) from public, anon;
grant execute on function public.record_statutory_challan(uuid, text, date, text, uuid, uuid, date, text, uuid[], text[], numeric) to authenticated;
comment on function public.record_statutory_challan(uuid, text, date, text, uuid, uuid, date, text, uuid[], text[], numeric) is
  '0671: records a statutory challan per person. Settles only what was withheld from those paid for; the rest of each head is cost on his client. Requires accounting.edit.';

-- R4: RLS on, policies present, nothing for anon.
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.statutory_remittance_lines'::regclass) then
    raise exception '0671 FAILED: RLS is off on statutory_remittance_lines.';
  end if;
  if (select count(*) from pg_policy where polrelid = 'public.statutory_remittance_lines'::regclass) < 3 then
    raise exception '0671 FAILED: statutory_remittance_lines is missing its policies.';
  end if;
  if has_table_privilege('anon', 'public.statutory_remittance_lines', 'select') then
    raise exception '0671 FAILED: anon can read statutory_remittance_lines.';
  end if;
end $$;

-- Self-test on the refusals (messages, not just "it raised"). Rolled back.
do $$
declare v_msg text;
begin
  begin
    perform public.record_statutory_challan('7f7899a0-edd2-4491-a40d-f81b54c68d1e', 'eobi', '2026-10-01', 'Cash',
      null, null, current_date, null, '{}'::uuid[], array['Test Person'], 1);
    raise exception 'SELFTEST: a cash challan with no custodian was accepted';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'Paying in cash needs the office-staff member who paid it.%' then raise exception '0671 SELFTEST failed (custodian): %', v_msg; end if;
  end;
  begin
    perform public.record_statutory_challan('7f7899a0-edd2-4491-a40d-f81b54c68d1e', 'eobi', '2026-10-01', 'Bank',
      (select id from public.bank_accounts where company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e' limit 1), null,
      current_date, null, '{}'::uuid[], array['Test Person'], 1000);
    raise exception 'SELFTEST: a wrong total was accepted';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'The challan total is 1,000 but 1 people at 2,442 a head make 2,442.%' then raise exception '0671 SELFTEST failed (total): %', v_msg; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
end $$;

-- 3. CLIENT PROFIT SEES THE CHALLAN (13 Nov 2026, Shayan: "the deducted was
--    never expensed anywhere"). client_statement_loaded counted payroll at NET
--    on the cash basis (51,600 of a 52,000 salary) and never read statutory
--    payments at all, so on cash the 400 deducted for EOBI — and the whole
--    challan — vanished from client profit; on accrual the employer share did.
--    Each challan line now joins the expense rows:
--      cash    — the whole head (employee + employer share) on the day paid:
--                the deducted share never reached net pay, so it is cost here;
--      accrual — GGS's cost only (the deducted share is already in gross
--                salary), in the challan's month.
--    No client (office staff, others) → the remittance's branch (head office).
--    SURGERY: client_statement_loaded has been edited by many migrations
--    (0349, 0431, 0514, 0516, 0535, 0542, 0549, 0553 …); amended against its
--    live definition at one anchor, asserted to appear exactly once.
do $mig$
declare
  v_src    text := pg_get_functiondef('public.client_statement_loaded(date,date,text,uuid)'::regprocedure);
  v_anchor text := $a$and je.source_table in ('expenses', 'expenses_prepaid_release')
       and a.account_type = 'expense'$a$;
  v_add    text := $b$
    union all
    -- 0671. STATUTORY CHALLANS recorded per person. Cash: the whole head on the
    -- day paid (the deducted share never reached net pay). Accrual: GGS's cost
    -- only, in the challan's month (the deducted share is in gross salary).
    select l.client_id, r.branch_id,
           (case when cash.on_cash then l.employee_share + l.employer_share else l.cost end)::numeric,
           case when cash.on_cash then r.paid_on else l.period_month end
      from public.statutory_remittance_lines l
      join public.statutory_remittances r on r.id = l.remittance_id
      cross join cid cross join cash
     where l.company_id = cid.company_id$b$;
  v_cnt int;
begin
  if position('0671. STATUTORY CHALLANS' in v_src) > 0 then return; end if;
  v_cnt := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  if v_cnt <> 1 then raise exception '0671 REFUSED: client_statement_loaded anchor found % times.', v_cnt; end if;
  execute replace(v_src, v_anchor, v_anchor || v_add);
  if position('0671. STATUTORY CHALLANS' in pg_get_functiondef('public.client_statement_loaded(date,date,text,uuid)'::regprocedure)) = 0 then
    raise exception '0671 FAILED: client_statement_loaded was not amended.';
  end if;
end $mig$;

-- Self-test: a challan moves company profit by exactly its cost on BOTH bases
-- (cash: the whole challan on the day paid; accrual: GGS's cost in its month).
-- Two named "others" at head office; recorded and rolled back.
do $$
declare
  v_co   constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_bank uuid := (select id from public.bank_accounts where company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e' and coalesce(active, true) order by balance desc limit 1);
  v_m    date := date_trunc('month', current_date)::date - interval '1 month';
  v_cb numeric; v_ca numeric; v_ab numeric; v_aa numeric; v_msg text;
begin
  begin
    select sum(net) into v_cb from public.client_statement_loaded(date_trunc('month', current_date)::date, current_date, 'cash', v_co);
    select sum(net) into v_ab from public.client_statement_loaded(v_m, (v_m + interval '1 month - 1 day')::date, 'revenue', v_co);
    perform public.record_statutory_challan(v_co, 'eobi', v_m, 'Bank', v_bank, null, current_date, 'SELFTEST',
      '{}'::uuid[], array['Self-test A', 'Self-test B'], 4884);
    select sum(net) into v_ca from public.client_statement_loaded(date_trunc('month', current_date)::date, current_date, 'cash', v_co);
    select sum(net) into v_aa from public.client_statement_loaded(v_m, (v_m + interval '1 month - 1 day')::date, 'revenue', v_co);
    raise exception 'SELFTEST_DONE cash=% accrual=%', round(v_cb - v_ca), round(v_ab - v_aa);
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> 'SELFTEST_DONE cash=4884 accrual=4884' then
      raise exception '0671 SELFTEST failed (client profit): %', v_msg;
    end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
end $$;