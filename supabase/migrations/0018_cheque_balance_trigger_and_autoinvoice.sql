-- ============================================================================
-- ADDITIVE migration. No data loss.
-- 1) Trigger that maintains bank_accounts.balance when cheques are created /
--    deleted while still pending. Cleared cheques stay deducted forever.
-- 2) Monthly auto-invoice job: runs on the 1st via pg_cron. Issues invoices for
--    every client where auto_invoice_enabled is true and the contract window
--    covers the issued period. advance_payment=true -> period is current month;
--    false -> previous month (arrears).
-- ============================================================================

-- ---------- 1. Cheque -> bank balance trigger ----------
create or replace function public.cheque_apply_balance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'INSERT' then
    update public.bank_accounts
       set balance = balance - NEW.amount,
           updated_at = now()
     where id = NEW.bank_account_id;
    return NEW;
  elsif TG_OP = 'DELETE' then
    if OLD.status = 'pending' then
      update public.bank_accounts
         set balance = balance + OLD.amount,
             updated_at = now()
       where id = OLD.bank_account_id;
    end if;
    return OLD;
  elsif TG_OP = 'UPDATE' then
    -- Allow status flips (pending<->cleared) without balance side-effects.
    -- Disallow editing amount/bank_account_id post-insert to keep ledger sane.
    if NEW.amount <> OLD.amount or NEW.bank_account_id <> OLD.bank_account_id then
      raise exception 'Cheque amount and bank account cannot be changed after creation';
    end if;
    if NEW.status = 'cleared' and OLD.status = 'pending' and NEW.cleared_at is null then
      NEW.cleared_at := now();
    end if;
    if NEW.status = 'pending' and OLD.status = 'cleared' then
      NEW.cleared_at := null;
    end if;
    return NEW;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_cheque_balance on public.cheques;
create trigger trg_cheque_balance
  before update on public.cheques
  for each row execute function public.cheque_apply_balance();

drop trigger if exists trg_cheque_balance_iu on public.cheques;
create trigger trg_cheque_balance_iu
  after insert or delete on public.cheques
  for each row execute function public.cheque_apply_balance();

-- ---------- 2. Auto-invoice issuer ----------
-- Returns the next sequential invoice number for a company within a month.
create or replace function public.next_invoice_number(p_company uuid, p_date date)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  yyyymm text := to_char(p_date, 'YYYYMM');
  n int;
  candidate text;
begin
  select coalesce(max(
    case
      when invoice_number ~ ('^INV-' || yyyymm || '-[0-9]+$')
      then substring(invoice_number from '[0-9]+$')::int
      else 0
    end
  ), 0) + 1
    into n
    from public.invoices i
    join public.clients c on c.id = i.client_id
   where c.company_id = p_company
     and to_char(i.invoice_date, 'YYYYMM') = yyyymm;
  candidate := 'INV-' || yyyymm || '-' || lpad(n::text, 4, '0');
  return candidate;
end;
$$;

-- Issues auto invoices for every eligible client. Idempotent per (client, period).
-- p_run_date is the date the job is firing (defaults to today). Issued invoice
-- is dated 1st of the period it represents.
create or replace function public.run_auto_invoices(p_run_date date default current_date)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
  period_start date;
  inv_number text;
  issued int := 0;
begin
  for rec in
    select c.id as client_id, c.company_id, c.auto_invoice_amount, c.advance_payment,
           c.contract_start, c.contract_end
      from public.clients c
     where c.auto_invoice_enabled = true
       and coalesce(c.auto_invoice_amount, 0) > 0
  loop
    -- Advance: invoice for the CURRENT month at start of month.
    -- Arrears: invoice for the PREVIOUS month at start of run month.
    if rec.advance_payment then
      period_start := date_trunc('month', p_run_date)::date;
    else
      period_start := (date_trunc('month', p_run_date) - interval '1 month')::date;
    end if;

    -- Contract window guard (inclusive).
    if rec.contract_start is not null and period_start < rec.contract_start then
      continue;
    end if;
    if rec.contract_end is not null and period_start > rec.contract_end then
      continue;
    end if;

    -- Idempotency: don't double-issue for the same (client, period_start).
    if exists (
      select 1 from public.invoices
       where client_id = rec.client_id
         and invoice_date = period_start
         and invoice_amount = rec.auto_invoice_amount
    ) then
      continue;
    end if;

    inv_number := public.next_invoice_number(rec.company_id, period_start);

    insert into public.invoices (
      client_id, invoice_number, invoice_date, invoice_amount,
      withholding_tax, amount_received, status, notes
    ) values (
      rec.client_id, inv_number, period_start, rec.auto_invoice_amount,
      0, 0, 'Pending',
      'Auto-issued for ' || to_char(period_start, 'Mon YYYY')
    );
    issued := issued + 1;
  end loop;
  return issued;
end;
$$;

grant execute on function public.run_auto_invoices(date) to authenticated;

-- Schedule via pg_cron if available. Job fires at 02:00 UTC on the 1st of every month.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('auto-invoices-monthly')
      where exists (select 1 from cron.job where jobname = 'auto-invoices-monthly');
    perform cron.schedule(
      'auto-invoices-monthly',
      '0 2 1 * *',
      $cron$ select public.run_auto_invoices(current_date); $cron$
    );
  end if;
exception when others then
  -- pg_cron may not be installed in local/dev; ignore silently.
  null;
end $$;
