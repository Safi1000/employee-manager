-- 0301 — twenty-one correct checks that nothing asks are twenty-one functions.
-- Schedule them, and they become twenty-one controls.
--
-- DEV ONLY. Production gets this with the ledger deployment.
--
-- THE ITEM THIS CLOSES
--
-- DETECTOR_INVOCATION_AUDIT's first and largest finding: ledger_checks() is
-- never called by the application and is not scheduled. Every invariant in it
-- — trial balance, AR control, salaries payable, bank and cash controls, the
-- tenant-guard coverage check, the uninvoked-control count, and as of 0300 the
-- delivery health check — executes only when a person runs it by hand.
--
-- Nothing here changes a single check. It changes who asks.
--
-- WHY A SQL FUNCTION AND NOT AN EDGE FUNCTION
--
-- ledger_checks() is SQL and the alerts it raises are SQL. Routing that
-- through HTTP would add a network hop, a deploy step and a second thing that
-- can be missing, for no gain. pg_cron calls it directly.
--
-- ONE ALERT PER FAILING CHECK, NOT ONE PER RUN AND NOT ONE PER COMPANY
--
-- raise_alert deduplicates on (company_id, category, ref_table, ref_id) among
-- open alerts (0295). All these alerts share a category, so the ref_id is what
-- separates them, and it must be STABLE across runs or the dedupe does nothing.
--
-- ref_id := md5(check_name)::uuid
--
-- Deterministic, so tomorrow's run finds today's row and bumps seen_count
-- rather than adding a second. Four standing reds are four rows that age, not
-- four rows a day. ref_table is 'ledger_checks' — there is no table row to
-- point at, and naming the function is more honest than a null that would make
-- every check collide into one alert.
--
-- NO AUTO-CLOSE, decided explicitly. A check that goes green leaves its alert
-- open until a person acknowledges or resolves it. Closing it automatically
-- would erase the only evidence that it was ever red, and the fact that
-- something was broken for a week is not cancelled by it being fixed.
--
-- THE JOB MUST BE ABLE TO DETECT ITS OWN ABSENCE
--
-- A scheduled job that silently stops is exactly the failure 0300 was written
-- against, and introducing one in the change that closes it would be perverse.
-- So the run records a notification_deliveries row — the same table, watched by
-- the same alert_delivery_gaps() — under a new 'in_app' channel.
--
-- The two channels need different rules, and the difference is the point:
--
--   email   'skipped' (nothing was due) is NOT success. The transport was
--           never exercised, so a quiet day must not make a dead sender look
--           healthy.
--   in_app  a run that found nothing red IS success. The job did its work;
--           there was simply nothing to raise. Requiring a red row to prove
--           the job runs would mean a healthy system looks like a stopped one.
--
-- Same table, same watchdog, opposite treatment of "nothing happened", because
-- in one case nothing happened to the mechanism and in the other the mechanism
-- ran and found nothing.
--
-- AND A SECOND, INDEPENDENT WATCHDOG, FOR FREE
--
-- run_scheduled_ledger_checks contains 'check' in its name, so
-- uninvoked_controls() treats it as a control. Its only caller is the cron
-- job, and the cron arm matches against cron.job.command for ACTIVE jobs only.
--
-- So if somebody deletes or disables the schedule, this function becomes
-- uninvoked and every_control_is_invoked goes red — through a completely
-- different path from the delivery recency check. Two mechanisms, one
-- unscheduled job, and neither depends on the other noticing.

-- ---------------------------------------------------------------------------
-- The delivery log learns a second channel.
-- ---------------------------------------------------------------------------

alter table public.notification_deliveries
  drop constraint if exists notification_deliveries_channel_check;
alter table public.notification_deliveries
  add constraint notification_deliveries_channel_check
  check (channel in ('email', 'in_app'));

comment on column public.notification_deliveries.channel is
  'email = the compliance digest via Resend. in_app = a scheduled ledger_checks run that raised alerts into the alerts table. They are watched by the same health check but treat "nothing happened" differently — see 0301.';

drop function if exists public.alert_delivery_gaps(uuid);

create function public.alert_delivery_gaps(p_company_id uuid)
returns table(channel text, problem text, detail text, last_seen timestamptz)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_last_success timestamptz;
  v_last_status  text;
  v_last_error   text;
  v_last_at      timestamptz;
  v_recipient    text;
