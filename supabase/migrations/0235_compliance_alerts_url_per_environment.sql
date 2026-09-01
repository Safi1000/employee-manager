-- 0235: Stop hardcoding the production project URL in the compliance-alerts
-- cron. 0032 baked https://mmkfpnshxjcyijhuydgr.supabase.co into
-- invoke_send_compliance_alerts(), so any non-production database rebuilt from
-- these migrations would fire its nightly job at PRODUCTION's edge function.
--
-- The URL now comes from a vault secret named `project_url`. Production has no
-- such secret and falls back to the same URL it always used, so nothing changes
-- there; other environments set `project_url` to their own project URL.

create or replace function public.invoke_send_compliance_alerts()
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_service_key text;
  v_base_url    text;
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

  select decrypted_secret
    into v_base_url
    from vault.decrypted_secrets
   where name = 'project_url'
   limit 1;

  v_base_url := coalesce(v_base_url, 'https://mmkfpnshxjcyijhuydgr.supabase.co');

  select net.http_post(
    url := v_base_url || '/functions/v1/send-compliance-alerts',
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
