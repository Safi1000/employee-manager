-- 0294 — uninvoked_controls() can only see functions, so it cannot see the
-- defect that started this. Extend it to views.
--
-- DEV ONLY. Production gets this with the ledger deployment.
--
-- WHY THIS IS THE OBVIOUS GAP AND WAS STILL MISSED
--
-- 0288 built a control that counts uninvoked controls, precisely so that "a
-- detector nothing calls" would stop being something a person had to notice.
-- It examines pg_proc. It cannot examine a view.
--
-- compliance_upcoming was a view that NOTHING read — not the database, not the
-- application, not a script — for its entire existence, and the check written
-- to find exactly that class of object could not see it. The audit found it by
-- hand; the audit's own automation would not have.
--
-- WHAT "INVOKED" MEANS FOR A VIEW, AND THE LIMIT THAT MATTERS
--
-- For a function, the honest reachability question is answerable in SQL: other
-- function bodies, view definitions, policies, constraints, indexes, defaults,
-- triggers, cron. 0288's exempt list already carries the two functions the
-- application calls by RPC, because THIS CHECK CANNOT SEE src/.
--
-- For views that limitation is not an edge case, it is the normal case. A view
-- exists to be selected from by the application. 37 views exist here; 30 have
-- no in-database reader at all, and most of those thirty are perfectly healthy
-- screens.
--
-- So a view with no database reader is UNKNOWN, not uninvoked, and reporting
-- all thirty would be thirty rows of noise — which is how a check gets ignored,
-- which is how it becomes a check nobody reads, which is this whole audit's
-- subject one turn further round.
--
-- The exempt list below therefore is not noise suppression. It is a MAP: each
-- entry names the file that reads that view, established by grep over src/ and
-- supabase/functions/ on 2026-09-01. It has to be maintained by hand, and the
-- verification asserts every entry still names a view that exists, so the list
-- rots loudly rather than quietly.
--
-- WHAT IT FINDS: FOURTEEN VIEWS THAT NOTHING READS
--
--   bonus_reserve_balances            payroll_run_totals
--   cash_control_reconciliation       payslip_reward_breakdown
--   cash_entitlement_reconciliation   trial_balance
--   compliance_weekly_review          vetting_dashboard
--   contract_amendment_history        interregion_balances
--   employee_service_history          journal_lines_regional
--   kpi_department_dashboard          low_stock_items
--
-- trial_balance is the one to look at first. It is the ledger's central
-- report, nothing reads it, and ledger_checks_base computes the debits-equal-
-- credits totals from journal_lines INLINE rather than summing the view. That
-- is the attendance_gate_mode_residue shape again (0289): one rule, two
-- implementations, and the uninvoked copy is where drift accumulates unseen.
-- Not collapsed here — 0289 showed that collapsing naively can silently change
-- a published figure, and this one deserves its own migration.
--
-- Three others are reconciliations — cash_control_reconciliation,
-- cash_entitlement_reconciliation, v_client_billing_reconciliation's two
-- siblings — that exist to be compared against something and are compared
-- against nothing.
--
-- Deciding the fourteen is the same policy call as deciding the five: each is
-- either wired to something that runs, or dropped. This migration does not
-- decide any of them. It makes them visible and countable, which is the part
-- that was missing.

-- ---------------------------------------------------------------------------
-- The signature gains a `kind` column, so a caller can tell a function from a
-- view without parsing the name. Dropped and recreated rather than replaced:
-- the return type changes. Safe because ledger_checks and ledger_checks_base
-- are plpgsql with string bodies, which record no dependency on this function
-- — verified before writing this, not assumed.
-- ---------------------------------------------------------------------------

drop function if exists public.uninvoked_controls();

