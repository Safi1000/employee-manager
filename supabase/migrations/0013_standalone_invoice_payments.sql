-- ============================================================================
-- ADDITIVE migration. No data loss.
-- Allow invoice_payments to be recorded WITHOUT a specific invoice — a
-- "standalone" payment that applies directly to a client's balance
-- (e.g., advance receipt, unallocated payment). Adds:
--   - invoice_id NULLABLE
--   - client_id column (FK to clients)
--   - CHECK: at least one of invoice_id / client_id must be set
-- Receivables math should now include standalone payments in total_received.
-- Cashflow already aggregates invoice_payments by payment_date — standalone
-- payments will be counted automatically.
-- Run this in Supabase Dashboard -> SQL Editor.
-- ============================================================================

alter table public.invoice_payments
  alter column invoice_id drop not null;

alter table public.invoice_payments
  add column if not exists client_id uuid references public.clients(id) on delete set null;

alter table public.invoice_payments
  drop constraint if exists invoice_payments_target_check;

alter table public.invoice_payments
  add constraint invoice_payments_target_check
  check (invoice_id is not null or client_id is not null);

create index if not exists invoice_payments_client_idx
  on public.invoice_payments(client_id);
