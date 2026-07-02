-- 0062: Cash deposits (Cash in Hand -> bank account) — Phase 4.
-- Atomic RPC moves money from the company treasury (Cash in Hand) into a bank
-- account: it is a pure location transfer, so it must NOT create an expense,
-- payroll, or partner-ledger row. Sequential per-company slip numbers back a
-- downloadable deposit slip PDF.

create table if not exists public.cash_deposits (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  bank_account_id uuid not null references public.bank_accounts(id) on delete cascade,
  amount numeric(14,2) not null check (amount > 0),
  deposit_date date not null,
  slip_number integer not null,
  notes text,
  deposited_by uuid,
  created_at timestamptz not null default now(),
  unique (company_id, slip_number)
);

alter table public.cash_deposits enable row level security;

drop policy if exists company_isolation on public.cash_deposits;
create policy company_isolation on public.cash_deposits for all
  using (company_id = (select profiles.company_id from public.profiles where profiles.id = auth.uid()));

-- Atomic: validate cash, decrement treasury, increment bank, log a bank
-- transaction + an audit entry, and allocate the next per-company slip number.
create or replace function public.record_cash_deposit(
  p_bank_account_id uuid,
  p_amount numeric,
  p_date date,
  p_notes text
) returns public.cash_deposits
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_bank_name text;
  v_cash numeric;
  v_treasury_id uuid;
  v_slip integer;
  v_deposit public.cash_deposits;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount_must_be_positive';
  end if;

  select company_id, bank_name into v_company_id, v_bank_name
  from public.bank_accounts where id = p_bank_account_id;
  if v_company_id is null then
    raise exception 'bank_not_found';
  end if;

  -- Lock the company treasury row and validate available Cash in Hand.
  select id, cash_balance into v_treasury_id, v_cash
  from public.treasury where company_id = v_company_id for update;
  if v_treasury_id is null then
    raise exception 'no_treasury';
  end if;
  if v_cash < p_amount then
    raise exception 'insufficient_cash';
  end if;

  select coalesce(max(slip_number), 0) + 1 into v_slip
  from public.cash_deposits where company_id = v_company_id;

  update public.treasury
    set cash_balance = cash_balance - p_amount, updated_at = now()
    where id = v_treasury_id;
  update public.bank_accounts
    set balance = balance + p_amount, updated_at = now()
    where id = p_bank_account_id;

  insert into public.cash_deposits (company_id, bank_account_id, amount, deposit_date, slip_number, notes, deposited_by)
  values (v_company_id, p_bank_account_id, p_amount, coalesce(p_date, current_date), v_slip, nullif(btrim(p_notes), ''), auth.uid())
  returning * into v_deposit;

  insert into public.bank_transactions
    (company_id, bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id, created_at)
  values
    (v_company_id, p_bank_account_id, 'deposit', p_amount, -p_amount, p_amount,
     'Cash deposit — slip #' || v_slip::text || ' to ' || coalesce(v_bank_name, 'bank'),
     v_deposit.id::text, (coalesce(p_date, current_date)::timestamp + time '12:00'));

  insert into public.audit_log (company_id, table_name, record_id, action, changed_by, changed_at, changes)
  values (v_company_id, 'cash_deposits', v_deposit.id, 'insert', auth.uid(), now(),
          jsonb_build_object(
            'slip_number', jsonb_build_object('after', v_slip),
            'amount', jsonb_build_object('after', p_amount),
            'bank_account_id', jsonb_build_object('after', p_bank_account_id::text)
          ));

  return v_deposit;
end;
$$;

grant execute on function public.record_cash_deposit(uuid, numeric, date, text) to authenticated;
