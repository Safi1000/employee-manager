-- 0135: Attribute cash movements to a specific OFFICE-STAFF custodian.
--
-- Today "Cash in Hand" is a single anonymous figure (treasury.cash_balance),
-- while custodian cash_locations track holdings separately via custody_transfers
-- only — so cash payments-in and cash expenses-out never touch a custodian and the
-- two drift. This links custodian locations to an office-staff EMPLOYEE and stamps
-- the receiving/paying custodian on cash client-payments and cash expenses, so every
-- rupee of Cash in Hand is attributable to exactly one custodian and reconciles.
--
-- Additive only. No existing row is modified; treasury.cash_balance stays the
-- canonical total (custodian balances reconcile up to it).

-- 1. A custodian cash_location can link to an office-staff employee (the holder).
--    Existing partner-held locations keep working via custodian_partner_id.
alter table public.cash_locations
  add column if not exists custodian_employee_id uuid references public.employees(id);

-- 2. Which custodian RECEIVED a cash client payment (Change 2). Null on bank/cheque
--    payments and on legacy cash payments recorded before this feature.
alter table public.invoice_payments
  add column if not exists custodian_location_id uuid references public.cash_locations(id);

-- 3. Which custodian PAID a cash expense (Change 3). Null on bank/other expenses and
--    on legacy cash expenses.
alter table public.expenses
  add column if not exists custodian_location_id uuid references public.cash_locations(id);
