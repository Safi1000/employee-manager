-- 0585 — a money report is read by whoever may open its screen, and nobody else
--
-- Phase 0, Migration B (reads). Shayan, 28 Oct 2026: "ok". Follows 0584 (writes).
--
-- WHAT WAS FOUND. 75 read-only SECURITY DEFINER functions that return money
-- (ledgers, bank and cash positions, payroll cost, partner figures, the check
-- suite) are executable by `authenticated` and check no permission. Any login
-- could call ledger_statement, partner_ledger or cash_in_hand through the REST
-- API whatever its keys. 30 are called by no screen; 45 are.
--
-- WHY A GATE AT THE DOOR AND NOT 45 EDITED BODIES. Most of these functions are
-- also called by OTHER functions (ledger_checks calls a dozen; the dashboard's
-- figures are built from them). A require_perm inside the body would fire on
-- those nested calls too and refuse a screen whose user is entitled to the
-- outer function. 44 of them are LANGUAGE sql, which cannot hold a plpgsql
-- guard without being rewritten, and most have several authors (surgery on
-- each). So the check sits where a call ENTERS the database from the API:
--
--   public.api_request_gate() — PostgREST's db_pre_request. It runs once per
--   API request, reads the path, and for /rpc/<name> looks <name> up in
--   public.api_function_gates. If a row lists keys and the caller holds none
--   of them, the request is refused before the function runs:
--       permission denied: one of <keys> required          (42501 → HTTP 403)
--   Calls between functions, triggers, views, pg_cron and the service-role
--   key never pass through it and are unaffected. A function with no row is
--   unaffected (today's behaviour) — 0587's nightly check is what will make a
--   missing row go red.
--
-- THE KEYS: the union of the route guards of every screen that calls the
-- function (routes.tsx), plus the in-screen condition where the screen already
-- had one (Dashboard: can.reports / can.accounting; Clients: canReadInvoices;
-- Expenses' fuel tab: expenses.edit; statutory tab: payables.view /
-- accounting.edit). Anyone who can open the screen keeps the figure; anyone
-- who cannot, loses the back door to it.
--
-- AND 26 REVOKED outright — called by no screen and by nothing that runs as
-- the user (asserted below: no invoker function, view or policy names them).
-- Five more no screen calls are NOT revoked, because an invoker trigger or a
-- view calls them as the user (bank_account_gl, cash_account_for,
-- settlement_account — the journal_on_* triggers; region_operating_profit —
-- the regional_scorecard view; reserve_target — reserve_status): those get a
-- gate row instead, so a direct call is refused and their internal use is not.
--
-- EXEMPT, by decision, with the reason on the row:
--   bank_account_options, bank_can_cover, cheque_linked_amounts — 0530: whoever
--     may pay from a bank needs the picker, never the balance.
--   ledger_start_date — a date, not a figure.
--   ensure_custodian_location — 0485: "No edit key required".
--   generate_fixed_expense_instances — raises the month's scheduled
--     instances on the Expenses screen for every viewer; moves no money.
--
-- Asserted: the 26 are executable by no user role and still by service_role,
-- and nothing that runs as the user names them; every gate row names a
-- function that exists and keys that public.permission_keys holds (a key the
-- grant screen cannot offer is a gate nobody can pass); the gate, driven with
-- a simulated request, refuses an HR login on a report with the exact message,
-- admits Shayan, admits the HR login on an exempt function, on an unlisted
-- function and on a table path, and admits a request with no user; PostgREST
-- is configured to call it.

-- ── 1. the table of gates ───────────────────────────────────────────────────
create table if not exists public.api_function_gates (
  function_name text primary key,
  any_of        text[],
  reason        text not null,
  check (any_of is null or cardinality(any_of) > 0)
);
comment on table public.api_function_gates is
  'DECIDED 0585: who may call a function through the API (/rpc/<name>). any_of = the keys of every screen that calls it — holding one admits; '
  'any_of NULL = exempt, reason says why. Read by api_request_gate() (PostgREST db_pre_request) only; nested calls, triggers, views, pg_cron and '
  'the service-role key never pass through it. A function with no row is not gated — the nightly check (0587) reports those.';
alter table public.api_function_gates enable row level security;
revoke all on public.api_function_gates from anon, authenticated;

insert into public.api_function_gates (function_name, any_of, reason) values
  -- Financial Reports › Overview, and the Accountant screen
  ('advances_booked_as_expense',       '{reports.view,accountant.view}', 'Overview tab (reports.view / accountant.view)'),
  ('bank_held_operational',            '{reports.view,accountant.view}', 'Overview tab'),
  ('cash_accrual_bridge',              '{reports.view,accountant.view}', 'Overview tab'),
  ('cash_bank_crossposted',            '{reports.view,accountant.view}', 'Overview tab'),
  ('cash_basis_partnership_mismatch',  '{reports.view,accountant.view}', 'Overview tab'),
  ('custodian_held_operational',       '{reports.view,accountant.view}', 'Overview tab'),
  ('invoice_outside_contract',         '{reports.view,accountant.view}', 'Overview tab'),
  ('ledger_checks',                    '{reports.view,accountant.view}', 'Overview tab, Accountant'),
  ('monthly_ledger_run_gaps',          '{reports.view,accountant.view}', 'Overview tab'),
  ('payroll_attendance_drift',         '{reports.view,accountant.view}', 'Overview tab'),
  ('payroll_booked_as_expense',        '{reports.view,accountant.view}', 'Overview tab'),
  ('revenue_outside_service_month',    '{reports.view,accountant.view}', 'Overview tab'),
  ('stale_prepaid_expenses',           '{reports.view,accountant.view}', 'Overview tab'),
  ('uninvoked_controls',               '{reports.view,accountant.view}', 'Overview tab'),
  ('unposted_source_rows',             '{reports.view,accountant.view}', 'Overview tab'),
  ('ho_driver',                        '{reports.view,accountant.view}', 'Client profit tab'),
  ('regional_pl_range',                '{reports.view,accountant.view}', 'Statements › Regional performance'),
  ('payroll_cost_by_client',           '{reports.view,accountant.view}', 'Partnership report (no live route)'),
  ('payroll_cash_by_client',           '{cashflow.view,reports.view,accountant.view}', 'Cash flow (cashflow.view), Statements (reports.view)'),
  ('operating_expense_detail',         '{reports.view,banks.view,accountant.view}', 'Regional scorecard (reports.view / banks.view)'),
  ('cash_forecast',                    '{banks.view,reports.view,cashflow.view}', 'Treasury (banks.view / reports.view / cashflow.view)'),
  ('ho_pool',                          '{reports.view,accountant.view,banks.view,receivables.view,payables.view,accounting.edit,partnership.post}', 'Head-office tab; Partnership policy panel'),
  -- Partnership (route: banks.view / receivables.view / payables.view / accounting.edit; posting: partnership.post)
  ('partnership_month_view',           '{banks.view,receivables.view,payables.view,accounting.edit,partnership.post}', 'Partnership › Months'),
  ('partnership_posting_deadline',     '{banks.view,receivables.view,payables.view,accounting.edit,partnership.post}', 'Partnership › Months, policy panel'),
  ('partnership_run_blocker',          '{banks.view,receivables.view,payables.view,accounting.edit,partnership.post}', 'Partnership › Months'),
  ('partnership_uninvoiced_clients',   '{banks.view,receivables.view,payables.view,accounting.edit,partnership.post}', 'Partnership › Months'),
  ('profit_allocation_review',         '{banks.view,receivables.view,payables.view,accounting.edit,partnership.post}', 'Partnership › Months'),
  ('partner_client_breakdown',         '{banks.view,receivables.view,payables.view,accounting.edit,partnership.post}', 'Partnership › Partners'),
  ('partner_ledger',                   '{banks.view,receivables.view,payables.view,accounting.edit,partnership.post,reports.view,accountant.view}', 'Partnership › Partners / Statements; Accountant ledgers'),
  ('partnership_allocation',           '{reports.view,accountant.view,banks.view,receivables.view,payables.view,accounting.edit,partnership.post}', 'Dashboard (can.reports); partnership figures'),
  -- Figures on wider screens
  ('ledger_statement',                 '{reports.view,accountant.view,banks.view}', 'Ledgers, detail drawer, Accountant; Dashboard bank and cash (can.accounting = banks.view)'),
  ('client_statement_loaded',          '{invoices.view,invoices.edit,receivables.view,accounting.edit,reports.view,cashflow.view,period_close.manage,accountant.view,reversals.execute,banks.view}', 'Clients (canReadInvoices), Dashboard (can.reports), Cash flow, Regional scorecard, reports'),
  ('cash_in_hand',                     '{banks.view,accounting.edit,reports.view,cashflow.view,accountant.view,reversals.execute,receivables.view,payables.view,payroll.view,payroll.edit,payroll.adjust}', 'Accounting › Cash custody, Dashboard (can.accounting), Payroll (cash cover check)'),
  ('employee_advance_outstanding',     '{payroll.view,payroll.edit,payroll.adjust}', 'Payroll'),
  ('employee_clearance_gates',         '{assignments.view,employees.view,employees.edit,clearance.ops,clearance.finance}', 'Assignments › fire guard'),
  ('statutory_booked_as_cost',         '{payables.view,accounting.edit}', 'Expenses › Statutory tab (payables.view / accounting.edit)'),
  ('statutory_liability_due',          '{payables.view,accounting.edit}', 'Expenses › Statutory tab, remit modal'),
  ('prepaid_schedule',                 '{expenses.view,expenses.edit,expenses.approve,accounting.edit,reports.view,accountant.view}', 'Expenses (deferred schedule)'),
  ('fuel_card_balances',               '{expenses.edit,banks.view,receivables.view,payables.view,accounting.edit}', 'Expenses › Fuel tab (expenses.edit), Accounting › Fuel cards'),
  ('fuel_card_statement',              '{expenses.edit,banks.view,receivables.view,payables.view,accounting.edit}', 'Fuel card statement (0582)'),
  -- No screen; called as the user by an invoker trigger or a view, so gated rather than revoked
  ('bank_account_gl',                  '{accounting.edit,reports.view,accountant.view}', 'Internal: journal_on_* triggers call it as the user'),
  ('cash_account_for',                 '{accounting.edit,reports.view,accountant.view}', 'Internal: journal_on_* triggers call it as the user'),
  ('settlement_account',               '{accounting.edit,reports.view,accountant.view}', 'Internal: journal_on_* triggers call it as the user'),
  ('region_operating_profit',          '{accounting.edit,reports.view,accountant.view}', 'Internal: the regional_scorecard view calls it'),
  ('reserve_target',                   '{accounting.edit,reports.view,accountant.view}', 'Internal: the reserve_status view calls it'),
  -- Exempt
  ('bank_account_options',             null, 'EXEMPT 0530: the bank picker for whoever may pay — names and last four digits, no balance'),
  ('bank_can_cover',                   null, 'EXEMPT 0530: yes/no on one payment, no balance'),
  ('cheque_linked_amounts',            null, 'EXEMPT 0530: what is already linked to a cheque, for whoever records against it'),
  ('ledger_start_date',                null, 'EXEMPT: a date, not a figure'),
  ('ensure_custodian_location',        null, 'EXEMPT 0485: creates an empty custodian location; "No edit key required"'),
  ('generate_fixed_expense_instances', null, 'EXEMPT: raises the month''s scheduled instances for every Expenses viewer; moves no money')
on conflict (function_name) do nothing;

-- ── 2. the gate ─────────────────────────────────────────────────────────────
create or replace function public.api_request_gate()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
  -- 0585. PostgREST's db_pre_request: runs once per API request, before it.
  -- Only /rpc/<name> with a row in api_function_gates listing keys is checked;
  -- everything else — table paths, unlisted functions, a request with no user
  -- (anon, service_role) — passes untouched, as before 0585.
  declare v_path text; v_fn text; v_keys text[];
  begin
    v_path := current_setting('request.path', true);
    if v_path is null or v_path = '' then return; end if;
    v_fn := lower(substring(v_path from '(?:^|/)rpc/([A-Za-z0-9_]+)/?$'));
    if v_fn is null then return; end if;
    if auth.uid() is null then return; end if;
    select g.any_of into v_keys from public.api_function_gates g where g.function_name = v_fn;
    if v_keys is null then return; end if;
    if exists (select 1 from unnest(v_keys) k where public.has_perm(k)) then return; end if;
    raise exception 'permission denied: one of % required', array_to_string(v_keys, ', ') using errcode = '42501';
  end $$;
comment on function public.api_request_gate() is
  'TENANT GUARD EXEMPT: takes no argument and reads only the request path and the caller''s own permissions. '
  '0585: PostgREST db_pre_request — refuses /rpc/<name> when api_function_gates lists keys for <name> and the caller holds none.';
revoke all on function public.api_request_gate() from public;
grant execute on function public.api_request_gate() to anon, authenticated, service_role;

-- ── 3. revoke what no screen and no user-run code calls ─────────────────────
do $revoke$
declare
  v_name text; v_bad text;
  v_list constant text[] := array[
    'avg_monthly_net_payroll','avg_monthly_overhead','billing_clients_on_head_office','branch_revenue_for_month',
    'closed_period_intrusions','compute_kpi_value','default_cash_location','fuel_card_portal_gaps','ledger_checks_base',
    'ledger_payroll_by_client','misparented_system_accounts','payslip_client_split','prepaid_schedule_drift',
    'profit_allocation_over_allocated','region_cash_entitlement','region_operating_profit_range','region_profit',
    'regional_cash_hunger','regional_general_expenses','run_unacked_exception_count','scenario_snapshot',
    'statutory_accrued','tenant_guard_gaps','unsettled_payroll_adjustments','withholding_written_after_cutover',
    'invoice_reminder_items'];
  r record;
begin
  foreach v_name in array v_list loop
    if not exists (select 1 from pg_proc where proname = v_name and pronamespace = 'public'::regnamespace) then
      raise exception '0585 REFUSED: % does not exist.', v_name;
    end if;
    for r in select oid::regprocedure::text sig from pg_proc where proname = v_name and pronamespace = 'public'::regnamespace loop
      execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
      execute format('grant execute on function %s to service_role', r.sig);
    end loop;
  end loop;

  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any(v_list)
     and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute')
          or not has_function_privilege('service_role', p.oid, 'execute'));
  if v_bad is not null then raise exception '0585 REFUSED: grants not as intended on %', v_bad; end if;

  select string_agg(distinct q.proname || ' → ' || n, ', ') into v_bad
    from unnest(v_list) n
    join pg_proc q on q.pronamespace = 'public'::regnamespace and not q.prosecdef and q.proname <> n and q.prosrc ~* ('\m' || n || '\M')
   where q.proname not in ('branch_guard_covered');
  if v_bad is not null then raise exception '0585 REFUSED: invoker functions call revoked functions: %', v_bad; end if;
  select string_agg(distinct v.viewname || ' → ' || n, ', ') into v_bad
    from unnest(v_list) n join pg_views v on v.schemaname = 'public' and v.definition ~* ('\m' || n || '\M');
  if v_bad is not null then raise exception '0585 REFUSED: views call revoked functions: %', v_bad; end if;
  select string_agg(distinct p.tablename || '.' || p.policyname, ', ') into v_bad
    from unnest(v_list) n join pg_policies p on p.schemaname = 'public'
     and (coalesce(p.qual, '') || coalesce(p.with_check, '')) ~* ('\m' || n || '\M');
  if v_bad is not null then raise exception '0585 REFUSED: policies call revoked functions: %', v_bad; end if;
