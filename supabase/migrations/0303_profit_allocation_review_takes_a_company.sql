-- 0303 — profit_allocation_review has never been called. Make it callable.
--
-- DEV ONLY. Production gets this with the ledger deployment.
--
-- WHAT WAS WRONG, AND WHY IT MATTERS MORE THAN ITS SIZE
--
-- profit_allocation_review's first arm is client_cost_no_invoice: expenses
-- booked against a client with no invoice dated in the period. That is the
-- Palm Grove pattern — contract lapses, client record keeps the date, guards
-- stay on site, cost accrues, nothing bills. It is the only thing in the
-- schema that asks that question, and it has never once run.
--
-- It threw on every invocation. The cause is one line, three functions deep:
--
--   partner_basis_for_report   reads finance_settings for current_company_id()
--   client_statement_loaded    with cid as (select current_company_id())
--   partnership_allocation     with cid as (select current_company_id())
--
-- current_company_id() reads the request JWT. It is NULL under service_role,
-- under pg_cron, in psql and in a migration — every context that is not a
-- logged-in browser session. So the review threw for the scheduler and could
-- only ever have run from a screen that does not exist.
--
-- A CORRECTION TO WHAT I WROTE IN THE VERDICTS DOC
--
-- I said it also failed from a logged-in session because no company had
-- partner_remuneration_basis configured. That is wrong. All four companies on
-- dev and all four on prod have it set to 'cash'. The NULL tenant was the
-- whole cause; I asserted a second one without checking it.
--
-- AND THE PART THAT IS NOT OBVIOUS
--
-- Parameterising partner_basis_for_report alone would have made the function
-- stop throwing — and left three of its four arms reading
-- `where company_id = NULL`, which matches nothing and raises nothing. The
-- review would have returned clean, forever, from a control that looked wired.
-- A function that throws is at least honest about not working. Half this fix
-- is the half that would not have been noticed.
--
-- AND A SECOND ONE, FOUND BY THE VERIFICATION FAILING
--
-- partnership_allocation calls partner_basis_for_report itself, with one
-- argument. The moment that function gained a defaulted company parameter the
-- one-argument call still compiled — and resolved to the default, NULL. So
-- partnership_allocation asked for the basis of no company and raised, under
-- the review that had just been made callable.
--
-- A defaulted parameter converts what would have been a compile-time error
-- into a runtime one, and a runtime error only appears if something asks. The
-- verification asked. That call site is threaded too, and its sibling callers
-- (run_profit_allocation, partner_client_breakdown) deliberately are not:
-- they run from a session and must keep resolving the session's tenant.
--
-- THE SHAPE
--
-- One helper, resolve_company_scope(uuid), used by all three. It returns the
-- session tenant when no company is named, and otherwise returns the named
-- company after passing it through assert_same_company — which returns early
-- for service_role and no-JWT callers and raises 'Row not found' for a
-- logged-in user naming somebody else's company. That guard is not optional:
-- all three functions are SECURITY DEFINER, so an unguarded company parameter
-- on them is a cross-tenant read.
--
-- The parameter is added LAST with a default, so every existing call site
-- keeps working unchanged: four frontend rpc calls to client_statement_loaded
-- (CashFlow, FinancialReports, RegionalScorecard) and three database callers
-- of partnership_allocation (partner_ledger, partner_client_breakdown, and
-- run_profit_allocation, which posts). None of them is edited here. Editing a
-- posting function immediately before deploying the ledger stream is a risk
-- with no reason behind it.
--
-- The bodies are edited by substitution on pg_get_functiondef rather than
-- retyped, so nothing but the named line can change. Each substitution
-- asserts it matched.

-- ---------------------------------------------------------------------------
-- 1. The helper.
-- ---------------------------------------------------------------------------

