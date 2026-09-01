-- 0304 — wire the four controls that are ready, and bump the canary once.
--
-- DEV ONLY. Production gets this with the ledger deployment.
--
-- THE FOUR, AND WHY THESE FOUR
--
-- Each is already built, already correct, and currently quiet on data that
-- would let it speak. That is the 0296/0297 criterion: a control worth wiring
-- is one that is silent today and structurally able to fire.
--
--   cash_forecast_clears_the_floor       first_breach_week(company, 13)
--   cash_control_has_no_direct_postings  cash_control_reconciliation
--   cash_entitlements_equal_pool         cash_entitlement_reconciliation
--   client_cost_has_an_invoice           profit_allocation_review, arm (a)
--
-- Measured on dev immediately before this migration:
--
--   first_breach_week           null, null, null, 2026-08-31 (SANDBOX)
--   cash_control difference     0.00 on all four
--   cash_entitlement difference 0.00 on SANDBOX, NO ROW on the other three
--   client_cost_no_invoice      0 rows on all four
--
-- THE ONE THAT NEEDED A DECISION: NO ROW IS NOT A FAILURE
--
-- cash_entitlement_reconciliation inner-joins entitlements to pool cash, so a
-- company with no cash_entitlements produces no row at all — not a row with a
-- null difference. Three of four companies are in that state. The arm counts
-- rows whose difference is non-zero, so no row counts zero and the check
-- passes. Written the other way round — comparing a scalar difference against
-- zero — it would have read NULL and failed a company that has nothing to
-- reconcile.
--
-- WHAT client_cost_has_an_invoice ACTUALLY COVERS, STATED PLAINLY
--
-- This is the arm that reads on the Palm Grove pattern, and it would not have
-- caught Palm Grove. Arm (a) joins expenses.client_id, and the Palm Grove cost
-- was payroll. On production today NONE of the six expense rows carries a
-- client_id at all, so on prod this check is a rule over a column nothing
-- populates. It is still worth wiring — it is correct, it is free, and the
-- column will be populated — but it is not the Palm Grove check, and calling
-- it that would be the fifth implementation of a question with no data.
--
-- The check that would catch Palm Grove reads deployments against contracts,
-- both of which are populated. It is logged in PRE_GO_LIVE.md and is not
-- built here.
--
-- A PRECONDITION THIS ARM INTRODUCES, AND IT IS DELIBERATE
--
-- profit_allocation_review resolves the partner remuneration basis from
-- finance_settings and raises if the company has none. Wiring it means
-- ledger_checks(company) now raises for a company with no basis rather than
-- returning a green suite about a company it cannot report on. All four
-- companies on dev and all four on prod have one ('cash'). This is recorded
-- as a go-live precondition rather than guarded away: a silent skip here
-- would be a check that reports success on a company it never examined.
--
-- THE CANARY IS READ, NOT ASSUMED
--
-- This migration was written when the suite had 21 real checks, and its first
-- draft moved the canary from a literal 21 to a literal 25. Between writing and
-- deployment, 0318 restored two checks that 0286/0288 had dropped, so on
-- crm-design the number was 23 — and a literal 21 would have aborted this
-- migration on a fact about a database that no longer existed (9.14: a number
-- measured in one database is not a property of the migration).
--
-- So the current value is read out of the function and four is added to it.
-- The +4 is the property of THIS migration — it adds four arms — and the base
-- is a reading, which is where a reading belongs.

do $wire$
declare
  v_oid oid; v_src text; v_new text; v_def text; v_hdr text; v_rest text;
  p1 int; p2 int;
  v_arms text;
  v_n int;