create function public.uninvoked_controls()
returns table(kind text, object_name text, args text, reason text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with cand as (
    select p.oid, p.proname::text as fname,
           pg_get_function_identity_arguments(p.oid) as fargs
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and (p.proname::text ~ '(gap|check|drift|residue|blocker|completeness|missing|breach|discrepanc|orphan|mismatch|unposted|over_allocated|negative_|invalid|stale|unbalanced|anomal)'
            or (p.proretset and p.proname::text ~ '(_rows|_balances|_held_|_review)'))
       and p.prorettype <> 'trigger'::regtype
  ),
  -- 0288b. Comments are not code. Strip them before asking what calls what.
  src as (
    select q.oid, regexp_replace(q.prosrc, '--[^\n]*', '', 'g') as code
      from pg_proc q where q.pronamespace = 'public'::regnamespace
  ),
  exempt as (
    select * from (values
      ('armed_post_blockers',
       'CALLED BY THE APPLICATION. This check cannot see src/.'),
      ('sweep_ammo_discrepancy_alerts',
       'CALLED BY THE APPLICATION. This check cannot see src/.'),
      ('uninvoked_controls',
       'THIS FUNCTION. Invoked by the ledger check suite; listing itself would be noise.')
    ) as t(fname, why)
  ),
  reach as (
    select c.oid, c.fname, c.fargs,
           -- CALL syntax, in code with comments removed.
           (select count(*) from src s
             where s.oid <> c.oid and s.code ~ ('\m'||c.fname||'\s*\('))              as by_fn,
           (select count(*) from pg_views v
             where v.schemaname='public' and v.definition ~ ('\m'||c.fname||'\s*\(')) as by_view,
           (select count(*) from pg_policy pol
             where pg_get_expr(pol.polqual, pol.polrelid) ~ ('\m'||c.fname||'\s*\(')
                or coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid),'') ~ ('\m'||c.fname||'\s*\(')) as by_policy,
           (select count(*) from pg_constraint k
             where k.contype='c' and pg_get_constraintdef(k.oid) ~ ('\m'||c.fname||'\s*\(')) as by_check,
           (select count(*) from pg_index i
             where pg_get_indexdef(i.indexrelid) ~ ('\m'||c.fname||'\s*\('))          as by_index,
           (select count(*) from pg_attrdef d
             where pg_get_expr(d.adbin, d.adrelid) ~ ('\m'||c.fname||'\s*\('))        as by_default,
           (select count(*) from pg_trigger t where not t.tgisinternal and t.tgfoid = c.oid) as by_trigger,
           (select count(*) from cron.job j where j.active and j.command ~ ('\m'||c.fname||'\s*\(')) as by_cron
      from cand c
  ),

  -- ── 0294. The same question, asked of views. ─────────────────────────────
  --
  -- A view name is matched as a bare identifier, NOT as call syntax: a view is
  -- selected FROM, it is not called. That makes the view arm weaker than the
  -- function arm — a view named in a string literal would count as a reader —
  -- and weaker in the SAFE direction: it over-credits readers, so it can
  -- produce a false negative but not a false alarm. Stated because 9.6 forbids
  -- inferring behaviour from a substring anywhere it is not the actual
  -- question, and here "does anything mention this relation" IS the question.
  views as (
    select v.viewname::text as vname from pg_views v where v.schemaname = 'public'
    union
    select m.matviewname::text from pg_matviews m where m.schemaname = 'public'
  ),
  -- THE MAP. Each entry names the file that reads the view, established by
  -- grep over src/ and supabase/functions/ on 2026-09-01. This check cannot
  -- see src/, so these cannot be verified here — only that the view still
  -- exists, which the migration's verification asserts.
  view_exempt as (
    select * from (values
      ('compliance_jurisdiction_register', 'src/app/pages/super-admin/ComplianceCases.tsx'),
      ('compliance_upcoming',              'Dashboard.tsx and Licences.tsx (0291-0293)'),
      ('dashboard_alerts',                 'src/app/pages/super-admin/Alerts.tsx'),
      ('due_invoice_reminders',            'src/app/pages/super-admin/Receivables.tsx'),
      ('employee_identity_amendments',     'src/app/pages/super-admin/EmployeeManagement.tsx'),
      ('fixed_assets_register',            'src/app/pages/super-admin/Assets.tsx'),
      ('kpi_dashboard',                    'src/app/pages/super-admin/Performance.tsx'),
      ('partner_capital_balances',         'src/app/pages/super-admin/Treasury.tsx'),
      ('regional_pnl_monthly',             'src/app/pages/super-admin/Treasury.tsx'),
      ('regional_receivables_aging',       'src/app/pages/super-admin/Receivables.tsx'),
      ('regional_scorecard',               'src/app/pages/super-admin/RegionalScorecard.tsx'),
      ('reserve_status',                   'src/app/pages/super-admin/Treasury.tsx'),
      ('v_client_billing_reconciliation',  'src/app/pages/super-admin/SitesStrength.tsx'),
      ('v_client_strength_reconciliation', 'EmployeeAssignments.tsx and SitesStrength.tsx'),
      ('vehicle_monthly_cost',             'src/app/pages/super-admin/Assets.tsx'),
      ('warning_alerts',                   'src/app/pages/super-admin/Alerts.tsx')
    ) as t(vname, read_by)
  ),
  view_reach as (
    select v.vname,
           (select count(*) from src s where s.code ~ ('\m'||v.vname||'\M'))          as by_fn,
           (select count(*) from pg_views w
             where w.schemaname='public' and w.viewname <> v.vname
               and w.definition ~ ('\m'||v.vname||'\M'))                             as by_view,
           (select count(*) from pg_matviews w
             where w.schemaname='public' and w.matviewname <> v.vname
               and w.definition ~ ('\m'||v.vname||'\M'))                             as by_mview,
           (select count(*) from pg_policy pol
             where pg_get_expr(pol.polqual, pol.polrelid) ~ ('\m'||v.vname||'\M')
                or coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid),'') ~ ('\m'||v.vname||'\M')) as by_policy,
           (select count(*) from cron.job j where j.active and j.command ~ ('\m'||v.vname||'\M')) as by_cron
      from views v
  )

  select 'function'::text, r.fname, r.fargs,
         'no function, view, policy, constraint, index, default, trigger or cron job CALLS it'
    from reach r
   where r.by_fn + r.by_view + r.by_policy + r.by_check
       + r.by_index + r.by_default + r.by_trigger + r.by_cron = 0
     and not exists (select 1 from exempt e where e.fname = r.fname)

  union all

  select 'view'::text, w.vname, ''::text,
         'no function, view, policy or cron job READS it, and it is not in the map of views the application reads'
    from view_reach w
   where w.by_fn + w.by_view + w.by_mview + w.by_policy + w.by_cron = 0
     and not exists (select 1 from view_exempt e where e.vname = w.vname)

   order by 1, 2;
