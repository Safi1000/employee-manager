-- Sprint 1 — IFRS-compliant P&L + Pakistani bank account fields.
-- Two unrelated changes shipped together because both touch only DDL.

-- ---------------------------------------------------------------------------
-- 1. Expense pl_category: tags each expense as either "Cost of Services"
--    (guard payroll, transport, equipment — tied to revenue) or "Operating
--    Expense" (office rent, head-office salaries — not tied to a client).
--    Drives the Gross Profit vs Operating Profit split on the P&L.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'expense_pl_category') then
    create type expense_pl_category as enum ('cost_of_services', 'operating_expense');
  end if;
end$$;

alter table public.expenses
  add column if not exists pl_category expense_pl_category;

-- Backfill: any expense tagged to a client/contract is a cost of services;
-- everything else is an operating expense. Matches the spec's default rule.
update public.expenses
  set pl_category = case
    when client_id is not null then 'cost_of_services'::expense_pl_category
    else 'operating_expense'::expense_pl_category
  end
  where pl_category is null;

alter table public.expenses
  alter column pl_category set default 'operating_expense'::expense_pl_category,
  alter column pl_category set not null;

-- ---------------------------------------------------------------------------
-- 2. Bank account additions for Pakistani banking + forward multi-currency.
--    All nullable: existing rows keep working, new fields populated going
--    forward. Currency defaults to PKR.
-- ---------------------------------------------------------------------------

alter table public.bank_accounts
  add column if not exists iban         text,
  add column if not exists branch_code  text,
  add column if not exists branch_name  text,
  add column if not exists swift_code   text,
  add column if not exists currency_code text not null default 'PKR';
