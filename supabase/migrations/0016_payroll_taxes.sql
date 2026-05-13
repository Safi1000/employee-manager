-- ============================================================================
-- ADDITIVE migration. No data loss.
-- 1) clients.eobi_enabled + eobi_amount: per-client EOBI tax. When enabled,
--    payroll subtracts the flat amount from each employee under that client's
--    final salary.
-- 2) payslips.income_tax + eobi: stored amounts so historical payslips remain
--    faithful even if the rule or client setting changes later.
-- ============================================================================

alter table public.clients
  add column if not exists eobi_enabled boolean not null default false;

alter table public.clients
  add column if not exists eobi_amount numeric(14,2) not null default 0
  check (eobi_amount >= 0);

alter table public.payslips
  add column if not exists income_tax numeric(14,2) not null default 0
  check (income_tax >= 0);

alter table public.payslips
  add column if not exists eobi numeric(14,2) not null default 0
  check (eobi >= 0);
