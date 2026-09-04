-- 0399 — the release run catches up instead of releasing one named month.
--
-- THE DEFECT. release_prepaid_expenses releases the ONE month it is given.
-- run_monthly_ledger_jobs gives it date_trunc('month', current_date) and the
-- cron job fires on the 1st. So a month is released only if the run happens to
-- fire DURING it, and the run only ever fires on its first day.
--
-- An expense entered on 15 September covering September to February is
-- therefore released for October, November, December, January and February.
-- SEPTEMBER IS NEVER RELEASED. The run never fires mid-month, and nothing goes
-- back for it. stale_prepaid_expenses does not notice until coverage_end has
-- passed — March — and by then five months of P&L have been reported with a
-- sixth of that cost missing from the first of them.
--
-- For a 0356 service period lying wholly inside one month the hole is total:
-- the amount defers into 1160 at entry and nothing ever brings it out.
--
-- 0362 REASONED THIS EXACT POINT AND STOPPED ONE LINE SHORT. It amended this
-- same function's caller, in this same file's neighbourhood, with:
--
--     -- 0362: the deadline for the month just ENDED. The job runs on the 1st,
--     -- and the month that now needs a posting deadline is the previous one.
--
-- and then left `release_prepaid_expenses(r.id, v_month)` on the CURRENT month.
-- Same function, same author, same sitting. The reasoning transferred; the
-- second call site did not. That is the ordinary way this defect happens, and
-- it is why the fix below is a property of the release run itself rather than
-- a correction at one caller — a caller can be forgotten again.
--
-- NOTHING HAS BEEN LOST. monthly-ledger-jobs (20 2 1 * *) was scheduled after
-- 1 September 2026 and has NEVER FIRED: cron.job_run_details holds zero rows
-- for it, and its first run is 1 October. Production carries zero expenses with
-- coverage_start and zero with service_start. There is nothing to repair — only
-- a hole to close before the first one is entered, which the expense form
-- (built the same day as this migration) now makes possible.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
--
-- p_month stops meaning "release this month" and starts meaning "release
-- THROUGH this month". The function finds the earliest month any expense with
-- an unreleased balance begins in, and walks forward to p_month.
--
-- This is safe because the run is ALREADY idempotent per (expense, month) —
-- the guard is the existence of a journal entry whose source_id is the expense
-- and whose entry_date falls in that month. Every month already released is a
-- no-op. That property was built in 0347 for re-running; it is what makes
-- catching up cost nothing.
--
-- It also cannot post ahead of the calendar, because the walk STOPS at p_month
-- and every caller passes the current month or earlier. 0322 remains absolute
-- and is not being worked around here.
--
-- ── WHAT A CLOSED PERIOD DOES, STATED RATHER THAN DISCOVERED ───────────────
--
-- If a month in the walk is closed, post_journal refuses and this function
-- raises with that month named. It does NOT skip and continue: a release that
-- silently omitted a month would be a smaller number reported as success, which
-- is the failure mode this project exists to remove.
--
-- That refusal is not new and this migration does not create it — an expense
-- entered today whose service period covers a month already closed is refused
-- by exactly the same rule today. accounting_periods is empty on production, so
-- nothing can be refused yet.
--
-- ── RESTATED, NOT AMENDED, AND WHY THAT IS ALLOWED HERE ────────────────────
--
-- CLAUDE.md: a function edited by more than one migration has no canonical
-- file. This one has been written twice — 0347 created it and 0356 REPLACED it
-- whole, so 0356's file does hold its complete current text. The permitted
-- shape for that case is a restatement behind a digest precondition, and this
-- migration refuses unless md5(prosrc) is the body it was written against. An
-- unrecognised body means a third edit nobody recorded, which is precisely the
-- case where restating destroys something.

do $$
declare
  v_md5      text;
  v_expected text := 'c0c862083f9fb2035d465ccc17fc4101';
begin
  select md5(prosrc) into v_md5
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'release_prepaid_expenses';

  if v_md5 is null then
    raise exception '0399 REFUSED: public.release_prepaid_expenses does not exist.';
  end if;
  if v_md5 <> v_expected then
    raise exception
      '0399 REFUSED: release_prepaid_expenses has body % , expected % (0356''s text). Somebody edited it after 0356 and this migration would silently discard that edit. Diff the live definition against 0356 before going further; do NOT update the digest to make this pass.',
      v_md5, v_expected;
  end if;
