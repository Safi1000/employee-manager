-- 0170: make contract-end alerts survive a missed day.
--
-- send-compliance-alerts fired a contract-end alert only when the contract was
-- EXACTLY 60, 30 or 7 days out. Miss that one daily run — function error, Resend
-- outage, project paused — and the alert was gone for good, with nothing to say
-- it had been skipped.
--
-- The fix is to alert when a contract is AT OR UNDER a threshold, which on its
-- own would then email every single day. This table is what stops that: one row
-- per (company, alert, threshold) the moment a notice actually goes out, so each
-- threshold is announced exactly once and a late run still catches up.
create table if not exists public.compliance_alert_log (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  -- Stable identifier for the thing being announced, e.g. 'contract:<uuid>'.
  alert_key   text not null,
  -- Which notice window this row records: 60, 30 or 7 days out.
  threshold   integer not null,
  sent_on     date not null default current_date,
  created_at  timestamptz not null default now(),
  constraint compliance_alert_log_unique unique (company_id, alert_key, threshold)
);

create index if not exists compliance_alert_log_company_idx
  on public.compliance_alert_log (company_id);

alter table public.compliance_alert_log enable row level security;

-- The edge function writes this with the service-role key, which bypasses RLS.
-- The policies exist so the rows are readable in-app for anyone auditing why a
-- notice did or did not go out.
drop policy if exists company_members on public.compliance_alert_log;
create policy company_members on public.compliance_alert_log
  for all using (company_id = current_company_id())
  with check (company_id = current_company_id());

drop policy if exists ssa_all on public.compliance_alert_log;
create policy ssa_all on public.compliance_alert_log
  for all using (is_ssa_unscoped()) with check (is_ssa_unscoped());