create or replace function public.resolve_company_scope(p_company_id uuid)
returns uuid
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  -- No company named: behave exactly as before — the session's tenant, which
  -- is NULL for service_role and cron. Callers that pass nothing are the
  -- existing ones and must not change behaviour.
  if p_company_id is null then
    return public.current_company_id();
  end if;

  -- A company was named. assert_same_company returns for trusted backend
  -- callers (no auth.uid(), non-authenticated role) and raises for a
  -- logged-in user naming a company that is not theirs.
  perform public.assert_same_company(p_company_id);
  return p_company_id;
end
$$;

comment on function public.resolve_company_scope(uuid) is
  'Tenant scope for a report that may be run either by a logged-in user (pass null) or by the scheduler on a named company (pass it). Guards the named case with assert_same_company because its callers are SECURITY DEFINER. Added 0303.';

-- ---------------------------------------------------------------------------
-- 2. The three functions gain the parameter.
-- ---------------------------------------------------------------------------

do $patch$
declare
  r          record;
  v_def      text;
  v_new      text;
  v_oldbody  text;
  v_newbody  text;
  v_cut      int;
begin
  for r in
    select *
      from (values
        ('partner_basis_for_report',
         'p_basis text',
         'where fs.company_id = public.current_company_id();',
         'where fs.company_id = public.resolve_company_scope(p_company_id);',
         null, null),
        ('client_statement_loaded',
         'p_start date, p_end date, p_basis text',
         'with cid as (select public.current_company_id() as company_id),',
         'with cid as (select public.resolve_company_scope(p_company_id) as company_id),',
         null, null),
        -- The second pair is the one the first attempt missed. See below.
        ('partnership_allocation',
         'p_start date, p_end date, p_basis text',
         'with cid as (select public.current_company_id() as company_id),',
         'with cid as (select public.resolve_company_scope(p_company_id) as company_id),',
         'cfg as (select public.partner_basis_for_report(p_basis) as basis),',
         'cfg as (select public.partner_basis_for_report(p_basis, p_company_id) as basis),')
      ) as t(fname, ident_args, oldbody, newbody, oldbody2, newbody2)
  loop
    v_oldbody := r.oldbody; v_newbody := r.newbody;

    -- Already done? 0303 must be replayable against a database that has it.
    if not exists (select 1 from pg_proc p
                    where p.pronamespace = 'public'::regnamespace
                      and p.proname = r.fname
                      and pg_get_function_identity_arguments(p.oid) = r.ident_args) then
      raise notice '0303: %(%) not present in its pre-0303 shape, skipping', r.fname, r.ident_args;
      continue;
    end if;

    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname = r.fname
       and pg_get_function_identity_arguments(p.oid) = r.ident_args;

    -- The parameter list is not retyped. Two of the three already carry a
    -- DEFAULT on p_basis, so matching a literal signature failed on the first
    -- attempt; the close of the parameter list is located structurally
    -- instead, as the first ')' immediately before RETURNS.
    v_cut := strpos(v_def, ')' || chr(10) || ' RETURNS');
    if v_cut = 0 then
      raise exception '0303 FAILED: could not locate the end of the parameter list for %', r.fname;
    end if;
    if strpos(v_def, v_oldbody) = 0 then
      raise exception '0303 FAILED: tenant line not found verbatim in % — do not guess', r.fname;
    end if;

    v_new := left(v_def, v_cut - 1)
             || ', p_company_id uuid DEFAULT NULL::uuid'
             || substr(v_def, v_cut);
    v_new := replace(v_new, v_oldbody, v_newbody);

    -- partnership_allocation calls partner_basis_for_report ITSELF, with one
    -- argument. Once that function gained a defaulted company parameter, the
    -- one-argument call kept resolving — to the default, NULL — so
    -- partnership_allocation looked up the basis for no company and raised
    -- 'No partner remuneration basis configured' for every caller, including
    -- the review it sits under. The first run of this migration failed there,
    -- which is the correct outcome and the reason the parameter is threaded
    -- rather than defaulted away: a defaulted parameter turns a compile error
    -- into a runtime one, and the runtime one only surfaces if something asks.
    if r.oldbody2 is not null then
      if strpos(v_new, r.oldbody2) = 0 then
        raise exception '0303 FAILED: second tenant line not found verbatim in % — do not guess', r.fname;
      end if;
      v_new := replace(v_new, r.oldbody2, r.newbody2);
    end if;

    if v_new = v_def then
      raise exception '0303 FAILED: substitution changed nothing in %', r.fname;
    end if;

    -- Drop first: the new signature differs, so CREATE OR REPLACE would leave
    -- an overload behind and every existing three-argument call would become
    -- ambiguous. All three are SECURITY DEFINER sql/plpgsql with no recorded
    -- dependents (checked: pg_depend deptype 'n' = 0 for each).
    execute format('drop function public.%I(%s)', r.fname, r.ident_args);
    execute v_new;
  end loop;
