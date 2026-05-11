-- ============================================================================
-- Multi-tenant redesign: companies, profiles, RLS, per-company counters
-- Drops & recreates all tables from 0001 with company_id NOT NULL.
-- Safe to run on a fresh DB; idempotent against an existing 0001 schema.
-- ============================================================================

drop table if exists public.notification_settings cascade;
drop table if exists public.recurring_alerts cascade;
drop table if exists public.important_dates cascade;
drop table if exists public.advances cascade;
drop table if exists public.payslips cascade;
drop table if exists public.invoice_payments cascade;
drop table if exists public.invoices cascade;
drop table if exists public.expenses cascade;
drop table if exists public.vendors cascade;
drop table if exists public.expense_categories cascade;
drop table if exists public.bank_transactions cascade;
drop table if exists public.treasury cascade;
drop table if exists public.bank_accounts cascade;
drop table if exists public.issuances cascade;
drop table if exists public.inventory_items cascade;
drop table if exists public.employee_documents cascade;
drop table if exists public.attendance_records cascade;
drop table if exists public.employees cascade;
drop table if exists public.clients cascade;
drop table if exists public.locations cascade;
drop function if exists public.gen_client_code() cascade;
drop function if exists public.gen_employee_code() cascade;
drop sequence if exists public.client_code_seq;
drop sequence if exists public.employee_code_seq;

create extension if not exists "pgcrypto";

-- Companies & profiles ------------------------------------------------------
create table public.companies (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,
  contact_email text,
  contact_phone text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

do $$ begin
  create type public.user_role as enum ('super_super_admin','super_admin','accounting','hr');
exception when duplicate_object then null; end $$;

create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  company_id  uuid references public.companies(id) on delete cascade,
  role        public.user_role not null,
  full_name   text,
  email       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint super_super_no_company check (
    (role = 'super_super_admin' and company_id is null)
    or (role <> 'super_super_admin' and company_id is not null)
  )
);
create index profiles_company_idx on public.profiles(company_id);

-- Helper functions ----------------------------------------------------------
create or replace function public.current_company_id()
returns uuid language sql stable security definer set search_path = public as $$
  select company_id from public.profiles where id = auth.uid()
$$;

create or replace function public.current_role()
returns public.user_role language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function public.is_super_super_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.profiles where id = auth.uid() and role = 'super_super_admin')
$$;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists trg_companies_updated_at on public.companies;
create trigger trg_companies_updated_at before update on public.companies
  for each row execute function public.set_updated_at();
drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- Per-company counters ------------------------------------------------------
create table public.company_counters (
  company_id   uuid not null references public.companies(id) on delete cascade,
  counter_name text not null,
  value        bigint not null default 0,
  primary key (company_id, counter_name)
);

create or replace function public.next_counter(p_company_id uuid, p_name text)
returns bigint language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  insert into public.company_counters (company_id, counter_name, value)
  values (p_company_id, p_name, 1)
  on conflict (company_id, counter_name)
    do update set value = public.company_counters.value + 1
  returning value into v;
  return v;
end;
$$;

create or replace function public.gen_client_code()
returns trigger language plpgsql as $$
begin
  if new.client_code is null or new.client_code = '' then
    new.client_code := 'CLI-' || lpad(public.next_counter(new.company_id, 'client')::text, 4, '0');
  end if;
  return new;
end;
$$;

create or replace function public.gen_employee_code()
returns trigger language plpgsql as $$
begin
  if new.employee_code is null or new.employee_code = '' then
    new.employee_code := 'EMP-' || lpad(public.next_counter(new.company_id, 'employee')::text, 4, '0');
  end if;
  return new;
end;
$$;

-- Per-company defaults seeded on company INSERT (attached at end of file)----
create or replace function public.seed_company_defaults()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.expense_categories (company_id, name)
  select new.id, t.name
  from (values
    ('Weapons & Ammunition'),('Uniform'),('Equipment & Supplies'),
    ('Transportation & Fuel'),('Utilities & Rent'),('Insurance'),
    ('Licenses'),('EOBI'),('IESSI'),('PESSI'),('Taxes')
  ) as t(name)
  on conflict (company_id, name) do nothing;

  insert into public.treasury (company_id, cash_balance) values (new.id, 0)
  on conflict (company_id) do nothing;

  insert into public.notification_settings (company_id) values (new.id)
  on conflict (company_id) do nothing;

  return new;
end;
$$;

-- Tables --------------------------------------------------------------------
create table public.locations (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now(),
  unique (company_id, name)
);
create index locations_company_idx on public.locations(company_id);