end $$;

create or replace function public.release_prepaid_expenses(p_company_id uuid, p_month date default null)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_through date;
  v_month   date;
  v_from    date;
  v_m_end   date;
  v_posted  int := 0;
  r         record;
  v_months  int;
  v_idx     int;
  v_share   numeric;
  v_done    numeric;
  v_amount  numeric;
  v_days    int;
  v_tot_d   int;
  v_prior   numeric;
  v_cat     text;
  v_key     text;
  v_label   text;
begin
  -- tenant guard [claimed, 0287]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  v_through := date_trunc('month', coalesce(p_month, current_date))::date;

  -- 0399. THE EARLIEST MONTH STILL OWED ANYTHING. Taken from the expenses that
  -- have an unreleased balance, so a company whose schedule is fully up to date
  -- walks exactly one month and this costs nothing. Null means nothing is open:
  -- start at v_through and the loop runs once, which is 0356's behaviour.
  select min(date_trunc('month', coalesce(e.coverage_start, e.service_start))::date)
    into v_from
    from public.expenses e
   where e.company_id = p_company_id
     and (e.coverage_start is not null or e.service_start is not null)
     and e.amount <> coalesce((
       select sum(jl.credit)
         from public.journal_entries je
         join public.journal_lines  jl on jl.journal_entry_id = je.id
         join public.chart_of_accounts a on a.id = jl.account_id
        where je.source_table = 'expenses_prepaid_release'
          and je.source_id = e.id
          and a.system_key = 'prepaid_expenses'), 0);

  if v_from is null or v_from > v_through then v_from := v_through; end if;

  v_month := v_from;
  while v_month <= v_through loop
  v_m_end := (v_month + interval '1 month - 1 day')::date;

  for r in
    select e.*
      from public.expenses e
     where e.company_id = p_company_id
       and (
         -- 0347 shape: month-granular, equal split.
         (e.coverage_start is not null
          and e.coverage_start <= v_month and e.coverage_end >= v_month)
         or
         -- 0356 shape: day-granular, weighted split. The month qualifies when
         -- the service period overlaps it at all.
         (e.service_start is not null
          and e.service_start <= v_m_end and e.service_end >= v_month)
       )
       -- THE IDEMPOTENCE THE CATCH-UP RIDES ON. Every month already released is
       -- filtered out here, so walking back over a settled schedule posts
       -- nothing and the walk is free.
       and not exists (
         select 1 from public.journal_entries je
          where je.company_id = e.company_id
            and je.source_table = 'expenses_prepaid_release'
            and je.source_id = e.id
            and date_trunc('month', je.entry_date)::date = v_month
       )
  loop
    if r.coverage_start is not null then
      -- ---- 0347: equal months, last takes the remainder ----
      v_months := (extract(year from age(r.coverage_end, r.coverage_start)) * 12
                 + extract(month from age(r.coverage_end, r.coverage_start)))::int + 1;
      if v_months < 1 then continue; end if;
      v_idx := (extract(year from age(v_month, r.coverage_start)) * 12
              + extract(month from age(v_month, r.coverage_start)))::int + 1;
      v_share := round(r.amount / v_months, 2);
      if v_idx = v_months then
        v_done   := v_share * (v_months - 1);
        v_amount := r.amount - v_done;
      else
        v_amount := v_share;
      end if;
      v_label := to_char(v_month, 'Mon YYYY') || ' of '
              || to_char(r.coverage_start, 'Mon YYYY') || '–' || to_char(r.coverage_end, 'Mon YYYY');
    else
      -- ---- 0356: weighted by DAYS in this month ----
      v_days  := (least(r.service_end, v_m_end) - greatest(r.service_start, v_month))::int + 1;
      v_tot_d := (r.service_end - r.service_start)::int + 1;
      if v_days <= 0 or v_tot_d <= 0 then continue; end if;

      if v_m_end >= r.service_end then
        -- FINAL month: take whatever has not been released yet, so the schedule
        -- sums to the amount exactly however the daily rounding fell.
        --
        -- 0399 NOTE: this reads what was ACTUALLY posted rather than assuming
        -- the earlier months were, which is exactly why the catch-up is safe to
        -- run in month order. Walk the months out of order and this would take
        -- the whole remaining balance in the first month it saw.
        select coalesce(sum(jl.credit), 0) into v_prior
          from public.journal_entries je
          join public.journal_lines jl on jl.journal_entry_id = je.id
          join public.chart_of_accounts a on a.id = jl.account_id
         where je.source_table = 'expenses_prepaid_release'
           and je.source_id = r.id
           and a.system_key = 'prepaid_expenses';
        v_amount := r.amount - v_prior;
      else
        v_amount := round(r.amount * v_days / v_tot_d, 2);
      end if;
      v_label := to_char(v_month, 'Mon YYYY') || ' — ' || v_days || '/' || v_tot_d || ' days of '
              || to_char(r.service_start, 'DD Mon') || '–' || to_char(r.service_end, 'DD Mon YYYY');
    end if;

    if v_amount = 0 then continue; end if;

    select name into v_cat from public.expense_categories where id = r.category_id;
    v_key := public.map_expense_to_coa_key(coalesce(v_cat, ''), r.pl_category::text, r.client_id);

    perform public.post_journal(
      r.company_id,
      v_m_end,
      coalesce(v_cat, 'Prepaid') || ' — ' || v_label || coalesce(' · ' || r.description, ''),
      'expenses_prepaid_release', r.id, false,
      jsonb_build_array(
        jsonb_build_object('key', v_key,              'debit', v_amount, 'credit', 0),
        jsonb_build_object('key', 'prepaid_expenses', 'debit', 0,        'credit', v_amount)
      ),
      r.branch_id
    );
    v_posted := v_posted + 1;
  end loop;

    v_month := (v_month + interval '1 month')::date;
  end loop;

  return v_posted;