begin
  select p.oid, p.prosrc into v_oid, v_src
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'ledger_checks';

  if v_src ~ 'client_cost_has_an_invoice' then
    raise notice '0304: the four arms are already wired, nothing to do';
    return;
  end if;

  v_arms :=
       E'    union all\n'
    || E'    -- 0304. Does cash stay above the floor across the 13-week horizon?\n'
    || E'    -- first_breach_week returns null when it does, so this is silent on a\n'
    || E'    -- healthy company and names a date on an unhealthy one. The scalar is\n'
    || E'    -- computed ONCE and used three times (0302), not called three times.\n'
    || E'    select ''cash_forecast_clears_the_floor''::text,\n'
    || E'           0::numeric, f.n, f.n, f.n = 0\n'
    || E'      from (select case when public.first_breach_week(p_company_id, 13) is null\n'
    || E'                        then 0 else 1 end::numeric) f (n)\n'
    || E'    union all\n'
    || E'    -- 0304. Nothing may post straight to the Cash control account; every\n'
    || E'    -- posting belongs on a location leaf. 0079 built the view to prove it\n'
    || E'    -- and nothing has ever read it.\n'
    || E'    select ''cash_control_has_no_direct_postings''::text,\n'
    || E'           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0\n'
    || E'      from public.cash_control_reconciliation r\n'
    || E'     where r.company_id = p_company_id and abs(r.difference) > 0.005\n'
    || E'    union all\n'
    || E'    -- 0304. Entitlements must sum to the pool they are claims on.\n'
    || E'    -- COUNTING ROWS, not reading a scalar: a company with no entitlements\n'
    || E'    -- produces no row, and no row means nothing to reconcile, not null.\n'
    || E'    select ''cash_entitlements_equal_pool''::text,\n'
    || E'           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0\n'
    || E'      from public.cash_entitlement_reconciliation r\n'
    || E'     where r.company_id = p_company_id and abs(r.difference) > 0.005\n'
    || E'    union all\n'
    || E'    -- 0304. Cost booked against a client with no invoice in the month.\n'
    || E'    -- Reads expenses.client_id only; see the header for what that does\n'
    || E'    -- and does not cover. Callable per company since 0303.\n'
    || E'    select ''client_cost_has_an_invoice''::text,\n'
    || E'           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0\n'
    || E'      from public.profit_allocation_review(\n'
    || E'             p_company_id,\n'
    || E'             (date_trunc(''month'', current_date) - interval ''1 month'')::date) r\n'
    || E'     where r.kind = ''client_cost_no_invoice''\n';

  -- Insert immediately before the close of the real_checks CTE.
  if strpos(v_src, E'  )\n  select * from real_checks') = 0 then
    raise exception '0304 FAILED: could not find the close of the real_checks CTE — do not guess';
  end if;
  v_new := replace(v_src,
    E'  )\n  select * from real_checks',
    v_arms || E'  )\n  select * from real_checks');

  -- And the canary, in the one place 0302 left it. See the header: the base is
  -- READ, the +4 is this migration's own property.
  v_n := (regexp_match(v_new, 'select (\d+)::numeric n\) e \(n\)'))[1]::int;
  if v_n is null then
    raise exception '0304 FAILED: the canary is not in the single-number shape 0302 left it — do not guess';
  end if;
  v_new := regexp_replace(v_new, 'select \d+::numeric n\) e \(n\)',
                          'select ' || (v_n + 4) || '::numeric n) e (n)');

  if v_new = v_src then
    raise exception '0304 FAILED: substitution changed nothing';
  end if;

  v_def  := pg_get_functiondef(v_oid);
  p1     := strpos(v_def, '$function$');
  v_rest := substr(v_def, p1 + 10);
  p2     := strpos(v_rest, '$function$');
  v_hdr  := left(v_def, p1 - 1);

  execute v_hdr || '$function$' || v_new || '$function$' || substr(v_rest, p2 + 10);
end
$wire$;

do $verify$
declare
  v_outcome text;
