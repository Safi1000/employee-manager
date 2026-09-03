-- 0360 — nine call sites that were handed a company and asked the session
--        instead. This is 0359's defect, and 0359 fixed one instance of it.
--
-- ===========================================================================
-- HOW IT WAS FOUND
-- ===========================================================================
--
-- Not by looking for it. The probe in the NEXT migration — which drafts a
-- partnership run to prove the DRAFT state is reachable — aborted with:
--
--   ERROR: No partner remuneration basis configured for this company
--   PL/pgSQL function partner_basis_for_report(text,uuid) line 10
--   PL/pgSQL function run_profit_allocation(uuid,date,text) line 5
--
-- GGS has a basis configured; 0354 established it is 'cash'. The lookup failed
-- because run_profit_allocation calls partner_basis_for_report(p_basis) with
-- ONE argument, and the second — the company — defaults to NULL, which sends
-- resolve_company_scope back to the SESSION. The session in a migration has no
-- tenant claim, so it found nothing.
--
-- Fixing that line moved the failure one line down. Then another. The survey
-- below is what the third failure prompted, and it should have been the first
-- thing 0359 did.
--
-- ===========================================================================
-- THE SURVEY: EVERY FUNCTION WITH A COMPANY PARAMETER, EVERY SCOPED READER
-- ===========================================================================
--
--   run_ho_cost_allocation      ho_apportionment_driver(p_company_id, ...)  x3   ok
--   profit_allocation_review    all four calls pass p_company_id                  ok
--   cash_basis_partnership_mismatch  both calls pass p_company_id                 ok
--   partnership_run_blocker     regional_pl_range(..., p_company_id)              ok
--
--   run_profit_allocation       partner_basis_for_report(p_basis)          x1  SESSION
--                               partnership_allocation(v_month, v_end, v_basis) x4  SESSION
--                               client_statement_loaded(v_month, v_end, v_basis) x1 SESSION
--   partnership_allocation      client_statement_loaded(p_start, p_end, 'cash')    SESSION
--                               client_statement_loaded(p_start, p_end, 'revenue') SESSION
--   partner_client_breakdown    partner_basis_for_report(null)             x1  SESSION
--
-- ===========================================================================
-- WHY THIS IS WORSE THAN 0359, NOT A TIDY-UP AFTER IT
-- ===========================================================================
--
-- 1. run_profit_allocation IS THE FUNCTION THAT DECIDES WHAT EVERY PARTNER IS
--    PAID. It takes a company id. It guards on it with assert_same_company. It
--    then resolves the company SIX MORE TIMES from the session — for the basis,
--    for the allocation it sums the totals from, for the allocation it stores
--    as `outputs`, for the two allocations it loops to build journal lines, and
--    for the client statements it stores as `inputs`. Handed one company and
--    asked about another, it would have posted one company's money against the
--    other's partners, and every assertion inside it would have agreed with
--    itself while doing so.
--
-- 2. partnership_allocation IS THE FUNCTION 0359 FIXED, AND IT IS STILL WRONG.
--    0359 corrected its regional_pl_range call and did not look at its other
--    two readers. Both client_statement_loaded calls are still session-scoped,
--    so under pg_cron they return nothing — which means
--    cash_basis_partnership_mismatch, item 9's check, running nightly under
--    run_scheduled_ledger_checks, WAS ABOUT TO GO BLIND IN EXACTLY THE WAY 0359
--    EXISTS TO HAVE PREVENTED. It reads partnership_allocation, correctly
--    passing p_company_id, and partnership_allocation would have thrown the
--    company away one level down.
--
--    That is the lesson, and it is not "check the callers". It is: FIXING ONE
--    CALL SITE IN A FUNCTION PROVES NOTHING ABOUT THE FUNCTION. 0359 read the
--    line it came for.
--
-- 3. It is invisible in normal use. A browser session has exactly one company,
--    so the argument and the session agree on every screen, every time. The
--    disagreement only appears under cron, under a migration, and under a Super
--    Super Admin viewing another tenant — which is to say, in exactly the
--    situations nobody is watching.
--
-- ===========================================================================
-- HOW IT IS APPLIED
-- ===========================================================================
--
-- All three functions have multiple authors, so every edit is SURGERY against
-- pg_get_functiondef with the occurrence count asserted first. The counts are
-- exact and stated, not "at least one": a call site that has moved or been
-- duplicated since this was written is a thing to stop for, not to widen the
-- anchor around.

