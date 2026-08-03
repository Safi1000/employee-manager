-- 0158: a failed cheque is BOUNCED, not deleted.
--
-- Deleting destroyed the record of a real banking event. The bank remembers it
-- either way, and a reconciliation with no trace of the failed cheque is
-- unexplainable. The row now survives with status 'bounced', a timestamp and an
-- optional reason.
--
-- Balance handling composes the two paths that already existed rather than
-- inventing a third: bouncing a CLEARED cheque first reverses its clearance
-- (exactly as cleared -> pending does), then applies what deleting a PENDING
-- cheque did. Every movement is written to bank_transactions.
alter table public.cheques drop constraint if exists cheques_status_check;
alter table public.cheques add constraint cheques_status_check
  check (status = any (array['pending'::text, 'cleared'::text, 'bounced'::text]));

alter table public.cheques add column if not exists bounced_at timestamptz;
alter table public.cheques add column if not exists bounce_reason text;

create or replace function public.cheque_bounce()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_receivables boolean;
begin
  -- Only act on the transition INTO bounced.
  if NEW.status <> 'bounced' or OLD.status = 'bounced' then
    return NEW;
  end if;

  is_receivables := (NEW.invoice_id is not null or NEW.client_id is not null);

  -- Step 1: undo a clearance, if the cheque had cleared.
  if OLD.status = 'cleared' then
    if NEW.direction = 'incoming' then
      update public.bank_accounts
         set balance = balance - NEW.amount, updated_at = now()
       where id = NEW.bank_account_id;
      if is_receivables then
        delete from public.invoice_payments where cheque_id = NEW.id;
        if NEW.invoice_id is not null then
          update public.invoices
             set amount_received = greatest(0, amount_received - NEW.amount), updated_at = now()
           where id = NEW.invoice_id;
        end if;
      end if;
      insert into public.bank_transactions
        (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
      values
        (NEW.bank_account_id, 'cheque', NEW.amount, 0, -NEW.amount,
         case when is_receivables then 'Receivables cheque' else 'Deposit cheque' end
         || ' #' || NEW.cheque_number || ' bounced (clearance reversed)', NEW.id);
    elsif NEW.cheque_type = 'cash' then
      update public.treasury
         set cash_balance = cash_balance - NEW.amount, updated_at = now()
       where company_id = NEW.company_id;
      insert into public.bank_transactions
        (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
      values
        (null, 'cheque', NEW.amount, -NEW.amount, 0,
         'Cash cheque #' || NEW.cheque_number || ' bounced (cash reversed)', NEW.id);
    end if;
  end if;

  -- Step 2: the money never left. An outgoing cheque reserved the amount at
  -- issue, so give it back; an incoming one never moved the balance.
  if NEW.direction = 'outgoing' then
    update public.bank_accounts
       set balance = balance + NEW.amount, updated_at = now()
     where id = NEW.bank_account_id;
    insert into public.bank_transactions
      (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
    values
      (NEW.bank_account_id, 'cheque', NEW.amount, 0, NEW.amount,
       'Cheque #' || NEW.cheque_number || ' bounced (bank restored)'
       || coalesce(' — ' || NEW.bounce_reason, ''), NEW.id);
  else
    insert into public.bank_transactions
      (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
    values
      (NEW.bank_account_id, 'cheque', NEW.amount, 0, 0,
       case when is_receivables then 'Receivables cheque' else 'Deposit cheque' end
       || ' #' || NEW.cheque_number || ' bounced (no balance change)'
       || coalesce(' — ' || NEW.bounce_reason, ''), NEW.id);
  end if;

  NEW.cleared_at := null;
  if NEW.bounced_at is null then
    NEW.bounced_at := now();
  end if;
  return NEW;
end;
$$;

-- Runs before the existing balance trigger's UPDATE branch, which only reacts to
-- pending<->cleared and ignores a move to bounced.
drop trigger if exists trg_cheque_bounce on public.cheques;
create trigger trg_cheque_bounce
  before update on public.cheques
  for each row execute function public.cheque_bounce();