end $revoke$;

-- ── 4. switch it on ─────────────────────────────────────────────────────────
alter role authenticator set pgrst.db_pre_request = 'public.api_request_gate';
notify pgrst, 'reload config';

-- ── 5. proof ────────────────────────────────────────────────────────────────
do $test$
declare
  v_hr   constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';   -- HR: employees/attendance/expenses keys only
  v_boss constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';   -- Shayan Ahmed (super_admin)
  v_bad text; v_msg text;
begin
  -- every row names a real function and grantable keys
  select string_agg(function_name, ', ') into v_bad from public.api_function_gates g
   where not exists (select 1 from pg_proc p where p.proname = g.function_name and p.pronamespace = 'public'::regnamespace);
  if v_bad is not null then raise exception '0585 REFUSED: gate rows name missing functions: %', v_bad; end if;
  select string_agg(distinct k, ', ') into v_bad from public.api_function_gates g, unnest(g.any_of) k
   where not exists (select 1 from public.permission_keys pk where pk.key = k);
  if v_bad is not null then raise exception '0585 REFUSED: gate keys the grant screen cannot offer: %', v_bad; end if;
  if (select count(*) from public.api_function_gates where any_of is not null) <> 45
     or (select count(*) from public.api_function_gates where any_of is null) <> 6 then
    raise exception '0585 REFUSED: expected 45 gated and 6 exempt rows.';
  end if;

  -- HR on a report: refused, with the message
  perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
  perform set_config('request.path', '/rpc/ledger_checks', true);
  v_msg := null;
  begin perform public.api_request_gate(); exception when others then get stacked diagnostics v_msg = message_text; end;
  if v_msg is distinct from 'permission denied: one of reports.view, accountant.view required' then
    raise exception '0585 REFUSED: HR on ledger_checks said "%".', v_msg;
  end if;
  perform set_config('request.path', '/rest/v1/rpc/partner_ledger', true);
  v_msg := null;
  begin perform public.api_request_gate(); exception when others then get stacked diagnostics v_msg = message_text; end;
  if v_msg is null or v_msg not like 'permission denied: one of banks.view, receivables.view%' then
    raise exception '0585 REFUSED: HR on partner_ledger (full path) said "%".', v_msg;
  end if;

  -- HR admitted: exempt function, unlisted function, table path, a function HR's keys open
  perform set_config('request.path', '/rpc/bank_account_options', true);   perform public.api_request_gate();
  perform set_config('request.path', '/rpc/daily_report_items', true);     perform public.api_request_gate();
  perform set_config('request.path', '/expenses', true);                   perform public.api_request_gate();
  perform set_config('request.path', '/rpc/prepaid_schedule', true);       perform public.api_request_gate();   -- expenses.view

  -- Shayan admitted on everything gated
  perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
  perform set_config('request.path', '/rpc/ledger_checks', true);          perform public.api_request_gate();
  perform set_config('request.path', '/rpc/partner_ledger', true);         perform public.api_request_gate();

  -- no user (anon / service_role): untouched
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  perform set_config('request.path', '/rpc/ledger_checks', true);          perform public.api_request_gate();
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.path', '', true);

  -- PostgREST will call it
  if not exists (select 1 from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
                  where r.rolname = 'authenticator' and 'pgrst.db_pre_request=public.api_request_gate' = any(s.setconfig)) then
    raise exception '0585 REFUSED: authenticator is not configured with the gate.';
  end if;
end $test$;
