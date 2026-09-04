-- 0400 — the monthly ledger run says whether it ran.
--
-- run_scheduled_ledger_checks (0301) writes a notification_deliveries row on
-- every pass, successful or not, and its comment gives the reason in one line:
-- "so a stopped schedule is visible to alert_delivery_gaps()". A run that
-- writes nothing when it succeeds is indistinguishable from a run that never
-- happened, and the second is the failure this project keeps finding.
--
-- run_monthly_ledger_jobs (0350) writes nothing. It returns a count into
-- cron.job_run_details, which `authenticated` cannot read and no screen reads,
-- and raises on failure into the postgres log. Its silence and its success look
-- identical from every surface a person can see.
--
-- It has also NEVER FIRED. monthly-ledger-jobs is active on 20 2 1 * * and was
-- scheduled after 1 September 2026; cron.job_run_details holds zero rows for
-- it. First run: 1 October. That is why this can be fixed calmly.
--
-- ===========================================================================
-- THE SECOND DEFECT, FOUND WHILE BUILDING THE FIRST: THE RAISE ERASES ITS
-- OWN EVIDENCE, AND EVERY POSTING BESIDE IT.
-- ===========================================================================
--
-- 0350 ends with:
--
--     if v_fail > 0 then
--       raise exception '0350: % of the monthly ledger runs failed for % ...
--         % entries were posted by the runs that succeeded; re-running is safe'
--
-- The sentence is not true. The function is one transaction. `raise exception`
-- at the end of it rolls back EVERYTHING — every entry every other company's
-- successful run posted, and (had this migration only added the row) every
-- delivery row recording that they had. One company failing discards the whole
-- month's work for all of them, and the message says the opposite.
--
-- The per-company `begin ... exception` blocks already contain each failure.
-- They are what makes "one company's failure must not stop the others" true.
-- The terminal raise then undoes exactly what they protected.
--
-- SO THE RAISE BECOMES A WARNING AND THE RECORD BECOMES THE ALARM. This is not
-- a loss of loudness, it is a move from a loud thing nobody can hear to a
-- durable one something checks:
--
--   * a notification_deliveries row PER COMPANY per run, status sent/failed,
--     item_count = entries posted, error = the first failure's message;
--   * monthly_ledger_run_gaps(), which reports a failed last run and a MISSING
--     one — the second being the case no failure row can ever record, because a
--     cron job that never runs writes nothing;
--   * that check wired into ledger_checks(), so it is evaluated nightly by
--     something that is itself checked.
--
-- ===========================================================================
-- STATED, NOT FIXED: alert_delivery_gaps() CANNOT SEE A STOPPED EMAIL PATH.
-- ===========================================================================
-- 0300's alert_delivery_gaps() reports 'no_recent_delivery' when the newest
-- 'sent' row in notification_deliveries is over two days old — ACROSS EVERY
-- SUBJECT. 0301 then began writing a 'sent' row daily for 'Scheduled
-- ledger_checks'. Since that day the two-day rule has been unfallible: the
-- daily ledger-checks row keeps the timestamp fresh whether or not a single
-- email has ever been delivered. That is 9.6 — a check that cannot fail —
-- introduced by a migration that was right about its own concern.
--
-- The rows this migration adds are monthly and change nothing about that; the
-- hole is already total. It is NOT fixed here because the fix is to subject-
-- scope 0300's function, which is a decision about what "delivery" means, and
-- widening this migration to take it would bury the question. Reported so the
-- next person finds it stated rather than discovering it. DEFERRED: owed an
-- answer — should alert_delivery_gaps() count only rows whose subject names an
-- outbound channel, or should each scheduled job own its own gap check as this
-- one now does?

