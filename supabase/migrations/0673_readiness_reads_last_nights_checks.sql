-- 0673 — partnership_readiness reads last night's checks instead of re-running them.
--
-- FOUND IN THE BROWSER (13 Nov 2026, the same day as 0672). Check 12 called
-- ledger_checks() live. ledger_checks runs every control in the system; inside a
-- signed-in request (statement_timeout 8s for authenticated) the whole
-- readiness call was cancelled, the screen received nothing — and read "all
-- clear". The screen now treats a failed load as "checks did not run, posting
-- off" (same commit); this makes the call fast enough to succeed.
--
-- The nightly job already stores every result in ledger_check_results. Check 12
-- now reads the latest run for the company, and its title says when that run was.
--
-- SURGERY: partnership_readiness has one author (0672), but the change is one
-- clause, so it is amended at two anchors against the live definition, each
-- asserted to appear exactly once, rather than restated.

do $mig$
declare
  v_src text := pg_get_functiondef('public.partnership_readiness(uuid,date)'::regprocedure);
  a1 text := $a$    from public.ledger_checks(p_company_id) lc
   where not lc.passed and lc.check_name in ($a$;
  b1 text := $b$    from public.ledger_check_results lc
   where lc.company_id = p_company_id
     and lc.run_at = (select max(x.run_at) from public.ledger_check_results x where x.company_id = p_company_id)
     and not lc.passed and lc.check_name in ($b$;
  a2 text := $a$case when v_n > 0 then v_n || ' nightly check(s) that touch profit are failing' else 'Nightly checks that touch profit pass' end,$a$;
  b2 text := $b$case when v_n > 0 then v_n || ' nightly check(s) that touch profit are failing' else 'Nightly checks that touch profit pass' end
      || coalesce(' (' || to_char((select max(x.run_at) from public.ledger_check_results x where x.company_id = p_company_id) at time zone 'Asia/Karachi', 'DD Mon HH24:MI') || ')', ' (no nightly run yet)'),$b$;
  n1 int; n2 int;
begin
  if position('from public.ledger_check_results lc' in v_src) > 0 then return; end if;
  n1 := (length(v_src) - length(replace(v_src, a1, ''))) / length(a1);
  n2 := (length(v_src) - length(replace(v_src, a2, ''))) / length(a2);
  if n1 <> 1 or n2 <> 1 then raise exception '0673 REFUSED: anchors found % and % times (expected 1 and 1).', n1, n2; end if;
  execute replace(replace(v_src, a1, b1), a2, b2);
  if position('from public.ledger_check_results lc' in pg_get_functiondef('public.partnership_readiness(uuid,date)'::regprocedure)) = 0 then
    raise exception '0673 FAILED: partnership_readiness was not amended.';
  end if;
end $mig$;

-- Self-test: still twelve checks in order, and it no longer runs the controls.
do $$
declare v_n int; v_keys text;
begin
  if position('ledger_checks(p_company_id)' in pg_get_functiondef('public.partnership_readiness(uuid,date)'::regprocedure)) > 0 then
    raise exception '0673 SELFTEST failed: partnership_readiness still calls ledger_checks live.';
  end if;
  select count(*), string_agg(key, ',' order by seq) into v_n, v_keys
    from public.partnership_readiness('7f7899a0-edd2-4491-a40d-f81b54c68d1e', '2026-10-01');
  if v_n <> 12 or v_keys <> 'prev_posted,draft_current,cash_ties_out,partner_setup,receipts_no_client,inet_in_transit,uninvoiced,banks_reconciled,unpaid_payslips,expense_requests,open_cheques,ledger_checks' then
    raise exception '0673 SELFTEST failed: % checks: %', v_n, v_keys;
  end if;
end $$;