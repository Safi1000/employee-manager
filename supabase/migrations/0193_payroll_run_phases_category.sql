-- 0193: let Payroll Run phase client-less category groups (office_staff, reliever,
-- armed, gunman) alongside real clients. Scope is client_id XOR category, same
-- pattern as the OPS-verify tables (0192).
alter table public.payroll_run_phases alter column client_id drop not null;
alter table public.payroll_run_phases add column if not exists category text;
alter table public.payroll_run_phases
  drop constraint if exists payroll_run_phases_company_id_client_id_period_month_key;
create unique index if not exists prp_scope_unique on public.payroll_run_phases
  (company_id, period_month, coalesce(client_id::text, 'cat:' || category));
alter table public.payroll_run_phases
  add constraint prp_scope_ck check ((client_id is not null) <> (category is not null));