begin
  begin
    declare
      v_co uuid; v_rows int; v_bad int; v_uninv int;
      v_period date := (date_trunc('month', current_date) - interval '1 month')::date;
      v_cl uuid; v_br uuid; v_passed boolean; v_exp int;
    begin
      select id into v_co from public.companies order by created_at limit 1;

      -- 1. THE SUITE STILL RUNS, ON EVERY COMPANY, AND THE CANARY AGREES.
      -- Asserting the VERDICT, not the operands — that is what 0301 omitted.
      select count(*) into v_bad
        from public.companies c, lateral public.ledger_checks(c.id) l
       where l.check_name = 'checks_evaluated' and not l.passed;
      if v_bad <> 0 then
        raise exception '0304 FAILED: the canary is red on % compan(ies) — the arm count and the expected number disagree', v_bad;
      end if;

      -- The suite is one row longer than the number of real checks, and the
      -- canary asserted above proves that number is the one the function
      -- intends. A literal here would be a reading of one database (9.14) —
      -- it was 26 when this was written and is 28 after 0318.
      select count(*) into v_rows from public.ledger_checks(v_co);
      select l.expected::int into v_exp from public.ledger_checks(v_co) l
       where l.check_name = 'checks_evaluated';
      if v_rows <> v_exp + 1 then
        raise exception '0304 FAILED: ledger_checks returned % rows for an expected check count of % — the suite carries something other than the canary', v_rows, v_exp;
      end if;

      -- 2. ALL FOUR ARMS ARE PRESENT AND NAMED. A union arm that silently
      -- failed to splice would leave the canary red, which (1) covers — but
      -- naming them catches the subtler case of splicing the wrong four.
      select count(*) into v_bad
        from public.ledger_checks(v_co) l
       where l.check_name in ('cash_forecast_clears_the_floor',
                              'cash_control_has_no_direct_postings',
                              'cash_entitlements_equal_pool',
                              'client_cost_has_an_invoice');
      if v_bad <> 4 then
        raise exception '0304 FAILED: % of the 4 new checks are present', v_bad;
      end if;

      -- 3. THE ENTITLEMENT ARM PASSES ON A COMPANY WITH NO ENTITLEMENTS.
      -- Three of four companies have none. Written as a scalar comparison
      -- this would have read null and failed them.
      for v_co in select c.id from public.companies c
                   where not exists (select 1 from public.cash_entitlements e
                                      where e.company_id = c.id)
      loop
        select l.passed into v_passed from public.ledger_checks(v_co) l
         where l.check_name = 'cash_entitlements_equal_pool';
        if not v_passed then
          raise exception '0304 FAILED: cash_entitlements_equal_pool is red on a company with no entitlements — no row is being read as a failure';
        end if;
      end loop;

      -- 4. THE FORECAST ARM IS NOT UNIFORMLY GREEN. SANDBOX has a real breach
      -- at 2026-08-31; if this arm passed everywhere it would be decoration.
      select count(*) into v_bad
        from public.companies c, lateral public.ledger_checks(c.id) l
       where l.check_name = 'cash_forecast_clears_the_floor' and not l.passed;
      if v_bad = 0 then
        raise exception '0304 FAILED: the forecast arm is green on every company, including the one first_breach_week reports a breach for';
      end if;

      -- 5. NON-VACUITY OF THE COST ARM, PROVED BY MAKING IT FIRE. It is green
      -- on all four companies today, which is indistinguishable from an arm
      -- that cannot fire. Plant the shape and require the CHECK — not the
      -- underlying function — to go red.
      select id into v_co from public.companies order by created_at limit 1;
      select l.passed into v_passed from public.ledger_checks(v_co) l
       where l.check_name = 'client_cost_has_an_invoice';
      if not v_passed then
        raise exception '0304 FAILED: client_cost_has_an_invoice is already red before the probe — the baseline is not clean';
      end if;

      select branch_id into v_br from public.employees
       where company_id = v_co and branch_id is not null limit 1;

      insert into public.clients (company_id, branch_id, name)
      values (v_co, v_br, 'ZZ 0304 PROBE CLIENT') returning id into v_cl;

      insert into public.expenses (company_id, branch_id, client_id,
                                   amount, expense_date, description, payment_mode)
      values (v_co, v_br, v_cl, 9999.99, v_period,
              '0304 probe — cost with no invoice', 'Bank');

      select l.passed into v_passed from public.ledger_checks(v_co) l
       where l.check_name = 'client_cost_has_an_invoice';
      if v_passed then
        raise exception '0304 FAILED: the check stayed green with a client carrying cost and no invoice — it is wired but not looking';
      end if;

      -- 6. AND THE FOUR HAVE LEFT uninvoked_controls(). This is the point of
      -- wiring them, and it is checked here rather than assumed.
      select count(*) into v_uninv
        from public.uninvoked_controls() u
       where u.object_name in ('first_breach_week', 'profit_allocation_review',
                               'cash_control_reconciliation', 'cash_entitlement_reconciliation');
      if v_uninv <> 0 then
        raise exception '0304 FAILED: % of the four are still reported uninvoked', v_uninv;
      end if;

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0304 verification failed: %', v_outcome;
  end if;
end
$verify$;
