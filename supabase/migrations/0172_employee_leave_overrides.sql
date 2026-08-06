-- 0172: per-employee, per-MONTH leave allowance override.
--
-- Until now a guard's allowed leaves came from their contract, falling back to
-- the client default, optionally grown by carry-forward. All of those are
-- policy: they apply to everyone on that contract or client, every month, and
-- changing one to accommodate a single person in a single month would quietly
-- change it for the whole group and for every month after.
--
-- This table is the exception to that policy, and it is deliberately scoped as
-- tightly as the exception is: ONE employee, ONE month. The month is part of
-- the key, so the override simply does not exist for the next period — nothing
-- has to be remembered or undone, and a payroll run for any other month is
-- unaffected.
--
-- Precedence when the payslip is computed:
--   override (this table)  >  carry-forward balance  >  contract  >  client
create table if not exists public.employee_leave_overrides (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  employee_id    uuid not null references public.employees(id) on delete cascade,
  -- First of the month, matching payslips.period_month exactly so the two
  -- always agree on what "this month" means.
  period_month   date not null,
  -- Halves are allowed: some clients grant a half-day allowance.
  allowed_leaves numeric(6,2) not null check (allowed_leaves >= 0),
  reason         text,
  created_by     uuid references auth.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint employee_leave_overrides_unique unique (employee_id, period_month)
);

-- Payroll reads a whole month at a time.
create index if not exists employee_leave_overrides_period_idx
  on public.employee_leave_overrides (company_id, period_month);

alter table public.employee_leave_overrides enable row level security;

drop policy if exists company_members on public.employee_leave_overrides;
create policy company_members on public.employee_leave_overrides
  for all using (company_id = current_company_id())
  with check (company_id = current_company_id());

drop policy if exists ssa_all on public.employee_leave_overrides;
create policy ssa_all on public.employee_leave_overrides
  for all using (is_ssa_unscoped()) with check (is_ssa_unscoped());

drop trigger if exists trg_aaa_employee_leave_overrides_fill_company on public.employee_leave_overrides;
create trigger trg_aaa_employee_leave_overrides_fill_company
before insert on public.employee_leave_overrides
for each row execute function public.fill_company_id();

drop trigger if exists trg_employee_leave_overrides_updated_at on public.employee_leave_overrides;
create trigger trg_employee_leave_overrides_updated_at
before update on public.employee_leave_overrides
for each row execute function public.touch_updated_at();

-- Changing someone's leave allowance changes their pay, so it is auditable.
drop trigger if exists trg_zzz_employee_leave_overrides_audit on public.employee_leave_overrides;
create trigger trg_zzz_employee_leave_overrides_audit
after insert or update or delete on public.employee_leave_overrides
for each row execute function public.log_audit_change();