end;
$fn$;

comment on function public.release_prepaid_expenses(uuid, date) is
  '0347/0356/0399: releases every month still owed, UP TO AND INCLUDING p_month — Dr the expense account, Cr Prepaid Expenses. p_month means THROUGH, not ON: before 0399 it released the single month it was given, and since the cron fires on the 1st, any month the run did not happen to fire inside was never released at all. TWO SHAPES, one function: coverage_start/end (0347) splits equally by month above a 50,000 threshold; service_start/end (0356) splits by DAYS. Both idempotent per (expense, month) — which is what makes walking back over a settled schedule free — and both make the final month take the remainder so the schedule sums exactly. The walk stops at p_month, so 0322 still forbids posting into a month nobody has reached. A closed month in the walk raises with that month named rather than being skipped.';

revoke execute on function public.release_prepaid_expenses(uuid, date) from public, anon;
grant execute on function public.release_prepaid_expenses(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- PROBE. Rollback only.
--
-- THE PROBE MUST FAIL AGAINST 0356's BODY, or it is not testing this migration.
-- The old function, asked for one month, releases that month and nothing else;
-- probe 1 below asserts that THREE months come out of a single call naming only
-- the last of them. Against 0356 that assertion reports 1 and the migration
-- refuses. Against 0399 it reports 3.
--
-- The coverage window ends in the CURRENT month deliberately (0347's lesson):
-- 0322 refuses a release into a month nobody has reached, so a probe reaching
-- forward would be refused by the rule rather than by the change under test.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co    uuid;
  v_id    uuid;
  v_n     int;
  v_rel   numeric;
  v_start date := (date_trunc('month', current_date) - interval '2 months')::date;
  v_mid   date := (date_trunc('month', current_date) - interval '1 month')::date;
  v_end   date := date_trunc('month', current_date)::date;
begin
  select id into v_co from public.companies where active and archived_at is null
   order by created_at limit 1;
  if v_co is null then raise notice '0399: no company to probe; skipped.'; return; end if;

  begin
    -- ---- 1. THE DEFECT, REPRODUCED. A prepaid entered mid-window: the run
    --         fires once, in the LAST month of the window, and must nonetheless
    --         release all three.
    insert into public.expenses
      (company_id, amount, expense_date, payment_mode, pl_category, description,
       coverage_start, coverage_end)
    values
      (v_co, 90000, v_start, 'Payable', 'operating_expense',
       '0399 probe — prepaid', v_start, v_end)
    returning id into v_id;

    v_n := public.release_prepaid_expenses(v_co, v_end);
    if v_n <> 3 then
      raise exception '0399 FAILED: one call naming only % released % month(s), expected 3. The run is not catching up.', v_end, v_n;
    end if;

    select coalesce(sum(jl.credit), 0) into v_rel
      from public.journal_entries je
      join public.journal_lines jl on jl.journal_entry_id = je.id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.source_table = 'expenses_prepaid_release' and je.source_id = v_id
       and a.system_key = 'prepaid_expenses';
    if v_rel <> 90000 then
      raise exception '0399 FAILED: the caught-up months released % of 90000.', v_rel;
    end if;

    -- ---- 2. STILL IDEMPOTENT. The catch-up must not re-release what it just
    --         released, or every monthly run would double the P&L.
    v_n := public.release_prepaid_expenses(v_co, v_end);
    if v_n <> 0 then
      raise exception '0399 FAILED: re-running posted % entries. Catching up broke idempotency, which is the property it rides on.', v_n;
    end if;

    -- ---- 3. THE WALK STOPS AT p_month. Asking for the middle month must
    --         release the two up to it and NOT the third — otherwise the run
    --         posts ahead of the calendar the moment 0322 is ever relaxed, and
    --         "through" would silently mean "all".
    --
    -- A SECOND EXPENSE RATHER THAN DELETING THE FIRST ONE'S ENTRIES. Posted
    -- journal rows are not this probe's to remove — app.ledger_maintenance
    -- exists precisely so that deleting them is a deliberate, named act — and a
    -- probe that reached for it would be teaching the wrong habit inside a file
    -- about not silently undoing ledger state.
    insert into public.expenses
      (company_id, amount, expense_date, payment_mode, pl_category, description,
       coverage_start, coverage_end)
    values
      (v_co, 90000, v_start, 'Payable', 'operating_expense',
       '0399 probe — prepaid, released only through the middle month',
       v_start, v_end)
    returning id into v_id;

    v_n := public.release_prepaid_expenses(v_co, v_mid);
    if v_n <> 2 then
      raise exception '0399 FAILED: releasing THROUGH % posted % months, expected 2. The walk does not stop where it was told to.', v_mid, v_n;
    end if;

    -- ---- 4. THE 0356 SHAPE CATCHES UP TOO, and it is the one that was
    --         completely stranded: a service period inside a single past month
    --         deferred into 1160 and nothing ever came back for it.
    insert into public.expenses
      (company_id, amount, expense_date, payment_mode, pl_category, description,
       service_start, service_end)
    values
      (v_co, 10000, current_date, 'Payable', 'operating_expense',
       '0399 probe — stranded service period',
       v_start, (v_start + interval '1 month - 1 day')::date)
    returning id into v_id;

    v_n := public.release_prepaid_expenses(v_co, v_end);
    if v_n < 1 then
      raise exception '0399 FAILED: a service period two months back released nothing. The stranded case is still stranded.';
    end if;

    select coalesce(sum(jl.credit), 0) into v_rel
      from public.journal_entries je
      join public.journal_lines jl on jl.journal_entry_id = je.id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.source_table = 'expenses_prepaid_release' and je.source_id = v_id
       and a.system_key = 'prepaid_expenses';
    if v_rel <> 10000 then
      raise exception '0399 FAILED: the stranded service period released % of 10000.', v_rel;
    end if;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_PROBE' then raise; end if;
      raise notice '0399: probe passed — catches up, stops where told, still idempotent, and unstrands a single-month service period.';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- THE TENANT GUARD ASSERTION. NOT OPTIONAL.
--
-- release_prepaid_expenses is restated here, guard and all — a restatement is exactly where a guard gets dropped without anyone noticing, because the function still exists and still works.
--
-- Asserted against the DETECTOR rather than against a reading of the source.
-- Four guard regressions so far — 0348 fixed two, 0352 one, 0363 the fourth —
-- and every one was a guard that was written correctly and never checked
-- against the thing that has to be able to READ it. Being right is not the
-- same as being verifiable: tenant_guard_covered() matches on the parameter
-- name appearing inside the guard call, so a guard that resolves the company
-- some other way is invisible to it and counts as absent.
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;

  if v_n <> 0 then
    raise exception
      '0399 REFUSED: tenant_guard_gaps() reports % gap(s): %. Every uuid parameter that names a tenant-scoped row needs a guard the detector can see. Resolve the company INSIDE the guard call and put the guard ahead of every read — do not add an exemption.',
      v_n, v_who;
  end if;
end $$;
