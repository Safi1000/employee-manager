-- Schedules a daily pg_cron job that calls the `send-compliance-alerts`
-- Edge Function. The function itself iterates every company with a recipient
-- email configured and sends a Resend digest when there are due alerts.
--
-- Requirements:
--   1. `pg_net` extension for outbound HTTP from Postgres.
--   2. A vault secret named `service_role_key` holding the Supabase service-
--      role key (used as the Authorization bearer when invoking the function).
--      Add it once in the Supabase dashboard under Project Settings → Vault.
--   3. RESEND_API_KEY set under Edge Functions → Secrets (used by the function
--      itself, not by this cron).
--
-- The job is scheduled for 06:00 UTC daily, which is ~09:00 PKT — early-morning
-- digest before the workday starts.

create extension if not exists pg_net with schema extensions;

-- Helper that performs the HTTP POST. Encapsulating it makes the cron command
-- short and lets us rerun / debug from SQL without rewriting headers each time.
create or replace function public.invoke_send_compliance_alerts()
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
    url := 'https://mmkfpnshxjcyijhuydgr.supabase.co/functions/v1/send-compliance-alerts',
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

-- Unschedule any prior version so this migration is idempotent.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'send-compliance-alerts-daily') then
    perform cron.unschedule('send-compliance-alerts-daily');
  end if;
end $$;

select cron.schedule(
  'send-compliance-alerts-daily',
  '0 6 * * *',
  $$select public.invoke_send_compliance_alerts();$$
);
