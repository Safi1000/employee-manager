-- 0419: a daily pg_cron job that calls the `send-task-alerts` Edge Function.
--
-- The function announces newly assigned tasks and reminds assignees at 7 / 3 /
-- 1 / 0 days before a due date, to the address each person set on their own
-- task board (`profiles.task_alert_email`, 0418). It de-duplicates against
-- `task_alert_log`, so running this more than once a day sends nothing extra —
-- which is what makes a catch-up run after an outage safe.
--
-- 07:00 UTC = ~12:00 PKT, an hour chosen to NOT collide with
-- send-compliance-alerts at 06:00. Two pg_net calls firing in the same minute
-- is not a problem in itself; two jobs sharing a minute means a slow one delays
-- diagnosis of the other, and there is no reason to pay that for free.
--
-- Requirements, all three shared with 0032 and none created here:
--   1. `pg_net` for outbound HTTP from Postgres.
--   2. A vault secret `service_role_key`. The function reads and writes
--      `task_alert_log` and every user's profile, which no anon key can do.
--   3. RESEND_API_KEY under Edge Functions → Secrets, used by the function.
--
-- THE FUNCTION MUST BE DEPLOYED SEPARATELY. `supabase functions deploy
-- send-task-alerts` is not something a migration can do, and this schedule will
-- happily call a URL that 404s every day without saying so — pg_cron records
-- the job as succeeding because the POST was made, not because it was answered.
-- DEFERRED: nothing in this repo checks that a scheduled function actually
-- exists. The same gap applies to 0032 and has since 0032.

create extension if not exists pg_net with schema extensions;

create or replace function public.invoke_send_task_alerts()
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_service_key text;
  v_request_id  bigint;
begin
  select decrypted_secret
    into v_service_key
    from vault.decrypted_secrets
   where name = 'service_role_key'
   limit 1;

  if v_service_key is null then
    raise exception
      'Vault secret `service_role_key` is missing. Add the Supabase service-role key under Project Settings → Vault before running this job.';
  end if;

  select net.http_post(
    url := 'https://mmkfpnshxjcyijhuydgr.supabase.co/functions/v1/send-task-alerts',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_service_key,
      'Content-Type',  'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  )
  into v_request_id;

  return v_request_id;
end;
$$;

-- Idempotent: drop any prior version of the schedule before adding this one.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'send-task-alerts-daily') then
    perform cron.unschedule('send-task-alerts-daily');
  end if;
end $$;

select cron.schedule(
  'send-task-alerts-daily',
  '0 7 * * *',
  $$select public.invoke_send_task_alerts();$$
);

-- Assert the schedule exists and is active. `cron.schedule` returns a job id
-- rather than raising on a malformed expression in every version, so the job
-- row is the thing to check — and "the job is there" is not the same claim as
-- "the select returned a number".
do $$
declare v_sched text; v_active boolean;
begin
  select schedule, active into v_sched, v_active
    from cron.job where jobname = 'send-task-alerts-daily';
  if v_sched is null then
    raise exception 'REFUSED: send-task-alerts-daily was not scheduled';
  end if;
  if v_sched <> '0 7 * * *' or not v_active then
    raise exception 'REFUSED: send-task-alerts-daily is scheduled % (active=%), expected 0 7 * * * active',
      v_sched, v_active;
  end if;
end $$;

-- TENANT GUARD ASSERTION NOT APPLICABLE: invoke_send_task_alerts() takes no
-- parameters, so it introduces no guard to gap. The detector is asserted anyway
-- — a green run is evidence about the database, not only about this file.
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception 'REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
