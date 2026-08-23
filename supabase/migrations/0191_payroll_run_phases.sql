-- 0191: Payroll Run per-(client, month) phase — Draft → Review → Finance Verify.
--
-- A row's existence means that client-month has left Draft. `phase` distinguishes
-- Review vs Finance Verify. The Draft→Review OPS-verified gate is checked ONCE at
-- insert time (app-side); afterwards the phase is read from here, never from live
-- OPS status, so a later OPS-revoke never retroactively re-blocks the client.
create table if not exists public.payroll_run_phases (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  period_month date not null,                 -- first calendar day of the month
  phase text not null default 'review' check (phase in ('review', 'finance_verify')),
  moved_by uuid references public.profiles(id),
  moved_at timestamptz not null default now(),
  unique (company_id, client_id, period_month)
);
alter table public.payroll_run_phases enable row level security;
create policy prp_company on public.payroll_run_phases
  for all using (company_id = current_company_id()) with check (company_id = current_company_id());
create policy prp_ssa on public.payroll_run_phases
  for all using (is_ssa_unscoped()) with check (is_ssa_unscoped());
create trigger trg_aaa_prp_fill_company
  before insert on public.payroll_run_phases
  for each row execute function fill_company_id();
