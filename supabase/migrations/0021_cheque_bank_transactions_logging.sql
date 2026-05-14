-- Widen bank_transactions.kind to include 'cheque'.
alter table public.bank_transactions drop constraint if exists bank_transactions_kind_check;
alter table public.bank_transactions add constraint bank_transactions_kind_check
  check (kind = any (array[
    'opening','deposit','withdraw_to_cash','payroll','reconcile','adjustment',
    'cash_adjustment','expense','receipt','advance','transfer','cheque'
  ]));

-- Extend the cheque trigger so every cheque lifecycle event lands in the bank ledger.
create or replace function public.cheque_apply_balance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  linked_total numeric(14,2) := 0;
  trea_id uuid;
  type_label text;
begin
  if TG_OP = 'INSERT' then
    update public.bank_accounts
       set balance = balance - NEW.amount,
           updated_at = now()
     where id = NEW.bank_account_id;

    type_label := case when NEW.cheque_type = 'cash' then 'Cash' else 'Payment' end;
    insert into public.bank_transactions (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
    values (NEW.bank_account_id, 'cheque', NEW.amount, 0, -NEW.amount,
            type_label || ' cheque #' || NEW.cheque_number
              || coalesce(' to ' || NEW.recipient, '')
              || ' issued (pending)',
            NEW.id);
    return NEW;
  elsif TG_OP = 'DELETE' then
    if OLD.status = 'pending' then
      update public.bank_accounts
         set balance = balance + OLD.amount,
             updated_at = now()
       where id = OLD.bank_account_id;
      insert into public.bank_transactions (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
      values (OLD.bank_account_id, 'cheque', OLD.amount, 0, OLD.amount,
              'Pending cheque #' || OLD.cheque_number || ' deleted (bank restored)',
              OLD.id);
    elsif OLD.status = 'cleared' and OLD.cheque_type = 'cash' then
      update public.treasury
         set cash_balance = cash_balance - OLD.amount,
             updated_at = now();
      insert into public.bank_transactions (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
      values (null, 'cheque', OLD.amount, -OLD.amount, 0,
              'Cash cheque #' || OLD.cheque_number || ' deleted (cash reversed)',
              OLD.id);
    end if;
    return OLD;
  elsif TG_OP = 'UPDATE' then
    if NEW.amount <> OLD.amount or NEW.bank_account_id <> OLD.bank_account_id then
      raise exception 'Cheque amount and bank account cannot be changed after creation';
    end if;
    if NEW.cheque_type <> OLD.cheque_type then
      raise exception 'Cheque type cannot be changed after creation';
    end if;

    if NEW.status = 'cleared' and OLD.status = 'pending' then
      if NEW.cheque_type = 'payment' then
        select coalesce(sum(amount), 0) into linked_total from (
          select net_salary as amount from public.payslips where cheque_id = NEW.id
          union all
          select amount from public.expenses where cheque_id = NEW.id
          union all
          select amount from public.advances where cheque_id = NEW.id
          union all
          select amount from public.invoice_payments where cheque_id = NEW.id
        ) s;
        if linked_total <> NEW.amount then
          raise exception 'Cannot clear payment cheque: linked items total PKR % but cheque is PKR %', linked_total, NEW.amount;
        end if;
        insert into public.bank_transactions (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
        values (NEW.bank_account_id, 'cheque', NEW.amount, 0, 0,
                'Payment cheque #' || NEW.cheque_number || ' cleared',
                NEW.id);
      elsif NEW.cheque_type = 'cash' then
        select id into trea_id from public.treasury limit 1;
        if trea_id is null then
          raise exception 'No treasury row exists; cannot apply cash cheque clearance';
        end if;
        update public.treasury
           set cash_balance = cash_balance + NEW.amount,
               updated_at = now()
         where id = trea_id;
        insert into public.bank_transactions (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
        values (null, 'cheque', NEW.amount, NEW.amount, 0,
                'Cash cheque #' || NEW.cheque_number || ' cleared (cash credited)',
                NEW.id);
      end if;

      if NEW.cleared_at is null then
        NEW.cleared_at := now();
      end if;
    end if;

    if NEW.status = 'pending' and OLD.status = 'cleared' then
      if NEW.cheque_type = 'cash' then
        update public.treasury
           set cash_balance = cash_balance - NEW.amount,
               updated_at = now();
        insert into public.bank_transactions (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
        values (null, 'cheque', NEW.amount, -NEW.amount, 0,
                'Cash cheque #' || NEW.cheque_number || ' clearance reverted',
                NEW.id);
      else
        insert into public.bank_transactions (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
        values (NEW.bank_account_id, 'cheque', NEW.amount, 0, 0,
                'Payment cheque #' || NEW.cheque_number || ' clearance reverted',
                NEW.id);
      end if;
      NEW.cleared_at := null;
    end if;

    return NEW;
  end if;
  return null;
end;
$$;
