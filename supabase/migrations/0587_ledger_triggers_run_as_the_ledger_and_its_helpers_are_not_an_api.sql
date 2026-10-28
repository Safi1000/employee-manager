-- 0587 — the ledger's triggers run as the ledger, and its helpers are not an API
--
-- Phase 0, finishing what 0584 left. Shayan, 28 Oct 2026: "lets wrap it up in
-- one go leaving for later is not the wise option just wind it up".
-- (0585's table comment names "0587" as the nightly check; that check is 0590.
-- A comment is a measurement of the moment it was written.)
--
-- 1. THIRTEEN TRIGGER FUNCTIONS BECOME SECURITY DEFINER.
--    journal_on_advance / _cash_deposit / _custody_transfer / _expense /
--    _expense_settlement / _fixed_asset / _invoice_payment / _partner_entry,
--    assert_journal_balanced, enforce_period_lock,
--    enforce_supplementary_matches_primary, enforce_cycle_event(_delete).
--    They ran as the user, and read tables that are — or after 0588 will be —
--    read only with a key. A trigger reading as the user sees only what the
--    user may see, so a control inside one quietly checks less.
--
--    THE INSTANCE, FOUND WHILE WRITING THIS: assert_journal_balanced (the
--    deferred constraint trigger that refuses an unbalanced journal entry)
--    begins `if not exists (select 1 from journal_entries where id = v_entry)
--    then return null`. Since 0531 gated journal_entries/journal_lines, a login
--    without reports/coa/accounting keys cannot see the entry its own expense
--    just posted — so for every journal an HR login caused, the balance check
--    returned before checking. Nothing went red: a skipped control looks
--    exactly like a passed one. As definer it reads as the owner and checks
--    every entry again.
--
--    A definer TRIGGER is the accepted exception (CLAUDE.md, "Converting a
--    child does not close its definer parents"): it fires inside a statement
--    the caller already passed RLS to make. Their search_path is already
--    pinned. Direct EXECUTE is revoked — a trigger function is never called.
--
-- 2. THE LEDGER'S HELPERS ARE REFUSED AS AN API. post_journal,
--    reverse_journal_for_source, ensure_bad_debt_account,
--    ensure_inventory_accounts, ensure_prepaid_expenses_account,
--    release_prepaid_expenses and fund_reserve stay EXECUTABLE (write_off_receivable
--    and record_opening_stock still call them as the user), but a direct
--    /rpc/ call is refused by 0585's gate without accounting.edit. The same
--    gate covers the user-called writes 0584 left: archive_guard_deployments,
--    next_counter, assess_clearance, change_client, request_approval,
--    run_kpi_computation, log_invoice_reminder — each with the keys of the
--    screen that calls it. acknowledge_alert and request_expense are exempt,
--    with the reason on the row.
--
-- Asserted: the thirteen are definer and not executable by a user role; as
-- the HR login (expenses.edit, no journal key), recording a fuel trip — an
-- expense, its journal, and the deferred balance check forced to run now —
-- succeeds end to end, and the journal it posted balances (rolled back by a
-- sentinel whose message is checked); the gate refuses HR on /rpc/post_journal
-- with the exact message and admits Shayan; every new gate row names a real
-- function and grantable keys; no tenant or branch guard gaps.

-- ── 1. triggers run as the ledger ───────────────────────────────────────────
do $trg$
declare
  v_sig text; v_bad text;
  v_list constant text[] := array[
    'journal_on_advance()','journal_on_cash_deposit()','journal_on_custody_transfer()','journal_on_expense()',
    'journal_on_expense_settlement()','journal_on_fixed_asset()','journal_on_invoice_payment()','journal_on_partner_entry()',
    'assert_journal_balanced()','enforce_period_lock()','enforce_supplementary_matches_primary()',
    'enforce_cycle_event()','enforce_cycle_event_delete()'];
begin
  foreach v_sig in array v_list loop
    if (select prorettype from pg_proc where oid = ('public.' || v_sig)::regprocedure) <> 'trigger'::regtype then
      raise exception '0587 REFUSED: % is not a trigger function.', v_sig;
    end if;
    if (select proconfig from pg_proc where oid = ('public.' || v_sig)::regprocedure) is null then
      raise exception '0587 REFUSED: % has no pinned search_path.', v_sig;
    end if;
    execute format('alter function public.%s security definer', v_sig);
    execute format('revoke execute on function public.%s from public, anon, authenticated', v_sig);
  end loop;
  select string_agg(s, ', ') into v_bad from unnest(v_list) s
   where not (select prosecdef from pg_proc where oid = ('public.' || s)::regprocedure)
      or has_function_privilege('authenticated', ('public.' || s)::regprocedure, 'execute');
  if v_bad is not null then raise exception '0587 REFUSED: not definer, or still executable: %', v_bad; end if;
end $trg$;

-- ── 2. helpers and user-called writes behind the API gate ───────────────────
insert into public.api_function_gates (function_name, any_of, reason) values
  ('post_journal',                    '{accounting.edit}', 'Ledger helper: called by definer functions and triggers; a direct call is a manual journal (0587)'),
  ('reverse_journal_for_source',      '{accounting.edit}', 'Ledger helper (0587)'),
  ('ensure_bad_debt_account',         '{accounting.edit}', 'Ledger helper; write_off_receivable calls it as the user (0587)'),
  ('ensure_inventory_accounts',       '{accounting.edit}', 'Ledger helper; record_opening_stock calls it as the user (0587)'),
  ('ensure_prepaid_expenses_account', '{accounting.edit}', 'Ledger helper (0587)'),
  ('release_prepaid_expenses',        '{accounting.edit}', 'Ledger helper (0587)'),
  ('fund_reserve',                    '{accounting.edit}', 'Treasury › reserves; also called by sweep/mirror functions (0587)'),
  ('archive_guard_deployments',       '{employees.edit,assignments.hr}', 'Called by change_guard_shift / record_separation (0587)'),
  ('next_counter',                    '{employees.edit,clients.edit}', 'Code counters; called by code-assigning functions and triggers (0587)'),
  ('assess_clearance',                '{clearance.ops,clearance.finance,employees.edit,assignments.hr,assignments.view}', 'Assignments › fire guard (0587)'),
  ('change_client',                   '{employees.edit,assignments.hr}', 'Employees › change client (0587)'),
  ('request_approval',                '{banks.view,reports.view,cashflow.view,accounting.edit}', 'Treasury (0587)'),
  ('run_kpi_computation',             '{performance.approve,payroll.view}', 'Performance (0587)'),
  ('log_invoice_reminder',            '{invoices.view,invoices.edit,receivables.view,accounting.edit}', 'Invoices › Receivables (0587)'),
  ('acknowledge_alert',               null, 'EXEMPT 0587: whoever is shown an alert may acknowledge it'),
  ('request_expense',                 null, 'EXEMPT 0587: anyone may request an expense; deciding it is gated')
on conflict (function_name) do nothing;

-- ── 3. proof ────────────────────────────────────────────────────────────────
do $test$
declare
  v_hr   constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';   -- HR: expenses.edit, no journal key
  v_boss constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';   -- Shayan Ahmed (super_admin)
  v_card uuid := (select id from public.fuel_cards where company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e' and card_last4 = '7724');
  v_trip uuid; v_exp uuid; v_seen bigint; v_dr numeric; v_cr numeric; v_msg text; v_bad text;
begin
  select string_agg(function_name, ', ') into v_bad from public.api_function_gates g
   where not exists (select 1 from pg_proc p where p.proname = g.function_name and p.pronamespace = 'public'::regnamespace);
  if v_bad is not null then raise exception '0587 REFUSED: gate rows name missing functions: %', v_bad; end if;
  select string_agg(distinct k, ', ') into v_bad from public.api_function_gates g, unnest(g.any_of) k
   where not exists (select 1 from public.permission_keys pk where pk.key = k);
  if v_bad is not null then raise exception '0587 REFUSED: gate keys the grant screen cannot offer: %', v_bad; end if;

  -- an HR login's expense still posts, and its journal is now checked
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    select count(*) into v_seen from public.journal_entries;          -- what HR can see of the journal
    v_trip := public.record_fuel_trip(v_card, '2026-10-28', '0587 test', null, 1);
    execute 'set constraints all immediate';                            -- the deferred balance check runs now
    execute 'reset role';
    if v_seen <> 0 then raise exception '0587 REFUSED: the HR login sees % journal entries; the test assumes none.', v_seen; end if;
    select t.expense_id into v_exp from public.fuel_trips t where t.id = v_trip;
    select sum(jl.debit), sum(jl.credit) into v_dr, v_cr
      from public.journal_entries je join public.journal_lines jl on jl.journal_entry_id = je.id
     where je.source_table = 'expenses' and je.source_id = v_exp and not je.is_reversal;
    if v_dr is null or v_dr <> 1 or v_cr <> 1 then
      raise exception '0587 REFUSED: the trip''s journal is % / %, not 1 / 1.', v_dr, v_cr;
    end if;
    raise exception '0587-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0587-SENTINEL' then raise; end if;
  end;

  -- the gate refuses HR on a ledger helper and admits Shayan
  perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
  perform set_config('request.path', '/rpc/post_journal', true);
  v_msg := null;
  begin perform public.api_request_gate(); exception when others then get stacked diagnostics v_msg = message_text; end;
  if v_msg is distinct from 'permission denied: one of accounting.edit required' then
    raise exception '0587 REFUSED: HR on post_journal said "%".', v_msg;
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
  perform public.api_request_gate();
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.path', '', true);

  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0587 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
  select string_agg(function_name, ', ') into v_bad from public.branch_guard_gaps()
   where function_name in ('journal_on_advance','journal_on_cash_deposit','journal_on_custody_transfer','journal_on_expense',
                           'journal_on_expense_settlement','journal_on_fixed_asset','journal_on_invoice_payment','journal_on_partner_entry',
                           'assert_journal_balanced','enforce_period_lock','enforce_supplementary_matches_primary',
                           'enforce_cycle_event','enforce_cycle_event_delete');
  if v_bad is not null then raise exception '0587 REFUSED: branch_guard_gaps() reports %.', v_bad; end if;
end $test$;
