-- 0516 — The accountant's surface: ledgers, the cash/accrual bridge, scenarios,
-- and the September audit's findings as checks. Nothing here posts.
--
-- PROPOSED 2026-10-16, NOT APPLIED. Each function below is read-only except the
-- two saved-scenario writers, which touch report_scenarios and nothing else.
--
-- 1. ledger_statement(co, kind, subject, start, end)
--    Opening, every line with its running balance, closing — computed here, not
--    in a screen. Kinds: 'account' (an account and its sub-accounts), 'client'
--    (receivable lines carrying the client), 'supplier' (payable lines whose
--    expense names the vendor), 'guard' (salaries payable and advances lines
--    carrying the employee). The partner ledger stays partner_ledger(), which is
--    the decided definition (0445/0476) and includes custody.
--
-- 2. cash_accrual_bridge(co, start, end)
--    Accrual result, each reconciling item by name, cash result, and an
--    'Unexplained' row that the assertion below requires to be zero. Read from
--    regional_pl_range — the same figures every statement reads.
--
-- 3. A scenario layer that REUSES 0514's mechanism: a transaction-local JSON
--    override, honoured only on the read path, cleared by every posting before
--    it computes. 0514/0515 already do this for head office
--    (bastion.ho_mode_override); this adds bastion.scenario beside it for the
--    other levers:
--      {"basis": "cash"|"revenue",
--       "partners": {"<partner_id>": {"pct": 30, "branch_id": "<uuid>"}},
--       "receipt_dates": {"<invoice_payment_id>": "YYYY-MM-DD"},
--       "expense_dates": {"<expense_id>": "YYYY-MM-DD"},
--       "exclude_clients": ["<uuid>"], "exclude_regions": ["<uuid>"]}
--    Head office per region rides on the existing override, as {"ho": {...}}.
--    scenario_compare(co, month, scenario) returns actual, scenario and delta
--    for the company result, every region, every partner, every client and the
--    head-office unallocated line. report_scenarios keeps named scenarios for
--    comparison; nothing can post one.
--    NOT a lever: the date of a payroll disbursement. Moving a payslip's paid
--    date would need surgery in the payroll cash CTEs of both statements for a
--    lever nobody asked for by name; receipts and expense payments are covered.
--    A scenario partner rate changes the partner's DEFAULT rate; a per-client
--    override (HMC Taxila at 37.5%, DECIDED) still takes precedence.
--
-- 4. Five checks, wired into ledger_checks (canary 39 -> 44):
--      every_billed_client_carries_cost   client_income_cost_gaps()
--      no_payroll_booked_as_expense       payroll_booked_as_expense()
--      cash_and_bank_land_where_recorded  cash_bank_crossposted()
--      no_advance_booked_as_expense       advances_booked_as_expense()
--      invoices_fall_inside_their_contract invoice_outside_contract()
--    Each was a finding of the September 2026 audit, found by hand. A check
--    fails on its own; a tile only shows what someone opens.
--
-- METHOD. Functions edited by many migrations are amended by surgery against
-- the live definition, each anchor asserted exactly once and skipped on replay.

-- ---------------------------------------------------------------------------
-- 0. Measure the actuals BEFORE the surgery, to prove it changes nothing.
-- ---------------------------------------------------------------------------
create temp table t0516_before as
select c.id co, m.m,
       (select coalesce(sum(s.net), 0) from public.client_statement_loaded(m.m, (m.m + interval '1 month - 1 day')::date, 'revenue', c.id) s) cs_rev,
       (select coalesce(sum(s.net), 0) from public.client_statement_loaded(m.m, (m.m + interval '1 month - 1 day')::date, 'cash', c.id) s) cs_cash,
       (select coalesce(sum(r.profit_accrual), 0) + coalesce(sum(r.profit_cash), 0) from public.regional_pl_range(m.m, (m.m + interval '1 month - 1 day')::date, c.id) r) rpl,
       (select coalesce(jsonb_object_agg(coalesce(a.partner_id::text, a.row_kind || coalesce(a.branch_id::text, '')), a.amount), '{}')
          from public.partnership_allocation(m.m, (m.m + interval '1 month - 1 day')::date, null, c.id) a) pa
  from public.companies c
 cross join (select (date_trunc('month', current_date) - (k || ' months')::interval)::date m from generate_series(0, 2) k) m
 where exists (select 1 from public.finance_settings fs where fs.company_id = c.id and fs.partner_remuneration_basis is not null);

-- ---------------------------------------------------------------------------
-- 1. The scenario override — read path only.
-- ---------------------------------------------------------------------------
create or replace function public.scenario()
returns jsonb
language sql stable
set search_path to 'public'
as $$ select nullif(current_setting('bastion.scenario', true), '')::jsonb $$;

create or replace function public.scenario_excluded(p_client_id uuid, p_branch_id uuid)
returns boolean
language sql stable
set search_path to 'public'
as $$
  select coalesce(
           (p_client_id is not null and coalesce((public.scenario() -> 'exclude_clients') ? p_client_id::text, false))
        or (p_branch_id is not null and coalesce((public.scenario() -> 'exclude_regions') ? p_branch_id::text, false)),
         false)
$$;

create or replace function public.scenario_date(p_kind text, p_id uuid, p_date date)
returns date
language sql stable
set search_path to 'public'
as $$ select coalesce((public.scenario() -> p_kind ->> p_id::text)::date, p_date) $$;