begin
  -- tenant guard [claimed]: p_company_id IS the caller's claim; compared as given (0242)
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  -- ── email ───────────────────────────────────────────────────────────────
  select ns.recipient_email into v_recipient
    from public.notification_settings ns where ns.company_id = p_company_id;

  -- A company with no recipient has not asked for delivery. Reporting it would
  -- fire on every company that never opted in, which is 9.11.
  if coalesce(btrim(v_recipient), '') <> '' then
    select max(d.attempted_at) into v_last_success
      from public.notification_deliveries d
     where d.company_id = p_company_id and d.channel = 'email' and d.status = 'sent';

    -- ONE row, read once. Two queries about "the latest row" are two chances
    -- to pick different rows (0300).
    select d.attempted_at, d.status, d.error
      into v_last_at, v_last_status, v_last_error
      from public.notification_deliveries d
     where d.company_id = p_company_id and d.channel = 'email'
     order by d.attempted_at desc, d.id desc
     limit 1;

    if v_last_status = 'failed' then
      channel := 'email'; problem := 'last_delivery_failed';
      detail := coalesce(v_last_error, '(no error recorded)');
      last_seen := v_last_at; return next;
    elsif v_last_success is null then
      channel := 'email'; problem := 'no_delivery_has_ever_succeeded';
      detail := 'A recipient is configured and no digest has ever been delivered.';
      last_seen := null; return next;
    elsif v_last_success < now() - interval '2 days' then
      channel := 'email'; problem := 'no_recent_delivery';
      detail := 'Last successful digest was ' || to_char(v_last_success, 'YYYY-MM-DD HH24:MI')
             || '. The daily job may not be running.';
      last_seen := v_last_success; return next;
    end if;
  end if;

  -- ── in_app: the scheduled ledger_checks run ─────────────────────────────
  --
  -- No configuration gate. Unlike email, nobody opts into having their
  -- invariants checked; if the schedule exists it should be running for every
  -- company, and if it has never run that IS the finding.
  --
  -- A run that raised nothing counts as SUCCESS here. See the header: for
  -- in_app, "nothing happened" means the mechanism ran and found nothing,
  -- which is the healthy state, not an unexercised transport.
  v_last_success := null; v_last_status := null; v_last_error := null; v_last_at := null;

  select max(d.attempted_at) into v_last_success
    from public.notification_deliveries d
   where d.company_id = p_company_id and d.channel = 'in_app' and d.status = 'sent';

  select d.attempted_at, d.status, d.error
    into v_last_at, v_last_status, v_last_error
    from public.notification_deliveries d
   where d.company_id = p_company_id and d.channel = 'in_app'
   order by d.attempted_at desc, d.id desc
   limit 1;

  if v_last_status = 'failed' then
    channel := 'in_app'; problem := 'last_run_failed';
    detail := coalesce(v_last_error, '(no error recorded)');
    last_seen := v_last_at; return next;
  elsif v_last_success is null then
    channel := 'in_app'; problem := 'ledger_checks_has_never_run';
    detail := 'The scheduled ledger_checks run has not completed for this company.';
    last_seen := null; return next;
  elsif v_last_success < now() - interval '2 days' then
    channel := 'in_app'; problem := 'no_recent_run';
    detail := 'Last scheduled ledger_checks run was ' || to_char(v_last_success, 'YYYY-MM-DD HH24:MI')
           || '. The schedule may have stopped.';
    last_seen := v_last_success; return next;
  end if;
end;
$function$;

comment on function public.alert_delivery_gaps(uuid) is
  'Why alert delivery is unhealthy for this company, empty when it is fine. Watches BOTH channels: the email digest (gated on a configured recipient; a skipped send is not a success) and the scheduled ledger_checks run (no gate; a run that found nothing IS a success). Each arm reports a failed last attempt AND a stale last success — the second is the one no failure row could ever record, because a job that never runs writes nothing. See 0300 and 0301.';