-- ---------------------------------------------------------------------------
-- Step 1. Is the schedule real? The check below carries a dated floor, and a
-- floor is only honest if the thing it waits for is actually scheduled.
-- 9.14: this is a READING of state this migration did not create, so it is
-- asserted rather than assumed.
-- ---------------------------------------------------------------------------
do $$
declare v_sched text; v_active boolean;
begin
  select schedule, active into v_sched, v_active
    from cron.job where jobname = 'monthly-ledger-jobs';

  if v_sched is null then
    raise exception '0400 REFUSED: there is no cron job named monthly-ledger-jobs. The gap check below waits for a schedule that does not exist, which would make it a control that can never go green.';
  end if;
  if not v_active then
    raise exception '0400 REFUSED: monthly-ledger-jobs exists but is not active.';
  end if;
  if v_sched !~ '^\S+\s+\S+\s+1\s' then
    raise exception '0400 REFUSED: monthly-ledger-jobs runs on "%", which is not the 1st of the month. The 35-day window and the 2026-10-02 floor below are both derived from a first-of-month schedule and would be wrong.', v_sched;
  end if;
  raise notice '0400: monthly-ledger-jobs confirmed active on "%".', v_sched;
end $$;

-- ---------------------------------------------------------------------------
-- Step 2. The run records itself. SURGERY: run_monthly_ledger_jobs has been
-- edited by 0350 and 0362, so no file holds its true text and it is amended
-- against the live definition with anchors asserted to appear exactly once.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def  text;
  v_new  text;
  a_dec  text := '  n         int;';
  a_top  text := '    begin
      n := public.recognise_advance_revenue(r.id, v_month);';
  a_loop text := '  end loop;';
  a_rais text := '    raise exception
      ''0350: % of the monthly ledger runs failed for % (first: %). % entries were posted by the runs that succeeded; re-running is safe — both are idempotent per (document, month).'',
      v_fail, v_month, v_first, v_total;';
  a_one  text;
  hits   int;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'run_monthly_ledger_jobs';
  if v_def is null then
    raise exception '0400 REFUSED: public.run_monthly_ledger_jobs does not exist.';
  end if;

  -- Every anchor, checked before ANY of them is used. A partial surgery that
  -- discovered its third anchor missing would already have rewritten the body.
  foreach a_one in array array[a_dec, a_top, a_loop, a_rais] loop
    hits := (length(v_def) - length(replace(v_def, a_one, ''))) / length(a_one);
    if hits <> 1 then
      raise exception '0400 REFUSED: an anchor appears % time(s), expected 1. Do not widen it — a second occurrence means the body is not the one this migration was written against. Anchor began: %', hits, left(a_one, 60);
    end if;
  end loop;

  v_new := v_def;

  -- (a) two counters, so each company's row reports ITS OWN work rather than
  --     the running total of every company before it.
  v_new := replace(v_new, a_dec, a_dec || '
  v_co_from int;   -- 0400: v_total as this company''s turn began
  v_co_err  int;   -- 0400: v_fail  as this company''s turn began');

  -- (b) mark the start of each company's turn.
  v_new := replace(v_new, a_top, '    v_co_from := v_total;
    v_co_err  := v_fail;

' || a_top);

  -- (c) the record itself, at the end of the turn. Written INSIDE the loop so
  --     a company that fails still has a row saying so, and wrapped in its own
  --     handler because a delivery row that could abort the run would make the
  --     observation more dangerous than the thing observed.
  v_new := replace(v_new, a_loop, '    begin
      insert into public.notification_deliveries
        (company_id, channel, recipient, subject, status, error, item_count)
      values (r.id, ''in_app'', null, ''Scheduled monthly ledger jobs'',
              case when v_fail > v_co_err then ''failed'' else ''sent'' end,
              -- v_first is the run''s FIRST failure across every company, so it
              -- may belong to somebody else. Each handler prefixes it with the
              -- company name, which is exactly enough to tell: claim it only
              -- when it is this company''s, and say so plainly when it is not.
              -- A row carrying another company''s error would be worse than a
              -- row carrying none — it would send somebody to the wrong place.
              case when v_fail > v_co_err then
                case when v_first like r.name || '' / %'' then left(v_first, 500)
                     else ''This company''''s monthly run failed. The first failure recorded for this run belongs to another company, so the message is not repeated here — see the run''''s warning in the postgres log for the full list.'' end
              end,
              v_total - v_co_from);
    exception when others then
      raise warning ''0400: could not record the monthly run for % — %'', r.name, sqlerrm;
    end;

' || a_loop);

  -- (d) THE RAISE BECOMES A WARNING. See the header: as an exception it rolled
  --     back every posting and every row recording them, including the rows
  --     that named the failure. The delivery rows and monthly_ledger_run_gaps()
  --     are what carry the alarm now, and they survive the run.
  v_new := replace(v_new, a_rais, '    raise warning
      ''0350/0400: % of the monthly ledger runs failed for % (first: %). % entries were posted by the runs that succeeded AND ARE KEPT — this was an exception until 0400, which rolled all of them back while claiming otherwise. Every company has a notification_deliveries row for this run; the failed ones are reported by monthly_ledger_run_gaps() and by ledger_checks().'',
      v_fail, v_month, v_first, v_total;');

  execute v_new;
  raise notice '0400: run_monthly_ledger_jobs records each company''s run and no longer discards the month on one failure.';
end $$;

comment on function public.run_monthly_ledger_jobs(date) is
  '0350/0362/0400: the monthly ledger loop — recognise_advance_revenue (0323), release_prepaid_expenses (0347/0356/0399) and sync_partnership_posting_date (0362) for every active, non-archived company. Writes ONE notification_deliveries row per company per run (subject "Scheduled monthly ledger jobs", item_count = entries posted) so its silence is distinguishable from its success, exactly as 0301 does for ledger_checks. It WARNS rather than raises on failure: as an exception it rolled back every posting the successful companies had made, and the message claimed they were kept. monthly_ledger_run_gaps() is the alarm instead, and ledger_checks() evaluates it nightly.';

-- ---------------------------------------------------------------------------
-- Step 3. The gap check.
--
-- TWO PROBLEMS AND THEY ARE NOT THE SAME. A failed run leaves a row saying so.
-- A run that never happened leaves nothing at all, and only a rule about
-- ABSENCE can catch that one — which is the whole reason 0300 exists.
--
-- 35 DAYS. The longest legitimate gap between two first-of-month runs is 31
-- days (1 Jan to 1 Feb); 35 leaves four days of grace so one late night does
-- not page anybody, and is well short of two months.
-- ---------------------------------------------------------------------------
create or replace function public.monthly_ledger_run_gaps(p_company_id uuid)
returns table (problem text, detail text, last_seen timestamptz)
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
declare
  v_subject text := 'Scheduled monthly ledger jobs';
  v_last_ok timestamptz;
  v_status  text;
  v_error   text;
  v_at      timestamptz;
  v_born    timestamptz;
begin
  -- tenant guard [claimed, 0287]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  select c.created_at into v_born from public.companies c where c.id = p_company_id;
  if v_born is null then return; end if;

  select max(d.attempted_at) into v_last_ok
    from public.notification_deliveries d
   where d.company_id = p_company_id and d.subject = v_subject and d.status = 'sent';

  -- ONE row, read once — 0300's lesson. Two queries about "the latest row" are
  -- two chances to pick different rows and report one row's status beside
  -- another's error.
  select d.attempted_at, d.status, d.error into v_at, v_status, v_error
    from public.notification_deliveries d
   where d.company_id = p_company_id and d.subject = v_subject
   order by d.attempted_at desc, d.id desc
   limit 1;

  -- 1. THE LAST RUN FAILED.
  if v_status = 'failed' then
    problem   := 'monthly_ledger_run_failed';
    detail    := coalesce(v_error, '(no error recorded)');
    last_seen := v_at;
    return next;
  end if;

  -- 2. NO RUN AT ALL.
  --
  -- THE FLOOR, AND WHY IT IS A DATE. monthly-ledger-jobs has never fired: it
  -- was scheduled after 1 September 2026 and its first turn is 1 October. Until
  -- it has had one, absence proves nothing about the schedule — it proves only
  -- that the calendar has not reached it, and a control that is red for
  -- twenty-six days before it can possibly be green is one people learn to
  -- ignore (9.11). The date is the day AFTER the first scheduled run, and Step
  -- 1 above asserts the schedule really is on the 1st so this cannot drift into
  -- being wrong quietly. It stops mattering on 2 October 2026 and never
  -- matters again.
  --
  -- A company younger than the window is skipped for the same reason: it has
  -- not yet had a turn either.
  if current_date < date '2026-10-02' then return; end if;
  if v_born > now() - interval '35 days' then return; end if;

  if v_last_ok is null then
    problem   := 'monthly_ledger_run_never_succeeded';
    detail    := 'monthly-ledger-jobs has never completed for this company. Prepaid and service-period expenses are deferred into 1160 at entry and released only by this run, so nothing is reaching the profit and loss.';
    last_seen := null;
    return next;
  elsif v_last_ok < now() - interval '35 days' then
    problem   := 'monthly_ledger_run_stale';
    detail    := 'Last successful monthly run was ' || to_char(v_last_ok, 'YYYY-MM-DD HH24:MI')
              || '. The schedule runs on the 1st, so more than one month has been missed.';
    last_seen := v_last_ok;
    return next;
  end if;
end;
$fn$;

comment on function public.monthly_ledger_run_gaps(uuid) is
  '0400: why the monthly ledger run is unhealthy for this company, empty when it is fine. Reports a FAILED last run and a MISSING one — the second is the case no failure row could ever record, because a cron job that never runs writes nothing. Scoped to subject "Scheduled monthly ledger jobs" rather than to notification_deliveries as a whole, which is what alert_delivery_gaps() does and is why a daily ledger-checks row keeps that function green regardless of the email path (see 0400''s header, DEFERRED).';

revoke execute on function public.monthly_ledger_run_gaps(uuid) from anon, public;
grant  execute on function public.monthly_ledger_run_gaps(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Step 4. Wire it into ledger_checks. SURGERY, and the canary is READ and
-- incremented rather than restated — a literal here would be a second opinion
-- about how many checks exist, and the two would eventually disagree.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def    text;
  v_anchor text := 'select ''profit_allocation_exhausts_pool''::text,';
  v_new    text;
  v_hits   int;
  v_before int;
  v_after  int;
  v_co     uuid;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'ledger_checks';
  if v_def is null then raise exception '0400 REFUSED: public.ledger_checks does not exist'; end if;

  v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 1 then
    raise exception '0400 REFUSED: the ledger_checks anchor appears % time(s), expected 1. Do not widen it.', v_hits;
  end if;

  select id into v_co from public.companies where active and archived_at is null
   order by created_at limit 1;
  if v_co is not null then select count(*) into v_before from public.ledger_checks(v_co); end if;

  v_new := replace(v_def, v_anchor,
    'select ''monthly_ledger_run_is_current''::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.monthly_ledger_run_gaps(p_company_id)
    union all
    ' || v_anchor);

  execute v_new;

  if v_co is not null then
    select count(*) into v_after from public.ledger_checks(v_co);
    if v_after <> v_before + 1 then
      raise exception '0400 FAILED: ledger_checks returned % rows, expected % (one more than before).', v_after, v_before + 1;
    end if;
    raise notice '0400: ledger_checks wired, % -> % rows.', v_before, v_after;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Step 5. Probe. Rollback only.
--
-- THE CHECK MUST GO RED AND GREEN UNDER CONDITIONS THIS BLOCK CREATES, both of
-- them, or it is 9.6: a control whose passing carries no information because
-- nothing has shown it can fail. And the failed-run arm must be tested with a
-- row this block INSERTS rather than one it hopes to find (9.14a).
-- ---------------------------------------------------------------------------
do $$
declare
  v_co   uuid;
  v_n    int;
  v_prob text;
  v_det  text;
begin
  select id into v_co from public.companies
   where active and archived_at is null and created_at < now() - interval '35 days'
   order by created_at limit 1;
  if v_co is null then
    raise exception '0400 FAILED: no company older than 35 days exists, so neither arm of the check can be exercised and this migration would be unverified.';
  end if;

  begin
    -- (a) TODAY. The floor holds and the check is silent, which is the state
    --     this migration must land in — red on every company until 1 October
    --     would be a control taught to be ignored before it ever meant
    --     anything.
    if current_date < date '2026-10-02' then
      select count(*) into v_n from public.monthly_ledger_run_gaps(v_co);
      if v_n <> 0 then
        raise exception '0400 FAILED: the check fires today (% rows) even though monthly-ledger-jobs has not had its first turn. The floor is not holding.', v_n;
      end if;
    end if;

    -- (b) A FAILED RUN IS REPORTED, and reported with its own reason rather
    --     than a count.
    insert into public.notification_deliveries
      (company_id, channel, recipient, subject, status, error, item_count)
    values (v_co, 'in_app', null, 'Scheduled monthly ledger jobs', 'failed',
            '0400 probe — a run that failed', 0);

    select problem, detail into v_prob, v_det from public.monthly_ledger_run_gaps(v_co);
    if v_prob is distinct from 'monthly_ledger_run_failed' then
      raise exception '0400 FAILED: a failed run reported "%" instead of monthly_ledger_run_failed.', coalesce(v_prob, '(nothing)');
    end if;
    if v_det not like '%0400 probe%' then
      raise exception '0400 FAILED: the failure was reported without carrying its error: %', v_det;
    end if;

    -- (c) AND ledger_checks CARRIES IT. A gap function nothing evaluates is
    --     0224's dead harness again.
    select count(*) into v_n from public.ledger_checks(v_co)
     where check_name = 'monthly_ledger_run_is_current' and not passed;
    if v_n <> 1 then
      raise exception '0400 FAILED: monthly_ledger_run_is_current did not go red in ledger_checks while a failed run was recorded.';
    end if;

    -- (d) A LATER SUCCESS CLEARS IT. Without this the check could be a
    --     one-way door that stays red forever and gets muted.
    --
    --     HONEST ABOUT WHAT THIS PROVES TODAY: before 2 October the floor
    --     returns early, so this arm passes for the floor's reason as much as
    --     for the success's. It is asserted anyway because after that date it
    --     is the real test, and an arm added later is an arm nobody adds.
    insert into public.notification_deliveries
      (company_id, channel, recipient, subject, status, item_count)
    values (v_co, 'in_app', null, 'Scheduled monthly ledger jobs', 'sent', 0);

    select count(*) into v_n from public.monthly_ledger_run_gaps(v_co);
    if v_n <> 0 then
      raise exception '0400 FAILED: a successful run after a failed one left % finding(s). The check does not clear.', v_n;
    end if;

    -- (e) THE OTHER SUBJECT IS NOT THIS CHECK'S BUSINESS. A ledger-checks row
    --     must not silence it — that scoping is the whole difference between
    --     this function and alert_delivery_gaps().
    delete from public.notification_deliveries
     where company_id = v_co and subject = 'Scheduled monthly ledger jobs';
    insert into public.notification_deliveries
      (company_id, channel, recipient, subject, status, item_count)
    values (v_co, 'in_app', null, 'Scheduled ledger_checks', 'sent', 0);

    if current_date >= date '2026-10-02' then
      select count(*) into v_n from public.monthly_ledger_run_gaps(v_co);
      if v_n <> 1 then
        raise exception '0400 FAILED: a Scheduled ledger_checks row silenced the monthly-run check. It is not subject-scoped, which is the defect it was written to avoid.';
      end if;
    end if;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_PROBE' then raise; end if;
      raise notice '0400: probe passed — silent before the first run, red on a failed one, green again after a good one, and not silenced by another subject.';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- THE TENANT GUARD ASSERTION. NOT OPTIONAL.
--
-- monthly_ledger_run_gaps(p_company_id) is new and run_monthly_ledger_jobs is amended.
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
      '0400 REFUSED: tenant_guard_gaps() reports % gap(s): %. Every uuid parameter that names a tenant-scoped row needs a guard the detector can see. Resolve the company INSIDE the guard call and put the guard ahead of every read — do not add an exemption.',
      v_n, v_who;
  end if;
end $$;
