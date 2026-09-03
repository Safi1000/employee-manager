-- 0362 — the posting deadline reaches the calendar, and the reminder predicate
--        reaches the people it is a reminder for.
--
-- 0358 built partnership_posting_deadline() and is_invoice_reminder_day() and
-- left both callable by nothing. A deadline nobody is told about is a comment,
-- and a reminder predicate nothing sends is a fact about the calendar. This
-- migration does the wiring; the edge function does the sending.
--
-- ===========================================================================
-- WHY important_dates AND NOT A NEW TABLE, AND NOT compliance_cases
-- ===========================================================================
--
-- The obvious move is a new arm on compliance_upcoming, the view 0291 made THE
-- source of truth for "what is due or overdue". It is the wrong move twice
-- over. The view is a view — amending it means restating its whole body, which
-- is the class of edit that cost this project 0286, 0288 and 0318 — and it
-- already carries an arm reading important_dates. Writing a row instead of a
-- union arm gets the same visibility with no restatement at all.
--
-- compliance_cases was the other candidate and is a worse fit: its case_type
-- enum is licence / renewal / noc / registration / other, its stages are a
-- filing machine (not_started -> submitted -> verification -> follow_up ->
-- issued), and it carries a jurisdiction. A partnership run has no authority
-- to file with. Forcing it in would mean 'other' + 'other' + a stage machine
-- that does not describe it, and every compliance screen would then be listing
-- an internal accounting deadline among statutory filings.
--
-- important_dates is exactly what this is: a date the company must hit, with a
-- notice window. It already reaches compliance_upcoming (kind
-- 'important_date') AND send-compliance-alerts (its first collection arm), so
-- one row buys both the calendar and the email.
--
-- ===========================================================================
-- THE ROW IS MAINTAINED, NOT ACCUMULATED
-- ===========================================================================
--
-- One row per company per allocated month, keyed by its title, and it is
-- DELETED the moment the run reaches POSTED — by trigger, not by waiting for
-- the next monthly job. A calendar that still shows a deadline for work that
-- is done teaches people to ignore the calendar.

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'important_dates'
       and column_name = 'company_id') then
    raise exception
      '0362 REFUSED: important_dates has no company_id column. This migration writes per-company calendar rows and would otherwise write rows visible to every tenant.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The title is the key. Stated in one place so the writer and the remover