revoke execute on function public.alert_delivery_gaps(uuid) from anon, public;
grant  execute on function public.alert_delivery_gaps(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The scheduled run.
-- ---------------------------------------------------------------------------

create or replace function public.run_scheduled_ledger_checks()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_co      record;
  v_row     record;
  v_raised  int := 0;
  v_reds    int;
  v_err     text;
begin
  for v_co in select c.id, c.name from public.companies c where c.active loop
    begin
      v_reds := 0;

      for v_row in
        select check_name, expected, actual, difference
          from public.ledger_checks(v_co.id)
         where not passed
      loop
        v_reds := v_reds + 1;

        perform public.raise_alert(
          v_co.id,
          'warning',
          'ledger_check_failed',
          'Ledger check ' || v_row.check_name || ' is failing: expected '
            || coalesce(v_row.expected::text, 'null') || ', actual '
            || coalesce(v_row.actual::text, 'null')
            || coalesce(' (difference ' || v_row.difference::text || ')', ''),
          'ledger_checks',
          -- Deterministic per check, so tomorrow's run updates today's alert
          -- instead of adding one. Without this the dedupe key would be
          -- identical for every check and they would collapse into one row.
          md5(v_row.check_name)::uuid,
          null);

        v_raised := v_raised + 1;
      end loop;

      -- A run that raised nothing is still a run, and it is the healthy state.
      insert into public.notification_deliveries
        (company_id, channel, recipient, subject, status, item_count)
      values (v_co.id, 'in_app', null,
              'Scheduled ledger_checks', 'sent', v_reds);

    exception when others then
      -- One company's failure must not stop the others. Record it so the
      -- health check sees it: an exception that only reaches the postgres log
      -- is the silent failure this whole design exists to prevent.
      v_err := sqlerrm;
      begin
        insert into public.notification_deliveries
          (company_id, channel, recipient, subject, status, error, item_count)
        values (v_co.id, 'in_app', null, 'Scheduled ledger_checks', 'failed',
                left(v_err, 500), 0);
      exception when others then
        raise warning 'run_scheduled_ledger_checks: could not record failure for %: %', v_co.id, sqlerrm;
      end;
    end;
  end loop;

  return v_raised;
end;
$function$;

comment on function public.run_scheduled_ledger_checks() is
  'Runs ledger_checks() for every active company and raises a WARNING alert per failing check, deduplicated by md5(check_name) so a standing red ages rather than repeating. Records each run in notification_deliveries (channel in_app) so a stopped schedule is visible to alert_delivery_gaps(). No auto-close: a check going green leaves its alert open for a person. Invoked ONLY by the cron job ledger-checks-daily, which is also what keeps it out of uninvoked_controls() — delete the schedule and every_control_is_invoked goes red. See 0301.';

revoke execute on function public.run_scheduled_ledger_checks() from anon, public, authenticated;
grant  execute on function public.run_scheduled_ledger_checks() to service_role;

-- ---------------------------------------------------------------------------
-- The schedule. 05:00, an hour before send-compliance-alerts-daily at 06:00,
-- so anything raised overnight is in the alerts table before the digest that
-- would carry it goes out.
-- ---------------------------------------------------------------------------

do $sched$
begin
  -- Idempotent: unschedule only if it exists, so a replay does not error on a
  -- job that was never created.
  if exists (select 1 from cron.job where jobname = 'ledger-checks-daily') then
    perform cron.unschedule('ledger-checks-daily');
  end if;

  perform cron.schedule('ledger-checks-daily', '0 5 * * *',
                        'select public.run_scheduled_ledger_checks()');
end
$sched$;

do $verify$
declare
  v_outcome text;
begin
  begin
    declare
      v_co uuid; v_n int; v_raised int; v_first uuid; v_second uuid;
      v_cnt int; v_seen int; v_deliv int;
    begin
      select id into v_co from public.companies order by created_at limit 1;

      -- 1. THE JOB IS SCHEDULED, ACTIVE, AND CALLS THE RIGHT THING. A cron row
      -- naming a function that does not exist would look identical from here
      -- if only the name were checked.
      if not exists (select 1 from cron.job
                      where jobname = 'ledger-checks-daily' and active
                        and command ~ '\mrun_scheduled_ledger_checks\s*\(') then
        raise exception '0301 FAILED: ledger-checks-daily is not scheduled, not active, or does not call run_scheduled_ledger_checks';
      end if;

      -- 2. ledger_checks IS NO LONGER UNINVOKED. This is the check reporting
      -- its own completion — the audit's largest finding closing itself.
      if exists (select 1 from public.uninvoked_controls()
                  where object_name = 'ledger_checks') then
        raise exception '0301 FAILED: ledger_checks is still reported as uninvoked — the invocation detection did not see the new caller';
      end if;

      -- 3. AND SO IS THE RUNNER, BUT ONLY BECAUSE THE CRON JOB EXISTS. Prove
      -- the second watchdog is real by removing the schedule and requiring
      -- the runner to appear as uninvoked, then restoring it.
      if exists (select 1 from public.uninvoked_controls()
                  where object_name = 'run_scheduled_ledger_checks') then
        raise exception '0301 FAILED: the runner is reported uninvoked while its cron job is active';
      end if;

      -- Unschedule rather than UPDATE cron.job: the migration role may call
      -- cron.schedule/unschedule but has no write privilege on the table
      -- itself, which an earlier version of this block discovered the hard way.
      perform cron.unschedule('ledger-checks-daily');
      if not exists (select 1 from public.uninvoked_controls()
                      where object_name = 'run_scheduled_ledger_checks') then
        raise exception '0301 FAILED: removing the schedule did NOT make the runner uninvoked — the second watchdog is vacuous';
      end if;
      perform cron.schedule('ledger-checks-daily', '0 5 * * *',
                            'select public.run_scheduled_ledger_checks()');
      if exists (select 1 from public.uninvoked_controls()
                  where object_name = 'run_scheduled_ledger_checks') then
        raise exception '0301 FAILED: the schedule was restored and the runner is still reported uninvoked';
      end if;

      -- 4. IT RAISES ONE ALERT PER FAILING CHECK.
      select count(*) into v_n from public.ledger_checks(v_co) where not passed;
      v_raised := public.run_scheduled_ledger_checks();

      select count(*) into v_cnt from public.alerts
       where company_id = v_co and category = 'ledger_check_failed';
      if v_cnt <> v_n then
        raise exception '0301 FAILED: % checks are red for this company and % alert(s) were raised', v_n, v_cnt;
      end if;
      if v_n = 0 then
        raise exception '0301 FAILED: no check is red on this company, so the raise path is untested here';
      end if;

      -- 5. A SECOND RUN DOES NOT DOUBLE THEM. This is the dedupe doing the
      -- work it was built for in 0295, and the reason the ref_id is derived
      -- from the check name rather than left null.
      select id into v_first from public.alerts
       where company_id = v_co and category = 'ledger_check_failed'
       order by created_at limit 1;

      perform public.run_scheduled_ledger_checks();

      select count(*) into v_seen from public.alerts
       where company_id = v_co and category = 'ledger_check_failed';
      if v_seen <> v_cnt then
        raise exception '0301 FAILED: a second run took the alerts from % to %', v_cnt, v_seen;
      end if;

      select seen_count into v_seen from public.alerts where id = v_first;
      if v_seen < 2 then
        raise exception '0301 FAILED: seen_count is % after two runs, expected at least 2', v_seen;
      end if;

      -- 6. AND THEY ARE DISTINCT ALERTS, not one row wearing four messages.
      select count(distinct ref_id) into v_cnt from public.alerts
       where company_id = v_co and category = 'ledger_check_failed';
      if v_cnt <> v_n then
        raise exception '0301 FAILED: % red checks produced % distinct ref_ids', v_n, v_cnt;
      end if;

      -- 7. THE RUN IS RECORDED, so a schedule that stops is visible.
      select count(*) into v_deliv from public.notification_deliveries
       where company_id = v_co and channel = 'in_app' and status = 'sent';
      if v_deliv < 2 then
        raise exception '0301 FAILED: two runs recorded % in_app deliveries', v_deliv;
      end if;

      -- 8. AND THE WATCHDOG SEES IT. A fresh run clears the in_app arm; an
      -- aged one brings it back. The second half is the stopped-schedule case,
      -- which no failure row could ever record.
      if exists (select 1 from public.alert_delivery_gaps(v_co) where channel = 'in_app') then
        raise exception '0301 FAILED: a run that just completed is still reported as a delivery gap';
      end if;

      update public.notification_deliveries
         set attempted_at = now() - interval '9 days'
       where company_id = v_co and channel = 'in_app';

      if not exists (select 1 from public.alert_delivery_gaps(v_co)
                      where channel = 'in_app' and problem = 'no_recent_run') then
        raise exception '0301 FAILED: a stale run is not reported — a stopped schedule would be invisible';
      end if;

      -- 9. THE EMAIL ARM STILL BEHAVES. The rewrite must not have lost it.
      delete from public.notification_settings where company_id = v_co;
      if exists (select 1 from public.alert_delivery_gaps(v_co) where channel = 'email') then
        raise exception '0301 FAILED: a company with no recipient is reported on the email arm';
      end if;
      insert into public.notification_settings (company_id, recipient_email)
      values (v_co, 'zz-0301@example.invalid');
      if not exists (select 1 from public.alert_delivery_gaps(v_co)
                      where channel = 'email' and problem = 'no_delivery_has_ever_succeeded') then
        raise exception '0301 FAILED: the email arm no longer reports a configured-but-never-delivered company';
      end if;

      -- 10. THE SUITE AND THE TENANT GUARDS ARE INTACT.
      select count(*) into v_cnt from public.ledger_checks(v_co);
      if v_cnt <> 22 then
        raise exception '0301 FAILED: ledger_checks returned % rows, expected 22', v_cnt;
      end if;
      select count(*) into v_cnt from public.tenant_guard_gaps();
      if v_cnt <> 0 then
        raise exception '0301 FAILED: tenant_guard_gaps() reports % gap(s)', v_cnt;
      end if;

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0301 verification failed: %', v_outcome;
  end if;
end
$verify$;
