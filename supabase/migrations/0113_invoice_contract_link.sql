-- 0113_invoice_contract_link.sql
-- Task 4: one invoice per contract per month.
--
-- Invoices linked only to a client. To cap invoices at "one per active contract
-- per month" (manual + generated paths) the invoice must know WHICH contract it
-- bills. Adds invoices.contract_id, a conservative unambiguous backfill, and a
-- partial unique index enforcing the rule at the DB level.
--
-- Numbered 0113: the DB already had 0109-0112 applied from a teammate branch, so
-- the original 0109 filename collided. Applied to crm-design 2026-07-22.
-- Depends on: contracts (0037), invoices period_start/period_end (0070).

-- 1) The link. ON DELETE SET NULL so deleting a contract never cascades away
--    historical invoices; they just become unlinked.
alter table public.invoices
  add column if not exists contract_id uuid references public.contracts(id) on delete set null;

create index if not exists idx_invoices_contract_id on public.invoices (contract_id);

-- 2) Backfill — ONLY where the link is unambiguous: a client that has exactly
--    one contract. Clients with 0 or 2+ contracts are left NULL for manual
--    review (never guess). On crm-design this linked 61/84 invoices.
update public.invoices i
set contract_id = c.id
from public.contracts c
where i.contract_id is null
  and c.client_id = i.client_id
  and (select count(*) from public.contracts c2 where c2.client_id = i.client_id) = 1;

-- 3) One invoice per contract per billing month (period_start when present, else
--    invoice_date). Partial so only contract-linked rows are governed; legacy
--    unlinked invoices and multi-contract clients awaiting review are unaffected.
--    The ::timestamp cast forces date_trunc's IMMUTABLE overload (an index
--    expression requires it; the timestamptz overload is only STABLE).
--
--    If this CREATE ever fails with a uniqueness violation, pre-existing data has
--    two invoices for one contract in one month. Find them with:
--      select contract_id, date_trunc('month', coalesce(period_start, invoice_date)::timestamp) m,
--             count(*), array_agg(invoice_number)
--      from invoices where contract_id is not null group by 1, 2 having count(*) > 1;
create unique index if not exists uq_invoice_contract_month
  on public.invoices (contract_id, (date_trunc('month', coalesce(period_start, invoice_date)::timestamp)))
  where contract_id is not null;
