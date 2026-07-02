-- 0061: Mirror bank accounts into cash_locations so Cash Custody's Cash Position
-- reflects real bank balances (Phase 2 fix — cash_locations was never backfilled).
--
-- Model: a BANK-type cash_location links to its bank_account via bank_account_id
-- and DERIVES its balance from the live bank_accounts.balance (single source of
-- truth — no duplicated balance, so the two can never drift or double-count).
-- Non-bank locations (petty cash / custodians) keep the opening + transfers model.

alter table public.cash_locations
  add column if not exists bank_account_id uuid references public.bank_accounts(id) on delete cascade;

create unique index if not exists cash_locations_bank_account_id_key
  on public.cash_locations(bank_account_id) where bank_account_id is not null;

-- Backfill: one BANK cash_location per existing bank account not already mirrored.
insert into public.cash_locations (company_id, name, location_type, opening_balance, is_active, bank_account_id)
select b.company_id,
       b.bank_name || ' — ' || b.account_number,
       'BANK',
       0,
       b.active,
       b.id
from public.bank_accounts b
where not exists (
  select 1 from public.cash_locations cl where cl.bank_account_id = b.id
);

-- Keep the mirror in sync as bank accounts are created / edited / (de)activated.
create or replace function public.sync_bank_account_cash_location()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (tg_op = 'INSERT') then
    if not exists (select 1 from public.cash_locations where bank_account_id = new.id) then
      insert into public.cash_locations (company_id, name, location_type, opening_balance, is_active, bank_account_id)
      values (new.company_id, new.bank_name || ' — ' || new.account_number, 'BANK', 0, new.active, new.id);
    end if;
  elsif (tg_op = 'UPDATE') then
    update public.cash_locations
      set name = new.bank_name || ' — ' || new.account_number,
          is_active = new.active,
          company_id = new.company_id
    where bank_account_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_bank_account_cash_location on public.bank_accounts;
create trigger trg_sync_bank_account_cash_location
after insert or update on public.bank_accounts
for each row execute function public.sync_bank_account_cash_location();
