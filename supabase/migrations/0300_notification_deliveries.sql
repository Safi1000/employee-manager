-- 0300 — prove the delivery, not the insert.
--
-- DEV ONLY. Production gets this with the ledger deployment.
--
-- THE FAILURE MODE THIS EXISTS FOR
--
-- send-compliance-alerts already does the hard half correctly: sendViaResend()
-- throws on a non-2xx, and compliance_alert_log is written only AFTER the send
-- returns, so a failed email does not burn the one notice it had.
--
-- What it does not do is tell anyone. The failure surfaces in the function's
-- HTTP response and in console.error. The function is invoked by the cron job
-- send-compliance-alerts-daily at 06:00, and NOTHING READS EITHER. A run that
-- throws every morning for a month looks exactly like a run that had nothing
-- to send.
--
-- That is this project's core failure wearing a new hat: a control that
-- reports success while doing nothing. It is the same shape as
-- tenant_guard_gaps() returning 19 with no caller, and as ledger_checks()
-- being correct and unscheduled.
--
-- TWO FAILURES, NOT ONE, AND THE SECOND IS THE HARDER
--
--   1. The send was attempted and failed.  Resend 403, no API key, no
--      recipient configured, domain unverified.
--   2. The send was never attempted at all. The cron job is disabled,
--      deleted, erroring before it reaches the send, or the function is not
--      deployed.
--
-- Only (1) can write a failure row. (2) writes nothing, and an alerting system
-- that is silent because it is broken is indistinguishable from one that is
-- silent because all is well — unless something asks when it last spoke.
--
-- So the check below is not "were there failures". It is "is there a recent
-- SUCCESS", which goes red for both. A table that only records failures cannot
-- detect its own absence.
--
-- WHAT IS DELIBERATELY NOT HERE
--
-- No escalation, no retry schedule, no severity climb, no auto-close — decided
-- explicitly. A delivery failure stays visible in ledger_checks until a
-- delivery succeeds, and that is the whole behaviour.

create table if not exists public.notification_deliveries (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  channel      text not null,
  recipient    text,
  subject      text,
  status       text not null,
  provider_id  text,
  error        text,
  item_count   integer not null default 0,
  -- clock_timestamp(), NOT now(). now() is transaction-start time, so two
  -- attempts written in one transaction get identical stamps and cannot be
  -- ordered — which is exactly how the first version of this migration's
  -- verification failed. This is an event log; it records when the event
  -- happened, not when the transaction opened.
  attempted_at timestamptz not null default clock_timestamp(),
  constraint notification_deliveries_status_check
    check (status in ('sent', 'failed', 'skipped')),
  constraint notification_deliveries_channel_check
    check (channel in ('email')),
  -- A failed row with no reason is a failure nobody can act on.
  constraint notification_deliveries_failed_has_error
    check (status <> 'failed' or (error is not null and error <> ''))
);

comment on table public.notification_deliveries is
  'Every attempt to deliver a notification, successful or not. Written by send-compliance-alerts on BOTH paths. Exists so a silently failing email path is visible to something that is itself checked — see alert_delivery_gaps() and 0300.';
comment on column public.notification_deliveries.status is
  'sent | failed | skipped. skipped is a deliberate no-op (nothing was due, or no recipient is configured) and is NOT a failure — but it is also not a success, so it does not satisfy the recency check.';
comment on column public.notification_deliveries.provider_id is
  'The message id the provider returned. Its presence is what distinguishes "we called the API and it accepted" from "we think we sent something".';

create index if not exists notification_deliveries_company_time
  on public.notification_deliveries (company_id, attempted_at desc);

alter table public.notification_deliveries enable row level security;

-- Read-only to the tenant; only the service role (the edge function) writes.
drop policy if exists notification_deliveries_select on public.notification_deliveries;
create policy notification_deliveries_select on public.notification_deliveries
  for select to authenticated
  using (company_id = public.current_company_id() or public.is_ssa_unscoped());

-- ---------------------------------------------------------------------------
-- The detector. Returns a row per problem, empty when delivery is healthy.
-- ---------------------------------------------------------------------------

create or replace function public.alert_delivery_gaps(p_company_id uuid)
returns table(problem text, detail text, last_seen timestamptz)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_last_success timestamptz;
  v_last_attempt timestamptz;
  v_last_status  text;
  v_last_error   text;
  v_recipient    text;
