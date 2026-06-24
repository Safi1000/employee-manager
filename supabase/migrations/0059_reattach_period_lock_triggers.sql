-- Item 4: enforce period close. The accounting_periods table, the
-- is_period_closed()/enforce_period_lock() functions and the Period Close UI
-- all exist (from 0040), but the BEFORE triggers that actually block writes in a
-- closed month are missing in the database — so transactions in closed periods
-- currently go through. This migration recreates the guard functions (idempotent)
-- and re-attaches the triggers to every dated financial table.

create or replace function public.is_period_closed(p_company_id uuid, p_date date)
returns boolean language sql stable security definer as $$
  select exists (
    select 1 from public.accounting_periods
    where company_id = p_company_id
      and period_month = date_trunc('month', p_date)::date
  );
$$;

create or replace function public.enforce_period_lock()
returns trigger language plpgsql as $$
declare
  v_date_col text;
  v_new_date date;
  v_old_date date;
  v_company  uuid;
begin
  v_date_col := tg_argv[0];

  -- Skip when running outside any authenticated company context (server
  -- maintenance / migrations). Trust the caller there.
  if public.current_company_id() is null and not public.is_ssa_unscoped() then
    return coalesce(new, old);
  end if;

  if tg_op = 'DELETE' then
    execute format('select ($1).%I::date, ($1).company_id', v_date_col)
      into v_old_date, v_company using old;
    if public.is_period_closed(v_company, v_old_date) then
      raise exception 'Period for % is closed. Deleting this row is not allowed; reopen the month in Period Close first.', v_old_date
        using errcode = 'P0001';
    end if;
    return old;
  end if;

  execute format('select ($1).%I::date, ($1).company_id', v_date_col)
    into v_new_date, v_company using new;
  if public.is_period_closed(v_company, v_new_date) then
    raise exception 'Period for % is closed. New / edited transactions in a closed month are not allowed; reopen the month in Period Close to continue.', v_new_date
      using errcode = 'P0001';
  end if;

  if tg_op = 'UPDATE' then
    execute format('select ($1).%I::date', v_date_col)
      into v_old_date using old;
    if v_old_date is distinct from v_new_date
       and public.is_period_closed(v_company, v_old_date) then
      raise exception 'Source period for % is closed. Moving a transaction out of a closed month requires reopening it first.', v_old_date
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

do $$
declare
  spec record;
begin
  for spec in
    select * from (values
      ('invoices',          'invoice_date'),
      ('invoice_payments',  'payment_date'),
      ('expenses',          'expense_date'),
      ('payslips',          'period_month'),
      ('advances',          'advance_date'),
      ('cheques',           'cheque_date')
    ) as t(tbl, col)
  loop
    execute format('drop trigger if exists trg_%I_period_lock on public.%I', spec.tbl, spec.tbl);
    execute format(
      'create trigger trg_%I_period_lock
         before insert or update or delete on public.%I
         for each row execute function public.enforce_period_lock(%L)',
      spec.tbl, spec.tbl, spec.col
    );
  end loop;
end$$;