create table public.clients (
  id                        uuid primary key default gen_random_uuid(),
  company_id                uuid not null references public.companies(id) on delete cascade,
  client_code               text,
  name                      text not null,
  email                     text,
  phone                     text,
  allowed_leaves_per_month  integer not null default 0 check (allowed_leaves_per_month >= 0),
  opening_balance           numeric(14,2) not null default 0,
  client_type               text not null default 'security_services'
                              check (client_type in ('security_services','guard_deployment')),
  leave_carry_forward       boolean not null default false,
  created_at                timestamptz not null default now(),
  unique (company_id, client_code)
);
create index clients_company_idx on public.clients(company_id);
drop trigger if exists trg_clients_code on public.clients;
create trigger trg_clients_code before insert on public.clients
  for each row execute function public.gen_client_code();

create table public.employees (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  employee_code   text,
  full_name       text not null,
  phone           text,
  location_id     uuid references public.locations(id) on delete set null,
  client_id       uuid references public.clients(id) on delete set null,
  department      text,
  shift           text not null default 'day' check (shift in ('day','night')),
  status          text not null default 'Active' check (status in ('Active','On Leave','Inactive')),
  base_salary     numeric(14,2),
  per_day_salary  numeric(14,2),
  join_date       date,
  bank_account    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (company_id, employee_code)
);
create index employees_company_idx on public.employees(company_id);
create index employees_location_idx on public.employees(location_id);
create index employees_client_idx on public.employees(client_id);
drop trigger if exists trg_employees_code on public.employees;
create trigger trg_employees_code before insert on public.employees
  for each row execute function public.gen_employee_code();
drop trigger if exists trg_employees_updated_at on public.employees;
create trigger trg_employees_updated_at before update on public.employees
  for each row execute function public.set_updated_at();

create table public.attendance_records (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  employee_id      uuid not null references public.employees(id) on delete cascade,
  attendance_date  date not null,
  status           text not null check (status in ('Present','Absent','Leave')),
  marked_at        timestamptz not null default now(),
  unique (employee_id, attendance_date)
);
create index attendance_company_idx on public.attendance_records(company_id);
create index attendance_date_idx on public.attendance_records(attendance_date);

create table public.employee_documents (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  employee_id   uuid not null references public.employees(id) on delete cascade,
  doc_type      text not null,
  file_name     text not null,
  storage_path  text not null,
  mime_type     text,
  size_bytes    bigint,
  uploaded_at   timestamptz not null default now()
);
create index employee_documents_company_idx on public.employee_documents(company_id);
create index employee_documents_employee_idx on public.employee_documents(employee_id);

