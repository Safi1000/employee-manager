-- Sprint 2 — Master records: client tax/billing fields, separate Contracts
-- entity, and the Pakistani-HR-compliant Employee field expansion.
--
-- Existing functionality is preserved: the legacy auto-invoice columns on
-- public.clients keep working as "default contract" fields for clients that
-- haven't migrated to the new contracts table yet.

-- ---------------------------------------------------------------------------
-- 1. Client tax / billing / signatory / industry fields (spec section 3.1)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'client_filer_status') then
    create type client_filer_status as enum ('filer', 'non_filer');
  end if;
end$$;

alter table public.clients
  add column if not exists ntn                  text,
  add column if not exists strn                 text,
  add column if not exists filer_status         client_filer_status,
  add column if not exists withholding_tax_rate numeric(5,2),
  add column if not exists billing_address      text,
  add column if not exists authorised_signatory text,
  add column if not exists signatory_cnic       text,
  add column if not exists industry             text;

-- Backfill withholding rate from the legacy auto_invoice_withholding column so
-- the new field has a sensible starting value.
update public.clients
   set withholding_tax_rate = auto_invoice_withholding
 where withholding_tax_rate is null
   and auto_invoice_withholding is not null;

-- ---------------------------------------------------------------------------
-- 2. Contracts table (spec section 3.2)
-- A client can have multiple simultaneous contracts.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'contract_type') then
    create type contract_type as enum ('static', 'mobile_patrol', 'event', 'reliever_pool');
  end if;
  if not exists (select 1 from pg_type where typname = 'contract_shift_pattern') then
    create type contract_shift_pattern as enum ('day', 'night', 'both', 'custom');
  end if;
  if not exists (select 1 from pg_type where typname = 'contract_status') then
    create type contract_status as enum ('active', 'expired', 'terminated', 'draft');
  end if;
end$$;

create table if not exists public.contracts (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null references public.companies(id) on delete cascade,
  client_id                uuid not null references public.clients(id) on delete cascade,
  contract_code            text,
  contract_type            contract_type not null default 'static',
  start_date               date not null,
  end_date                 date,
  number_of_guards         integer not null default 0,
  shift_pattern            contract_shift_pattern not null default 'day',
  rate_per_guard_per_month numeric(14,2) not null default 0,
  allowed_leaves_per_month integer,
  eobi_deduction           boolean not null default false,
  eobi_amount              numeric(14,2),
  annual_escalation_pct    numeric(5,2),
  auto_invoice_enabled     boolean not null default false,
  renewal_terms            text,
  status                   contract_status not null default 'active',
  -- Contract document (Google Drive)
  drive_file_id            text,
  drive_view_url           text,
  contract_file_name       text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists idx_contracts_company on public.contracts(company_id);
create index if not exists idx_contracts_client  on public.contracts(client_id);
create index if not exists idx_contracts_status  on public.contracts(status);
create index if not exists idx_contracts_end_date on public.contracts(end_date);

-- Per-company sequential contract codes (CON-0001, CON-0002, ...).
alter table public.company_counters
  add column if not exists next_contract_seq integer not null default 1;

create or replace function public.assign_contract_code()
returns trigger language plpgsql as $$
declare
  next_seq integer;
begin
  if new.contract_code is null or new.contract_code = '' then
    update public.company_counters
       set next_contract_seq = next_contract_seq + 1
     where company_id = new.company_id
     returning next_contract_seq - 1 into next_seq;
    if next_seq is null then
      insert into public.company_counters (company_id, next_contract_seq)
        values (new.company_id, 2)
        on conflict (company_id) do update set next_contract_seq = company_counters.next_contract_seq + 1
        returning next_contract_seq - 1 into next_seq;
    end if;
    new.contract_code := 'CON-' || lpad(next_seq::text, 4, '0');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_contracts_code on public.contracts;
create trigger trg_contracts_code
  before insert on public.contracts
  for each row execute function public.assign_contract_code();

-- Auto-fill company_id (matches the pattern from 0003).
drop trigger if exists trg_aaa_contracts_fill_company on public.contracts;
create trigger trg_aaa_contracts_fill_company
  before insert on public.contracts
  for each row execute function public.fill_company_id();

-- updated_at maintenance.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_contracts_updated_at on public.contracts;
create trigger trg_contracts_updated_at
  before update on public.contracts
  for each row execute function public.touch_updated_at();

-- RLS: same pattern as clients/employees.
alter table public.contracts enable row level security;
drop policy if exists "ssa_all" on public.contracts;
create policy "ssa_all" on public.contracts for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.contracts;
create policy "company_members" on public.contracts for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- ---------------------------------------------------------------------------
-- 3. Employee HR field expansion (spec section 3.3 + Appendix A.1)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'employee_contract_type') then
    create type employee_contract_type as enum ('permanent', 'contract', 'probation', 'daily_wages');
  end if;
end$$;

alter table public.employees
  -- Identity
  add column if not exists cnic_number             text,
  add column if not exists date_of_birth           date,
  add column if not exists father_or_husband_name  text,
  add column if not exists blood_group             text,
  -- Addresses
  add column if not exists permanent_address       text,
  add column if not exists current_address         text,
  -- Emergency contact
  add column if not exists emergency_contact_name     text,
  add column if not exists emergency_contact_relation text,
  add column if not exists emergency_contact_phone    text,
  -- Employment
  add column if not exists reporting_to_employee_id uuid references public.employees(id) on delete set null,
  add column if not exists employee_contract_type   employee_contract_type,
  add column if not exists probation_end_date       date,
  add column if not exists contract_id              uuid references public.contracts(id) on delete set null,
  -- Compliance / licences
  add column if not exists weapon_licence_number       text,
  add column if not exists weapon_licence_expiry       date,
  add column if not exists guard_service_licence_number text,
  add column if not exists guard_service_licence_expiry date,
  add column if not exists medical_fitness_expiry      date,
  add column if not exists eobi_registration_number    text,
  -- Bank: keep legacy bank_name/bank_account, add iban explicitly. The current
  -- bank_account column is renamed conceptually to "IBAN" in the UI; we keep
  -- the column name so existing rows aren't touched. New IBAN field is for
  -- companies that want to migrate to the canonical 24-char format separately.
  add column if not exists iban text;

create index if not exists idx_employees_reporting_to on public.employees(reporting_to_employee_id);
create index if not exists idx_employees_contract_id  on public.employees(contract_id);
create index if not exists idx_employees_weapon_exp   on public.employees(weapon_licence_expiry);
create index if not exists idx_employees_guard_exp    on public.employees(guard_service_licence_expiry);
create index if not exists idx_employees_medical_exp  on public.employees(medical_fitness_expiry);
create index if not exists idx_employees_probation    on public.employees(probation_end_date);