$function$;

comment on function public.uninvoked_controls() is
  'Controls that exist and that nothing asks. Functions since 0288; VIEWS since 0294, because compliance_upcoming was a view nothing read and the check written to find exactly that could not see it. For views, "invoked" cannot be answered in SQL alone — a view exists to be selected from by the application — so the view exempt list is a MAP naming the file that reads each one, maintained by hand and asserted to name real views. Wired into ledger_checks as every_control_is_invoked.';

revoke execute on function public.uninvoked_controls() from anon, public;
grant  execute on function public.uninvoked_controls() to authenticated, service_role;

do $verify$
declare
  v_outcome text;
begin
  begin
    declare
      v_fn int; v_vw int; v_stale text; v_before int; v_after int;
    begin
      -- 1. THE FUNCTION ARM DID NOT MOVE. Extending to views must not change
      -- what was already reported; six functions before, six after.
      select count(*) into v_fn from public.uninvoked_controls() where kind = 'function';
      if v_fn <> 6 then
        raise exception '0294 FAILED: the function arm reports % rows, expected the 6 that 0288b left', v_fn;
      end if;

      -- 2. THE VIEW ARM FINDS THE FOURTEEN.
      select count(*) into v_vw from public.uninvoked_controls() where kind = 'view';
      if v_vw <> 14 then
        raise exception '0294 FAILED: the view arm reports % views, expected 14 — if a view was added or wired, update this number DELIBERATELY', v_vw;
      end if;

      -- 3. THE MAP IS NOT ROTTEN. Every exempt view must still exist. An entry
      -- naming a dropped view suppresses nothing and misleads the next reader
      -- into thinking a screen reads something that is gone.
      select string_agg(t.vname, ', ') into v_stale
        from (values
          ('compliance_jurisdiction_register'),('compliance_upcoming'),('dashboard_alerts'),
          ('due_invoice_reminders'),('employee_identity_amendments'),('fixed_assets_register'),
          ('kpi_dashboard'),('partner_capital_balances'),('regional_pnl_monthly'),
          ('regional_receivables_aging'),('regional_scorecard'),('reserve_status'),
          ('v_client_billing_reconciliation'),('v_client_strength_reconciliation'),
          ('vehicle_monthly_cost'),('warning_alerts')
        ) as t(vname)
       where not exists (select 1 from pg_views v
                          where v.schemaname='public' and v.viewname = t.vname)
         and not exists (select 1 from pg_matviews m
                          where m.schemaname='public' and m.matviewname = t.vname);
      if v_stale is not null then
        raise exception '0294 FAILED: the exempt map names view(s) that do not exist: %', v_stale;
      end if;

      -- 4. THE VIEW ARM CAN GO RED. Create a view nothing reads and require the
      -- count to rise; then have another view read it and require it to fall
      -- back. Both directions, because a check that only ever counts up is
      -- indistinguishable from one that counts wrong.
      select count(*) into v_before from public.uninvoked_controls() where kind = 'view';

      execute 'create view public.zz_0294_probe as select 1 as n';
      select count(*) into v_after from public.uninvoked_controls() where kind = 'view';
      if v_after <> v_before + 1 then
        raise exception 'PROBE INSENSITIVE: added an unread view and the view arm went from % to %', v_before, v_after;
      end if;

      execute 'create view public.zz_0294_reader as select n from public.zz_0294_probe';
      select count(*) into v_after from public.uninvoked_controls() where kind = 'view';
      -- The probe is now read by the reader; the reader is read by nothing. Net
      -- unchanged, and the row that remains must be the READER, not the probe.
      if v_after <> v_before + 1 then
        raise exception 'PROBE INSENSITIVE: with a reader in place the view arm reported % (was %)', v_after, v_before;
      end if;
      if exists (select 1 from public.uninvoked_controls()
                  where kind = 'view' and object_name = 'zz_0294_probe') then
        raise exception '0294 FAILED: a view that another view selects from is still reported as unread';
      end if;
      if not exists (select 1 from public.uninvoked_controls()
                      where kind = 'view' and object_name = 'zz_0294_reader') then
        raise exception '0294 FAILED: the reading view, which nothing reads, was not reported';
      end if;

      execute 'drop view public.zz_0294_reader';
      execute 'drop view public.zz_0294_probe';
      select count(*) into v_after from public.uninvoked_controls() where kind = 'view';
      if v_after <> v_before then
        raise exception 'PROBE DID NOT RESTORE: view arm is %, was %', v_after, v_before;
      end if;

      -- 5. STILL WIRED. ledger_checks counts rows from this function, so the
      -- new rows must reach it rather than sitting in a function nobody asks —
      -- which would be this audit's own subject, one level further out.
      if not exists (
        select 1 from public.ledger_checks((select id from public.companies order by created_at limit 1))
         where check_name = 'every_control_is_invoked' and actual = (v_fn + v_vw)::numeric
      ) then
        raise exception '0294 FAILED: ledger_checks does not report % for every_control_is_invoked', v_fn + v_vw;
      end if;

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0294 verification failed: %', v_outcome;
  end if;
end
$verify$;
