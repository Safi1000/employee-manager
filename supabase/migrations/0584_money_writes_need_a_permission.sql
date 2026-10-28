-- 0584 — a function that writes money is not callable on company membership alone
--
-- Shayan, 28 Oct 2026: "lets first tighten the security and then start with
-- app development" — Phase 0, Migration A (writes). Reads (B), table read
-- gates (C) and the nightly check (D) follow.
--
-- WHAT WAS FOUND. 60 SECURITY DEFINER functions executable by `authenticated`
-- write something and check no permission — only that the caller belongs to
-- the company (assert_same_company). Any of the eight logins could call them
-- straight through the REST API. Among them: post_manual_journal (any journal
-- entry), reverse_profit_allocation (undo a posted profit run), run_depreciation,
-- run_ho_cost_allocation, the bonus accruals, pay_bonus_allocation,
-- repost_payslip_accruals_for_month, and ai_credit_topup (credit any amount of
-- AI usage to one's own company).
--
-- WHAT THIS DOES, IN TWO PARTS.
--
-- 1. REVOKED from public/anon/authenticated — 32 functions no screen calls.
--    Each is called only by other SECURITY DEFINER functions or definer
--    triggers (which run as the owner and keep their access), by pg_cron (runs
--    as postgres), or by an Edge Function on the service-role key (keeps its
--    grant). Nothing a user does reaches them except through a caller that
--    already gates itself.
--
-- 2. GATED (surgery against the live definition, anchor asserted once) — the
--    seven money-writing functions a screen calls directly. The key is what a
--    direct write to the target table requires (CLAUDE.md "Which key a
--    function should require"):
--      post_manual_journal         accounting.edit     (journal_lines)
--      run_depreciation            accounting.edit     (depreciation_entries)
--      run_ho_cost_allocation      accounting.edit     (journal)
--      accrue_bonus_reserve        accounting.edit     (journal / reserves)
--      reverse_profit_allocation   partnership.post    (the screen's own key: canPost)
--      accrue_attendance_bonuses   performance.approve (guard_bonuses)
--      accrue_eid_bonuses          performance.approve (guard_bonuses)
--    The gate is the house pattern: `auth.uid() is not null and
--    pg_trigger_depth() = 0`, so pg_cron (run_monthly_ledger_jobs) and trigger
--    paths are unaffected.
--
-- DELIBERATELY NOT HERE, AND WHY (each is owed a later migration):
--   * post_journal, reverse_journal_for_source, ensure_bad_debt_account,
--     ensure_inventory_accounts, ensure_prepaid_expenses_account,
--     release_prepaid_expenses — called by SECURITY INVOKER trigger functions
--     (journal_on_expense, journal_on_advance, journal_on_invoice_payment,
--     journal_on_custody_transfer, …) and by write_off_receivable /
--     record_opening_stock, which run as the user. Revoking would break
--     expense entry. DEFERRED: convert those triggers to definer (a definer
--     trigger parent is the accepted exception, CLAUDE.md), then revoke.
--   * archive_guard_deployments, next_counter — invoker callers likewise.
--   * fund_reserve — called by sweep_receipt_to_reserve and
--     mirror_depreciation_to_reserve; their callers' keys not yet traced.
--   * generate_fixed_expense_instances — the Expenses screen calls it on load
--     for every viewer to raise the month's scheduled instances (idempotent,
--     moves no money); gating it would break the screen for view-only users.
--   * ensure_custodian_location — "No edit key required" by decision (0485).
--   * Non-money writes (acknowledge_alert, assess_clearance, change_client,
--     request_approval, request_expense, run_kpi_computation,
--     log_invoice_reminder) — a later sweep.
--   * update_company_profile, update_invoice_structure, add_subscription_payment
--     — already role-gated in their bodies.
--
-- Asserted: none of the 32 is executable by anon/authenticated and every one
-- still is by service_role; no invoker function, view or policy names a revoked
-- function; each gated function carries its gate exactly once; as an HR login
-- without the key, each gated function refuses with the exact message
-- "permission denied: <key> required"; as Shayan (super_admin) none of them
-- refuses on permission (in blocks rolled back by a sentinel whose message is
-- checked); no tenant or branch guard gaps.

-- ── 1. revoke ───────────────────────────────────────────────────────────────
do $revoke$
declare
  v_sig text;
  v_list constant text[] := array[
    'accrue_long_service_bonus(uuid,numeric,text)',
    'acknowledge_payroll_exception(uuid,text)',
    'ai_credit_reset_period(uuid,numeric)',
    'ai_credit_spend(uuid,numeric,text,uuid)',
    'ai_credit_topup(uuid,numeric,text,text)',
    'allocate_cash_location_account(uuid,text,text)',
    'allocate_partner_capital_account(uuid,text)',
    'amend_contract(uuid,text,text,text)',
    'ensure_statutory_contributions_account(uuid)',
    'ensure_unearned_revenue_account(uuid)',
    'ensure_unpresented_cheques_account(uuid)',
    'fund_region(uuid,uuid,uuid,numeric,uuid,boolean,text)',
    'launch_site(uuid)',
    'log_clearance_issued(uuid,text)',
    'pay_bonus_allocation(uuid,uuid)',
    'post_invoice_journal(uuid)',
    'post_kit_issuance_cost(uuid,date)',
    'post_payslip_accrual(uuid)',
    'post_payslip_disbursement(uuid)',
    'raise_alert(uuid,alert_tier,text,text,text,uuid,uuid)',
    'recognise_advance_revenue(uuid,date)',
    'repost_payslip_accruals_for_month(uuid,date)',
    'retire_orphaned_leaf_account(uuid)',
    'run_monthly_ledger_jobs(date)',
    'seed_chart_of_accounts(uuid)',
    'seed_document_checklist(uuid,uuid)',
    'sync_bank_transfer_journal(uuid,uuid)',
    'sync_bank_transfer_journal(uuid)',
    'sync_cheque_journal(uuid)',
    'sync_partnership_posting_date(uuid,date)',
    'trueup_bonus_provision(uuid,integer)',
    'warn_repeat_no_show(uuid)'];
  v_bad text;
begin
  foreach v_sig in array v_list loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', v_sig);
    execute format('grant execute on function public.%s to service_role', v_sig);
  end loop;

  -- none reachable by a user role; all still reachable by service_role
  select string_agg(s, ', ') into v_bad from unnest(v_list) s
   where has_function_privilege('authenticated', ('public.' || s)::regprocedure, 'execute')
      or has_function_privilege('anon', ('public.' || s)::regprocedure, 'execute')
      or not has_function_privilege('service_role', ('public.' || s)::regprocedure, 'execute');
  if v_bad is not null then raise exception '0584 REFUSED: grants not as intended on %', v_bad; end if;

  -- nothing that runs as the user names a revoked function
  select string_agg(distinct q.proname || ' → ' || split_part(s, '(', 1), ', ') into v_bad
    from unnest(v_list) s
    join pg_proc q on not q.prosecdef and q.prosrc ~* ('\m' || split_part(s, '(', 1) || '\M')
    join pg_namespace n on n.oid = q.pronamespace and n.nspname = 'public'
   where q.proname not in ('branch_guard_covered');   -- names functions in text, calls none of these
  if v_bad is not null then raise exception '0584 REFUSED: invoker functions call revoked functions: %', v_bad; end if;

  select string_agg(distinct v.viewname || ' → ' || split_part(s, '(', 1), ', ') into v_bad
    from unnest(v_list) s join pg_views v on v.schemaname = 'public' and v.definition ~* ('\m' || split_part(s, '(', 1) || '\M');
  if v_bad is not null then raise exception '0584 REFUSED: views call revoked functions: %', v_bad; end if;

  select string_agg(distinct p.tablename || '.' || p.policyname, ', ') into v_bad
    from unnest(v_list) s join pg_policies p on p.schemaname = 'public'
     and (coalesce(p.qual, '') || coalesce(p.with_check, '')) ~* ('\m' || split_part(s, '(', 1) || '\M');
  if v_bad is not null then raise exception '0584 REFUSED: policies call revoked functions: %', v_bad; end if;
end $revoke$;

-- ── 2. gate ─────────────────────────────────────────────────────────────────
do $gate$
declare
  g record; v_def text; v_n int;
  v_tg constant text := E'  -- tenant guard [claimed]: p_company_id IS the caller''s claim; compared as given (0242)\n  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;\n';
begin
  for g in
    select * from (values
      ('public.post_manual_journal(date,text,uuid,uuid,numeric,uuid)', 'accounting.edit',
       E'  if v_company is null then\n    raise exception ''Not authorised for any company'';\n  end if;\n'),
      ('public.run_depreciation(uuid,date)',              'accounting.edit',     v_tg),
      ('public.run_ho_cost_allocation(uuid,date,text)',   'accounting.edit',     v_tg),
      ('public.accrue_bonus_reserve(uuid,date)',          'accounting.edit',     v_tg),
      ('public.accrue_attendance_bonuses(uuid,date,numeric)', 'performance.approve', v_tg),
      ('public.accrue_eid_bonuses(uuid,date,numeric)',    'performance.approve', v_tg),
      ('public.reverse_profit_allocation(uuid)',          'partnership.post',
       E'  if p_run_id is not null then perform public.assert_same_company((select company_id from public.profit_allocation_runs where id = p_run_id)); end if;\n')
    ) as t(sig, perm, anchor)
  loop
    v_def := pg_get_functiondef(g.sig::regprocedure);
    if position('0584:' in v_def) > 0 then continue; end if;   -- replay
    v_n := (length(v_def) - length(replace(v_def, g.anchor, ''))) / length(g.anchor);
    if v_n <> 1 then raise exception '0584 REFUSED: the anchor appears % times in %.', v_n, g.sig; end if;
    execute replace(v_def, g.anchor, g.anchor ||
      format(E'  -- 0584: %s required. A direct call without it is refused; pg_cron and trigger paths are unaffected.\n'
             '  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm(%L); end if;\n', g.perm, g.perm));
  end loop;
end $gate$;

-- ── 3. proof ────────────────────────────────────────────────────────────────
do $test$
declare
  v_co   constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_hr   constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';   -- HR login: no accounting.edit / partnership.post / performance.approve
  v_boss constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';   -- Shayan Ahmed (super_admin)
  t record; v_msg text; v_n int;
begin
  -- each gated function carries its gate exactly once
  for t in select unnest(array['post_manual_journal','run_depreciation','run_ho_cost_allocation','accrue_bonus_reserve',
                               'accrue_attendance_bonuses','accrue_eid_bonuses','reverse_profit_allocation']) as f loop
    select (length(prosrc) - length(replace(prosrc, '-- 0584:', ''))) / length('-- 0584:') into v_n
      from pg_proc where proname = t.f and pronamespace = 'public'::regnamespace;
    if v_n <> 1 then raise exception '0584 REFUSED: % carries % gates.', t.f, v_n; end if;
  end loop;

  perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
  if public.has_perm('accounting.edit') or public.has_perm('partnership.post') or public.has_perm('performance.approve') then
    raise exception '0584 REFUSED: the test login holds a key it must not.';
  end if;

  for t in select * from (values
      ('select public.post_manual_journal(null, null, null, null, null, null)', 'accounting.edit'),
      ('select public.run_depreciation(''7f7899a0-edd2-4491-a40d-f81b54c68d1e'', ''2099-01-01'')', 'accounting.edit'),
      ('select public.run_ho_cost_allocation(''7f7899a0-edd2-4491-a40d-f81b54c68d1e'', ''2099-01-01'', null)', 'accounting.edit'),
      ('select public.accrue_bonus_reserve(''7f7899a0-edd2-4491-a40d-f81b54c68d1e'', ''2099-01-01'')', 'accounting.edit'),
      ('select public.accrue_attendance_bonuses(''7f7899a0-edd2-4491-a40d-f81b54c68d1e'', ''2099-01-01'', 1)', 'performance.approve'),
      ('select public.accrue_eid_bonuses(''7f7899a0-edd2-4491-a40d-f81b54c68d1e'', ''2099-01-01'', 1)', 'performance.approve'),
      ('select public.reverse_profit_allocation(null)', 'partnership.post')) as x(q, perm)
  loop
    v_msg := null;
    begin
      execute t.q;
      raise exception '0584-SENTINEL';
    exception when others then get stacked diagnostics v_msg = message_text;
    end;
    if v_msg is distinct from format('permission denied: %s required', t.perm) then
      raise exception '0584 REFUSED: as HR, "%" said "%", not the % refusal.', t.q, v_msg, t.perm;
    end if;
  end loop;

  -- the same calls as Shayan are not refused on permission (whatever they do is rolled back)
  perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
  for t in select * from (values
      ('select public.post_manual_journal(null, null, null, null, null, null)'),
      ('select public.run_depreciation(''7f7899a0-edd2-4491-a40d-f81b54c68d1e'', ''2099-01-01'')'),
      ('select public.run_ho_cost_allocation(''7f7899a0-edd2-4491-a40d-f81b54c68d1e'', ''2099-01-01'', null)'),
      ('select public.accrue_bonus_reserve(''7f7899a0-edd2-4491-a40d-f81b54c68d1e'', ''2099-01-01'')'),
      ('select public.accrue_attendance_bonuses(''7f7899a0-edd2-4491-a40d-f81b54c68d1e'', ''2099-01-01'', 1)'),
      ('select public.accrue_eid_bonuses(''7f7899a0-edd2-4491-a40d-f81b54c68d1e'', ''2099-01-01'', 1)'),
      ('select public.reverse_profit_allocation(null)')) as x(q)
  loop
    v_msg := null;
    begin
      execute t.q;
      raise exception '0584-SENTINEL';
    exception when others then get stacked diagnostics v_msg = message_text;
    end;
    if v_msg like 'permission denied%' then
      raise exception '0584 REFUSED: as Shayan, "%" was refused: %', t.q, v_msg;
    end if;
  end loop;
  perform set_config('request.jwt.claims', '', true);

  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0584 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
  if exists (select 1 from public.branch_guard_gaps()
              where function_name in ('post_manual_journal','run_depreciation','run_ho_cost_allocation','accrue_bonus_reserve',
                                      'accrue_attendance_bonuses','accrue_eid_bonuses','reverse_profit_allocation')) then
    raise exception '0584 REFUSED: branch_guard_gaps() reports a gated function.';
  end if;
end $test$;
