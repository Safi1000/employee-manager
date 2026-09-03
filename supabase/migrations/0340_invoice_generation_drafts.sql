-- 0340 — persist the WHOLE Invoices ▸ Generate draft, not just the Cleared flag.
--
-- 0315 added invoice_generation_clears to persist a draft's "Cleared" status
-- (contract_id, period). But every OTHER field on a Generate-tab draft — the
-- Variable line-item grid (columns/rows), remit account, notes, override total,
-- period dates, invoice number, Fixed line items — still lived only in React
-- state and was wiped when the tab unmounted. This generalises that table into
-- invoice_generation_drafts: the same (company, contract, period) key now also
-- carries a `data` jsonb blob of the editable draft, and `cleared` becomes an
-- explicit column instead of "a row exists". The frontend autosaves the blob
-- and hydrates from it on load, so drafts survive navigation/refresh/sessions.
--
-- Rename + backfill are wrapped so the whole block is a no-op on replay (it only
-- fires while the old clears table still exists).
do $$
begin
  if exists (
        select 1 from information_schema.tables
        where table_schema = 'public' and table_name = 'invoice_generation_clears')
     and not exists (
        select 1 from information_schema.tables
        where table_schema = 'public' and table_name = 'invoice_generation_drafts') then

    alter table public.invoice_generation_clears rename to invoice_generation_drafts;

    alter table public.invoice_generation_drafts
      add column data       jsonb       not null default '{}'::jsonb;
    alter table public.invoice_generation_drafts
      add column cleared    boolean     not null default false;
    alter table public.invoice_generation_drafts
      add column updated_at timestamptz not null default now();

    -- Every row that existed before this migration was a "Cleared" marker.
    update public.invoice_generation_drafts set cleared = true;
  end if;
end $$;

-- Autosave issues UPDATE (and toggling Cleared updates the flag), so the role
-- needs UPDATE and a matching restrictive write-perm policy (0310 pattern:
-- writes require invoices.edit). Insert/delete/select policies already exist and
-- carried over with the rename.
grant update on public.invoice_generation_drafts to authenticated;

do $$
begin
  if not exists (
        select 1 from pg_policies
        where schemaname = 'public'
          and tablename = 'invoice_generation_drafts'
          and policyname = 'perm_write_upd') then
    create policy perm_write_upd on public.invoice_generation_drafts
      as restrictive for update to authenticated
      using (public.has_perm('invoices.edit'))
      with check (public.has_perm('invoices.edit'));
  end if;
end $$;