end
$patch$;

-- ---------------------------------------------------------------------------
-- 3. profit_allocation_review threads the company it was already given.
-- ---------------------------------------------------------------------------

do $review$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname = 'profit_allocation_review';

  v_new := v_def;
  v_new := replace(v_new,
    'public.partner_basis_for_report(null)',
    'public.partner_basis_for_report(null, p_company_id)');
  v_new := replace(v_new,
    'public.client_statement_loaded(v_start, v_end, v_basis)',
    'public.client_statement_loaded(v_start, v_end, v_basis, p_company_id)');
  v_new := replace(v_new,
    'public.partnership_allocation(v_start, v_end, v_basis)',
    'public.partnership_allocation(v_start, v_end, v_basis, p_company_id)');

  if v_new = v_def then
    if v_def ~ 'partner_basis_for_report\(null, p_company_id\)' then
      raise notice '0303: profit_allocation_review already threads the company';
      return;
    end if;
    raise exception '0303 FAILED: none of the three call sites matched in profit_allocation_review';
  end if;

  -- All three must have moved. Two out of three is the shape of the defect
  -- this migration is fixing — a partial parameterisation that reads NULL.
  if v_new !~ 'partner_basis_for_report\(null, p_company_id\)'
     or v_new !~ 'client_statement_loaded\(v_start, v_end, v_basis, p_company_id\)'
     or v_new !~ 'partnership_allocation\(v_start, v_end, v_basis, p_company_id\)' then
    raise exception '0303 FAILED: only some call sites were threaded — that is the original bug, not a fix';
  end if;

  execute v_new;
end
$review$;

-- ---------------------------------------------------------------------------
-- 4. Verification.
-- ---------------------------------------------------------------------------

do $verify$
declare
  v_outcome text;