-- cannot drift apart — which is how the last duplicate-calendar-entry defect
-- happened (0291's header: the same item entered four times at four windows).
-- ---------------------------------------------------------------------------
create or replace function public.partnership_deadline_title(p_period date)
returns text
language sql
immutable
as $fn$
  select 'Partnership run — ' || to_char(date_trunc('month', p_period), 'Mon YYYY')
      || ' must be posted';
$fn$;

comment on function public.partnership_deadline_title(date) is
  '0362: the exact title of the calendar row for a month''s partnership posting deadline. One definition, because the row is found by its title and a writer and a remover that disagree leave the calendar showing work that is done.';

-- ---------------------------------------------------------------------------
-- Put the deadline on the calendar, take it off when it is met.
-- ---------------------------------------------------------------------------
create or replace function public.sync_partnership_posting_date(
  p_company_id uuid, p_period date)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_month date := date_trunc('month', p_period)::date;
  v_title text := public.partnership_deadline_title(v_month);
  d       record;
begin
  -- tenant guard [claimed, 0287]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  select * into d
    from public.partnership_posting_deadline(p_company_id, v_month) limit 1;

  -- No deadline configured, or the run is already posted: the calendar should
  -- carry nothing. Deleting unconditionally covers the case where the day was
  -- configured, a row was raised, and the setting was then cleared.
  if not found or d.posted then
    delete from public.important_dates
     where company_id = p_company_id and title = v_title;
    return false;
  end if;

  update public.important_dates
     set due_date = d.due_date,
         category = 'Other',
         priority = case when d.days_late > 0 then 'critical' else 'high' end,
         advance_notice_days = 7
   where company_id = p_company_id and title = v_title;

  if not found then
    insert into public.important_dates
      (company_id, title, due_date, category, priority, advance_notice_days, notes)
    values (p_company_id, v_title, d.due_date, 'Other',
            case when d.days_late > 0 then 'critical' else 'high' end, 7,
            'Raised and removed automatically by sync_partnership_posting_date (0362). It disappears when the run for this month is POSTED. Editing it by hand will be overwritten.');
  end if;

  return true;
end;
$fn$;

comment on function public.sync_partnership_posting_date(uuid, date) is
  '0362: raises, updates or removes the calendar row for one month''s partnership posting deadline. Returns true if a deadline is now on the calendar. Removes the row when the run is POSTED or when no posting day is configured — a calendar showing work that is done is a calendar people learn to ignore.';

revoke execute on function public.sync_partnership_posting_date(uuid, date) from public, anon;
grant execute on function public.sync_partnership_posting_date(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- The moment the run is posted, the deadline stops being a deadline.
-- ---------------------------------------------------------------------------
create or replace function public.clear_partnership_deadline_on_post()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  -- Both directions. A REVERSED run puts the deadline back, because the month
  -- is unallocated again and that is exactly when somebody needs telling.
  perform public.sync_partnership_posting_date(new.company_id, new.period_month);
  return new;
end;
$fn$;

drop trigger if exists trg_partnership_deadline_sync on public.profit_allocation_runs;
create trigger trg_partnership_deadline_sync
  after insert or update of status on public.profit_allocation_runs
  for each row execute function public.clear_partnership_deadline_on_post();

comment on function public.clear_partnership_deadline_on_post() is
  '0362: keeps the calendar row in step with the run''s status. Posting removes it; reversing puts it back, because a reversed month is an unallocated month.';

-- ---------------------------------------------------------------------------
-- The monthly loop raises next month's deadlines. Surgery on 0350's loop — one
-- author, but surgery is what the file costs either way and it cannot drop
-- what it does not read.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def  text;
  v_new  text;
  v_hits int;
  a_loop text := '  end loop;';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'run_monthly_ledger_jobs';
  if v_def is null then raise exception '0362 REFUSED: run_monthly_ledger_jobs does not exist.'; end if;

  v_hits := (length(v_def) - length(replace(v_def, a_loop, ''))) / length(a_loop);
  if v_hits <> 1 then
    raise exception '0362 REFUSED: the loop anchor appears % time(s) in run_monthly_ledger_jobs, expected 1.', v_hits;
  end if;

  v_new := replace(v_def, a_loop,
    '    -- 0362: the deadline for the month just ENDED. The job runs on the 1st,' || chr(10) ||
    '    -- and the month that now needs a posting deadline is the previous one.' || chr(10) ||
    '    begin' || chr(10) ||
    '      perform public.sync_partnership_posting_date(' || chr(10) ||
    '        r.id, (v_month - interval ''1 month'')::date);' || chr(10) ||
    '    exception when others then' || chr(10) ||
    '      v_fail := v_fail + 1;' || chr(10) ||
    '      v_first := coalesce(v_first, r.name || '' / sync_partnership_posting_date: '' || sqlerrm);' || chr(10) ||
    '      raise warning ''0362: sync_partnership_posting_date failed for % - %'', r.name, sqlerrm;' || chr(10) ||
    '    end;' || chr(10) || chr(10) || a_loop);

  execute v_new;
  raise notice '0362: run_monthly_ledger_jobs now raises the previous month''s posting deadline.';
end $$;

-- ---------------------------------------------------------------------------
-- What the alert sender needs, in one call, so the edge function holds no
-- copy of the rule. is_invoice_reminder_day() decides WHETHER; this decides
-- WHAT — and returns nothing on a day that is not a reminder day, so the
-- caller cannot accidentally send on an even day by forgetting to ask.
--
-- THE MONTH IS THE PREVIOUS ONE, ALWAYS. Reminders run in the first days of a
-- month, and what is uninvoiced then is the month that just ended. Reminding
-- somebody on 3 September that September is uninvoiced is noise; September is
-- not billable yet.
-- ---------------------------------------------------------------------------
create or replace function public.invoice_reminder_items(
  p_company_id uuid, p_date date default null)
returns table (
  period_month  date,
  client_name   text,
  contract_code text,
  region_name   text,
  reason        text
)
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
declare
  v_today date := coalesce(p_date, current_date);
  v_month date := (date_trunc('month', v_today) - interval '1 month')::date;
begin
  -- tenant guard [claimed, 0287]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  if not public.is_invoice_reminder_day(v_today) then return; end if;

  return query
  select v_month, u.client_name, u.contract_code, u.region_name, u.reason
    from public.partnership_uninvoiced_clients(p_company_id, v_month) u;
end;
$fn$;

comment on function public.invoice_reminder_items(uuid, date) is
  '0362: what to remind about today, or nothing if today is not a reminder day (1st, 3rd, 5th, then every two days — every odd day, per 0358). Always the PREVIOUS month: reminders run in the first days of a month and what is uninvoiced then is the month that just ended. The sender asks this one question; the cadence rule stays in the database.';

revoke execute on function public.invoice_reminder_items(uuid, date) from public, anon;
grant execute on function public.invoice_reminder_items(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Prove the calendar row appears and disappears, then roll it all back.
-- ---------------------------------------------------------------------------
do $probe$
declare
  v_co    uuid := (select id from public.companies where name = 'GUARDS AND GUIDES (PVT) LTD');
  v_month date := (date_trunc('month', current_date) - interval '1 month')::date;
  v_title text;
  v_had   int;
  v_after int;
  v_msg   text;
begin
  if v_co is null then raise notice '0362: GGS absent; probe skipped.'; return; end if;
  v_title := public.partnership_deadline_title(v_month);

  update public.finance_settings set partnership_posting_day = 10 where company_id = v_co;
  if not found then
    insert into public.finance_settings (company_id, partnership_posting_day) values (v_co, 10);
  end if;

  perform public.sync_partnership_posting_date(v_co, v_month);
  select count(*) into v_had from public.important_dates
   where company_id = v_co and title = v_title;

  -- Now say the month is posted, and the row must go.
  insert into public.profit_allocation_runs (company_id, period_month, status)
  values (v_co, v_month, 'POSTED')
  on conflict (company_id, period_month) do update set status = 'POSTED';

  select count(*) into v_after from public.important_dates
   where company_id = v_co and title = v_title;

  v_msg := 'raised=' || v_had || ' (expected 1), after_posted=' || v_after || ' (expected 0)';

  if v_had <> 1 then
    raise exception '0362 FAILED: the deadline was not raised onto the calendar. %', v_msg;
  end if;
  if v_after <> 0 then
    raise exception '0362 FAILED: the deadline survived the run being posted, so the calendar shows work that is done. %', v_msg;
  end if;

  raise exception 'ROLLBACK_PROBE_0362: %', v_msg;
exception
  when others then
    if sqlerrm like 'ROLLBACK_PROBE_0362:%' then
      raise notice '0362 probe passed and rolled back: %', sqlerrm;
    else
      raise;
    end if;
end;
$probe$;
