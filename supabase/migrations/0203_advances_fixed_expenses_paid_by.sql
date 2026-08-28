-- 0203 — "Paid By" on advances and fixed expenses.
--
-- expenses has carried custodian_location_id since 0135, so a cash expense says
-- whose hands the money left. Advances and fixed expenses paid in cash had no
-- such column: the amount came out of Cash in Hand but landed against nobody,
-- and the difference surfaced as "unattributed" on the custody reconciliation
-- with no way to trace it.
--
-- On advances this is the custodian who actually handed the cash over.
-- On fixed_expenses — a monthly TEMPLATE, not a payment — it is the DEFAULT
-- custodian, prefilled onto the raised instance when that instance is approved.
alter table public.advances
  add column if not exists custodian_location_id uuid references public.cash_locations(id);

alter table public.fixed_expenses
  add column if not exists custodian_location_id uuid references public.cash_locations(id);

comment on column public.advances.custodian_location_id is
  'Office-staff custodian whose held cash this advance was paid from. Null for non-cash advances.';
comment on column public.fixed_expenses.custodian_location_id is
  'Default office-staff custodian for cash instances raised from this template; prefills the approval.';

create index if not exists advances_custodian_location_idx
  on public.advances (custodian_location_id) where custodian_location_id is not null;
create index if not exists fixed_expenses_custodian_location_idx
  on public.fixed_expenses (custodian_location_id) where custodian_location_id is not null;
