-- 0499 — Invoices ▸ Generate splits into two tabs.
--
--   "Invoice"         — the receivable. Invoice number, invoice date, period
--                       start, period end and ONE total. No lines, no taxes,
--                       no previous balance. Posts to invoices → journal as
--                       before; the whole total is revenue.
--                       DECIDED (2026-10-07, Shayan): a total-only invoice
--                       carries no sales tax split — tax_added_total = 0, so
--                       post_invoice_journal credits the entire amount to
--                       revenue and nothing to sales_tax_payable.
--
--   "Detailed record" — the old Generate tab (lines, taxes, grid, previous
--                       balance), kept for the company's own record. It is
--                       NOT an invoice: it lives in invoice_records, which no
--                       journal trigger, receivable read or ledger check
--                       touches. Deleting one moves no money.
--
-- 1. invoices.total_only marks the receivable so its PDF renders the
--    total-only layout wherever it is downloaded again.
-- 2. invoice_generation_drafts gains `kind`, so each tab keeps its own draft
--    for the same (contract, period). Existing rows were made by the detailed
--    screen, hence the default.
-- 3. invoice_records holds the posted detailed record.

-- 1 ---------------------------------------------------------------------------
alter table public.invoices
  add column if not exists total_only boolean not null default false;

comment on column public.invoices.total_only is
  '0499: issued from the Generate ▸ Invoice tab — number, date, period and one total, no lines or taxes. Drives the total-only PDF layout.';

-- 2 ---------------------------------------------------------------------------
alter table public.invoice_generation_drafts
  add column if not exists kind text not null default 'detailed';

do $$
declare c record;
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.invoice_generation_drafts'::regclass
                    and conname = 'invoice_generation_drafts_kind_check') then
    alter table public.invoice_generation_drafts
      add constraint invoice_generation_drafts_kind_check check (kind in ('detailed', 'simple'));
  end if;

  -- Drop the (company, contract, period) unique constraint, whatever its name
  -- became through the 0340 rename, and replace it with one that includes kind.
  for c in
    select con.conname
      from pg_constraint con
     where con.conrelid = 'public.invoice_generation_drafts'::regclass
       and con.contype = 'u'
       and (select array_agg(a.attname::text order by a.attname::text)
              from unnest(con.conkey) k
              join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k)
           = array['company_id', 'contract_id', 'period']
  loop
    execute format('alter table public.invoice_generation_drafts drop constraint %I', c.conname);
  end loop;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.invoice_generation_drafts'::regclass
                    and conname = 'invoice_generation_drafts_company_contract_period_kind_key') then
    alter table public.invoice_generation_drafts
      add constraint invoice_generation_drafts_company_contract_period_kind_key
      unique (company_id, contract_id, period, kind);
  end if;
end $$;

-- 3 ---------------------------------------------------------------------------
create table if not exists public.invoice_records (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null,
  branch_id      uuid,
  client_id      uuid not null references public.clients(id) on delete cascade,
  contract_id    uuid references public.contracts(id) on delete cascade,
  period         text not null,            -- 'YYYY-MM', the Generate tab's period key
  invoice_number text not null,
  invoice_date   date not null,
  period_start   date,
  period_end     date,
  invoice_group  text,
  total_due      numeric not null default 0,
  -- Snapshot of the document as generated: the invoice-shaped header fields,
  -- lines, taxes, variable grid and the current-period amount. Enough to
  -- re-render the same PDF; never read as money.
  data           jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  created_by     uuid default auth.uid(),
  unique (company_id, contract_id, period)
);

comment on table public.invoice_records is
  '0499: detailed invoice documents kept for the company''s own record (Generate ▸ Detailed record). NOT a receivable — no journal, no balance, no ledger check reads this table. The receivable is the total-only row in invoices.';

create index if not exists idx_invoice_records_client on public.invoice_records(client_id);

alter table public.invoice_records enable row level security;

drop trigger if exists trg_aaa_invoice_records_fill_company on public.invoice_records;
create trigger trg_aaa_invoice_records_fill_company before insert on public.invoice_records
  for each row execute function public.fill_company_id();

-- Same region as the client, exactly as an invoice inherits it.
drop trigger if exists trg_bbb_invoice_records_region on public.invoice_records;
create trigger trg_bbb_invoice_records_region
  before insert or update of client_id, company_id on public.invoice_records
  for each row execute function public.inherit_region_invoice();

drop policy if exists company_members on public.invoice_records;
create policy company_members on public.invoice_records for all to public
  using (company_id = public.current_company_id()) with check (company_id = public.current_company_id());
drop policy if exists ssa_all on public.invoice_records;
create policy ssa_all on public.invoice_records for all to public
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists branch_scope on public.invoice_records;
create policy branch_scope on public.invoice_records as restrictive for all
  using (not public.is_branched_user() or public.is_super_super_admin() or branch_id = public.current_branch_id())
  with check (not public.is_branched_user() or public.is_super_super_admin() or branch_id = public.current_branch_id());
drop policy if exists perm_read on public.invoice_records;
create policy perm_read on public.invoice_records as restrictive for select to authenticated
  using (public.has_perm('invoices.view') or public.has_perm('invoices.edit'));
drop policy if exists perm_write_ins on public.invoice_records;
create policy perm_write_ins on public.invoice_records as restrictive for insert to authenticated
  with check (public.has_perm('invoices.edit'));
drop policy if exists perm_write_del on public.invoice_records;
create policy perm_write_del on public.invoice_records as restrictive for delete to authenticated
  using (public.has_perm('invoices.edit'));

grant select, insert, delete on public.invoice_records to authenticated;

-- Tenant guard assertion (scripts/migration-template.sql).
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0499 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