comment on function public.scenario() is
  '0516. The scenario override (bastion.scenario), transaction-local, set only by scenario_compare and cleared before it returns. READ PATH ONLY: run_profit_allocation and run_ho_cost_allocation clear it before computing, so a posting can never run under a scenario. Same mechanism as 0514''s bastion.ho_mode_override.';

-- ---------------------------------------------------------------------------
-- 2. The five checks.
-- ---------------------------------------------------------------------------
create or replace function public.client_income_cost_gaps(p_company_id uuid, p_month date)
returns table(client_id uuid, client_name text, kind text, revenue numeric, cost numeric)
language plpgsql stable security definer
set search_path to 'public'
as $$
#variable_conflict use_column
declare v_m date := date_trunc('month', p_month)::date; v_e date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  -- 0516. A client that deploys guards and was billed, with no payroll and no
  -- expense against it (Lahore's six, September 2026) — or cost with no
  -- billing. Read from the accrual client statement, so it agrees with every
  -- screen. "Deploys guards" = an active contract line with committed heads
  -- in the month: a weapons-rental client billing with no guard cost is not a
  -- gap.
  return query
  with s as (
    select * from public.client_statement_loaded(v_m, v_e, 'revenue', p_company_id) x where x.client_id is not null
  ),
  deploying as (
    select distinct k.client_id
      from public.contracts k join public.contract_lines cl on cl.contract_id = k.id
     where k.status = 'active' and cl.committed_count > 0
       and k.start_date <= v_e
       and (k.end_date is null or k.end_date >= v_m)
       and (k.termination_date is null or k.termination_date >= v_m)
  )
  select s.client_id, s.client_name, 'income_no_cost'::text, s.revenue, s.direct_payroll + s.direct_expenses
    from s where s.revenue > 0 and s.direct_payroll + s.direct_expenses = 0
     and s.client_id in (select d.client_id from deploying d)
  union all
  select s.client_id, s.client_name, 'cost_no_income'::text, s.revenue, s.direct_payroll + s.direct_expenses
    from s where s.revenue = 0 and s.direct_payroll + s.direct_expenses > 0;
end $$;

create or replace function public.payroll_booked_as_expense(p_company_id uuid)
returns table(expense_id uuid, expense_date date, amount numeric, category text, description text, client_name text)
language plpgsql stable security definer
set search_path to 'public'
as $$
#variable_conflict use_column
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  -- 0516. Pay for guards booked as an expense instead of through payroll —
  -- September 2026: Berger's 464,000, Nova's 142,515, "remaining salary". It
  -- makes the client look costed while the guard has no payslip, no attendance
  -- trail and no statutory deductions. Matched by the payroll category or a
  -- salary word in the description. Outsourced guards paid to a contractor
  -- (DECIDED 2026-10-16: Karachi stays as expense) say so in the description
  -- and are not payroll.
  return query
  select x.id, x.expense_date, x.amount, ec.name::text, x.description, c.name::text
    from public.expenses x
    left join public.expense_categories ec on ec.id = x.category_id
    left join public.clients c on c.id = x.client_id
   where x.company_id = p_company_id
     and (ec.name ~* '(payroll|salar)' or coalesce(x.description, '') ~* '\m(salar(y|ies)|wages?|payroll)\M')
     and coalesce(x.description, '') !~* 'outsourc'
   order by x.expense_date desc;
end $$;

create or replace function public.cash_bank_crossposted(p_company_id uuid)
returns table(source_table text, source_id uuid, txn_date date, payment_mode text, account_code text, account_name text, amount numeric)
language plpgsql stable security definer
set search_path to 'public'
as $$
#variable_conflict use_column
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  -- 0516. A receipt or payment recorded as CASH whose money landed in a bank
  -- account, or recorded as bank and landing in a custodian's cash. The
  -- September 2026 workbook put 594,000 of cash receipts into a bank column;
  -- Bastion had them right. This keeps it that way.
  return query
  with recursive tree as (
    select a.id, a.system_key as root from public.chart_of_accounts a
     where a.company_id = p_company_id and a.system_key in ('cash', 'bank')
    union all
    select c.id, t.root from public.chart_of_accounts c join tree t on c.parent_id = t.id
  ),
  moves as (
    select 'invoice_payments'::text st, p.id, p.payment_date d, p.payment_mode m, jl.account_id, jl.debit amt
      from public.invoice_payments p
      join public.journal_entries je on je.source_table = 'invoice_payments' and je.source_id = p.id and not je.is_reversal
      join public.journal_lines jl on jl.journal_entry_id = je.id and jl.debit > 0
     where p.company_id = p_company_id
    union all
    select 'expenses', x.id, x.expense_date, x.payment_mode, jl.account_id, jl.credit
      from public.expenses x
      join public.journal_entries je on je.source_table = 'expenses' and je.source_id = x.id and not je.is_reversal
      join public.journal_lines jl on jl.journal_entry_id = je.id and jl.credit > 0
     where x.company_id = p_company_id and x.payment_mode in ('Cash', 'Bank')
       and not exists (select 1 from public.journal_entries r where r.reversal_of_entry_id = je.id)
  )
  select m.st, m.id, m.d, m.m, a.account_code, a.account_name::text, m.amt
    from moves m
    join tree t on t.id = m.account_id
    join public.chart_of_accounts a on a.id = m.account_id
   where (lower(m.m) = 'cash' and t.root = 'bank')
      or (lower(m.m) <> 'cash' and t.root = 'cash');
end $$;

create or replace function public.advances_booked_as_expense(p_company_id uuid)
returns table(expense_id uuid, expense_date date, amount numeric, category text, description text)
language plpgsql stable security definer
set search_path to 'public'
as $$
#variable_conflict use_column
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  -- 0516. An advance to an employee is a receivable, not an expense — the
  -- September 2026 workbook carried 30,000 of advances inside expense. A
  -- prepaid ("paid in advance") is a different thing and is excluded.
  return query
  select x.id, x.expense_date, x.amount, ec.name::text, x.description
    from public.expenses x
    left join public.expense_categories ec on ec.id = x.category_id
   where x.company_id = p_company_id
     and (ec.name ~* 'advance' or coalesce(x.description, '') ~* '\madvance(s|d)?\M')
     and coalesce(x.description, '') !~* 'in advance'
     and x.coverage_start is null and x.service_start is null
   order by x.expense_date desc;
end $$;

create or replace function public.invoice_outside_contract(p_company_id uuid)
returns table(invoice_id uuid, invoice_number text, client_name text, service_month date, contract_code text, contract_start date, contract_end date)
language plpgsql stable security definer
set search_path to 'public'
as $$
#variable_conflict use_column
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  -- 0516. An invoice for a service month its own contract does not cover —
  -- Waheed Shahzad, September 2026, against a contract that starts 9 October.
  -- One of the two is wrong, and nothing else would say so.
  return query
  select i.id, i.invoice_number, c.name::text, i.service_month, k.contract_code,
         k.start_date, coalesce(k.termination_date, k.end_date)
    from public.invoices i
    join public.contracts k on k.id = i.contract_id
    join public.clients c on c.id = i.client_id
   where i.company_id = p_company_id
     and coalesce(i.status, '') <> 'Written-Off'
     and (i.service_month < date_trunc('month', k.start_date)::date
          or (coalesce(k.termination_date, k.end_date) is not null
              and i.service_month > coalesce(k.termination_date, k.end_date)))
   order by i.service_month desc;
end $$;

create or replace function public.client_cover(p_company_id uuid, p_month date)
returns table(client_id uuid, client_name text, contracted numeric, deployed numeric, unbilled_cover numeric, payroll_cost numeric)
language plpgsql stable security definer
set search_path to 'public'
as $$
#variable_conflict use_column
declare v_m date := date_trunc('month', p_month)::date; v_e date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  -- 0516. Contracted vs deployed vs unbilled cover, per client — the same
  -- definitions the Contracted vs Deployed screen computes in the browser
  -- today, moved here so a dashboard tile and that screen cannot disagree:
  --   contracted  committed heads on personnel lines of active guard-deployment contracts
  --   deployed    distinct guards marked present / double duty / relief cover FOR the client
  --   unbilled    deployed above contracted — cover the company absorbs (a report, not a failure)
  --   payroll     the accrual client statement's direct payroll (salary split by days worked)
  -- DEFERRED: ContractedVsDeployed.tsx should read this function once 0516 is
  -- applied, retiring its browser copy of the same rule.
  return query
  with con as (
    select k.client_id, sum(cl.committed_count)::numeric n
      from public.contracts k
      join public.clients c on c.id = k.client_id and c.company_id = p_company_id
      join public.contract_lines cl on cl.contract_id = k.id
     where k.status = 'active' and k.contract_type = 'guard_deployment'
       and cl.category in ('SR_SUPERVISOR', 'ASST_SUPERVISOR', 'SUPERVISOR', 'GUARD', 'RELIEVER')
     group by 1
  ),
  dep as (
    select ar.worked_for_client_id cid, count(distinct ar.employee_id)::numeric n
      from public.attendance_records ar
      join public.employees e on e.id = ar.employee_id and e.company_id = p_company_id
     where ar.attendance_date between v_m and v_e
       and ar.status in ('present', 'double_duty', 'relief_cover')
       and ar.worked_for_client_id is not null
     group by 1
  ),
  pay as (
    select s.client_id, s.direct_payroll from public.client_statement_loaded(v_m, v_e, 'revenue', p_company_id) s
     where s.client_id is not null
  ),
  ids as (select client_id from con union select cid from dep union select client_id from pay where direct_payroll <> 0)
  select i.client_id, c.name::text, coalesce(con.n, 0), coalesce(dep.n, 0),
         greatest(coalesce(dep.n, 0) - coalesce(con.n, 0), 0), coalesce(pay.direct_payroll, 0)
    from ids i
    join public.clients c on c.id = i.client_id
    left join con on con.client_id = i.client_id
    left join dep on dep.cid = i.client_id
    left join pay on pay.client_id = i.client_id
   order by (coalesce(dep.n, 0) - coalesce(con.n, 0)) desc, c.name;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Ledgers, from the GL.
-- ---------------------------------------------------------------------------
create or replace function public.ledger_statement(p_company_id uuid, p_kind text, p_subject_id uuid, p_start date, p_end date)
returns table(row_kind text, entry_date date, journal_entry_id uuid, source_table text, source_id uuid,
              description text, account_code text, account_name text, debit numeric, credit numeric, balance numeric)
language plpgsql stable security definer
set search_path to 'public'
as $$
#variable_conflict use_column
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  -- tenant guard [resolved]: owning company looked up from p_subject_id
  if p_subject_id is not null then
    perform public.assert_same_company(coalesce(
      (select company_id from public.chart_of_accounts where id = p_subject_id),
      (select company_id from public.clients where id = p_subject_id),
      (select company_id from public.vendors where id = p_subject_id),
      (select company_id from public.employees where id = p_subject_id)));
  end if;
  if p_kind not in ('account', 'client', 'supplier', 'guard') then
    raise exception 'Ledger kind must be account, client, supplier or guard (the partner ledger is partner_ledger()).' using errcode = '22023';
  end if;
  -- 0516. Opening (everything before p_start), each line with its running
  -- balance (debit - credit), closing. The same arithmetic for every kind; only
  -- the set of lines differs.
  return query
  with recursive sub as (
    select a.id from public.chart_of_accounts a where a.id = p_subject_id and a.company_id = p_company_id and p_kind = 'account'
    union all
    select c.id from public.chart_of_accounts c join sub s on c.parent_id = s.id
  ),
  lines as (
    select je.entry_date, je.id je_id, je.created_at, je.source_table, je.source_id, je.description,
           a.account_code, a.account_name::text an, jl.debit, jl.credit, jl.id jl_id
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.company_id = p_company_id
       and case p_kind
             when 'account' then jl.account_id in (select id from sub)
             when 'client' then jl.client_id = p_subject_id and a.system_key = 'ar'
             when 'guard' then jl.employee_id = p_subject_id
                               and a.system_key in ('salaries_payable', 'employee_advances_receivable')
             when 'supplier' then a.system_key = 'ap' and p_subject_id = coalesce(
                    (select x.vendor_id from public.expenses x
                      where je.source_table in ('expenses', 'expense_settlements') and x.id = je.source_id),
                    (select x.vendor_id from public.payable_payments pp join public.expenses x on x.id = pp.expense_id
                      where je.source_table = 'payable_payments' and pp.id = je.source_id))
           end
  ),
  opening as (
    select coalesce(sum(debit - credit), 0) amt from lines where entry_date < p_start
  ),
  body as (
    select l.*, (select amt from opening)
             + sum(l.debit - l.credit) over (order by l.entry_date, l.created_at, l.jl_id rows unbounded preceding) bal
      from lines l where l.entry_date between p_start and p_end
  )
  select 'OPENING'::text, p_start, null::uuid, null::text, null::uuid, 'Balance brought forward'::text,
         null::text, null::text, null::numeric, null::numeric, (select amt from opening)
  union all
  select * from (
    select 'LINE'::text, b.entry_date, b.je_id, b.source_table, b.source_id, b.description,
           b.account_code, b.an, b.debit, b.credit, b.bal
      from body b order by b.entry_date, b.created_at, b.jl_id) z
  union all
  select 'CLOSING'::text, p_end, null::uuid, null::text, null::uuid, 'Balance carried forward'::text,
         null::text, null::text,
         (select coalesce(sum(debit), 0) from body), (select coalesce(sum(credit), 0) from body),
         (select amt from opening) + (select coalesce(sum(debit - credit), 0) from body);
end $$;

-- ---------------------------------------------------------------------------
-- 4. The cash/accrual bridge.
-- ---------------------------------------------------------------------------
create or replace function public.cash_accrual_bridge(p_company_id uuid, p_start date, p_end date)
returns table(sort int, item text, amount numeric, detail text)
language plpgsql stable security definer
set search_path to 'public'
as $$
declare
  v_ra numeric; v_rc numeric; v_pa numeric; v_pc numeric; v_ea numeric; v_ec numeric;
  v_wht numeric; v_ded numeric; v_raw numeric; v_acc numeric; v_cash numeric; v_items numeric;
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  -- 0516. From the accrual result to the cash result, every step named. Read
  -- from regional_pl_range, the figures every statement reads. Each item is
  -- what to ADD to the accrual result to reach cash; 'Unexplained' is the
  -- remainder and is asserted to be zero.
  select coalesce(sum(revenue_accrual), 0), coalesce(sum(revenue_cash), 0),
         coalesce(sum(payroll_accrual), 0), coalesce(sum(payroll_cash), 0),
         coalesce(sum(expenses_accrual), 0), coalesce(sum(expenses_cash), 0),
         coalesce(sum(profit_accrual), 0), coalesce(sum(profit_cash), 0)
    into v_ra, v_rc, v_pa, v_pc, v_ea, v_ec, v_acc, v_cash
    from public.regional_pl_range(p_start, p_end, p_company_id);

  select coalesce(sum(coalesce(p.withholding_amount, 0)), 0) into v_wht
    from public.invoice_payments p
   where p.company_id = p_company_id and p.payment_date between p_start and p_end;

  select coalesce(sum(ps.final_salary - ps.net_salary), 0) into v_ded
    from public.payslips ps join public.employees e on e.id = ps.employee_id
   where e.company_id = p_company_id
     and ps.period_month between date_trunc('month', p_start)::date and p_end;

  select coalesce(sum(x.amount), 0) into v_raw
    from public.expenses x
   where x.company_id = p_company_id and x.expense_date between p_start and p_end;

  v_items := (v_rc + v_wht - v_ra) + (-v_wht) + v_ded + (v_pa - v_pc - v_ded) + (v_ea - v_raw) + (v_raw - v_ec);

  return query values
    (10, 'Accrual result'::text, v_acc, 'Revenue by service month, less payroll accrued and expense the GL recognised.'::text),
    (20, 'Invoiced, not yet received (net of receipts for earlier months)', v_rc + v_wht - v_ra,
         'Receipts in the period before tax withheld, less revenue invoiced for the period.'),
    (25, 'Tax withheld by clients from receipts', -v_wht,
         'Received short of the invoice; held as a receivable from FBR, not cash.'),
    (30, 'Deducted from pay (tax, EOBI, advances recovered)', v_ded,
         'Accrued gross, paid net: the difference is owed to FBR/EOBI or recovers an advance.'),
    (35, 'Payroll accrued not yet paid, less paid for earlier months', v_pa - v_pc - v_ded,
         'Net pay for the period still unpaid, offset by earlier months paid in this one.'),
    (40, 'Prepaid and service-period schedules', v_ea - v_raw,
         'Recognised by the GL release schedule rather than on the day paid (insurance, licences, service months).'),
    (45, 'Payables and uncleared cheques', v_raw - v_ec,
         'Expenses booked in the period but not yet paid, or paid by a cheque not yet cleared.'),
    (80, 'Unexplained', v_cash - (v_acc + v_items), 'Must be zero.'),
    (90, 'Cash result', v_cash, 'Received, less payroll paid and expenses paid, in the period.');
end $$;

-- ---------------------------------------------------------------------------
-- 5. Scenarios: snapshot, compare, keep.
-- ---------------------------------------------------------------------------
create or replace function public.scenario_snapshot(p_company_id uuid, p_start date, p_end date)
returns jsonb
language plpgsql stable security definer
set search_path to 'public'
as $$
declare v_basis text; v jsonb := '{}'::jsonb;
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  -- 0516. Every figure a scenario can move, keyed section|subject, under
  -- whatever overrides are in force. Called twice by scenario_compare.
  v_basis := public.partner_basis_for_report(null, p_company_id);
  select v || coalesce(jsonb_object_agg('client|' || coalesce(s.client_id::text, 'HO'),
                       jsonb_build_object('n', s.client_name, 'v', round(s.net, 2))), '{}')
         || jsonb_build_object('company|result', jsonb_build_object('n', 'Company result', 'v', round(coalesce(sum(s.net), 0), 2)))
         || jsonb_build_object('ho|unallocated', jsonb_build_object('n', 'Head office, unallocated',
                               'v', round(coalesce(sum(s.ho_share) filter (where s.client_id is null), 0), 2)))
    into v
    from public.client_statement_loaded(p_start, p_end, v_basis, p_company_id) s;
  select v || coalesce(jsonb_object_agg(
           case when a.row_kind = 'REGION' then 'region|' || coalesce(a.branch_id::text, 'none') else 'partner|' || a.partner_id::text end,
           jsonb_build_object('n', coalesce(a.partner_name, a.region_name), 'v',
                              round(case when a.row_kind = 'REGION' then a.base_amount else a.amount end, 2))), '{}')
    into v
    from public.partnership_allocation(p_start, p_end, null, p_company_id) a
   where a.row_kind in ('REGION', 'REGIONAL_PARTNER', 'EQUITY_PARTNER');
  return v;
end $$;

create or replace function public.scenario_compare(p_company_id uuid, p_period date, p_scenario jsonb)
returns table(section text, subject_id text, subject text, actual numeric, scenario numeric, delta numeric)
language plpgsql volatile security definer
set search_path to 'public'
as $$
#variable_conflict use_column
declare
  v_m date := date_trunc('month', p_period)::date;
  v_e date := (date_trunc('month', p_period) + interval '1 month - 1 day')::date;
  v_bad text; v_act jsonb; v_sc jsonb;
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  select string_agg(k, ', ') into v_bad
    from jsonb_object_keys(coalesce(p_scenario, '{}')) k
   where k not in ('basis', 'ho', 'partners', 'receipt_dates', 'expense_dates', 'exclude_clients', 'exclude_regions');
  if v_bad is not null then
    raise exception 'Unknown scenario lever(s): %', v_bad using errcode = '22023';
  end if;
  -- 0516. COMPUTED AND DISCARDED. Both overrides are transaction-local and
  -- cleared before returning, on success or failure; no posting function will
  -- read them (each clears both before computing).
  begin
    perform set_config('bastion.scenario', '', true);
    perform set_config('bastion.ho_mode_override', '', true);
    v_act := public.scenario_snapshot(p_company_id, v_m, v_e);
    perform set_config('bastion.scenario', (coalesce(p_scenario, '{}') - 'ho')::text, true);
    perform set_config('bastion.ho_mode_override',
      case when coalesce(p_scenario -> 'ho', '{}'::jsonb) = '{}'::jsonb then '' else (p_scenario -> 'ho')::text end, true);
    v_sc := public.scenario_snapshot(p_company_id, v_m, v_e);
    perform set_config('bastion.scenario', '', true);
    perform set_config('bastion.ho_mode_override', '', true);
  exception when others then
    perform set_config('bastion.scenario', '', true);
    perform set_config('bastion.ho_mode_override', '', true);
    raise;
  end;
  return query
  select split_part(k, '|', 1), split_part(k, '|', 2),
         coalesce(v_act -> k ->> 'n', v_sc -> k ->> 'n'),
         (v_act -> k ->> 'v')::numeric, (v_sc -> k ->> 'v')::numeric,
         coalesce((v_sc -> k ->> 'v')::numeric, 0) - coalesce((v_act -> k ->> 'v')::numeric, 0)
    from (select jsonb_object_keys(v_act) k union select jsonb_object_keys(v_sc)) ks
   order by case split_part(k, '|', 1) when 'company' then 1 when 'ho' then 2 when 'partner' then 3 when 'region' then 4 else 5 end, 3;
end $$;

create table if not exists public.report_scenarios (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  name       text not null check (length(btrim(name)) > 0),
  period     date not null,
  params     jsonb not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (company_id, name)
);
alter table public.report_scenarios enable row level security;
drop policy if exists company_members_read on public.report_scenarios;
create policy company_members_read on public.report_scenarios
  for select using (company_id = (select public.current_company_id()));
comment on table public.report_scenarios is
  '0516. Named scenarios kept for comparison: the levers and the month, never a result and never a posting. Written only by save_report_scenario / delete_report_scenario.';

create or replace function public.save_report_scenario(p_company_id uuid, p_name text, p_period date, p_params jsonb)
returns uuid
language plpgsql security definer
set search_path to 'public'
as $$
declare v_id uuid;
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is null then raise exception 'A company is required.' using errcode = '22023'; end if;
  perform public.assert_same_company(p_company_id);
  perform public.require_perm('reports.view');
  if p_name is null or btrim(p_name) = '' then raise exception 'Name the scenario.' using errcode = '22023'; end if;
  insert into public.report_scenarios (company_id, name, period, params, created_by)
  values (p_company_id, btrim(p_name), date_trunc('month', p_period)::date, coalesce(p_params, '{}'), auth.uid())
  on conflict (company_id, name) do update set period = excluded.period, params = excluded.params,
                                               created_by = excluded.created_by, created_at = now()
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.delete_report_scenario(p_id uuid)
returns void
language plpgsql security definer
set search_path to 'public'
as $$
begin
  -- tenant guard [resolved]: owning company looked up from p_id
  perform public.assert_same_company((select company_id from public.report_scenarios where id = p_id));
  perform public.require_perm('reports.view');
  delete from public.report_scenarios where id = p_id;
  if not found then raise exception 'That scenario no longer exists.' using errcode = 'P0002'; end if;
end $$;

revoke all on function public.scenario(), public.scenario_excluded(uuid, uuid), public.scenario_date(text, uuid, date),
  public.client_income_cost_gaps(uuid, date), public.payroll_booked_as_expense(uuid), public.cash_bank_crossposted(uuid),
  public.advances_booked_as_expense(uuid), public.invoice_outside_contract(uuid), public.client_cover(uuid, date),
  public.ledger_statement(uuid, text, uuid, date, date), public.cash_accrual_bridge(uuid, date, date),
  public.scenario_snapshot(uuid, date, date), public.scenario_compare(uuid, date, jsonb),
  public.save_report_scenario(uuid, text, date, jsonb), public.delete_report_scenario(uuid) from public, anon;
grant execute on function public.scenario(), public.scenario_excluded(uuid, uuid), public.scenario_date(text, uuid, date),
  public.client_income_cost_gaps(uuid, date), public.payroll_booked_as_expense(uuid), public.cash_bank_crossposted(uuid),
  public.advances_booked_as_expense(uuid), public.invoice_outside_contract(uuid), public.client_cover(uuid, date),
  public.ledger_statement(uuid, text, uuid, date, date), public.cash_accrual_bridge(uuid, date, date),
  public.scenario_snapshot(uuid, date, date), public.scenario_compare(uuid, date, jsonb),
  public.save_report_scenario(uuid, text, date, jsonb), public.delete_report_scenario(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Surgery: the read path honours the scenario; postings clear it; the five
--    checks join ledger_checks.
-- ---------------------------------------------------------------------------
create or replace function pg_temp.surg0516(p_fn text, p_key text, p_old text, p_new text)
returns void language plpgsql as $f$
declare v_def text; v_hits int;
begin
  v_def := pg_get_functiondef(p_fn::regprocedure);
  if position(p_new in v_def) > 0 then
    raise notice '0516: % [%] already applied.', p_fn, p_key;
    return;
  end if;
  v_hits := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  if v_hits <> 1 then
    raise exception '0516 REFUSED: in %, anchor [%] appears % time(s), expected 1.', p_fn, p_key, v_hits;
  end if;
  execute replace(v_def, p_old, p_new);
end $f$;

select pg_temp.surg0516($f$public.client_statement_loaded(date,date,text,uuid)$f$, $k$cs_cl$k$, $a$     where c.company_id = cid.company_id
  ),
  ip as (
$a$, $b$     where c.company_id = cid.company_id
       and not public.scenario_excluded(c.id, c.branch_id)  /* 0516 scenario */
  ),
  ip as (
$b$);
select pg_temp.surg0516($f$public.client_statement_loaded(date,date,text,uuid)$f$, $k$cs_ip$k$, $a$     where p.company_id = cid.company_id and p.payment_date between p_start and p_end
$a$, $b$     where p.company_id = cid.company_id and public.scenario_date('receipt_dates', p.id, p.payment_date) between p_start and p_end  /* 0516 scenario */
$b$);
select pg_temp.surg0516($f$public.client_statement_loaded(date,date,text,uuid)$f$, $k$cs_exp$k$, $a$           case when x.payment_mode in ('Cash','Bank') then x.expense_date
                when x.payment_mode = 'Cheque'
                  then case when ch.status = 'cleared' then ch.cleared_at::date end
                when x.payment_mode = 'Payable' and x.payable_status = 'Paid' then x.paid_at::date end as eff_date
$a$, $b$           coalesce((public.scenario() -> 'expense_dates' ->> x.id::text)::date,  /* 0516 scenario */
           case when x.payment_mode in ('Cash','Bank') then x.expense_date
                when x.payment_mode = 'Cheque'
                  then case when ch.status = 'cleared' then ch.cleared_at::date end
                when x.payment_mode = 'Payable' and x.payable_status = 'Paid' then x.paid_at::date end) as eff_date
$b$);
select pg_temp.surg0516($f$public.regional_pl_range(date,date,uuid)$f$, $k$rpl_inv$k$, $a$     where i.company_id = cid.company_id and i.service_month between date_trunc('month', p_start)::date and p_end /* 0513: revenue month is the service month (A4) */ group by 1
$a$, $b$     where i.company_id = cid.company_id and i.service_month between date_trunc('month', p_start)::date and p_end /* 0513: revenue month is the service month (A4) */
       and not public.scenario_excluded(i.client_id, coalesce(i.branch_id, c.branch_id))  /* 0516 scenario */ group by 1
$b$);
select pg_temp.surg0516($f$public.regional_pl_range(date,date,uuid)$f$, $k$rpl_rcp$k$, $a$     where p.company_id = cid.company_id and p.payment_date between p_start and p_end group by 1
$a$, $b$     where p.company_id = cid.company_id and public.scenario_date('receipt_dates', p.id, p.payment_date) between p_start and p_end
       and not public.scenario_excluded(p.client_id, coalesce(p.branch_id, c.branch_id))  /* 0516 scenario */ group by 1
$b$);
select pg_temp.surg0516($f$public.regional_pl_range(date,date,uuid)$f$, $k$rpl_pay_a$k$, $a$     where e.company_id = cid.company_id
       and ps.period_month between date_trunc('month', p_start)::date and p_end group by 1
$a$, $b$     where e.company_id = cid.company_id
       and ps.period_month between date_trunc('month', p_start)::date and p_end
       and not public.scenario_excluded(e.client_id, e.branch_id)  /* 0516 scenario */ group by 1
$b$);
select pg_temp.surg0516($f$public.regional_pl_range(date,date,uuid)$f$, $k$rpl_pay_c$k$, $a$     where e.company_id = cid.company_id and ps.disbursed
$a$, $b$     where e.company_id = cid.company_id and ps.disbursed
       and not public.scenario_excluded(e.client_id, e.branch_id)  /* 0516 scenario */
$b$);
select pg_temp.surg0516($f$public.regional_pl_range(date,date,uuid)$f$, $k$rpl_exp_a$k$, $a$       and je.entry_date between p_start and p_end group by 1
$a$, $b$       and je.entry_date between p_start and p_end
       and not public.scenario_excluded(x.client_id, coalesce(jl.branch_id, x.branch_id, c.branch_id))  /* 0516 scenario */ group by 1
$b$);
select pg_temp.surg0516($f$public.regional_pl_range(date,date,uuid)$f$, $k$rpl_exp_c$k$, $a$     where x.company_id = cid.company_id
       and (case when x.payment_mode in ('Cash','Bank') then x.expense_date
                 when x.payment_mode = 'Cheque'
                   then case when ch.status = 'cleared' then ch.cleared_at::date end
                 when x.payment_mode = 'Payable' and x.payable_status = 'Paid' then x.paid_at::date end)
           between p_start and p_end group by 1
$a$, $b$     where x.company_id = cid.company_id
       and not public.scenario_excluded(x.client_id, coalesce(x.branch_id, c.branch_id))  /* 0516 scenario */
       and coalesce((public.scenario() -> 'expense_dates' ->> x.id::text)::date, (case when x.payment_mode in ('Cash','Bank') then x.expense_date
                 when x.payment_mode = 'Cheque'
                   then case when ch.status = 'cleared' then ch.cleared_at::date end
                 when x.payment_mode = 'Payable' and x.payable_status = 'Paid' then x.paid_at::date end))
           between p_start and p_end group by 1
$b$);
select pg_temp.surg0516($f$public.regional_pl_range(date,date,uuid)$f$, $k$rpl_regions$k$, $a$    select b.id, b.name::text from public.branches b cross join cid where b.company_id = cid.company_id
$a$, $b$    select b.id, b.name::text from public.branches b cross join cid where b.company_id = cid.company_id
      and not coalesce((public.scenario() -> 'exclude_regions') ? b.id::text, false)  /* 0516 scenario */
$b$);
select pg_temp.surg0516($f$public.partnership_allocation(date,date,text,uuid)$f$, $k$pa_reg$k$, $a$    select p.id, p.name, p.branch_id, p.profit_share_percent
$a$, $b$    select p.id, p.name,
           coalesce((public.scenario() -> 'partners' -> p.id::text ->> 'branch_id')::uuid, p.branch_id) as branch_id,  /* 0516 scenario */
           coalesce((public.scenario() -> 'partners' -> p.id::text ->> 'pct')::numeric, p.profit_share_percent) as profit_share_percent
$b$);
select pg_temp.surg0516($f$public.partnership_allocation(date,date,text,uuid)$f$, $k$pa_eq$k$, $a$    select p.id, p.name, p.profit_share_percent
$a$, $b$    select p.id, p.name,
           coalesce((public.scenario() -> 'partners' -> p.id::text ->> 'pct')::numeric, p.profit_share_percent) as profit_share_percent  /* 0516 scenario */
$b$);
select pg_temp.surg0516($f$public.ho_driver(uuid,date,date)$f$, $k$drv$k$, $a$     and je.entry_date between p_start and p_end
   group by jl.client_id$a$, $b$     and je.entry_date between p_start and p_end
     and not public.scenario_excluded(jl.client_id, coalesce(jl.branch_id, c.branch_id))  /* 0516 scenario */
   group by jl.client_id$b$);
select pg_temp.surg0516($f$public.partner_basis_for_report(text,uuid)$f$, $k$pbr$k$, $a$  if p_basis is not null and lower(p_basis) <> v_policy then
$a$, $b$  -- 0516. READ PATH ONLY: a scenario may ask for the other basis. Postings
  -- clear bastion.scenario before computing, so they always read the policy.
  if lower(public.scenario() ->> 'basis') in ('cash', 'revenue') then
    return lower(public.scenario() ->> 'basis');
  end if;

  if p_basis is not null and lower(p_basis) <> v_policy then
$b$);
select pg_temp.surg0516($f$public.run_profit_allocation(uuid,date,text,boolean)$f$, $k$rpa$k$, $a$  perform set_config('bastion.ho_mode_override', '', true);  -- 0514: a posting reads the setting, never a preview override
$a$, $b$  perform set_config('bastion.ho_mode_override', '', true);  -- 0514: a posting reads the setting, never a preview override
  perform set_config('bastion.scenario', '', true);  -- 0516: nor a scenario
$b$);
select pg_temp.surg0516($f$public.run_ho_cost_allocation(uuid,date,text)$f$, $k$rhca$k$, $a$  perform set_config('bastion.ho_mode_override', '', true);

  v_cost := public.ho_pool($a$, $b$  perform set_config('bastion.ho_mode_override', '', true);
  perform set_config('bastion.scenario', '', true);  -- 0516: nor a scenario

  v_cost := public.ho_pool($b$);
select pg_temp.surg0516($f$public.ledger_checks(uuid)$f$, $k$lc_arms$k$, $a$    select 'no_definer_function_crosses_a_branch'::text,
$a$, $b$    -- 0516. The September 2026 audit's findings, made checks so they fire
    -- again instead of being found by hand.
    select 'every_billed_client_carries_cost'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.client_income_cost_gaps(p_company_id,
             (date_trunc('month', current_date) - interval '1 month')::date)
    union all
    select 'no_payroll_booked_as_expense'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.payroll_booked_as_expense(p_company_id)
    union all
    select 'cash_and_bank_land_where_recorded'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.cash_bank_crossposted(p_company_id)
    union all
    select 'no_advance_booked_as_expense'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.advances_booked_as_expense(p_company_id)
    union all
    select 'invoices_fall_inside_their_contract'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.invoice_outside_contract(p_company_id)
    union all
    select 'no_definer_function_crosses_a_branch'::text,
$b$);
select pg_temp.surg0516($f$public.ledger_checks(uuid)$f$, $k$lc_canary$k$, $a$    from (select 39::numeric n) e (n);   -- expected_check_count$a$, $b$    from (select 44::numeric n) e (n);   -- expected_check_count (0516: +5)$b$);

-- ---------------------------------------------------------------------------
-- 7. ASSERTIONS.
-- ---------------------------------------------------------------------------
do $$
declare r record; v_bad int; v_txt text; v_un numeric;
begin
  -- 7a. The surgery changed no actual figure: every statement, region and
  -- partner reads exactly what it read before, with no scenario in force.
  perform set_config('bastion.scenario', '', true);
  select count(*), string_agg(b.m::text, ', ') into v_bad, v_txt
    from t0516_before b
   where b.cs_rev  <> (select coalesce(sum(s.net), 0) from public.client_statement_loaded(b.m, (b.m + interval '1 month - 1 day')::date, 'revenue', b.co) s)
      or b.cs_cash <> (select coalesce(sum(s.net), 0) from public.client_statement_loaded(b.m, (b.m + interval '1 month - 1 day')::date, 'cash', b.co) s)
      or b.rpl     <> (select coalesce(sum(rr.profit_accrual), 0) + coalesce(sum(rr.profit_cash), 0) from public.regional_pl_range(b.m, (b.m + interval '1 month - 1 day')::date, b.co) rr)
      or b.pa      <> (select coalesce(jsonb_object_agg(coalesce(a.partner_id::text, a.row_kind || coalesce(a.branch_id::text, '')), a.amount), '{}')
                         from public.partnership_allocation(b.m, (b.m + interval '1 month - 1 day')::date, null, b.co) a);
  if v_bad > 0 then raise exception '0516 FAILED: the surgery moved an actual figure in: %', v_txt; end if;

  -- 7b. An empty scenario moves nothing.
  for r in select distinct co, m from t0516_before loop
    if exists (select 1 from public.scenario_compare(r.co, r.m, '{}'::jsonb) x where abs(x.delta) > 0.005) then
      raise exception '0516 FAILED: an empty scenario moved a figure for %.', r.m;
    end if;
  end loop;

  -- 7c. The bridge explains everything: Unexplained is zero.
  for r in select distinct co, m from t0516_before loop
    select amount into v_un from public.cash_accrual_bridge(r.co, r.m, (r.m + interval '1 month - 1 day')::date) where item = 'Unexplained';
    if abs(v_un) > 0.01 then raise exception '0516 FAILED: the cash/accrual bridge leaves % unexplained for %.', v_un, r.m; end if;
  end loop;

  -- 7d. Postings never read a scenario.
  if position($q$set_config('bastion.scenario', '', true)$q$ in pg_get_functiondef('public.run_profit_allocation(uuid,date,text,boolean)'::regprocedure)) = 0
  or position($q$set_config('bastion.scenario', '', true)$q$ in pg_get_functiondef('public.run_ho_cost_allocation(uuid,date,text)'::regprocedure)) = 0 then
    raise exception '0516 FAILED: a posting function does not clear the scenario.';
  end if;
  if public.scenario() is not null then raise exception '0516 FAILED: a scenario is still in force.'; end if;

  -- 7e. The canary agrees with itself after the five new checks.
  for r in select id from public.companies loop
    if not (select passed from public.ledger_checks(r.id) where check_name = 'checks_evaluated') then
      raise exception '0516 FAILED: checks_evaluated disagrees with the number of checks.';
    end if;
  end loop;
end $$;

-- Tenant guard assertion (scripts/migration-template.sql).
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0516 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