-- ---------------------------------------------------------------------------
-- 1. run_profit_allocation — six call sites, one function.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def  text;
  v_new  text;
  v_hits int;
  a_bas  text := 'public.partner_basis_for_report(p_basis)';
  a_all  text := 'public.partnership_allocation(v_month, v_end, v_basis)';
  a_cli  text := 'public.client_statement_loaded(v_month, v_end, v_basis)';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'run_profit_allocation';
  if v_def is null then raise exception '0360 REFUSED: run_profit_allocation does not exist.'; end if;

  v_hits := (length(v_def) - length(replace(v_def, a_bas, ''))) / length(a_bas);
  if v_hits <> 1 then raise exception '0360 REFUSED: partner_basis_for_report anchor appears %, expected 1.', v_hits; end if;

  v_hits := (length(v_def) - length(replace(v_def, a_all, ''))) / length(a_all);
  if v_hits <> 4 then raise exception '0360 REFUSED: partnership_allocation anchor appears %, expected 4.', v_hits; end if;

  v_hits := (length(v_def) - length(replace(v_def, a_cli, ''))) / length(a_cli);
  if v_hits <> 1 then raise exception '0360 REFUSED: client_statement_loaded anchor appears %, expected 1.', v_hits; end if;

  v_new := replace(v_def, a_bas, 'public.partner_basis_for_report(p_basis, p_company_id)');
  v_new := replace(v_new, a_all, 'public.partnership_allocation(v_month, v_end, v_basis, p_company_id)');
  v_new := replace(v_new, a_cli, 'public.client_statement_loaded(v_month, v_end, v_basis, p_company_id)');

  execute v_new;
  raise notice '0360: run_profit_allocation now passes its company to all six readers.';
end $$;

-- ---------------------------------------------------------------------------
-- 2. partnership_allocation — the two readers 0359 did not look at.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def  text;
  v_new  text;
  v_hits int;
  a_cash text := 'public.client_statement_loaded(p_start, p_end, ''cash'')';
  a_rev  text := 'public.client_statement_loaded(p_start, p_end, ''revenue'')';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'partnership_allocation';
  if v_def is null then raise exception '0360 REFUSED: partnership_allocation does not exist.'; end if;

  v_hits := (length(v_def) - length(replace(v_def, a_cash, ''))) / length(a_cash);
  if v_hits <> 1 then raise exception '0360 REFUSED: the cash client_statement_loaded call appears %, expected 1.', v_hits; end if;

  v_hits := (length(v_def) - length(replace(v_def, a_rev, ''))) / length(a_rev);
  if v_hits <> 1 then raise exception '0360 REFUSED: the revenue client_statement_loaded call appears %, expected 1.', v_hits; end if;

  v_new := replace(v_def, a_cash, 'public.client_statement_loaded(p_start, p_end, ''cash'', p_company_id)');
  v_new := replace(v_new, a_rev,  'public.client_statement_loaded(p_start, p_end, ''revenue'', p_company_id)');

  execute v_new;
  raise notice '0360: partnership_allocation now passes its company to both client statements.';
end $$;

-- ---------------------------------------------------------------------------
-- 3. partner_client_breakdown — no company parameter, but it has a PARTNER,
--    and a partner belongs to exactly one company. A [resolved] scope, which is
--    better than a [claimed] one here: the answer cannot depend on who asks.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def  text;
  v_hits int;
  a_bas  text := 'partner_basis_for_report(null)';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'partner_client_breakdown';
  if v_def is null then raise exception '0360 REFUSED: partner_client_breakdown does not exist.'; end if;

  v_hits := (length(v_def) - length(replace(v_def, a_bas, ''))) / length(a_bas);
  if v_hits <> 1 then raise exception '0360 REFUSED: the unscoped basis call appears %, expected 1.', v_hits; end if;

  execute replace(v_def, a_bas,
    'partner_basis_for_report(null, (select company_id from public.partners where id = p_partner_id))');
  raise notice '0360: partner_client_breakdown resolves its basis from the partner, not the session.';
end $$;

-- ---------------------------------------------------------------------------
-- PROVE THE BLINDNESS IS GONE. This session carries no tenant claim, exactly
-- like pg_cron. Before this migration, partnership_allocation answered with
-- nothing here; it must now answer for the company it is handed.
--
-- The assertion is on the BASIS RESOLVING, not on a row count. Row counts
-- depend on data — 0291's probe failed once for exactly that reason — and the
-- thing this migration changed is which company the function looks up.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co    uuid := (select id from public.companies where name = 'GUARDS AND GUIDES (PVT) LTD');
  v_start date := (date_trunc('month', current_date) - interval '1 month')::date;
  v_end   date := (date_trunc('month', current_date) - interval '1 day')::date;
  v_basis text;
  v_n     int;
begin
  if v_co is null then raise notice '0360: GGS absent; probe skipped.'; return; end if;

  -- This is the exact call that raised 23502 before the migration.
  v_basis := public.partner_basis_for_report(null, v_co);
  if v_basis is null then
    raise exception '0360 FAILED: the basis is still unresolvable for a company handed by argument.';
  end if;

  select count(*) into v_n
    from public.partnership_allocation(v_start, v_end, v_basis, v_co);

  raise notice '0360 probe: basis=% resolved with no session claim; partnership_allocation returned % row(s).',
    v_basis, v_n;
end $$;
