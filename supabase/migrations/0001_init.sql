-- ============================================================================
-- Employee Manager - schema reconstruction from frontend code
-- Derived from src/app/lib/supabase.ts and all super-admin pages.
-- Run in a fresh Supabase project: SQL Editor -> paste -> Run.
-- ============================================================================

-- Extensions ----------------------------------------------------------------
create extension if not exists "pgcrypto";  -- gen_random_uuid()

-- ============================================================================
-- Generic updated_at trigger
-- ============================================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================================
-- Code generator (CLI-0001, EMP-0001, INV-0001 style)
-- Uses a sequence per "code domain". Pads to 4 digits.
-- ============================================================================
create sequence if not exists public.client_code_seq;
create sequence if not exists public.employee_code_seq;

create or replace function public.gen_client_code()
returns trigger
language plpgsql
as $$
begin
  if new.client_code is null or new.client_code = '' then
    new.client_code := 'CLI-' || lpad(nextval('public.client_code_seq')::text, 4, '0');
  end if;
  return new;
end;
$$;

create or replace function public.gen_employee_code()
returns trigger
language plpgsql
as $$
begin
  if new.employee_code is null or new.employee_code = '' then
    new.employee_code := 'EMP-' || lpad(nextval('public.employee_code_seq')::text, 4, '0');
  end if;
  return new;
end;
$$;

-- ============================================================================
-- Tables
-- ============================================================================

-- locations -----------------------------------------------------------------
create table if not exists public.locations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  created_at  timestamptz not null default now()
);

-- clients -------------------------------------------------------------------
create table if not exists public.clients (
  id                        uuid primary key default gen_random_uuid(),
  client_code               text unique,
  name                      text not null,
  email                     text,
  phone                     text,
  allowed_leaves_per_month  integer not null default 0 check (allowed_leaves_per_month >= 0),
  opening_balance           numeric(14,2) not null default 0,
  client_type               text not null default 'security_services'
                              check (client_type in ('security_services','guard_deployment')),
  leave_carry_forward       boolean not null default false,
  created_at                timestamptz not null default now()
);
drop trigger if exists trg_clients_code on public.clients;
create trigger trg_clients_code before insert on public.clients
  for each row execute function public.gen_client_code();