begin
  -- tenant guard [claimed]: p_company_id IS the caller's claim; compared as given (0242)
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  select max(attempted_at) into v_last_success
    from public.notification_deliveries
   where company_id = p_company_id and status = 'sent';

  -- ONE row, read once. An earlier version took the timestamp from this
  -- query and the status from a separate EXISTS, which disagreed the moment
  -- two rows shared a stamp: it reported the failure and printed the success
  -- row's (null) error. Two queries about "the latest row" are two chances to
  -- pick different rows.
  select d.attempted_at, d.status, d.error
    into v_last_attempt, v_last_status, v_last_error
    from public.notification_deliveries d
   where d.company_id = p_company_id
   order by d.attempted_at desc, d.id desc
   limit 1;

  select ns.recipient_email into v_recipient
    from public.notification_settings ns where ns.company_id = p_company_id;

  -- A company with no recipient configured is not failing to deliver; it has
  -- not asked for delivery. Reporting it would be noise on every company that
  -- has not opted in, which is how a check earns being ignored (9.11).
  if coalesce(btrim(v_recipient), '') = '' then
    return;
  end if;

  -- 1. THE LAST ATTEMPT FAILED.
  if v_last_status = 'failed' then
    problem   := 'last_delivery_failed';
    detail    := coalesce(v_last_error, '(no error recorded)');
    last_seen := v_last_attempt;
    return next;
  end if;

  -- 2. NOTHING HAS SUCCEEDED RECENTLY. Catches the case no failure row can:
  -- the daily cron not running at all. Two days, because the job is daily and
  -- one missed morning should not page anyone.
  if v_last_success is null then
    problem   := 'no_delivery_has_ever_succeeded';
    detail    := 'A recipient is configured and no notification has ever been delivered.';
    last_seen := null;
    return next;
  elsif v_last_success < now() - interval '2 days' then
    problem   := 'no_recent_delivery';
    detail    := 'Last successful delivery was ' ||
                 to_char(v_last_success, 'YYYY-MM-DD HH24:MI') ||
                 '. The daily job may not be running.';
    last_seen := v_last_success;
    return next;
  end if;
end;
$function$;

comment on function public.alert_delivery_gaps(uuid) is
  'Why notification delivery is unhealthy for this company, empty when it is fine. Reports a failed last attempt AND a stale last success — the second is the one no failure row could ever record, because a cron job that never runs writes nothing. Companies with no recipient configured are silent by choice and are not reported. See 0300.';

