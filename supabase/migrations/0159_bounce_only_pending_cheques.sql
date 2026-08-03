-- 0159: only a PENDING cheque can bounce.
--
-- 0158 allowed bouncing a cleared cheque and unwound the clearance to do it. But
-- a cleared cheque has settled: money moved, the invoice payment was recorded,
-- cash or bank was credited. Calling that "bounced" after the fact rewrites a
-- settled event in one step. If a cleared cheque genuinely fails, revert the
-- clearance first — that reversal is already audited — then bounce it, so the
-- two events stay separately recorded.
create or replace function public.cheque_bounce()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_receivables boolean;
begin
  if NEW.status <> 'bounced' or OLD.status = 'bounced' then
    return NEW;
  end if;

  if OLD.status <> 'pending' then
    raise exception 'Only a pending cheque can be bounced. Revert the clearance first, then mark it bounced.';
  end if;

  is_receivables := (NEW.invoice_id is not null or NEW.client_id is not null);

  -- The money never left. An outgoing cheque reserved the amount at issue, so
  -- give it back; an incoming one never moved the balance.
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
