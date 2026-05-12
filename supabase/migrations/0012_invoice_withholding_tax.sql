-- ============================================================================
-- ADDITIVE migration. No data loss.
-- Adds invoices.withholding_tax (nullable; default 0) for optional WHT on each
-- invoice. Outstanding receivable for a client is computed as:
--   opening_balance + SUM(invoice_amount) - SUM(withholding_tax) - SUM(amount_received)
-- This is reflected in the Client Receivables view in the app.
-- Run this in Supabase dashboard -> SQL Editor.
-- ============================================================================

alter table public.invoices
  add column if not exists withholding_tax numeric(14,2) not null default 0
  check (withholding_tax >= 0);
