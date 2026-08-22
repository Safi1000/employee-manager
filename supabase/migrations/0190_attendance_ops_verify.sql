-- 0190: OPS Verify for monthly attendance (per client + month).
--
-- Monthly Board (the per-client attendance sheet) gains an "OPS Verify" pass that
-- checks a *finished* month has no unmarked days for that client's active guards.
-- Two new tables + a lock; the `attendance.ops_verify` permission is code-only.

-- 1. Verification stamp. A row's mere existence = that (client, month) is OPS-Verified.
create table if not exists public.attendance_month_verifications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  period_month date not null,               -- first calendar day of the verified month
  verified_by uuid references public.profiles(id),
  verified_at timestamptz not null default now(),
  unique (company_id, client_id, period_month)
);
alter table public.attendance_month_verifications enable row level security;
create policy amv_company on public.attendance_month_verifications
  for all using (company_id = current_company_id()) with check (company_id = current_company_id());
create policy amv_ssa on public.attendance_month_verifications
  for all using (is_ssa_unscoped()) with check (is_ssa_unscoped());
create trigger trg_aaa_amv_fill_company
  before insert on public.attendance_month_verifications
  for each row execute function fill_company_id();

-- 2. Override audit log. PERMANENT: only INSERT + SELECT policies exist, so RLS
--    denies UPDATE/DELETE to everyone (records can never be edited or removed).
create table if not exists public.attendance_overrides (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  employee_id uuid not null references public.employees(id) on delete cascade,
  attendance_date date not null,
  reason text not null,
  before_value text,                        -- e.g. "unmarked" / prior status
  after_value text,                         -- e.g. "override-resolved"
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_attendance_overrides_emp_date
  on public.attendance_overrides (employee_id, attendance_date);
alter table public.attendance_overrides enable row level security;
create policy ao_select on public.attendance_overrides
  for select using (company_id = current_company_id() or is_ssa_unscoped());
create policy ao_insert on public.attendance_overrides
  for insert with check (company_id = current_company_id() or is_ssa_unscoped());
create trigger trg_aaa_ao_fill_company
  before insert on public.attendance_overrides
  for each row execute function fill_company_id();

-- 3. Lock: once a (client, month) is verified, attendance for that client's guards
--    in that month is frozen. Un-verify (delete the stamp) to edit again.
create or replace function public.enforce_attendance_month_lock() returns trigger
language plpgsql as $$
declare
  v_emp uuid;
  v_date date;
  v_client uuid;
begin
  if TG_OP = 'DELETE' then v_emp := OLD.employee_id; v_date := OLD.attendance_date;
  else v_emp := NEW.employee_id; v_date := NEW.attendance_date;
  end if;
  select client_id into v_client from public.employees where id = v_emp;
  if v_client is not null and exists (
    select 1 from public.attendance_month_verifications v
    where v.client_id = v_client
      and v.period_month = date_trunc('month', v_date)::date
  ) then
    raise exception 'This month is OPS-verified for this client and locked. Un-verify it to edit attendance.';
  end if;
  return case when TG_OP = 'DELETE' then OLD else NEW end;
end $$;
create trigger enforce_attendance_month_lock
  before insert or update or delete on public.attendance_records
  for each row execute function public.enforce_attendance_month_lock();
