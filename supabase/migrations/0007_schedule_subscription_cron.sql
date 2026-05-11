-- ============================================================================
-- Daily cron: enforce_subscription_expiry() at 01:00 UTC.
-- Deactivates any company whose subscription_expires_at has passed.
-- The function is idempotent and only flips active=false (no data deletion).
-- Idempotent re-scheduling: drops any existing job with this name first.
-- ============================================================================

create extension if not exists pg_cron with schema extensions;

do $cron$
begin
  if exists (
    select 1 from cron.job where jobname = 'enforce-subscription-expiry-daily'
  ) then
    perform cron.unschedule('enforce-subscription-expiry-daily');
  end if;
  perform cron.schedule(
    'enforce-subscription-expiry-daily',
    '0 1 * * *',
    'select public.enforce_subscription_expiry()'
  );
end
$cron$;
