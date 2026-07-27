-- 0134: Retire SLA as a selectable Client Group; make Variable a fully-manual grid.
--
-- Change 1: SLA is removed as a selectable invoice_group in the UI (done in code).
--   The SLA enum value, the SLA PDF template (renderSla), and clients.billing_type
--   'SLA' are intentionally LEFT in place — other code still references them and the
--   task says not to delete the SLA format code yet.
-- Change 2: existing SLA clients become Variable, keeping their SLA column layout as
--   their manual default structure. (Scan on 2026-07-28: 0 SLA clients — all 59 are
--   FIXED — so this is a safe no-op that also future-proofs a stray SLA row.)
-- Changes 4/5: storage for the manual Variable grid + the per-client saved layout.
--
-- Additive only. No existing invoice/line/tax data is modified.

-- 1. Per-INVOICE manual grid (Change 4): the fully-manual spreadsheet a Variable
--    client's invoice stores — { columns: string[], rows: string[][], total: number }.
--    Null on Fixed / legacy invoices (they keep using invoice_lines).
alter table public.invoices
  add column if not exists variable_grid jsonb;

-- 2. Per-CLIENT saved Variable column STRUCTURE (Change 5): the column headers a
--    Variable client's grid should open with next month. STRUCTURE ONLY — no values.
alter table public.clients
  add column if not exists variable_columns jsonb;

-- 3. Migrate existing SLA clients → Variable (Change 2), seeding their SLA column
--    layout as the carried-over manual structure. 0 rows today (no SLA clients).
update public.clients
   set invoice_group    = 'VARIABLE',
       variable_columns = coalesce(
         variable_columns,
         '["Category","Salary & Expenses","No.","Total Expenses","Admin Cost","Period From","Period To","Amount w/o GST","GST","WHT","Grand Total"]'::jsonb
       )
 where invoice_group = 'SLA';
