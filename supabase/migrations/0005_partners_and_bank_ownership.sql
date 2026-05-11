-- ============================================================================
-- Partners + bank account ownership + wire transfers.
-- bank_accounts gains owner_type (company/partner/client) and owner_*_id refs.
-- bank_transactions gains 'transfer' kind + transfer_pair_id linking pairs.
-- partners table holds profit share % and one-time opening balance.
-- ============================================================================

create table if not exists public.partners (
  id                        uuid primary key default gen_random_uuid(),
  company_id                uuid not null references public.companies(id) on delete cascade,
  name                      text not null,
  profit_share_percent      numeric(6,3) not null default 0
                              check (profit_share_percent >= 0 and profit_share_percent <= 100),
  opening_balance           numeric(14,2) not null default 0,
  opening_balance_locked    boolean not null default false,
  start_month               date,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (company_id, name)
);
create index if not exists partners_company_idx on public.partners(company_id);

drop trigger if exists trg_partners_updated_at on public.partners;
create trigger trg_partners_updated_at before update on public.partners
  for each row execute function public.set_updated_at();
drop trigger if exists trg_aaa_partners_fill_company on public.partners;
create trigger trg_aaa_partners_fill_company before insert on public.partners
  for each row execute function public.fill_company_id();

alter table public.partners enable row level security;
drop policy if exists "ssa_all" on public.partners;
create policy "ssa_all" on public.partners for all
  using (public.is_ssa_unscoped())
  with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.partners;
create policy "company_members" on public.partners for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- bank_accounts ownership
alter table public.bank_accounts add column if not exists owner_type text
  not null default 'company' check (owner_type in ('company','partner','client'));
alter table public.bank_accounts add column if not exists owner_partner_id uuid
  references public.partners(id) on delete restrict;
alter table public.bank_accounts add column if not exists owner_client_id uuid
  references public.clients(id) on delete restrict;
alter table public.bank_accounts drop constraint if exists bank_accounts_owner_link;
alter table public.bank_accounts add constraint bank_accounts_owner_link check (
  (owner_type = 'company'  and owner_partner_id is null and owner_client_id is null) or
  (owner_type = 'partner'  and owner_partner_id is not null and owner_client_id is null) or
  (owner_type = 'client'   and owner_partner_id is null and owner_client_id is not null)
);
create index if not exists bank_accounts_owner_partner_idx on public.bank_accounts(owner_partner_id);
create index if not exists bank_accounts_owner_client_idx on public.bank_accounts(owner_client_id);

-- bank_transactions: 'transfer' kind + pair id
alter table public.bank_transactions drop constraint if exists bank_transactions_kind_check;
alter table public.bank_transactions add constraint bank_transactions_kind_check check (
  kind in ('opening','deposit','withdraw_to_cash','payroll','reconcile',
           'adjustment','cash_adjustment','expense','receipt','advance','transfer')
);
alter table public.bank_transactions add column if not exists transfer_pair_id uuid;
create index if not exists bank_tx_transfer_pair_idx on public.bank_transactions(transfer_pair_id);
