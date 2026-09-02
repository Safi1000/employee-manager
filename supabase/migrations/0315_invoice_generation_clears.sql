-- 0315 — persist the Invoices ▸ Generate tab "Cleared" flag.
--
-- BUG: a draft's "Cleared" status was pure React state (InvoiceGenerate `drafts`).
-- Generate-tab drafts are synthetic per-contract-per-period objects (no DB row
-- exists until "Generate All Cleared" posts the real invoice), and the component
-- is unmounted when you leave the tab — so Clear was lost on navigation, and the
-- "N cleared" count reset. This table records which (contract, period) drafts are
-- Cleared so it survives navigation, refresh and other sessions.
create table if not exists public.invoice_generation_clears (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null,
  contract_id uuid not null references public.contracts(id) on delete cascade,
  period      text not null,               -- 'YYYY-MM', matches the Generate tab's period key
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  unique (company_id, contract_id, period)
);

alter table public.invoice_generation_clears enable row level security;

-- company_id is filled by the trigger, matching every other table (invoices etc.).
create trigger trg_aaa_igc_fill_company before insert on public.invoice_generation_clears
  for each row execute function public.fill_company_id();

-- Read scoped to the company; SSA sees all. Writes additionally require
-- invoices.edit (clearing is part of the invoice-generation flow, 0310 pattern).
create policy company_members on public.invoice_generation_clears for all to public
  using (company_id = public.current_company_id()) with check (company_id = public.current_company_id());
create policy ssa_all on public.invoice_generation_clears for all to public
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
create policy perm_write_ins on public.invoice_generation_clears as restrictive for insert to authenticated
  with check (public.has_perm('invoices.edit'));
create policy perm_write_del on public.invoice_generation_clears as restrictive for delete to authenticated
  using (public.has_perm('invoices.edit'));

grant select, insert, delete on public.invoice_generation_clears to authenticated;