revoke execute on function public.alert_delivery_gaps(uuid) from anon, public;
grant  execute on function public.alert_delivery_gaps(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Wire it into ledger_checks. Surgery, per 0289/0299 — restating the function
-- would risk losing a guard or a subtree fix to a copy-paste.
-- ---------------------------------------------------------------------------

do $wire$
declare
  v_oid oid; v_src text; v_new text; v_def text; v_hdr text; v_rest text;
  p1 int; p2 int;
begin
  select p.oid, p.prosrc into v_oid, v_src
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'ledger_checks';

  if v_src ~ 'alert_delivery_gaps' then
    raise notice '0300: already wired, nothing to do';
    return;
  end if;

  v_new := replace(
    v_src,
    E'      from public.uninvoked_controls()\n  )',
    E'      from public.uninvoked_controls()\n'
    || E'    union all\n'
    || E'    -- 0300. Is the alerting mechanism itself delivering? Red when the\n'
    || E'    -- last attempt failed AND when nothing has succeeded lately, the\n'
    || E'    -- second being the failure a cron job that never runs produces.\n'
    || E'    select ''alert_delivery_is_healthy''::text,\n'
    || E'           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0\n'
    || E'      from public.alert_delivery_gaps(p_company_id)\n'
    || E'  )');

  if v_new = v_src then
    raise exception '0300 FAILED: could not find the end of the real_checks CTE — ledger_checks has changed shape, do not guess';
  end if;

  -- The canary counts REAL checks. Bumping it is the deliberate act CLAUDE.md
  -- requires; it must never be edited to make a red row green.
  if v_new !~ '\m20::numeric,' then
    raise exception '0300 FAILED: the checks_evaluated canary is not 20 — do not adjust it blindly';
  end if;
  v_new := regexp_replace(v_new, '\m20::numeric,', '21::numeric,');

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
      v_co uuid; v_rows int; v_n int; v_ok boolean; v_exp numeric;
      v_recip text; v_had_settings boolean;
    begin
      select id into v_co from public.companies order by created_at limit 1;

      -- 1. THE SUITE GREW BY EXACTLY ONE, AND THE CANARY AGREES WITH IT.
      -- ledger_foundation sat dead from 0224 because a suite's silence could
      -- not distinguish "all passed" from "aborted at test 9"; the canary is
      -- what makes that distinguishable, so it has to move with the suite.
      select count(*) into v_rows from public.ledger_checks(v_co);
      if v_rows <> 22 then
        raise exception '0300 FAILED: ledger_checks returned % rows, expected 22 (21 checks + canary)', v_rows;
      end if;
      select expected, actual into v_exp, v_n from public.ledger_checks(v_co)
       where check_name = 'checks_evaluated';
      if v_exp <> 21 or v_n <> 21 then
        raise exception '0300 FAILED: canary says expected % / actual %, both should be 21', v_exp, v_n;
      end if;
      if not exists (select 1 from public.ledger_checks(v_co)
                      where check_name = 'alert_delivery_is_healthy') then
        raise exception '0300 FAILED: the new check is not in the suite';
      end if;

      -- 2. A COMPANY THAT HAS NOT ASKED FOR DELIVERY IS NOT REPORTED. Without
      -- this the check is red on every company that never configured email,
      -- which is a control that fires on every input (9.11).
      delete from public.notification_settings where company_id = v_co;
      if exists (select 1 from public.alert_delivery_gaps(v_co)) then
        raise exception '0300 FAILED: a company with no recipient is reported as a delivery gap';
      end if;

      -- 3. CONFIGURED AND NEVER DELIVERED -> RED. This is the state every
      -- company is in right now, and it is the correct verdict: the mechanism
      -- has never delivered anything.
      insert into public.notification_settings (company_id, recipient_email)
      values (v_co, 'zz-0300@example.invalid');

      select count(*) into v_n from public.alert_delivery_gaps(v_co);
      if v_n <> 1 then
        raise exception '0300 FAILED: configured-but-never-delivered produced % row(s), expected 1', v_n;
      end if;
      if not exists (select 1 from public.alert_delivery_gaps(v_co)
                      where problem = 'no_delivery_has_ever_succeeded') then
        raise exception '0300 FAILED: the never-delivered problem was not the one reported';
      end if;

      -- 4. A RECENT SUCCESS CLEARS IT.
      insert into public.notification_deliveries
        (company_id, channel, recipient, subject, status, provider_id, item_count)
      values (v_co, 'email', 'zz-0300@example.invalid', 'probe', 'sent', 're_probe', 3);

      if exists (select 1 from public.alert_delivery_gaps(v_co)) then
        raise exception '0300 FAILED: a fresh successful delivery did not clear the check';
      end if;

      -- 5. A LATER FAILURE GOES RED AGAIN, and carries the reason. A failure
      -- with no error text is a failure nobody can act on, which the table
      -- constraint also forbids.
      insert into public.notification_deliveries
        (company_id, channel, recipient, subject, status, error, item_count)
      values (v_co, 'email', 'zz-0300@example.invalid', 'probe', 'failed',
              'Resend send failed (status 403): domain not verified', 3);

      if not exists (select 1 from public.alert_delivery_gaps(v_co)
                      where problem = 'last_delivery_failed'
                        and detail like '%403%') then
        raise exception '0300 FAILED: a failed last attempt is not reported with its reason';
      end if;

      -- 6. AND THE LEDGER SUITE FOLLOWS. The detector being right is worth
      -- nothing if the thing that runs does not read it — the whole subject of
      -- DETECTOR_INVOCATION_AUDIT.
      select passed into v_ok from public.ledger_checks(v_co)
       where check_name = 'alert_delivery_is_healthy';
      if v_ok then
        raise exception '0300 FAILED: alert_delivery_gaps reports a problem and ledger_checks says passed';
      end if;

      -- 7. STALENESS, WHICH NO FAILURE ROW COULD RECORD. Age the only success
      -- past the window with no failure present and require the check to speak
      -- anyway: this is the cron-never-ran case.
      delete from public.notification_deliveries
       where company_id = v_co and status = 'failed';
      update public.notification_deliveries
         set attempted_at = now() - interval '9 days'
       where company_id = v_co;

      if not exists (select 1 from public.alert_delivery_gaps(v_co)
                      where problem = 'no_recent_delivery') then
        raise exception '0300 FAILED: a stale last success is not reported — the silent-cron case is undetected';
      end if;

      -- 8. THE DETECTOR IS NOT UNINVOKED. It would be an odd thing to ship a
      -- delivery-watchdog that nothing asks.
      if exists (select 1 from public.uninvoked_controls()
                  where object_name = 'alert_delivery_gaps') then
        raise exception '0300 FAILED: alert_delivery_gaps is reported as uninvoked';
      end if;

      -- 9. THE TENANT GUARDS ARE INTACT.
      select count(*) into v_n from public.tenant_guard_gaps();
      if v_n <> 0 then
        raise exception '0300 FAILED: tenant_guard_gaps() reports % gap(s)', v_n;
      end if;

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0300 verification failed: %', v_outcome;
  end if;
end
$verify$;
