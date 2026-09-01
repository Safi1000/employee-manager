-- 0060b: Create `cash_locations`, the base table for Cash Custody.
--
-- Reconstructed from production (project crm-design). This table was created
-- directly in the SQL editor and never captured as a migration, so every later
-- migration that touches it (0061 bank mirror, 0079 sub-ledgers, 0135 custodian,
-- 0136 RLS, 0142 …) failed to apply on a from-scratch database. Column set,
-- constraints and policies below mirror prod exactly.
--
-- Columns added by later migrations are included here so those migrations
-- no-op on their `add column if not exists` steps and still layer on their
-- indexes, triggers and policy changes.

create table if not exists public.cash_locations (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references public.companies(id),
  name                   text not null,
  location_type          text not null,
  custodian_partner_id   uuid references public.partners(id),
  custodian_user_id      uuid references public.profiles(id),
  opening_balance        numeric not null default 0,
  branch_id              uuid references public.branches(id),
  is_active              boolean not null default true,
  created_at             timestamptz not null default now(),
  bank_account_id        uuid references public.bank_accounts(id) on delete cascade,
  coa_account_id         uuid references public.chart_of_accounts(id),
  custodian_employee_id  uuid references public.employees(id),
  constraint cash_locations_location_type_check
    check (location_type in ('BANK', 'TREASURY', 'CUSTODIAN', 'PETTY_CASH'))
);

alter table public.cash_locations enable row level security;

-- The original policy, as prod had it at this point in history. 0136 later
-- replaces it with company_members / ssa_all so the "view as company" context
-- is honoured — leave that swap to 0136 rather than pre-empting it here.
drop policy if exists company_isolation on public.cash_locations;
create policy company_isolation on public.cash_locations
  for all
  using (company_id = (select company_id from public.profiles where id = auth.uid()));