begin
  begin
    declare
      v_co      uuid;
      v_period  date := (date_trunc('month', current_date) - interval '1 month')::date;
      v_bad     int;
      v_hit     int;
      v_cl      uuid;
      v_br      uuid;
      v_basis   text;
    begin
      -- 1. THE CONTEXT IT HAS NEVER SURVIVED. This block runs with no JWT, so
      -- current_company_id() is NULL here exactly as it is under pg_cron.
      if public.current_company_id() is not null then
        raise exception '0303 FAILED: this migration is running with a tenant identity, so it cannot prove the cron case';
      end if;

      -- 2. IT NO LONGER THROWS, ON EVERY COMPANY. Before this migration each
      -- of these raised 23502 'No partner remuneration basis configured'.
      for v_co in select id from public.companies loop
        perform * from public.profit_allocation_review(v_co, v_period);
      end loop;

      -- 3. THE BASIS RESOLVES PER COMPANY, not from a session.
      select id into v_co from public.companies order by created_at limit 1;
      v_basis := public.partner_basis_for_report(null, v_co);
      if v_basis is null then
        raise exception '0303 FAILED: partner_basis_for_report returned null for a company that has a basis';
      end if;

      -- 4. THE OLD CALL SHAPES STILL RESOLVE, AND STILL BEHAVE AS BEFORE.
      -- Four frontend rpc calls pass three arguments to
      -- client_statement_loaded; if the default were missing they would 404 at
      -- runtime and nothing here would have noticed.
      perform * from public.client_statement_loaded(v_period, v_period, 'revenue');

      -- partnership_allocation is the opposite case and the distinction is the
      -- point. Called with no company it resolves the session tenant, which is
      -- NULL here, and raises exactly as it always has. Asserting that it
      -- STILL raises is what proves the default did not quietly widen the
      -- three-argument call — the call run_profit_allocation makes when it
      -- posts.
      begin
        perform * from public.partnership_allocation(v_period, v_period, 'cash');
        raise exception '0303 FAILED: the three-argument partnership_allocation no longer raises without a tenant — the default changed its behaviour';
      exception
        when sqlstate '23502' then null;   -- 'No partner remuneration basis configured'
      end;

      -- And with a company named it runs, in this same no-tenant context.
      perform * from public.partnership_allocation(v_period, v_period, 'cash', v_co);

      -- 5. NON-VACUITY, AND IT IS THE POINT OF THE MIGRATION. A parameterised
      -- function that returns nothing looks identical to the broken one. Plant
      -- the Palm Grove shape — cost against a client with no invoice in the
      -- period — and require arm (a) to name it.
      select branch_id into v_br from public.employees
       where company_id = v_co and branch_id is not null limit 1;

      insert into public.clients (company_id, branch_id, name)
      values (v_co, v_br, 'ZZ 0303 PROBE CLIENT')
      returning id into v_cl;

      -- payment_mode 'Bank', not 'Cash': expenses_cash_names_a_location
      -- requires a custodian location for Cash, and the probe has none.
      insert into public.expenses (company_id, branch_id, client_id,
                                   amount, expense_date, description, payment_mode)
      values (v_co, v_br, v_cl, 4242.42, v_period,
              '0303 probe — cost with no invoice', 'Bank');

      select count(*) into v_hit
        from public.profit_allocation_review(v_co, v_period)
       where kind = 'client_cost_no_invoice' and subject_id = v_cl;

      if v_hit <> 1 then
        raise exception '0303 FAILED: the review did not find a client with cost and no invoice (% rows) — it is callable but not looking', v_hit;
      end if;

      -- 6. AND IT IS NOT MERELY ECHOING ITS INPUT: the same client stops being
      -- reported once an invoice exists in the period. Without this, arm (a)
      -- could be reporting every client with an expense.
      insert into public.invoices (company_id, branch_id, client_id, invoice_number,
                                   invoice_date, period_start, period_end,
                                   invoice_amount, status)
      values (v_co, v_br, v_cl, 'ZZ-0303-PROBE', v_period, v_period,
              (date_trunc('month', v_period) + interval '1 month - 1 day')::date,
              4242.42, 'Pending');

      select count(*) into v_hit
        from public.profit_allocation_review(v_co, v_period)
       where kind = 'client_cost_no_invoice' and subject_id = v_cl;

      if v_hit <> 0 then
        raise exception '0303 FAILED: the review still reports the client after an invoice was raised — it is not testing the invoice';
      end if;

      -- 7. THE HELPER'S TWO BRANCHES.
      if public.resolve_company_scope(null) is not null then
        raise exception '0303 FAILED: resolve_company_scope(null) should be the session tenant, which is null here';
      end if;
      if public.resolve_company_scope(v_co) <> v_co then
        raise exception '0303 FAILED: resolve_company_scope did not return the named company for a trusted caller';
      end if;

      -- 8. NO SIGNATURE WAS LEFT BEHIND. An overload would make every existing
      -- three-argument call ambiguous at runtime and green here.
      select count(*) into v_bad from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and p.proname in ('partner_basis_for_report', 'client_statement_loaded', 'partnership_allocation');
      if v_bad <> 3 then
        raise exception '0303 FAILED: expected exactly 3 functions, found % — an overload survived the drop', v_bad;
      end if;

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0303 verification failed: %', v_outcome;
  end if;
end
$verify$;
