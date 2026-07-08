-- 0068: Invoice generation detail (Phase 6).
--
-- Extends invoices with the Generate-workflow fields and adds invoice_lines /
-- invoice_taxes for itemized, multi-tax invoices. Also broadens the status
-- CHECK to carry payment state (Unpaid / Partly-Paid / Paid) alongside the
-- existing delivery states (Pending / Delivered) so generated invoices post as
-- Unpaid without disturbing the legacy ad-hoc flow.
--
-- Depends on 0063 (contract_line_category) and 0065 (client_invoice_group).

-- ---------------------------------------------------------------------------
-- 1. Broaden the invoice status set.
-- ---------------------------------------------------------------------------
alter table public.invoices drop constraint if exists invoices_status_check;
alter table public.invoices
  add constraint invoices_status_check
  check (status in ('Pending', 'Delivered', 'Unpaid', 'Partly-Paid', 'Paid'));

-- ---------------------------------------------------------------------------
-- 2. Generation fields on invoices.
--    invoice_amount keeps meaning "current-period gross (subtotal + added tax)"
--    and withholding_tax keeps meaning "withheld total", so the existing list's
--    outstanding math (invoice_amount − withholding_tax − amount_received) still
--    holds. The new columns carry the richer breakdown + presentation data.
-- ---------------------------------------------------------------------------
alter table public.invoices
  add column if not exists period_start        date,
  add column if not exists period_end          date,
  add column if not exists subtotal            numeric(14,2) not null default 0,
  add column if not exists tax_added_total      numeric(14,2) not null default 0,
  add column if not exists tax_withheld_total   numeric(14,2) not null default 0,
  add column if not exists previous_balance     numeric(14,2) not null default 0,
  add column if not exists total_due            numeric(14,2) not null default 0,
  add column if not exists amount_in_words      text,
  add column if not exists remit_account        jsonb,
  add column if not exists override_reason      text,
  add column if not exists financial_year       text,
  add column if not exists invoice_group        client_invoice_group,
  add column if not exists generated            boolean not null default false;

-- ---------------------------------------------------------------------------
-- 3. Invoice line items.
-- ---------------------------------------------------------------------------
create table if not exists public.invoice_lines (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  invoice_id   uuid not null references public.invoices(id) on delete cascade,
  category     contract_line_category,
  label        text not null,
  quantity     integer not null default 0,
  unit_rate    numeric(14,2) not null default 0,
  amount       numeric(14,2) not null default 0,
  taxable      boolean not null default true,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists idx_invoice_lines_invoice on public.invoice_lines(invoice_id);
create index if not exists idx_invoice_lines_company on public.invoice_lines(company_id);

-- ---------------------------------------------------------------------------
-- 4. Invoice tax lines (snapshot of the client's tax_profile at generation).
-- ---------------------------------------------------------------------------
create table if not exists public.invoice_taxes (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  invoice_id   uuid not null references public.invoices(id) on delete cascade,
  name         text not null,
  rate         numeric(6,3) not null default 0,
  base         text not null default 'WHOLE_INVOICE',
  direction    text not null default 'ADDED',
  component    text,
  amount       numeric(14,2) not null default 0,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists idx_invoice_taxes_invoice on public.invoice_taxes(invoice_id);
create index if not exists idx_invoice_taxes_company on public.invoice_taxes(company_id);

-- ---------------------------------------------------------------------------
-- 5. Triggers + RLS for the two new tables (same pattern as everywhere).
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['invoice_lines', 'invoice_taxes'] loop
    execute format('drop trigger if exists trg_aaa_%I_fill_company on public.%I', t, t);
    execute format('create trigger trg_aaa_%I_fill_company before insert on public.%I for each row execute function public.fill_company_id()', t, t);

    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "ssa_all" on public.%I', t);
    execute format('create policy "ssa_all" on public.%I for all using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped())', t);
    execute format('drop policy if exists "company_members" on public.%I', t);
    execute format('create policy "company_members" on public.%I for all using (company_id = public.current_company_id()) with check (company_id = public.current_company_id())', t);

    execute format('drop trigger if exists trg_zzz_%I_audit on public.%I', t, t);
    execute format('create trigger trg_zzz_%I_audit after insert or update or delete on public.%I for each row execute function public.log_audit_change()', t, t);
  end loop;
end$$;

-- invoices is already audited (0041): generation / clearing / override edits
-- are captured in the Audit Log automatically.