-- employees -----------------------------------------------------------------
create table if not exists public.employees (
  id              uuid primary key default gen_random_uuid(),
  employee_code   text unique,
  full_name       text not null,
  phone           text,
  location_id     uuid references public.locations(id) on delete set null,
  client_id       uuid references public.clients(id)   on delete set null,
  department      text,
  shift           text not null default 'day' check (shift in ('day','night')),
  status          text not null default 'Active'
                    check (status in ('Active','On Leave','Inactive')),
  base_salary     numeric(14,2),
  per_day_salary  numeric(14,2),
  join_date       date,
  bank_account    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
drop trigger if exists trg_employees_code on public.employees;
create trigger trg_employees_code before insert on public.employees
  for each row execute function public.gen_employee_code();
drop trigger if exists trg_employees_updated_at on public.employees;
create trigger trg_employees_updated_at before update on public.employees
  for each row execute function public.set_updated_at();
create index if not exists idx_employees_location  on public.employees(location_id);
create index if not exists idx_employees_client    on public.employees(client_id);
create index if not exists idx_employees_status    on public.employees(status);

-- attendance_records --------------------------------------------------------
create table if not exists public.attendance_records (
  id               uuid primary key default gen_random_uuid(),
  employee_id      uuid not null references public.employees(id) on delete cascade,
  attendance_date  date not null,
  status           text not null check (status in ('Present','Absent','Leave')),
  marked_at        timestamptz not null default now(),
  unique (employee_id, attendance_date)
);
create index if not exists idx_attendance_date on public.attendance_records(attendance_date);

-- employee_documents --------------------------------------------------------
create table if not exists public.employee_documents (
  id            uuid primary key default gen_random_uuid(),
  employee_id   uuid not null references public.employees(id) on delete cascade,
  doc_type      text not null,
  file_name     text not null,
  storage_path  text not null,
  mime_type     text,
  size_bytes    bigint,
  uploaded_at   timestamptz not null default now()
);
create index if not exists idx_employee_documents_employee on public.employee_documents(employee_id);

-- inventory_items -----------------------------------------------------------
create table if not exists public.inventory_items (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('weapon','uniform')),
  item_type       text not null,
  serial_number   text,
  size            text,
  quantity        integer not null default 1 check (quantity >= 0),
  location_id     uuid references public.locations(id) on delete set null,
  license_expiry  date,
  status          text not null default 'Available'
                    check (status in ('Available','Issued','Maintenance')),
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
drop trigger if exists trg_inventory_items_updated_at on public.inventory_items;
create trigger trg_inventory_items_updated_at before update on public.inventory_items
  for each row execute function public.set_updated_at();

-- issuances -----------------------------------------------------------------
create table if not exists public.issuances (
  id           uuid primary key default gen_random_uuid(),
  item_id      uuid not null references public.inventory_items(id) on delete cascade,
  employee_id  uuid references public.employees(id) on delete set null,
  client_id    uuid references public.clients(id)   on delete set null,
  location_id  uuid references public.locations(id) on delete set null,
  issue_date   date not null,
  return_date  date,
  condition    text check (condition in ('Good','Fair','Damaged')),
  notes        text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_issuances_item     on public.issuances(item_id);
create index if not exists idx_issuances_employee on public.issuances(employee_id);
create index if not exists idx_issuances_client   on public.issuances(client_id);

-- bank_accounts -------------------------------------------------------------
create table if not exists public.bank_accounts (
  id               uuid primary key default gen_random_uuid(),
  bank_name        text not null,
  account_number   text not null,
  account_type     text not null check (account_type in ('Current','Savings')),
  opening_balance  numeric(14,2) not null default 0,
  balance          numeric(14,2) not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
drop trigger if exists trg_bank_accounts_updated_at on public.bank_accounts;
create trigger trg_bank_accounts_updated_at before update on public.bank_accounts
  for each row execute function public.set_updated_at();

-- treasury (single-row table for cash on hand) ------------------------------
create table if not exists public.treasury (
  id           uuid primary key default gen_random_uuid(),
  cash_balance numeric(14,2) not null default 0,
  updated_at   timestamptz not null default now()
);
drop trigger if exists trg_treasury_updated_at on public.treasury;
create trigger trg_treasury_updated_at before update on public.treasury
  for each row execute function public.set_updated_at();

-- bank_transactions ---------------------------------------------------------
create table if not exists public.bank_transactions (
  id                uuid primary key default gen_random_uuid(),
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
create index if not exists idx_bank_tx_account on public.bank_transactions(bank_account_id);
create index if not exists idx_bank_tx_kind    on public.bank_transactions(kind);
create index if not exists idx_bank_tx_created on public.bank_transactions(created_at desc);

-- expense_categories --------------------------------------------------------
create table if not exists public.expense_categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  created_at  timestamptz not null default now()
);

-- vendors -------------------------------------------------------------------
create table if not exists public.vendors (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  account_number  text,
  created_at      timestamptz not null default now()
);

-- expenses ------------------------------------------------------------------
create table if not exists public.expenses (
  id                    uuid primary key default gen_random_uuid(),
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
drop trigger if exists trg_expenses_updated_at on public.expenses;
create trigger trg_expenses_updated_at before update on public.expenses
  for each row execute function public.set_updated_at();
create index if not exists idx_expenses_date     on public.expenses(expense_date);
create index if not exists idx_expenses_client   on public.expenses(client_id);
create index if not exists idx_expenses_category on public.expenses(category_id);
create index if not exists idx_expenses_vendor   on public.expenses(vendor_id);

-- invoices ------------------------------------------------------------------
create table if not exists public.invoices (
  id               uuid primary key default gen_random_uuid(),
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
  unique (client_id, invoice_number)
);
drop trigger if exists trg_invoices_updated_at on public.invoices;
create trigger trg_invoices_updated_at before update on public.invoices
  for each row execute function public.set_updated_at();
create index if not exists idx_invoices_client on public.invoices(client_id);
create index if not exists idx_invoices_date   on public.invoices(invoice_date desc);

-- invoice_payments ----------------------------------------------------------
create table if not exists public.invoice_payments (
  id               uuid primary key default gen_random_uuid(),
  invoice_id       uuid not null references public.invoices(id) on delete cascade,
  amount           numeric(14,2) not null check (amount > 0),
  payment_date     date not null,
  payment_mode     text not null check (payment_mode in ('Cash','Bank')),
  bank_account_id  uuid references public.bank_accounts(id) on delete set null,
  notes            text,
  created_at       timestamptz not null default now()
);
create index if not exists idx_invoice_payments_invoice on public.invoice_payments(invoice_id);

-- payslips ------------------------------------------------------------------
create table if not exists public.payslips (
  id                uuid primary key default gen_random_uuid(),
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
drop trigger if exists trg_payslips_updated_at on public.payslips;
create trigger trg_payslips_updated_at before update on public.payslips
  for each row execute function public.set_updated_at();
create index if not exists idx_payslips_period on public.payslips(period_month);

-- advances ------------------------------------------------------------------
create table if not exists public.advances (
  id               uuid primary key default gen_random_uuid(),
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
drop trigger if exists trg_advances_updated_at on public.advances;
create trigger trg_advances_updated_at before update on public.advances
  for each row execute function public.set_updated_at();
create index if not exists idx_advances_employee on public.advances(employee_id);
create index if not exists idx_advances_date     on public.advances(advance_date desc);

-- important_dates -----------------------------------------------------------
create table if not exists public.important_dates (
  id                   uuid primary key default gen_random_uuid(),
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
drop trigger if exists trg_important_dates_updated_at on public.important_dates;
create trigger trg_important_dates_updated_at before update on public.important_dates
  for each row execute function public.set_updated_at();

-- recurring_alerts ----------------------------------------------------------
create table if not exists public.recurring_alerts (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
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
drop trigger if exists trg_recurring_alerts_updated_at on public.recurring_alerts;
create trigger trg_recurring_alerts_updated_at before update on public.recurring_alerts
  for each row execute function public.set_updated_at();

-- notification_settings (singleton-style: read first row) -------------------
create table if not exists public.notification_settings (
  id               uuid primary key default gen_random_uuid(),
  recipient_email  text,
  sender_email     text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
drop trigger if exists trg_notification_settings_updated_at on public.notification_settings;
create trigger trg_notification_settings_updated_at before update on public.notification_settings
  for each row execute function public.set_updated_at();

-- ============================================================================
-- Seed: hardcoded expense categories the frontend expects
-- (referenced from supabase.ts HARDCODED_EXPENSE_CATEGORIES)
-- ============================================================================
insert into public.expense_categories (name) values
  ('Weapons & Ammunition'),
  ('Uniform'),
  ('Equipment & Supplies'),
  ('Transportation & Fuel'),
  ('Utilities & Rent'),
  ('Insurance'),
  ('Licenses'),
  ('EOBI'),
  ('IESSI'),
  ('PESSI'),
  ('Taxes')
on conflict (name) do nothing;

-- ============================================================================
-- Storage buckets (run from SQL or via Dashboard -> Storage)
-- These three are referenced as constants in supabase.ts.
-- ============================================================================
insert into storage.buckets (id, name, public)
values
  ('employee-documents',  'employee-documents',  false),
  ('expense-receipts',    'expense-receipts',    false),
  ('invoice-attachments', 'invoice-attachments', false)
on conflict (id) do nothing;

-- ============================================================================
-- RLS (left OFF for now to keep the app working immediately).
-- See RECONSTRUCTION_NOTES.md for the policy decisions you still need to make.
-- ============================================================================
-- Example (uncomment per table once you have auth wired):
-- alter table public.clients enable row level security;
-- create policy "authenticated read clients" on public.clients
--   for select using (auth.role() = 'authenticated');
