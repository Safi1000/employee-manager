-- ============================================================================
-- DESCRIBES PRODUCTION. It does not change it.
--
-- This file was reverse-engineered FROM production (crm-design,
-- mmkfpnshxjcyijhuydgr), which already had this state before the file existed.
-- It is here so a from-scratch replay reaches the same shape, not because it
-- introduced anything.
--
-- Consequences, all of which have bitten:
--   * Production has NO schema_migrations row for it and correctly never will.
--     scripts/check-migrations.mjs reports it as "in repo, NOT recorded"; that
--     is expected for this class of file, not a defect to alias away.
--   * It is NOT safe to assume it runs at the position its number implies. It
--     was written long after the migrations that follow it, so applying it to
--     an existing database can undo later work. Guard anything order-sensitive.
--   * It reflects production as of the date it was recovered. If prod has moved
--     since, this file is stale and reconciling it is the fix.
-- ============================================================================

-- 0078b: Create the 12 tables that exist in production but were never captured
-- as migrations (created directly in the SQL editor). Without them a from-scratch
-- database fails at 0079 (custody_transfers), 0207 (partner_account_entries) and
-- every later migration that touches Finance / Profit distribution.
--
-- Column types, defaults, constraints, indexes and RLS policies below are
-- reproduced from production (project crm-design). No later migration ALTERs
-- these tables, so creating them at their final shape here is safe.
--
-- Note: the Finance / Profit tables use a `company_isolation` policy that reads
-- profiles.company_id directly, while the older tables use current_company_id()
-- / is_ssa_unscoped(). Both styles are kept exactly as prod has them.

-- ── Cash custody ────────────────────────────────────────────────────────────
create table if not exists public.custody_transfers (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id),
  date             date not null,
  from_location_id uuid references public.cash_locations(id),
  to_location_id   uuid references public.cash_locations(id),
  amount           numeric(14,2) not null,
  notes            text,
  created_by       uuid references public.profiles(id),
  created_at       timestamptz not null default now()
);
alter table public.custody_transfers enable row level security;
-- 0136 later swaps this for company_members / ssa_all; keep the original here.
drop policy if exists company_isolation on public.custody_transfers;
create policy company_isolation on public.custody_transfers for all
  using (company_id = (select company_id from public.profiles where id = auth.uid()));

-- ── Expense receipts (Drive-backed attachments) ─────────────────────────────
create table if not exists public.expense_receipts (
  id             uuid primary key default gen_random_uuid(),
  expense_id     uuid not null references public.expenses(id) on delete cascade,
  company_id     uuid not null references public.companies(id) on delete cascade,
  drive_file_id  text,
  drive_view_url text,
  file_name      text,
  created_at     timestamptz not null default now()
);
create index if not exists expense_receipts_expense_id_idx on public.expense_receipts(expense_id);
alter table public.expense_receipts enable row level security;
drop policy if exists expense_receipts_company_select on public.expense_receipts;
create policy expense_receipts_company_select on public.expense_receipts for select
  using (company_id = current_company_id());
drop policy if exists expense_receipts_company_insert on public.expense_receipts;
create policy expense_receipts_company_insert on public.expense_receipts for insert
  with check (company_id = current_company_id());
drop policy if exists expense_receipts_company_delete on public.expense_receipts;
create policy expense_receipts_company_delete on public.expense_receipts for delete
  using (company_id = current_company_id());

-- ── Invoice reminders ───────────────────────────────────────────────────────
create table if not exists public.invoice_reminders (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  step_day   integer not null,
  channel    text,
  note       text,
  sent_by    uuid,
  sent_at    timestamptz not null default now(),
  constraint invoice_reminders_invoice_id_step_day_key unique (invoice_id, step_day)
);
create index if not exists idx_invrem_invoice on public.invoice_reminders(invoice_id);
alter table public.invoice_reminders enable row level security;
drop policy if exists company_members on public.invoice_reminders;
create policy company_members on public.invoice_reminders for all
  using (company_id = current_company_id()) with check (company_id = current_company_id());
drop policy if exists ssa_all on public.invoice_reminders;
create policy ssa_all on public.invoice_reminders for all
  using (is_ssa_unscoped()) with check (is_ssa_unscoped());