create table public.inventory_items (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  kind            text not null check (kind in ('weapon','uniform')),
  item_type       text not null,
  serial_number   text,
  size            text,
  quantity        integer not null default 1 check (quantity >= 0),
  location_id     uuid references public.locations(id) on delete set null,
  license_expiry  date,
  status          text not null default 'Available' check (status in ('Available','Issued','Maintenance')),
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index inventory_items_company_idx on public.inventory_items(company_id);
drop trigger if exists trg_inventory_items_updated_at on public.inventory_items;
create trigger trg_inventory_items_updated_at before update on public.inventory_items
  for each row execute function public.set_updated_at();

create table public.issuances (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  item_id      uuid not null references public.inventory_items(id) on delete cascade,
  employee_id  uuid references public.employees(id) on delete set null,
  client_id    uuid references public.clients(id) on delete set null,
  location_id  uuid references public.locations(id) on delete set null,
  issue_date   date not null,
  return_date  date,
  condition    text check (condition in ('Good','Fair','Damaged')),
  notes        text,
  created_at   timestamptz not null default now()
);
create index issuances_company_idx on public.issuances(company_id);
create index issuances_item_idx on public.issuances(item_id);

create table public.bank_accounts (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  bank_name        text not null,
  account_number   text not null,
  account_type     text not null check (account_type in ('Current','Savings')),
  opening_balance  numeric(14,2) not null default 0,
  balance          numeric(14,2) not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index bank_accounts_company_idx on public.bank_accounts(company_id);
drop trigger if exists trg_bank_accounts_updated_at on public.bank_accounts;
create trigger trg_bank_accounts_updated_at before update on public.bank_accounts
  for each row execute function public.set_updated_at();

create table public.treasury (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null unique references public.companies(id) on delete cascade,
  cash_balance numeric(14,2) not null default 0,
  updated_at   timestamptz not null default now()
);
drop trigger if exists trg_treasury_updated_at on public.treasury;
create trigger trg_treasury_updated_at before update on public.treasury
  for each row execute function public.set_updated_at();

create table public.bank_transactions (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  bank_account_id   uuid references public.bank_accounts(id) on delete set null,
  kind              text not null check (kind in (
                      'opening','deposit','withdraw_to_cash','payroll','reconcile',
                      'adjustment','cash_adjustment','expense','receipt','advance'
                    )),
  amount            numeric(14,2) not null default 0,
  cash_delta        numeric(14,2) not null default 0,
  account_delta     numeric(14,2) not null default 0,
  description       text,
  reference_id      text,
  created_at        timestamptz not null default now()
);
create index bank_tx_company_idx on public.bank_transactions(company_id);
create index bank_tx_account_idx on public.bank_transactions(bank_account_id);
create index bank_tx_created_idx on public.bank_transactions(created_at desc);

create table public.expense_categories (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now(),
  unique (company_id, name)
);
create index expense_categories_company_idx on public.expense_categories(company_id);

create table public.vendors (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  name            text not null,
  account_number  text,
  created_at      timestamptz not null default now()
);
create index vendors_company_idx on public.vendors(company_id);

create table public.expenses (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies(id) on delete cascade,
  category_id           uuid references public.expense_categories(id) on delete set null,
  client_id             uuid references public.clients(id) on delete set null,
  vendor_id             uuid references public.vendors(id) on delete set null,
  description           text,
  amount                numeric(14,2) not null default 0,
  expense_date          date not null,
  payment_mode          text not null check (payment_mode in ('Cash','Bank','Payable')),
  bank_account_id       uuid references public.bank_accounts(id) on delete set null,
  due_date              date,
  payable_status        text check (payable_status in ('Pending','Paid')),
  paid_via              text check (paid_via in ('Cash','Bank')),
  paid_bank_account_id  uuid references public.bank_accounts(id) on delete set null,
  paid_at               timestamptz,
  receipt_path          text,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index expenses_company_idx on public.expenses(company_id);
create index expenses_date_idx on public.expenses(expense_date);
drop trigger if exists trg_expenses_updated_at on public.expenses;
create trigger trg_expenses_updated_at before update on public.expenses
  for each row execute function public.set_updated_at();

create table public.invoices (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  client_id        uuid not null references public.clients(id) on delete restrict,
  invoice_number   text not null,
  invoice_date     date not null,
  invoice_amount   numeric(14,2) not null default 0,
  amount_received  numeric(14,2) not null default 0,
  attachment_path  text,
  notes            text,
  status           text not null default 'Pending' check (status in ('Pending','Delivered')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (company_id, client_id, invoice_number)
);
create index invoices_company_idx on public.invoices(company_id);
create index invoices_client_idx on public.invoices(client_id);
create index invoices_date_idx on public.invoices(invoice_date desc);
drop trigger if exists trg_invoices_updated_at on public.invoices;
create trigger trg_invoices_updated_at before update on public.invoices
  for each row execute function public.set_updated_at();

create table public.invoice_payments (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  invoice_id       uuid not null references public.invoices(id) on delete cascade,
  amount           numeric(14,2) not null check (amount > 0),
  payment_date     date not null,
  payment_mode     text not null check (payment_mode in ('Cash','Bank')),
  bank_account_id  uuid references public.bank_accounts(id) on delete set null,
  notes            text,
  created_at       timestamptz not null default now()
);
create index invoice_payments_company_idx on public.invoice_payments(company_id);
create index invoice_payments_invoice_idx on public.invoice_payments(invoice_id);

create table public.payslips (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  employee_id       uuid not null references public.employees(id) on delete cascade,
  period_month      date not null,
  working_days      integer not null default 0,
  present_days      integer not null default 0,
  absent_days       integer not null default 0,
  leave_days        integer not null default 0,
  base_salary       numeric(14,2) not null default 0,
  per_day_salary    numeric(14,2),
  bonus             numeric(14,2) not null default 0,
  deductions        numeric(14,2) not null default 0,
  advance           numeric(14,2) not null default 0,
  final_salary      numeric(14,2) not null default 0,
  net_salary        numeric(14,2) not null default 0,
  payment_mode      text not null default 'Cash' check (payment_mode in ('Cash','Bank')),
  bank_account_id   uuid references public.bank_accounts(id) on delete set null,
  status            text not null default 'Pending' check (status in ('Pending','Cleared')),
  disbursed         boolean not null default false,
  disbursed_at      timestamptz,
  notes             text,
  override_leaves   boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (employee_id, period_month)
);
create index payslips_company_idx on public.payslips(company_id);
create index payslips_period_idx on public.payslips(period_month);
drop trigger if exists trg_payslips_updated_at on public.payslips;
create trigger trg_payslips_updated_at before update on public.payslips
  for each row execute function public.set_updated_at();

create table public.advances (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  employee_id      uuid not null references public.employees(id) on delete cascade,
  client_id        uuid references public.clients(id) on delete set null,
  amount           numeric(14,2) not null check (amount > 0),
  advance_date     date not null,
  payment_mode     text not null check (payment_mode in ('Cash','Bank')),
  bank_account_id  uuid references public.bank_accounts(id) on delete set null,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index advances_company_idx on public.advances(company_id);
create index advances_employee_idx on public.advances(employee_id);
drop trigger if exists trg_advances_updated_at on public.advances;
create trigger trg_advances_updated_at before update on public.advances
  for each row execute function public.set_updated_at();

create table public.important_dates (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies(id) on delete cascade,
  title                text not null,
  due_date             date not null,
  category             text not null check (category in
                         ('License','Tax','HR','Payroll','Inventory','Client','Invoice','Operations','Other')),
  priority             text not null check (priority in ('critical','high','medium','low')),
  advance_notice_days  integer not null default 7 check (advance_notice_days >= 0),
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index important_dates_company_idx on public.important_dates(company_id);
drop trigger if exists trg_important_dates_updated_at on public.important_dates;
create trigger trg_important_dates_updated_at before update on public.important_dates
  for each row execute function public.set_updated_at();

create table public.recurring_alerts (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  company_id           uuid not null references public.companies(id) on delete cascade,
  category             text not null check (category in
                         ('License','Tax','HR','Payroll','Inventory','Client','Invoice','Operations','Other')),
  frequency            text not null check (frequency in ('Daily','Weekly','Monthly','Yearly')),
  trigger_day          text not null,
  advance_notice_days  integer not null default 7 check (advance_notice_days >= 0),
  active               boolean not null default true,
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index recurring_alerts_company_idx on public.recurring_alerts(company_id);
drop trigger if exists trg_recurring_alerts_updated_at on public.recurring_alerts;
create trigger trg_recurring_alerts_updated_at before update on public.recurring_alerts
  for each row execute function public.set_updated_at();

create table public.notification_settings (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null unique references public.companies(id) on delete cascade,
  recipient_email  text,
  sender_email     text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
drop trigger if exists trg_notification_settings_updated_at on public.notification_settings;
create trigger trg_notification_settings_updated_at before update on public.notification_settings
  for each row execute function public.set_updated_at();

drop trigger if exists trg_companies_seed on public.companies;
create trigger trg_companies_seed after insert on public.companies
  for each row execute function public.seed_company_defaults();

-- ============================================================================
-- RLS
-- ============================================================================
alter table public.companies enable row level security;
create policy "ssa_all" on public.companies for all
  using (public.is_super_super_admin())
  with check (public.is_super_super_admin());
create policy "members_read_own_company" on public.companies for select
  using (id = public.current_company_id());

alter table public.profiles enable row level security;
create policy "self_read" on public.profiles for select
  using (id = auth.uid());
create policy "self_update" on public.profiles for update
  using (id = auth.uid())
  with check (id = auth.uid() and role = (select role from public.profiles where id = auth.uid()));
create policy "ssa_all_profiles" on public.profiles for all
  using (public.is_super_super_admin())
  with check (public.is_super_super_admin());
create policy "super_admin_company_profiles" on public.profiles for all
  using (
    public.current_role() = 'super_admin'
    and company_id = public.current_company_id()
  )
  with check (
    public.current_role() = 'super_admin'
    and company_id = public.current_company_id()
    and role in ('hr','accounting','super_admin')
  );

alter table public.company_counters enable row level security;
create policy "ssa_all" on public.company_counters for all
  using (public.is_super_super_admin())
  with check (public.is_super_super_admin());
create policy "company_read_counters" on public.company_counters for select
  using (company_id = public.current_company_id());

do $$
declare
  t text;
  per_company_tables text[] := array[
    'locations','clients','employees','attendance_records','employee_documents',
    'inventory_items','issuances','bank_accounts','treasury','bank_transactions',
    'expense_categories','vendors','expenses','invoices','invoice_payments',
    'payslips','advances','important_dates','recurring_alerts','notification_settings'
  ];
begin
  foreach t in array per_company_tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format($p$create policy "ssa_all" on public.%I for all
      using (public.is_super_super_admin())
      with check (public.is_super_super_admin())$p$, t);
    execute format($p$create policy "company_members" on public.%I for all
      using (company_id = public.current_company_id())
      with check (company_id = public.current_company_id())$p$, t);
  end loop;
end $$;