-- ── Partner current account ─────────────────────────────────────────────────
create table if not exists public.partner_account_entries (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id),
  partner_id       uuid not null references public.partners(id),
  date             date not null,
  type             text not null,
  description      text not null default '',
  amount           numeric(14,2) not null,
  payment_method   text,
  bank_account_id  uuid references public.bank_accounts(id),
  cash_location_id uuid references public.cash_locations(id),
  period_month     date,
  is_locked        boolean not null default false,
  created_by       uuid references public.profiles(id),
  created_at       timestamptz not null default now(),
  constraint partner_account_entries_type_check
    check (type in ('OPENING', 'PROFIT_ALLOCATION', 'DRAWING', 'CONTRIBUTION')),
  constraint partner_account_entries_payment_method_check
    check (payment_method in ('CASH', 'BANK_TRANSFER', 'FUEL_CARD', 'CHEQUE'))
);
create index if not exists idx_pae_partner_date on public.partner_account_entries(partner_id, date, created_at);
alter table public.partner_account_entries enable row level security;
-- 0211 later swaps this for company_members / ssa_all; keep the original here.
drop policy if exists company_isolation on public.partner_account_entries;
create policy company_isolation on public.partner_account_entries for all
  using (company_id = (select company_id from public.profiles where id = auth.uid()));

-- ── Profit distribution ─────────────────────────────────────────────────────
create table if not exists public.profit_distribution_rules (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id),
  level          text not null check (level in ('COMPANY', 'BRANCH', 'CLIENT')),
  target_id      uuid,
  effective_from date not null,
  created_at     timestamptz not null default now()
);
alter table public.profit_distribution_rules enable row level security;
drop policy if exists company_isolation on public.profit_distribution_rules;
create policy company_isolation on public.profit_distribution_rules for all
  using (company_id = (select company_id from public.profiles where id = auth.uid()));

create table if not exists public.profit_distribution_rule_lines (
  id          uuid primary key default gen_random_uuid(),
  rule_id     uuid not null references public.profit_distribution_rules(id) on delete cascade,
  beneficiary text not null check (beneficiary in ('PARTNER', 'RETAINED')),
  partner_id  uuid references public.partners(id),
  percentage  numeric(5,2) not null check (percentage >= 0 and percentage <= 100)
);
alter table public.profit_distribution_rule_lines enable row level security;
drop policy if exists via_rule on public.profit_distribution_rule_lines;
create policy via_rule on public.profit_distribution_rule_lines for all
  using (rule_id in (
    select id from public.profit_distribution_rules
    where company_id = (select company_id from public.profiles where id = auth.uid())
  ));

create table if not exists public.profit_allocation_runs (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  period_month date not null,
  status       text not null default 'DRAFT' check (status in ('DRAFT', 'POSTED')),
  run_data     jsonb not null default '{}'::jsonb,
  posted_at    timestamptz,
  created_by   uuid references public.profiles(id),
  created_at   timestamptz not null default now(),
  constraint profit_allocation_runs_company_id_period_month_status_key
    unique (company_id, period_month, status)
);
alter table public.profit_allocation_runs enable row level security;
drop policy if exists company_isolation on public.profit_allocation_runs;
create policy company_isolation on public.profit_allocation_runs for all
  using (company_id = (select company_id from public.profiles where id = auth.uid()));

-- ── Referrals ───────────────────────────────────────────────────────────────
create table if not exists public.referral_arrangements (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies(id),
  referring_partner_id uuid not null references public.partners(id),
  source_branch_id     uuid not null references public.branches(id),
  basis                text not null check (basis in ('CLIENT_PROFIT', 'BRANCH_PROFIT')),
  client_id            uuid references public.clients(id),
  percentage           numeric(5,2) not null check (percentage > 0 and percentage <= 100),
  funding_method       text not null default 'OFF_THE_TOP'
                       check (funding_method in ('OFF_THE_TOP', 'PARTNERS_ONLY', 'CUSTOM_SPLIT')),
  custom_split_lines   jsonb,
  is_active            boolean not null default true,
  created_at           timestamptz not null default now()
);
alter table public.referral_arrangements enable row level security;
drop policy if exists company_isolation on public.referral_arrangements;
create policy company_isolation on public.referral_arrangements for all
  using (company_id = (select company_id from public.profiles where id = auth.uid()));

-- ── Project finance / investors ─────────────────────────────────────────────
create table if not exists public.finance_investors (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id),
  name              text not null,
  type              text not null check (type in ('PARTNER', 'THIRD_PARTY')),
  linked_partner_id uuid references public.partners(id),
  contact_info      text,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now()
);
alter table public.finance_investors enable row level security;
drop policy if exists company_isolation on public.finance_investors;
create policy company_isolation on public.finance_investors for all
  using (company_id = (select company_id from public.profiles where id = auth.uid()));

create table if not exists public.finance_projects (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies(id),
  name                text not null,
  client_id           uuid references public.clients(id),
  total_required      numeric(14,2) not null default 0,
  reserved_profit_pct numeric(5,2) not null default 0
                      check (reserved_profit_pct >= 0 and reserved_profit_pct <= 100),
  payout_gate         text not null default 'COMPANY_CASHFLOW'
                      check (payout_gate in ('COMPANY_CASHFLOW', 'PROJECT_CASHFLOW')),
  status              text not null default 'Raising'
                      check (status in ('Raising', 'Active', 'Completed')),
  notes               text,
  created_at          timestamptz not null default now()
);
alter table public.finance_projects enable row level security;
drop policy if exists company_isolation on public.finance_projects;
create policy company_isolation on public.finance_projects for all
  using (company_id = (select company_id from public.profiles where id = auth.uid()));

create table if not exists public.project_investments (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id),
  project_id        uuid not null references public.finance_projects(id) on delete cascade,
  investor_id       uuid not null references public.finance_investors(id),
  return_type       text not null check (return_type in ('PROFIT_SHARE', 'FIXED_FINANCE')),
  committed_amount  numeric(14,2) not null default 0,
  fixed_cost_amount numeric(14,2),
  fixed_schedule    jsonb,
  created_at        timestamptz not null default now()
);
alter table public.project_investments enable row level security;
drop policy if exists company_isolation on public.project_investments;
create policy company_isolation on public.project_investments for all
  using (company_id = (select company_id from public.profiles where id = auth.uid()));

create table if not exists public.investor_ledger_entries (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id),
  investor_id      uuid not null references public.finance_investors(id),
  project_id       uuid not null references public.finance_projects(id),
  date             date not null,
  type             text not null check (type in (
                     'CAPITAL_IN', 'CAPITAL_REPAYMENT', 'RETURN_ALLOCATION',
                     'RETURN_PAYOUT', 'FINANCE_COST_ACCRUAL', 'FINANCE_COST_PAYMENT')),
  amount           numeric(14,2) not null,
  cash_location_id uuid references public.cash_locations(id),
  description      text,
  is_locked        boolean not null default false,
  created_by       uuid references public.profiles(id),
  created_at       timestamptz not null default now()
);
create index if not exists idx_ile_investor_project
  on public.investor_ledger_entries(investor_id, project_id, date);
alter table public.investor_ledger_entries enable row level security;
drop policy if exists company_isolation on public.investor_ledger_entries;
create policy company_isolation on public.investor_ledger_entries for all
  using (company_id = (select company_id from public.profiles where id = auth.uid()));

-- ── Do not regress a table that has already moved on ────────────────────────
--
-- Everything above recreates production's HISTORICAL shape, including the old
-- `company_isolation` policy, and 0136 (cash_locations, custody_transfers) and
-- 0211 (partner_account_entries) drop it again further down the sequence. A
-- clean forward replay therefore ends in the right state, and that is what the
-- comments above mean by "keep the original here".
--
-- It only holds if this file runs BEFORE 0136 and 0211. It did not on dev.
-- 0078b is a recovery migration, written long after both, and applying it to an
-- existing database re-created `company_isolation` on three tables that had been
-- migrated off it years earlier. Dev carries all three to this day, next to the
-- modern pair, and prod does not.
--
-- So the ordering assumption is now asserted rather than assumed. If a table
-- already has `company_members`, it is past this point in history and the legacy
-- policy must not be reintroduced. On a genuine forward replay no table has it
-- yet and this block does nothing.
--
-- Same lesson as the 0224b/0231b guards: a migration may not assume it is
-- running at the position its number implies.
do $legacy_rls$
declare r record;
begin
  for r in
    select p.tablename
      from pg_policies p
     where p.schemaname = 'public'
       and p.policyname = 'company_isolation'
       and exists (
         select 1 from pg_policies m
          where m.schemaname = 'public'
            and m.tablename = p.tablename
            and m.policyname = 'company_members')
  loop
    execute format('drop policy if exists company_isolation on public.%I', r.tablename);
    raise notice '0078b: % already on company_members — legacy company_isolation not reintroduced', r.tablename;
  end loop;
end
$legacy_rls$;
