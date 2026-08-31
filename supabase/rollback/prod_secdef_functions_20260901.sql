-- ===FUNC 18024 current_company_id()
CREATE OR REPLACE FUNCTION public.current_company_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(p.view_as_company, p.company_id)
  from public.profiles p
  where p.id = auth.uid()
$function$
-- ===END 18024
-- ===FUNC 18025 current_role()
CREATE OR REPLACE FUNCTION public."current_role"()
 RETURNS user_role
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select role from public.profiles where id = auth.uid()
$function$
-- ===END 18025
-- ===FUNC 18026 is_super_super_admin()
CREATE OR REPLACE FUNCTION public.is_super_super_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists(select 1 from public.profiles where id = auth.uid() and role = 'super_super_admin')
$function$
-- ===END 18026
-- ===FUNC 18042 next_counter(p_company_id uuid, p_name text)
CREATE OR REPLACE FUNCTION public.next_counter(p_company_id uuid, p_name text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v bigint;
begin
  insert into public.company_counters (company_id, counter_name, value)
  values (p_company_id, p_name, 1)
  on conflict (company_id, counter_name)
    do update set value = public.company_counters.value + 1
  returning value into v;
  return v;
end;
$function$
-- ===END 18042
-- ===FUNC 18045 seed_company_defaults()
CREATE OR REPLACE FUNCTION public.seed_company_defaults()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.expense_categories (company_id, name)
  select new.id, t.name
  from (values
    ('Weapons & Ammunition'),('Uniform'),('Equipment & Supplies'),
    ('Transportation & Fuel'),('Utilities & Rent'),('Insurance'),
    ('Licenses'),('EOBI'),('IESSI'),('PESSI'),('Taxes')
  ) as t(name)
  on conflict (company_id, name) do nothing;

  insert into public.treasury (company_id, cash_balance) values (new.id, 0)
  on conflict (company_id) do nothing;

  insert into public.notification_settings (company_id) values (new.id)
  on conflict (company_id) do nothing;

  return new;
end;
$function$
-- ===END 18045
-- ===FUNC 18697 is_ssa_unscoped()
CREATE OR REPLACE FUNCTION public.is_ssa_unscoped()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists(
    select 1 from public.profiles
    where id = auth.uid()
      and role = 'super_super_admin'
      and view_as_company is null
  )
$function$
-- ===END 18697
-- ===FUNC 18788 add_subscription_payment(p_company_id uuid, p_amount numeric, p_days integer, p_payment_date date, p_notes text)
CREATE OR REPLACE FUNCTION public.add_subscription_payment(p_company_id uuid, p_amount numeric, p_days integer, p_payment_date date DEFAULT CURRENT_DATE, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  caller_role public.user_role;
  current_expiry date;
  base_date date;
  new_expiry date;
begin
  select role into caller_role from public.profiles where id = auth.uid();
  if caller_role is null or caller_role <> 'super_super_admin' then
    raise exception 'only super_super_admin can manage subscriptions';
  end if;
  if p_days is null or p_days <= 0 then
    raise exception 'days must be positive';
  end if;
  if p_amount is null or p_amount < 0 then
    raise exception 'amount must be non-negative';
  end if;

  select subscription_expires_at into current_expiry
  from public.companies where id = p_company_id;

  -- Extend from the later of: current expiry, today.
  base_date := greatest(coalesce(current_expiry, current_date), current_date);
  new_expiry := base_date + (p_days || ' days')::interval;

  insert into public.subscription_payments
    (company_id, amount, days_added, payment_date, notes, recorded_by)
  values
    (p_company_id, p_amount, p_days, p_payment_date, p_notes, auth.uid());

  update public.companies
  set subscription_expires_at = new_expiry,
      active = true,
      updated_at = now()
  where id = p_company_id;
end;
$function$
-- ===END 18788
-- ===FUNC 18789 enforce_subscription_expiry()
CREATE OR REPLACE FUNCTION public.enforce_subscription_expiry()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  affected integer;
begin
  update public.companies
  set active = false,
      updated_at = now()
  where active = true
    and subscription_expires_at is not null
    and subscription_expires_at < current_date;
  get diagnostics affected = row_count;
  return affected;
end;
$function$
-- ===END 18789
-- ===FUNC 18887 stamp_attendance_marker()
CREATE OR REPLACE FUNCTION public.stamp_attendance_marker()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  new.marked_by_user_id := auth.uid();
  new.marked_by_role := public.current_role();
  return new;
end;
$function$
-- ===END 18887
-- ===FUNC 18988 seed_head_office()
CREATE OR REPLACE FUNCTION public.seed_head_office()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.branches (company_id, name, is_head_office)
  values (new.id, 'Head Office', true)
  on conflict do nothing;
  return new;
end;
$function$
-- ===END 18988
-- ===FUNC 19069 current_branch_id()
CREATE OR REPLACE FUNCTION public.current_branch_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select branch_id from public.profiles where id = auth.uid()
$function$
-- ===END 19069
-- ===FUNC 19070 is_branched_user()
CREATE OR REPLACE FUNCTION public.is_branched_user()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select (select branch_id from public.profiles where id = auth.uid()) is not null
$function$
-- ===END 19070
-- ===FUNC 19089 cheque_apply_balance()
CREATE OR REPLACE FUNCTION public.cheque_apply_balance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  linked_total numeric(14,2) := 0;
  type_label text;
  is_receivables boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.direction = 'incoming' THEN
      is_receivables := (NEW.invoice_id IS NOT NULL OR NEW.client_id IS NOT NULL);
      INSERT INTO public.bank_transactions
        (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
      VALUES
        (NEW.bank_account_id, 'cheque', NEW.amount, 0, 0,
         CASE WHEN is_receivables THEN 'Receivables cheque' ELSE 'Deposit cheque' END
           || ' #' || NEW.cheque_number
           || COALESCE(' from ' || NEW.recipient, '') || ' received (pending)',
         NEW.id);
    ELSE
      UPDATE public.bank_accounts
         SET balance = balance - NEW.amount, updated_at = now()
       WHERE id = NEW.bank_account_id;
      type_label := CASE WHEN NEW.cheque_type = 'cash' THEN 'Cash' ELSE 'Payment' END;
      INSERT INTO public.bank_transactions
        (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
      VALUES
        (NEW.bank_account_id, 'cheque', NEW.amount, 0, -NEW.amount,
         type_label || ' cheque #' || NEW.cheque_number
           || COALESCE(' to ' || NEW.recipient, '') || ' issued (pending)',
         NEW.id);
    END IF;
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.direction = 'incoming' THEN
      is_receivables := (OLD.invoice_id IS NOT NULL OR OLD.client_id IS NOT NULL);
      IF OLD.status = 'pending' THEN
        INSERT INTO public.bank_transactions
          (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
        VALUES
          (OLD.bank_account_id, 'cheque', OLD.amount, 0, 0,
           'Pending ' || CASE WHEN is_receivables THEN 'receivables' ELSE 'deposit' END
           || ' cheque #' || OLD.cheque_number || ' deleted (no balance change)',
           OLD.id);
      ELSIF OLD.status = 'cleared' THEN
        UPDATE public.bank_accounts
           SET balance = balance - OLD.amount, updated_at = now()
         WHERE id = OLD.bank_account_id;
        IF is_receivables THEN
          DELETE FROM public.invoice_payments WHERE cheque_id = OLD.id;
          IF OLD.invoice_id IS NOT NULL THEN
            UPDATE public.invoices
               SET amount_received = GREATEST(0, amount_received - OLD.amount), updated_at = now()
             WHERE id = OLD.invoice_id;
          END IF;
        END IF;
        INSERT INTO public.bank_transactions
          (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
        VALUES
          (OLD.bank_account_id, 'cheque', OLD.amount, 0, -OLD.amount,
           'Cleared ' || CASE WHEN is_receivables THEN 'receivables' ELSE 'deposit' END
           || ' cheque #' || OLD.cheque_number || ' deleted (bank reversed)',
           OLD.id);
      END IF;
    ELSE
      IF OLD.status = 'pending' THEN
        UPDATE public.bank_accounts
           SET balance = balance + OLD.amount, updated_at = now()
         WHERE id = OLD.bank_account_id;
        INSERT INTO public.bank_transactions
          (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
        VALUES
          (OLD.bank_account_id, 'cheque', OLD.amount, 0, OLD.amount,
           'Pending cheque #' || OLD.cheque_number || ' deleted (bank restored)',
           OLD.id);
      ELSIF OLD.status = 'cleared' AND OLD.cheque_type = 'cash' THEN
        UPDATE public.treasury
           SET cash_balance = cash_balance - OLD.amount, updated_at = now()
         WHERE company_id = OLD.company_id;
        INSERT INTO public.bank_transactions
          (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
        VALUES
          (NULL, 'cheque', OLD.amount, -OLD.amount, 0,
           'Cash cheque #' || OLD.cheque_number || ' deleted (cash reversed)',
           OLD.id);
      END IF;
    END IF;
    RETURN OLD;

  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.amount <> OLD.amount OR NEW.bank_account_id <> OLD.bank_account_id THEN
      RAISE EXCEPTION 'Cheque amount and bank account cannot be changed after creation';
    END IF;
    IF NEW.cheque_type <> OLD.cheque_type THEN
      RAISE EXCEPTION 'Cheque type cannot be changed after creation';
    END IF;
    IF NEW.direction <> OLD.direction THEN
      RAISE EXCEPTION 'Cheque direction cannot be changed after creation';
    END IF;

    IF NEW.status = 'cleared' AND OLD.status = 'pending' THEN
      IF NEW.direction = 'incoming' THEN
        is_receivables := (NEW.invoice_id IS NOT NULL OR NEW.client_id IS NOT NULL);
        UPDATE public.bank_accounts
           SET balance = balance + NEW.amount, updated_at = now()
         WHERE id = NEW.bank_account_id;
        INSERT INTO public.bank_transactions
          (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
        VALUES
          (NEW.bank_account_id, 'cheque', NEW.amount, 0, NEW.amount,
           CASE WHEN is_receivables THEN 'Receivables cheque' ELSE 'Deposit cheque' END
           || ' #' || NEW.cheque_number || ' cleared (bank credited)',
           NEW.id);
        IF is_receivables THEN
          INSERT INTO public.invoice_payments
            (invoice_id, client_id, amount, payment_date, payment_mode, bank_account_id, cheque_id, notes)
          VALUES
            (NEW.invoice_id, NEW.client_id, NEW.amount, CURRENT_DATE, 'Cheque', NEW.bank_account_id, NEW.id, NEW.notes);
          IF NEW.invoice_id IS NOT NULL THEN
            UPDATE public.invoices
               SET amount_received = amount_received + NEW.amount, updated_at = now()
             WHERE id = NEW.invoice_id;
          END IF;
        END IF;

      ELSIF NEW.cheque_type = 'payment' THEN
        SELECT COALESCE(SUM(amount), 0) INTO linked_total FROM (
          SELECT net_salary AS amount FROM public.payslips         WHERE cheque_id = NEW.id
          UNION ALL
          SELECT amount               FROM public.expenses         WHERE cheque_id = NEW.id
          UNION ALL
          SELECT amount               FROM public.advances         WHERE cheque_id = NEW.id
          UNION ALL
          SELECT amount               FROM public.invoice_payments WHERE cheque_id = NEW.id
        ) s;
        IF linked_total <> NEW.amount THEN
          RAISE EXCEPTION 'Cannot clear payment cheque: linked items total PKR % but cheque is PKR %',
            linked_total, NEW.amount;
        END IF;
        INSERT INTO public.bank_transactions
          (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
        VALUES
          (NEW.bank_account_id, 'cheque', NEW.amount, 0, 0,
           'Payment cheque #' || NEW.cheque_number || ' cleared', NEW.id);

      ELSIF NEW.cheque_type = 'cash' THEN
        UPDATE public.treasury
           SET cash_balance = cash_balance + NEW.amount, updated_at = now()
         WHERE company_id = NEW.company_id;
        IF NOT FOUND THEN
          INSERT INTO public.treasury (company_id, cash_balance) VALUES (NEW.company_id, NEW.amount);
        END IF;
        INSERT INTO public.bank_transactions
          (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
        VALUES
          (NULL, 'cheque', NEW.amount, NEW.amount, 0,
           'Cash cheque #' || NEW.cheque_number || ' cleared (cash credited)', NEW.id);
      END IF;
      IF NEW.cleared_at IS NULL THEN
        NEW.cleared_at := NOW();
      END IF;
    END IF;

    IF NEW.status = 'pending' AND OLD.status = 'cleared' THEN
      IF NEW.direction = 'incoming' THEN
        is_receivables := (NEW.invoice_id IS NOT NULL OR NEW.client_id IS NOT NULL);
        UPDATE public.bank_accounts
           SET balance = balance - NEW.amount, updated_at = now()
         WHERE id = NEW.bank_account_id;
        IF is_receivables THEN
          DELETE FROM public.invoice_payments WHERE cheque_id = NEW.id;
          IF NEW.invoice_id IS NOT NULL THEN
            UPDATE public.invoices
               SET amount_received = GREATEST(0, amount_received - NEW.amount), updated_at = now()
             WHERE id = NEW.invoice_id;
          END IF;
        END IF;
        INSERT INTO public.bank_transactions
          (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
        VALUES
          (NEW.bank_account_id, 'cheque', NEW.amount, 0, -NEW.amount,
           CASE WHEN is_receivables THEN 'Receivables cheque' ELSE 'Deposit cheque' END
           || ' #' || NEW.cheque_number || ' clearance reverted', NEW.id);
      ELSIF NEW.cheque_type = 'cash' THEN
        UPDATE public.treasury
           SET cash_balance = cash_balance - NEW.amount, updated_at = now()
         WHERE company_id = NEW.company_id;
        INSERT INTO public.bank_transactions
          (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
        VALUES
          (NULL, 'cheque', NEW.amount, -NEW.amount, 0,
           'Cash cheque #' || NEW.cheque_number || ' clearance reverted', NEW.id);
      ELSE
        INSERT INTO public.bank_transactions
          (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
        VALUES
          (NEW.bank_account_id, 'cheque', NEW.amount, 0, 0,
           'Payment cheque #' || NEW.cheque_number || ' clearance reverted', NEW.id);
      END IF;
      NEW.cleared_at := NULL;
    END IF;

    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$function$
-- ===END 19089
-- ===FUNC 19092 next_invoice_number(p_company uuid, p_date date)
CREATE OR REPLACE FUNCTION public.next_invoice_number(p_company uuid, p_date date)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
-- ===END 19092
-- ===FUNC 19093 run_auto_invoices(p_run_date date)
CREATE OR REPLACE FUNCTION public.run_auto_invoices(p_run_date date DEFAULT CURRENT_DATE)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  rec record;
  period_start date;
  inv_number text;
  v_contract uuid;
  issued int := 0;
begin
  for rec in
    select c.id as client_id, c.company_id, c.auto_invoice_amount, c.advance_payment,
           c.auto_invoice_withholding, c.contract_start, c.contract_end
      from public.clients c
     where c.auto_invoice_enabled = true
       and coalesce(c.auto_invoice_amount, 0) > 0
       and c.company_id is not null
  loop
    if rec.advance_payment then
      period_start := date_trunc('month', p_run_date)::date;
    else
      period_start := (date_trunc('month', p_run_date) - interval '1 month')::date;
    end if;

    if rec.contract_start is not null and period_start < rec.contract_start then
      continue;
    end if;
    if rec.contract_end is not null and period_start > rec.contract_end then
      continue;
    end if;

    if exists (
      select 1 from public.invoices
       where client_id = rec.client_id
         and invoice_date = period_start
         and invoice_amount = rec.auto_invoice_amount
    ) then
      continue;
    end if;

    -- The contract in force for the billed period. Left null when the client has
    -- none or more than one could apply — never guessed.
    select k.id into v_contract
      from public.contracts k
     where k.client_id = rec.client_id
       and k.status = 'active'
       and k.start_date <= period_start
       and (k.is_infinite or k.end_date is null or k.end_date >= period_start)
     limit 2;
    if (select count(*) from public.contracts k
         where k.client_id = rec.client_id
           and k.status = 'active'
           and k.start_date <= period_start
           and (k.is_infinite or k.end_date is null or k.end_date >= period_start)) <> 1 then
      v_contract := null;
    end if;

    inv_number := public.next_invoice_number(rec.company_id, period_start);

    insert into public.invoices (
      company_id, client_id, contract_id, invoice_number, invoice_date, invoice_amount,
      withholding_tax, amount_received, status, notes
    ) values (
      rec.company_id, rec.client_id, v_contract, inv_number, period_start, rec.auto_invoice_amount,
      coalesce(rec.auto_invoice_withholding, 0), 0, 'Pending',
      'Auto-issued for ' || to_char(period_start, 'Mon YYYY')
    );
    issued := issued + 1;
  end loop;
  return issued;
end;
$function$
-- ===END 19093
-- ===FUNC 19139 assert_cheque_capacity(p_cheque uuid)
CREATE OR REPLACE FUNCTION public.assert_cheque_capacity(p_cheque uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  chq_amount numeric(14,2);
  total numeric(14,2);
begin
  if p_cheque is null then return; end if;
  select amount into chq_amount from public.cheques where id = p_cheque;
  if chq_amount is null then return; end if;

  select coalesce(sum(amount), 0) into total from (
    select net_salary as amount from public.payslips where cheque_id = p_cheque
    union all
    select amount from public.expenses where cheque_id = p_cheque
    union all
    select amount from public.advances where cheque_id = p_cheque
    union all
    select amount from public.invoice_payments where cheque_id = p_cheque
  ) s;

  if total > chq_amount then
    raise exception 'Cheque capacity exceeded: linked items total PKR % > cheque amount PKR %', total, chq_amount;
  end if;
end;
$function$
-- ===END 19139
-- ===FUNC 19140 check_cheque_capacity_trigger()
CREATE OR REPLACE FUNCTION public.check_cheque_capacity_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if NEW.cheque_id is not null then
    perform public.assert_cheque_capacity(NEW.cheque_id);
  end if;
  return NEW;
end;
$function$
-- ===END 19140
-- ===FUNC 19196 user_can_see_employee(p_employee uuid)
CREATE OR REPLACE FUNCTION public.user_can_see_employee(p_employee uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  emp_branch uuid;
begin
  if not public.is_branched_user() or public.is_super_super_admin() then
    return true;
  end if;
  select branch_id into emp_branch from public.employees where id = p_employee;
  if emp_branch is null then
    return public.employee_in_branch(p_employee, public.current_branch_id());
  end if;
  return emp_branch = public.current_branch_id()
      or public.employee_in_branch(p_employee, public.current_branch_id());
end;
$function$
-- ===END 19196
-- ===FUNC 19207 employee_in_branch(p_employee uuid, p_branch uuid)
CREATE OR REPLACE FUNCTION public.employee_in_branch(p_employee uuid, p_branch uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.employee_branches
     where employee_id = p_employee
       and branch_id = p_branch
  );
$function$
-- ===END 19207
-- ===FUNC 19208 employee_company_id(p_employee uuid)
CREATE OR REPLACE FUNCTION public.employee_company_id(p_employee uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select company_id from public.employees where id = p_employee;
$function$
-- ===END 19208
-- ===FUNC 19242 client_contract_history_set_company()
CREATE OR REPLACE FUNCTION public.client_contract_history_set_company()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.company_id is null then
    select c.company_id into new.company_id
      from public.clients c
     where c.id = new.client_id;
  end if;
  if new.renewed_by is null then
    new.renewed_by := auth.uid();
  end if;
  return new;
end;
$function$
-- ===END 19242
-- ===FUNC 19281 tasks_set_defaults()
CREATE OR REPLACE FUNCTION public.tasks_set_defaults()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.company_id is null then
    new.company_id := public.current_company_id();
  end if;
  if new.created_by is null then
    new.created_by := auth.uid();
  end if;
  new.updated_at := now();
  return new;
end;
$function$
-- ===END 19281
-- ===FUNC 19289 attendance_records_enforce_reliever()
CREATE OR REPLACE FUNCTION public.attendance_records_enforce_reliever()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  emp_category text;
  emp_client   uuid;
  v_client     uuid;
begin
  if public.is_maintenance_session() then
    return new;
  end if;

  select category::text, client_id into emp_category, emp_client
    from public.employees
   where id = new.employee_id;

  if emp_category = 'reliever' then
    if lower(new.status) = 'present' and new.worked_for_client_id is null then
      raise exception 'Relievers marked present must record worked_for_client_id'
        using errcode = '23514';
    end if;
    if lower(new.status) <> 'present' then
      new.worked_for_client_id := null;
    end if;
  else
    v_client := public.deployment_client_on(new.employee_id, new.attendance_date);
    new.worked_for_client_id := coalesce(v_client, emp_client);
  end if;
  return new;
end;
$function$
-- ===END 19289
-- ===FUNC 19338 invoke_send_compliance_alerts()
CREATE OR REPLACE FUNCTION public.invoke_send_compliance_alerts()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_service_key text;
  v_request_id  bigint;
begin
  select decrypted_secret
    into v_service_key
    from vault.decrypted_secrets
   where name = 'service_role_key'
   limit 1;

  if v_service_key is null then
    raise exception
      'Vault secret `service_role_key` is missing. Add the Supabase service-role key under Project Settings -> Vault before running this job.';
  end if;

  select net.http_post(
    url := 'https://mmkfpnshxjcyijhuydgr.supabase.co/functions/v1/send-compliance-alerts',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_service_key,
      'Content-Type',  'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  )
  into v_request_id;

  return v_request_id;
end;
$function$
-- ===END 19338
-- ===FUNC 19475 assign_contract_code()
CREATE OR REPLACE FUNCTION public.assign_contract_code()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  next_seq integer;
begin
  if new.contract_code is null or new.contract_code = '' then
    insert into public.company_counters (company_id, counter_name, value)
      values (new.company_id, 'contract', 1)
      on conflict (company_id, counter_name)
        do update set value = company_counters.value + 1
      returning value into next_seq;
    new.contract_code := 'CON-' || lpad(next_seq::text, 4, '0');
  end if;
  return new;
end;
$function$
-- ===END 19475
-- ===FUNC 19683 assign_incident_code()
CREATE OR REPLACE FUNCTION public.assign_incident_code()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  next_seq integer;
begin
  if new.incident_code is null or new.incident_code = '' then
    insert into public.company_counters (company_id, counter_name, value)
      values (new.company_id, 'incident', 1)
      on conflict (company_id, counter_name)
        do update set value = company_counters.value + 1
      returning value into next_seq;
    new.incident_code := 'INC-' || lpad(next_seq::text, 4, '0');
  end if;
  return new;
end;
$function$
-- ===END 19683
-- ===FUNC 19760 seed_chart_of_accounts(p_company_id uuid)
CREATE OR REPLACE FUNCTION public.seed_chart_of_accounts(p_company_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.chart_of_accounts
    (company_id, account_code, account_name, account_type, normal_side, system_key, system_account, is_control)
  values
    (p_company_id, '1000', 'Cash in Hand',                    'asset',     'debit',  'cash',                          true, true),
    (p_company_id, '1010', 'Bank Accounts',                   'asset',     'debit',  'bank',                          true, true),
    (p_company_id, '1100', 'Accounts Receivable',             'asset',     'debit',  'ar',                            true, true),
    (p_company_id, '1110', 'Employee Advances Receivable',    'asset',     'debit',  'employee_advances_receivable',  true, true),
    (p_company_id, '1150', 'Withholding Tax Receivable',      'asset',     'debit',  'wht_receivable',                true, false),
    (p_company_id, '1200', 'Inventory — Weapons',             'asset',     'debit',  'inventory_weapons',             true, false),
    (p_company_id, '1210', 'Inventory — Uniforms',            'asset',     'debit',  'inventory_uniforms',            true, false),
    (p_company_id, '1300', 'Inter-Region Receivable',         'asset',     'debit',  'interregion_receivable',        true, false),
    (p_company_id, '1400', 'Fixed Assets — Weapons',          'asset',     'debit',  'fa_weapons',                    true, false),
    (p_company_id, '1410', 'Fixed Assets — Vehicles',         'asset',     'debit',  'fa_vehicles',                   true, false),
    (p_company_id, '1420', 'Fixed Assets — Equipment',        'asset',     'debit',  'fa_equipment',                  true, false),
    (p_company_id, '1430', 'Fixed Assets — Furniture',        'asset',     'debit',  'fa_furniture',                  true, false),
    (p_company_id, '1440', 'Fixed Assets — IT Equipment',     'asset',     'debit',  'fa_it',                         true, false),
    (p_company_id, '1490', 'Accumulated Depreciation',        'asset',     'credit', 'accum_dep',                     true, false),
    (p_company_id, '1500', 'Payroll Reserve',                 'asset',     'debit',  'payroll_reserve',               true, false),
    (p_company_id, '1510', 'Statutory Reserve',               'asset',     'debit',  'statutory_reserve',             true, false),
    (p_company_id, '1520', 'Bonus Reserve',                   'asset',     'debit',  'bonus_reserve',                 true, false),
    (p_company_id, '1530', 'Asset Replacement Reserve',       'asset',     'debit',  'asset_replacement_reserve',     true, false),
    (p_company_id, '1540', 'Emergency Reserve',               'asset',     'debit',  'emergency_reserve',             true, false),
    (p_company_id, '2000', 'Accounts Payable',                'liability', 'credit', 'ap',                            true, true),
    (p_company_id, '2100', 'Salaries Payable',                'liability', 'credit', 'salaries_payable',              true, true),
    (p_company_id, '2200', 'Withholding Tax Payable',         'liability', 'credit', 'wht_payable',                   true, false),
    (p_company_id, '2300', 'EOBI Payable',                    'liability', 'credit', 'eobi_payable',                  true, true),
    (p_company_id, '2400', 'Sales Tax Payable',               'liability', 'credit', 'sales_tax_payable',             true, false),
    (p_company_id, '2450', 'Salary Tax Payable (FBR)',        'liability', 'credit', 'salary_tax_payable',            true, false),
    (p_company_id, '2500', 'Inter-Region Payable',            'liability', 'credit', 'interregion_payable',           true, false),
    (p_company_id, '2600', 'Bonus Provision',                 'liability', 'credit', 'bonus_provision',               true, false),
    (p_company_id, '3000', 'Owner''s Equity',                 'equity',    'credit', 'equity',                        true, false),
    (p_company_id, '3100', 'Retained Earnings',               'equity',    'credit', 'retained_earnings',             true, false),
    (p_company_id, '3200', 'Opening Balance Equity',          'equity',    'credit', 'opening_balance_equity',        true, false),
    (p_company_id, '4000', 'Security Services Revenue',       'revenue',   'credit', 'revenue_security',              true, false),
    (p_company_id, '4100', 'Guard Deployment Revenue',        'revenue',   'credit', 'revenue_guard',                 true, false),
    (p_company_id, '4200', 'Gain on Asset Disposal',          'revenue',   'credit', 'gain_disposal',                 true, false),
    (p_company_id, '5000', 'Guard Payroll & Salaries',        'expense',   'debit',  'cos_payroll',                   true, false),
    (p_company_id, '5100', 'Guard Statutory (EOBI/IESSI/PESSI)','expense', 'debit',  'cos_statutory',                 true, false),
    (p_company_id, '5200', 'Transportation & Fuel',           'expense',   'debit',  'cos_transport',                 true, false),
    (p_company_id, '5300', 'Equipment & Supplies',            'expense',   'debit',  'cos_equipment',                 true, false),
    (p_company_id, '5900', 'Other Cost of Services',          'expense',   'debit',  'cos_other',                     true, false),
    (p_company_id, '6000', 'Office Salaries',                 'expense',   'debit',  'opex_office_payroll',           true, false),
    (p_company_id, '6100', 'Utilities & Rent (HQ)',           'expense',   'debit',  'opex_utilities',                true, false),
    (p_company_id, '6200', 'Insurance',                       'expense',   'debit',  'opex_insurance',                true, false),
    (p_company_id, '6300', 'Licences (company-level)',        'expense',   'debit',  'opex_licences',                 true, false),
    (p_company_id, '6400', 'Regional Partner Remuneration',   'expense',   'debit',  'regional_partner_remuneration', true, false),
    (p_company_id, '6500', 'Depreciation Expense',            'expense',   'debit',  'dep_expense',                   true, false),
    (p_company_id, '6600', 'Bonus Expense',                   'expense',   'debit',  'bonus_expense',                 true, false),
    (p_company_id, '6700', 'Loss on Asset Disposal',          'expense',   'debit',  'loss_disposal',                 true, false),
    (p_company_id, '6800', 'Allocated Head Office Cost',      'expense',   'debit',  'allocated_ho_cost',             true, false),
    (p_company_id, '6850', 'Head Office Cost Recovery',       'expense',   'credit', 'ho_cost_recovery',              true, false),
    (p_company_id, '6900', 'Other Operating Expenses',        'expense',   'debit',  'opex_other',                    true, false),
    (p_company_id, '7000', 'Income Tax',                      'expense',   'debit',  'income_tax',                    true, false)
  on conflict (company_id, account_code) do nothing;

  update public.chart_of_accounts
     set is_control = true
   where company_id = p_company_id
     and system_key in ('cash','bank','ar','ap','employee_advances_receivable',
                        'salaries_payable','eobi_payable')
     and is_control = false;
end;
$function$
-- ===END 19760
-- ===FUNC 19761 auto_seed_coa_on_company_insert()
CREATE OR REPLACE FUNCTION public.auto_seed_coa_on_company_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.seed_chart_of_accounts(new.id);
  return new;
end;
$function$
-- ===END 19761
-- ===FUNC 19790 is_period_closed(p_company_id uuid, p_date date)
CREATE OR REPLACE FUNCTION public.is_period_closed(p_company_id uuid, p_date date)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  select exists (
    select 1 from public.accounting_periods
    where company_id = p_company_id
      and period_month = date_trunc('month', p_date)::date
  );
$function$
-- ===END 19790
-- ===FUNC 19826 log_audit_change()
CREATE OR REPLACE FUNCTION public.log_audit_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_changes  jsonb := '{}'::jsonb;
  v_record   uuid;
  v_company  uuid;
  v_action   audit_action;
  v_user     uuid;
  v_old      jsonb;
  v_new      jsonb;
  v_key      text;
  v_skip     text[] := array['created_at', 'updated_at'];
begin
  begin v_user := auth.uid(); exception when others then v_user := null; end;
  if tg_op = 'INSERT' then
    v_action := 'insert';
    v_new := to_jsonb(new);
    begin v_record := (v_new->>'id')::uuid; exception when others then v_record := null; end;
    begin v_company := nullif(v_new->>'company_id', '')::uuid; exception when others then v_company := null; end;
    for v_key in select jsonb_object_keys(v_new) loop
      if v_key = any(v_skip) then continue; end if;
      if (v_new->v_key) is not null and (v_new->v_key)::text <> 'null' then
        v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object('after', v_new->v_key));
      end if;
    end loop;
  elsif tg_op = 'UPDATE' then
    v_action := 'update';
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    begin v_record := (v_new->>'id')::uuid; exception when others then v_record := null; end;
    begin v_company := nullif(v_new->>'company_id', '')::uuid; exception when others then v_company := null; end;
    for v_key in select jsonb_object_keys(v_new) loop
      if v_key = any(v_skip) then continue; end if;
      if (v_old->v_key) is distinct from (v_new->v_key) then
        v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object('before', v_old->v_key, 'after', v_new->v_key));
      end if;
    end loop;
    if v_changes = '{}'::jsonb then return new; end if;
  else
    v_action := 'delete';
    v_old := to_jsonb(old);
    begin v_record := (v_old->>'id')::uuid; exception when others then v_record := null; end;
    begin v_company := nullif(v_old->>'company_id', '')::uuid; exception when others then v_company := null; end;
    for v_key in select jsonb_object_keys(v_old) loop
      if v_key = any(v_skip) then continue; end if;
      v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object('before', v_old->v_key));
    end loop;
  end if;

  if v_company is not null
     and not exists (select 1 from public.companies c where c.id = v_company) then
    return coalesce(new, old);
  end if;

  insert into public.audit_log (company_id, table_name, record_id, action, changed_by, changes)
  values (v_company, tg_table_name, v_record, v_action, v_user, v_changes);
  return coalesce(new, old);
end;
$function$
-- ===END 19826
-- ===FUNC 20026 reverse_journal_for_source(p_company_id uuid, p_source_table text, p_source_id uuid, p_date date)
CREATE OR REPLACE FUNCTION public.reverse_journal_for_source(p_company_id uuid, p_source_table text, p_source_id uuid, p_date date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_entry  record;
  v_rev_id uuid;
  v_user   uuid;
begin
  begin v_user := auth.uid(); exception when others then v_user := null; end;

  for v_entry in
    select je.id, je.description
      from public.journal_entries je
     where je.company_id = p_company_id
       and je.source_table = p_source_table
       and je.source_id = p_source_id
       and je.is_reversal = false
       and je.status = 'posted'
       and not exists (
         select 1 from public.journal_entries rev
          where rev.reversal_of_entry_id = je.id)
  loop
    v_rev_id := gen_random_uuid();

    insert into public.journal_entries
      (id, company_id, entry_date, description, source_table, source_id,
       is_reversal, posted_by, status, posting_period, reversal_of_entry_id)
    values
      (v_rev_id, p_company_id, p_date,
       v_entry.description || ' (reversal)',
       p_source_table, p_source_id, true, v_user,
       'posted', date_trunc('month', p_date)::date, v_entry.id);

    insert into public.journal_lines
      (journal_entry_id, account_id, debit, credit, branch_id,
       client_id, employee_id, partner_id, contract_id, cost_center)
    select v_rev_id, jl.account_id, jl.credit, jl.debit, jl.branch_id,
           jl.client_id, jl.employee_id, jl.partner_id, jl.contract_id, jl.cost_center
      from public.journal_lines jl
     where jl.journal_entry_id = v_entry.id;

    update public.journal_entries set status = 'reversed' where id = v_entry.id;
  end loop;
end;
$function$
-- ===END 20026
-- ===FUNC 20027 journal_on_invoice()
CREATE OR REPLACE FUNCTION public.journal_on_invoice()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_old_date date;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(
      old.company_id, 'invoices', old.id,
      coalesce(old.period_start, old.invoice_date));
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.invoice_amount is distinct from new.invoice_amount
       or coalesce(old.tax_added_total, 0) is distinct from coalesce(new.tax_added_total, 0)
       or old.period_start is distinct from new.period_start
       or old.invoice_date is distinct from new.invoice_date
       or old.client_id is distinct from new.client_id
       or old.branch_id is distinct from new.branch_id then
      v_old_date := coalesce(old.period_start, old.invoice_date);
      perform public.reverse_journal_for_source(new.company_id, 'invoices', new.id, v_old_date);
    else
      return new;
    end if;
  end if;

  perform public.post_invoice_journal(new.id);
  return new;
end;
$function$
-- ===END 20027
-- ===FUNC 20029 journal_on_invoice_payment()
CREATE OR REPLACE FUNCTION public.journal_on_invoice_payment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dr_line jsonb;
  v_wht     numeric;
  v_client  uuid;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'invoice_payments', old.id, old.payment_date);
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.amount is distinct from new.amount
       or coalesce(old.withholding_amount, 0) is distinct from coalesce(new.withholding_amount, 0)
       or old.branch_id is distinct from new.branch_id
       or old.cash_location_id is distinct from new.cash_location_id then
      perform public.reverse_journal_for_source(new.company_id, 'invoice_payments', new.id, old.payment_date);
    else
      return new;
    end if;
  end if;

  v_wht := coalesce(new.withholding_amount, 0);
  v_client := coalesce(new.client_id, (select i.client_id from public.invoices i where i.id = new.invoice_id));

  v_dr_line := case
    when new.payment_mode = 'Cash' then jsonb_build_object(
      'account_id', public.cash_account_for(new.company_id, new.cash_location_id),
      'debit', new.amount, 'credit', 0)
    else jsonb_build_object('key', 'bank', 'debit', new.amount, 'credit', 0)
  end;

  perform public.post_journal(
    new.company_id, new.payment_date,
    'Payment received',
    'invoice_payments', new.id, false,
    jsonb_build_array(v_dr_line)
    || jsonb_build_array(
         jsonb_build_object('key', 'wht_receivable', 'debit', v_wht, 'credit', 0,
                            'client_id', v_client),
         jsonb_build_object('key', 'ar', 'debit', 0, 'credit', new.amount + v_wht,
                            'client_id', v_client)
       ),
    new.branch_id
  );
  return new;
end;
$function$
-- ===END 20029
-- ===FUNC 20032 journal_on_expense()
CREATE OR REPLACE FUNCTION public.journal_on_expense()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_exp_key  text;
  v_cr_line  jsonb;
  v_cat_name text;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'expenses', old.id, old.expense_date);
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.amount is distinct from new.amount
       or old.payment_mode is distinct from new.payment_mode
       or old.category_id is distinct from new.category_id
       or old.branch_id is distinct from new.branch_id
       or old.cash_location_id is distinct from new.cash_location_id then
      perform public.reverse_journal_for_source(new.company_id, 'expenses', new.id, old.expense_date);
    else
      return new;
    end if;
  end if;

  select name into v_cat_name from public.expense_categories where id = new.category_id;
  v_exp_key := public.map_expense_to_coa_key(coalesce(v_cat_name, ''), new.pl_category::text, new.client_id);

  v_cr_line := case
    when new.payment_mode = 'Cash' then jsonb_build_object(
      'account_id', public.cash_account_for(new.company_id, new.cash_location_id),
      'debit', 0, 'credit', new.amount)
    when new.payment_mode in ('Bank', 'Cheque') then jsonb_build_object(
      'key', 'bank', 'debit', 0, 'credit', new.amount)
    else jsonb_build_object('key', 'ap', 'debit', 0, 'credit', new.amount)
  end;

  perform public.post_journal(
    new.company_id, new.expense_date,
    coalesce(v_cat_name, 'Expense') || coalesce(' — ' || new.description, ''),
    'expenses', new.id, false,
    jsonb_build_array(
      jsonb_build_object('key', v_exp_key, 'debit', new.amount, 'credit', 0)
    ) || jsonb_build_array(v_cr_line),
    new.branch_id
  );
  return new;
end;
$function$
-- ===END 20032
-- ===FUNC 20034 journal_on_payslip()
CREATE OR REPLACE FUNCTION public.journal_on_payslip()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'payslips', old.id, old.period_month);
    perform public.reverse_journal_for_source(old.company_id, 'payslips_disbursement', old.id,
              coalesce(old.disbursed_at::date, old.period_month));
    return old;
  end if;

  if tg_op = 'INSERT' then
    perform public.post_payslip_accrual(new.id);
    if new.disbursed then perform public.post_payslip_disbursement(new.id); end if;
    return new;
  end if;

  if old.final_salary  is distinct from new.final_salary
     or old.advance    is distinct from new.advance
     or old.eobi       is distinct from new.eobi
     or old.income_tax is distinct from new.income_tax
     or coalesce(old.eobi_employer, 0) is distinct from coalesce(new.eobi_employer, 0)
     or old.period_month is distinct from new.period_month
     or old.employee_id  is distinct from new.employee_id
     or old.branch_id    is distinct from new.branch_id then
    perform public.reverse_journal_for_source(new.company_id, 'payslips', new.id, old.period_month);
    perform public.post_payslip_accrual(new.id);
  end if;

  if old.disbursed and not new.disbursed then
    perform public.reverse_journal_for_source(new.company_id, 'payslips_disbursement', new.id,
              coalesce(old.disbursed_at::date, old.period_month));
  elsif new.disbursed and (
          not old.disbursed
       or old.net_salary       is distinct from new.net_salary
       or old.payment_mode     is distinct from new.payment_mode
       or old.cash_location_id is distinct from new.cash_location_id
       or old.disbursed_at     is distinct from new.disbursed_at) then
    perform public.reverse_journal_for_source(new.company_id, 'payslips_disbursement', new.id,
              coalesce(old.disbursed_at::date, old.period_month));
    perform public.post_payslip_disbursement(new.id);
  end if;

  return new;
end;
$function$
-- ===END 20034
-- ===FUNC 20036 journal_on_advance()
CREATE OR REPLACE FUNCTION public.journal_on_advance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_cr_line jsonb;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'advances', old.id, old.advance_date);
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if old.amount is distinct from new.amount
       or old.branch_id is distinct from new.branch_id
       or old.cash_location_id is distinct from new.cash_location_id then
      perform public.reverse_journal_for_source(new.company_id, 'advances', new.id, old.advance_date);
    else
      return new;
    end if;
  end if;

  v_cr_line := case
    when new.payment_mode = 'Cash' then jsonb_build_object(
      'account_id', public.cash_account_for(new.company_id, new.cash_location_id),
      'debit', 0, 'credit', new.amount)
    else jsonb_build_object('key', 'bank', 'debit', 0, 'credit', new.amount)
  end;

  perform public.post_journal(
    new.company_id, new.advance_date,
    'Employee advance',
    'advances', new.id, false,
    jsonb_build_array(
      jsonb_build_object('key', 'employee_advances_receivable',
                         'debit', new.amount, 'credit', 0,
                         'employee_id', new.employee_id,
                         'client_id', new.client_id)
    ) || jsonb_build_array(v_cr_line),
    new.branch_id
  );
  return new;
end;
$function$
-- ===END 20036
-- ===FUNC 20140 update_company_profile(p_name text, p_legal_address text, p_tax_ntn text, p_presentation_currency text, p_fiscal_year_start text, p_logo_url text)
CREATE OR REPLACE FUNCTION public.update_company_profile(p_name text, p_legal_address text, p_tax_ntn text, p_presentation_currency text, p_fiscal_year_start text, p_logo_url text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company uuid;
  v_role public.user_role;
begin
  v_company := public.current_company_id();
  v_role := public.current_role();
  if v_company is null then
    raise exception 'No company in context';
  end if;
  if v_role not in ('super_admin', 'super_super_admin') then
    raise exception 'Not authorised to edit company profile';
  end if;

  update public.companies set
    name                  = coalesce(nullif(btrim(p_name), ''), name),
    legal_address         = p_legal_address,
    tax_ntn               = p_tax_ntn,
    presentation_currency = coalesce(nullif(p_presentation_currency, ''), presentation_currency),
    fiscal_year_start     = coalesce(nullif(p_fiscal_year_start, ''), fiscal_year_start),
    logo_url              = p_logo_url,
    updated_at            = now()
  where id = v_company;
end;
$function$
-- ===END 20140
-- ===FUNC 20249 cascade_client_branch_to_employees()
CREATE OR REPLACE FUNCTION public.cascade_client_branch_to_employees()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.branch_id is not null and new.branch_id is distinct from old.branch_id then
    update public.employees
      set branch_id = new.branch_id, updated_at = now()
      where client_id = new.id
        and branch_id is distinct from new.branch_id;

    delete from public.employee_branches eb
      using public.employees e
      where eb.employee_id = e.id
        and e.client_id = new.id
        and eb.branch_id = new.branch_id;
  end if;
  return new;
end;
$function$
-- ===END 20249
-- ===FUNC 20279 apply_monthly_account_zeroing()
CREATE OR REPLACE FUNCTION public.apply_monthly_account_zeroing()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  acct record;
  m date;
  cur_month date := date_trunc('month', now())::date;  -- first day of the current (incomplete) month
  start_m date;
  net numeric(14,2);
begin
  for acct in
    select id, last_zeroed_month, created_at
    from public.bank_accounts
    where auto_zero_monthly = true
  loop
    -- Start from the month after the last one we zeroed, otherwise from the
    -- account's first activity month.
    if acct.last_zeroed_month is not null then
      start_m := (acct.last_zeroed_month + interval '1 month')::date;
    else
      start_m := date_trunc('month', coalesce(
        (select min(created_at) from public.bank_transactions where bank_account_id = acct.id),
        acct.created_at,
        now()
      ))::date;
    end if;

    m := start_m;
    while m < cur_month loop
      -- Net account movement within month m. Because every prior month has been
      -- zeroed, the start-of-month balance is 0, so this equals the end-of-month
      -- balance that needs to be removed.
      select coalesce(sum(account_delta), 0) into net
      from public.bank_transactions
      where bank_account_id = acct.id
        and created_at >= m
        and created_at < (m + interval '1 month');

      if net <> 0 then
        insert into public.bank_transactions
          (bank_account_id, kind, amount, cash_delta, account_delta, description, created_at)
        values
          (acct.id, 'adjustment', abs(net), 0, -net,
           'Month-end auto-zero (' || to_char(m, 'Mon YYYY') || ')',
           (m + interval '1 month' - interval '1 second'));
      end if;

      m := (m + interval '1 month')::date;
    end loop;

    -- Recompute the live balance from the full ledger (= activity in the current,
    -- still-open month) and record how far we've zeroed.
    update public.bank_accounts b
      set balance = coalesce(
            (select sum(account_delta) from public.bank_transactions where bank_account_id = b.id),
            0),
          last_zeroed_month = (cur_month - interval '1 month')::date,
          updated_at = now()
      where b.id = acct.id;
  end loop;
end;
$function$
-- ===END 20279
-- ===FUNC 20761 sync_bank_account_cash_location()
CREATE OR REPLACE FUNCTION public.sync_bank_account_cash_location()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
-- ===END 20761
-- ===FUNC 20781 record_cash_deposit(p_bank_account_id uuid, p_amount numeric, p_date date, p_notes text)
CREATE OR REPLACE FUNCTION public.record_cash_deposit(p_bank_account_id uuid, p_amount numeric, p_date date, p_notes text)
 RETURNS cash_deposits
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
-- ===END 20781
-- ===FUNC 21185 assign_employee_code(p_employee_id uuid, p_client_id uuid, p_reason text, p_old_code text)
CREATE OR REPLACE FUNCTION public.assign_employee_code(p_employee_id uuid, p_client_id uuid, p_reason text, p_old_code text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company_id uuid;
  v_prefix     text;
  v_n          bigint;
  v_new_code   text;
begin
  select company_id into v_company_id
    from public.employees where id = p_employee_id;
  if v_company_id is null then
    raise exception 'Employee % not found', p_employee_id;
  end if;

  select employee_id_prefix into v_prefix
    from public.clients
   where id = p_client_id and company_id = v_company_id;
  if v_prefix is null then
    raise exception 'NO_PREFIX';
  end if;

  v_n := public.next_counter(v_company_id, 'empid:' || v_prefix);
  v_new_code := v_prefix || '-' || lpad(v_n::text, 3, '0');

  update public.employees
     set employee_code = v_new_code, updated_at = now()
   where id = p_employee_id;

  insert into public.employee_code_history
    (company_id, employee_id, old_code, new_code, client_id, reason, changed_by)
  values
    (v_company_id, p_employee_id, p_old_code, v_new_code, p_client_id, p_reason, auth.uid());

  return v_new_code;
end;
$function$
-- ===END 21185
-- ===FUNC 21186 reassign_client_employee_codes(p_client_id uuid)
CREATE OR REPLACE FUNCTION public.reassign_client_employee_codes(p_client_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r   record;
  cnt integer := 0;
begin
  for r in
    select id, employee_code
      from public.employees
     where client_id = p_client_id
       and category = 'client'
     order by employee_code
  loop
    perform public.assign_employee_code(r.id, p_client_id, 'prefix_changed', r.employee_code);
    cnt := cnt + 1;
  end loop;
  return cnt;
end;
$function$
-- ===END 21186
-- ===FUNC 21187 count_client_employees(p_client_id uuid)
CREATE OR REPLACE FUNCTION public.count_client_employees(p_client_id uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select count(*)::integer
    from public.employees
   where client_id = p_client_id and category = 'client';
$function$
-- ===END 21187
-- ===FUNC 21213 head_office_region(p_company_id uuid)
CREATE OR REPLACE FUNCTION public.head_office_region(p_company_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select id from public.branches
   where company_id = p_company_id and is_head_office
   limit 1;
$function$
-- ===END 21213
-- ===FUNC 21214 region_for_client(p_client_id uuid)
CREATE OR REPLACE FUNCTION public.region_for_client(p_client_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select branch_id from public.clients where id = p_client_id;
$function$
-- ===END 21214
-- ===FUNC 21215 region_for_employee(p_employee_id uuid)
CREATE OR REPLACE FUNCTION public.region_for_employee(p_employee_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(e.branch_id, c.branch_id)
    from public.employees e
    left join public.clients c on c.id = e.client_id
   where e.id = p_employee_id;
$function$
-- ===END 21215
-- ===FUNC 21234 inherit_region_invoice()
CREATE OR REPLACE FUNCTION public.inherit_region_invoice()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  new.branch_id := coalesce(
    public.region_for_client(new.client_id),
    public.head_office_region(new.company_id)
  );
  return new;
end;
$function$
-- ===END 21234
-- ===FUNC 21236 inherit_region_invoice_payment()
CREATE OR REPLACE FUNCTION public.inherit_region_invoice_payment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_region uuid;
begin
  select i.branch_id into v_region from public.invoices i where i.id = new.invoice_id;
  new.branch_id := coalesce(
    v_region,
    public.region_for_client(new.client_id),
    public.head_office_region(new.company_id)
  );
  return new;
end;
$function$
-- ===END 21236
-- ===FUNC 21238 inherit_region_payslip()
CREATE OR REPLACE FUNCTION public.inherit_region_payslip()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  new.branch_id := coalesce(
    public.region_for_employee(new.employee_id),
    public.head_office_region(new.company_id)
  );
  return new;
end;
$function$
-- ===END 21238
-- ===FUNC 21240 inherit_region_advance()
CREATE OR REPLACE FUNCTION public.inherit_region_advance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  new.branch_id := coalesce(
    public.region_for_employee(new.employee_id),
    public.region_for_client(new.client_id),
    public.same_company_branch(new.company_id, new.branch_id),
    public.head_office_region(new.company_id));
  return new;
end;
$function$
-- ===END 21240
-- ===FUNC 21242 inherit_region_expense()
CREATE OR REPLACE FUNCTION public.inherit_region_expense()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  new.branch_id := coalesce(
    public.region_for_client(new.client_id),
    public.same_company_branch(new.company_id, new.branch_id),
    public.head_office_region(new.company_id));
  return new;
end;
$function$
-- ===END 21242
-- ===FUNC 21324 inherit_region_incident()
CREATE OR REPLACE FUNCTION public.inherit_region_incident()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_region uuid;
begin
  select p.branch_id into v_region from public.posts p where p.id = new.post_id;
  new.branch_id := coalesce(
    v_region,
    public.region_for_client(new.client_id),
    public.head_office_region(new.company_id)
  );
  return new;
end;
$function$
-- ===END 21324
-- ===FUNC 21326 inherit_region_attendance()
CREATE OR REPLACE FUNCTION public.inherit_region_attendance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  new.branch_id := coalesce(
    public.region_for_client(new.worked_for_client_id),
    public.region_for_employee(new.employee_id),
    public.head_office_region(new.company_id)
  );
  return new;
end;
$function$
-- ===END 21326
-- ===FUNC 21328 inherit_region_roster()
CREATE OR REPLACE FUNCTION public.inherit_region_roster()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_region uuid;
begin
  select p.branch_id into v_region from public.posts p where p.id = new.post_id;
  new.branch_id := coalesce(
    v_region,
    public.region_for_client(new.client_id),
    public.region_for_employee(new.employee_id),
    public.head_office_region(new.company_id)
  );
  return new;
end;
$function$
-- ===END 21328
-- ===FUNC 21330 inherit_region_cheque()
CREATE OR REPLACE FUNCTION public.inherit_region_cheque()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_region uuid;
begin
  select i.branch_id into v_region from public.invoices i where i.id = new.invoice_id;
  new.branch_id := coalesce(
    public.region_for_client(new.client_id),
    v_region,
    public.same_company_branch(new.company_id, new.branch_id),
    public.head_office_region(new.company_id));
  return new;
end;
$function$
-- ===END 21330
-- ===FUNC 21332 inherit_region_post()
CREATE OR REPLACE FUNCTION public.inherit_region_post()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  new.branch_id := coalesce(
    public.region_for_client(new.client_id),
    new.branch_id,
    public.head_office_region(new.company_id)
  );
  return new;
end;
$function$
-- ===END 21332
-- ===FUNC 21334 current_region_id()
CREATE OR REPLACE FUNCTION public.current_region_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select branch_id from public.profiles where id = auth.uid();
$function$
-- ===END 21334
-- ===FUNC 21335 can_see_region(p_region_id uuid)
CREATE OR REPLACE FUNCTION public.can_see_region(p_region_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public.current_region_id() is null
      or public.current_region_id() = p_region_id;
$function$
-- ===END 21335
-- ===FUNC 21431 inherit_region_fixed_asset()
CREATE OR REPLACE FUNCTION public.inherit_region_fixed_asset()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  new.branch_id := coalesce(new.branch_id, public.head_office_region(new.company_id));
  return new;
end;
$function$
-- ===END 21431
-- ===FUNC 21434 journal_on_fixed_asset()
CREATE OR REPLACE FUNCTION public.journal_on_fixed_asset()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_cr_key text;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'fixed_assets', old.id, old.acquisition_date);
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.cost is distinct from new.cost
       or old.category is distinct from new.category
       or old.payment_mode is distinct from new.payment_mode
       or old.branch_id is distinct from new.branch_id then
      perform public.reverse_journal_for_source(new.company_id, 'fixed_assets', new.id, old.acquisition_date);
    else
      return new;
    end if;
  end if;

  v_cr_key := case
    when new.payment_mode = 'Cash' then 'cash'
    when new.payment_mode in ('Bank', 'Cheque') then 'bank'
    else 'ap'
  end;

  perform public.post_journal(
    new.company_id, new.acquisition_date,
    'Asset purchase — ' || new.name,
    'fixed_assets', new.id, false,
    jsonb_build_array(
      jsonb_build_object('key', public.fa_coa_key(new.category), 'debit', new.cost, 'credit', 0),
      jsonb_build_object('key', v_cr_key,                        'debit', 0,        'credit', new.cost)
    ),
    new.branch_id
  );
  return new;
end;
$function$
-- ===END 21434
-- ===FUNC 21436 sync_accumulated_depreciation()
CREATE OR REPLACE FUNCTION public.sync_accumulated_depreciation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_asset uuid;
begin
  v_asset := coalesce(new.asset_id, old.asset_id);
  update public.fixed_assets fa
     set accumulated_depreciation = coalesce((
           select sum(d.amount) from public.depreciation_entries d
            where d.asset_id = v_asset
         ), 0),
         updated_at = now()
   where fa.id = v_asset;
  return null;
end;
$function$
-- ===END 21436
-- ===FUNC 21438 run_depreciation(p_company_id uuid, p_period date)
CREATE OR REPLACE FUNCTION public.run_depreciation(p_company_id uuid, p_period date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r          record;
  v_month    date := date_trunc('month', p_period)::date;
  v_monthly  numeric;
  v_remain   numeric;
  v_amount   numeric;
  v_entry_id uuid;
  v_count    integer := 0;
begin
  for r in
    select fa.* from public.fixed_assets fa
     where fa.company_id = p_company_id
       and fa.status = 'active'
       and date_trunc('month', fa.acquisition_date)::date <= v_month
  loop
    v_entry_id := null;

    v_monthly := round((r.cost - r.salvage_value) / r.useful_life_months, 2);
    v_remain  := (r.cost - r.salvage_value) - r.accumulated_depreciation;
    v_amount  := least(v_monthly, v_remain);

    if v_amount is null or v_amount <= 0 then
      continue;
    end if;

    insert into public.depreciation_entries
      (company_id, asset_id, branch_id, period_month, amount)
    values (r.company_id, r.id, r.branch_id, v_month, v_amount)
    on conflict (asset_id, period_month) do nothing
    returning id into v_entry_id;

    if v_entry_id is null then
      continue;
    end if;

    perform public.post_journal(
      r.company_id, (v_month + interval '1 month - 1 day')::date,
      'Depreciation — ' || r.name || ' — ' || to_char(v_month, 'YYYY-MM'),
      'depreciation_entries', v_entry_id, false,
      jsonb_build_array(
        jsonb_build_object('key', 'dep_expense', 'debit', v_amount, 'credit', 0),
        jsonb_build_object('key', 'accum_dep',   'debit', 0,        'credit', v_amount)
      ),
      r.branch_id
    );

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$
-- ===END 21438
-- ===FUNC 21439 dispose_fixed_asset(p_asset_id uuid, p_disposal_date date, p_proceeds numeric, p_payment_mode text)
CREATE OR REPLACE FUNCTION public.dispose_fixed_asset(p_asset_id uuid, p_disposal_date date, p_proceeds numeric DEFAULT 0, p_payment_mode text DEFAULT 'Bank'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r        record;
  v_nbv    numeric;
  v_gain   numeric;
  v_dr_key text;
  v_lines  jsonb;
begin
  select * into r from public.fixed_assets where id = p_asset_id;
  if not found then
    raise exception 'fixed asset % not found', p_asset_id using errcode = '23503';
  end if;
  if r.status <> 'active' then
    raise exception 'fixed asset % is already %', p_asset_id, r.status using errcode = '23514';
  end if;

  v_nbv  := r.cost - r.accumulated_depreciation;
  v_gain := coalesce(p_proceeds, 0) - v_nbv;

  v_dr_key := case
    when p_payment_mode = 'Cash' then 'cash'
    when p_payment_mode in ('Bank', 'Cheque') then 'bank'
    else 'ar'
  end;

  v_lines := jsonb_build_array(
    jsonb_build_object('key', 'accum_dep', 'debit', r.accumulated_depreciation, 'credit', 0),
    jsonb_build_object('key', v_dr_key,    'debit', coalesce(p_proceeds, 0),    'credit', 0),
    jsonb_build_object('key', public.fa_coa_key(r.category), 'debit', 0, 'credit', r.cost)
  );

  if v_gain > 0 then
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('key', 'gain_disposal', 'debit', 0, 'credit', v_gain));
  elsif v_gain < 0 then
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('key', 'loss_disposal', 'debit', -v_gain, 'credit', 0));
  end if;

  perform public.post_journal(
    r.company_id, p_disposal_date,
    'Asset disposal — ' || r.name,
    'fixed_assets_disposal', r.id, false,
    v_lines,
    r.branch_id
  );

  update public.fixed_assets
     set status = 'disposed',
         disposal_date = p_disposal_date,
         disposal_proceeds = coalesce(p_proceeds, 0),
         updated_at = now()
   where id = p_asset_id;

  return p_asset_id;
end;
$function$
-- ===END 21439
-- ===FUNC 21452 allocate_cash_location_account(p_company_id uuid, p_location_type text, p_name text)
CREATE OR REPLACE FUNCTION public.allocate_cash_location_account(p_company_id uuid, p_location_type text, p_name text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_parent      uuid;
  v_parent_code text;
  v_code        text;
  v_seq         integer := 0;
  v_acct        uuid;
begin
  if p_location_type = 'BANK' then
    select id, account_code into v_parent, v_parent_code
      from public.chart_of_accounts
     where company_id = p_company_id and system_key = 'bank';
  else
    select id, account_code into v_parent, v_parent_code
      from public.chart_of_accounts
     where company_id = p_company_id and system_key = 'cash';
  end if;

  if v_parent is null then return null; end if;

  loop
    v_seq := v_seq + 1;
    v_code := v_parent_code || '.' || lpad(v_seq::text, 2, '0');
    exit when not exists (
      select 1 from public.chart_of_accounts
       where company_id = p_company_id and account_code = v_code
    );
    if v_seq > 500 then
      raise exception 'could not allocate a sub-account code under %', v_parent_code;
    end if;
  end loop;

  insert into public.chart_of_accounts
    (company_id, account_code, account_name, account_type, normal_side,
     parent_id, system_account, active, notes)
  values
    (p_company_id, v_code, p_name, 'asset', 'debit',
     v_parent, true, true, 'Cash location sub-ledger')
  returning id into v_acct;

  return v_acct;
end;
$function$
-- ===END 21452
-- ===FUNC 21453 ensure_cash_location_account()
CREATE OR REPLACE FUNCTION public.ensure_cash_location_account()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.coa_account_id is null then
    new.coa_account_id := public.allocate_cash_location_account(
      new.company_id, new.location_type, new.name);
  end if;
  return new;
end;
$function$
-- ===END 21453
-- ===FUNC 21455 default_cash_location(p_company_id uuid)
CREATE OR REPLACE FUNCTION public.default_cash_location(p_company_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select id from public.cash_locations
   where company_id = p_company_id and location_type = 'TREASURY' and is_active
   order by created_at
   limit 1;
$function$
-- ===END 21455
-- ===FUNC 21456 cash_account_for(p_company_id uuid, p_location_id uuid)
CREATE OR REPLACE FUNCTION public.cash_account_for(p_company_id uuid, p_location_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(
    (select cl.coa_account_id from public.cash_locations cl
      where cl.id = p_location_id and cl.company_id = p_company_id),
    (select cl.coa_account_id from public.cash_locations cl
      where cl.id = public.default_cash_location(p_company_id)),
    public.coa_id(p_company_id, 'cash')
  );
$function$
-- ===END 21456
-- ===FUNC 21486 journal_on_custody_transfer()
CREATE OR REPLACE FUNCTION public.journal_on_custody_transfer()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_from record;
  v_to   record;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'custody_transfers', old.id, old.date);
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.amount is distinct from new.amount
       or old.from_location_id is distinct from new.from_location_id
       or old.to_location_id is distinct from new.to_location_id then
      perform public.reverse_journal_for_source(new.company_id, 'custody_transfers', new.id, old.date);
    else
      return new;
    end if;
  end if;

  select coa_account_id, branch_id into v_from
    from public.cash_locations where id = new.from_location_id;
  select coa_account_id, branch_id into v_to
    from public.cash_locations where id = new.to_location_id;

  perform public.post_journal(
    new.company_id, new.date,
    'Custody transfer',
    'custody_transfers', new.id, false,
    jsonb_build_array(
      jsonb_build_object('account_id', v_to.coa_account_id,   'debit', new.amount, 'credit', 0,
                         'region', v_to.branch_id),
      jsonb_build_object('account_id', v_from.coa_account_id, 'debit', 0, 'credit', new.amount,
                         'region', v_from.branch_id)
    ),
    coalesce(v_from.branch_id, v_to.branch_id)
  );
  return new;
end;
$function$
-- ===END 21486
-- ===FUNC 21488 journal_on_cash_deposit()
CREATE OR REPLACE FUNCTION public.journal_on_cash_deposit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_from record;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'cash_deposits', old.id, old.deposit_date);
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.amount is distinct from new.amount
       or old.cash_location_id is distinct from new.cash_location_id then
      perform public.reverse_journal_for_source(new.company_id, 'cash_deposits', new.id, old.deposit_date);
    else
      return new;
    end if;
  end if;

  select coa_account_id, branch_id into v_from
    from public.cash_locations where id = new.cash_location_id;

  perform public.post_journal(
    new.company_id, new.deposit_date,
    'Cash deposited to bank',
    'cash_deposits', new.id, false,
    jsonb_build_array(
      jsonb_build_object('key', 'bank', 'debit', new.amount, 'credit', 0),
      jsonb_build_object('account_id',
                         coalesce(v_from.coa_account_id,
                                  public.cash_account_for(new.company_id, new.cash_location_id)),
                         'debit', 0, 'credit', new.amount)
    ),
    v_from.branch_id
  );
  return new;
end;
$function$
-- ===END 21488
-- ===FUNC 21512 allocate_partner_capital_account(p_company_id uuid, p_name text)
CREATE OR REPLACE FUNCTION public.allocate_partner_capital_account(p_company_id uuid, p_name text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_parent      uuid;
  v_parent_code text;
  v_code        text;
  v_seq         integer := 0;
  v_acct        uuid;
begin
  select id, account_code into v_parent, v_parent_code
    from public.chart_of_accounts
   where company_id = p_company_id and system_key = 'equity';

  if v_parent is null then return null; end if;

  loop
    v_seq := v_seq + 1;
    v_code := v_parent_code || '.' || lpad(v_seq::text, 2, '0');
    exit when not exists (
      select 1 from public.chart_of_accounts
       where company_id = p_company_id and account_code = v_code
    );
    if v_seq > 500 then
      raise exception 'could not allocate a partner capital code under %', v_parent_code;
    end if;
  end loop;

  insert into public.chart_of_accounts
    (company_id, account_code, account_name, account_type, normal_side,
     parent_id, system_account, active, notes)
  values
    (p_company_id, v_code, p_name || ' — Capital', 'equity', 'credit',
     v_parent, true, true, 'Partner capital sub-ledger')
  returning id into v_acct;

  return v_acct;
end;
$function$
-- ===END 21512
-- ===FUNC 21513 ensure_partner_capital_account()
CREATE OR REPLACE FUNCTION public.ensure_partner_capital_account()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.coa_account_id is null then
    new.coa_account_id := public.allocate_partner_capital_account(new.company_id, new.name);
  end if;
  return new;
end;
$function$
-- ===END 21513
-- ===FUNC 21515 journal_on_partner_entry()
CREATE OR REPLACE FUNCTION public.journal_on_partner_entry()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  p         record;
  v_capital uuid;
  v_region  uuid;
  v_cash    jsonb;
  v_lines   jsonb;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'partner_account_entries', old.id, old.date);
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.amount is distinct from new.amount
       or old.type is distinct from new.type
       or old.payment_method is distinct from new.payment_method
       or old.cash_location_id is distinct from new.cash_location_id
       or old.bank_account_id is distinct from new.bank_account_id then
      perform public.reverse_journal_for_source(new.company_id, 'partner_account_entries', new.id, old.date);
    else
      return new;
    end if;
  end if;

  select * into p from public.partners where id = new.partner_id;
  if not found or p.coa_account_id is null then
    return new;
  end if;

  v_capital := p.coa_account_id;

  v_region := case
    when p.scope = 'BRANCH' then coalesce(p.branch_id, public.head_office_region(new.company_id))
    else public.head_office_region(new.company_id)
  end;

  v_cash := case
    when new.payment_method = 'CASH' then jsonb_build_object(
      'account_id', public.cash_account_for(new.company_id, new.cash_location_id))
    else jsonb_build_object('key', 'bank')
  end;

  v_lines := case new.type
    when 'CONTRIBUTION' then jsonb_build_array(
      v_cash || jsonb_build_object('debit', new.amount, 'credit', 0),
      jsonb_build_object('account_id', v_capital, 'debit', 0, 'credit', new.amount))
    when 'DRAWING' then jsonb_build_array(
      jsonb_build_object('account_id', v_capital, 'debit', new.amount, 'credit', 0),
      v_cash || jsonb_build_object('debit', 0, 'credit', new.amount))
    when 'PROFIT_ALLOCATION' then jsonb_build_array(
      jsonb_build_object('key', 'retained_earnings', 'debit', new.amount, 'credit', 0),
      jsonb_build_object('account_id', v_capital,    'debit', 0, 'credit', new.amount))
    when 'OPENING' then jsonb_build_array(
      jsonb_build_object('key', 'opening_balance_equity', 'debit', new.amount, 'credit', 0),
      jsonb_build_object('account_id', v_capital,         'debit', 0, 'credit', new.amount))
  end;

  if v_lines is null then
    return new;
  end if;

  perform public.post_journal(
    new.company_id, new.date,
    p.name || ' — ' || new.type || coalesce(' — ' || new.description, ''),
    'partner_account_entries', new.id, false,
    v_lines,
    v_region
  );
  return new;
end;
$function$
-- ===END 21515
-- ===FUNC 21588 guard_posted_opening_batch()
CREATE OR REPLACE FUNCTION public.guard_posted_opening_batch()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_status public.opening_batch_status;
begin
  select status into v_status from public.opening_balance_batches
   where id = coalesce(new.batch_id, old.batch_id);
  if v_status = 'posted' then
    raise exception 'opening batch is already posted and cannot be edited'
      using errcode = '23514';
  end if;
  return coalesce(new, old);
end;
$function$
-- ===END 21588
-- ===FUNC 21590 opening_batch_totals(p_batch_id uuid)
CREATE OR REPLACE FUNCTION public.opening_batch_totals(p_batch_id uuid)
 RETURNS TABLE(total_debit numeric, total_credit numeric, difference numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(sum(debit), 0),
         coalesce(sum(credit), 0),
         coalesce(sum(debit), 0) - coalesce(sum(credit), 0)
    from public.opening_balance_lines where batch_id = p_batch_id;
$function$
-- ===END 21590
-- ===FUNC 21591 post_opening_balances(p_batch_id uuid)
CREATE OR REPLACE FUNCTION public.post_opening_balances(p_batch_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  b       record;
  v_diff  numeric;
  v_count integer;
  v_lines jsonb;
  v_entry uuid;
begin
  select * into b from public.opening_balance_batches where id = p_batch_id;
  if not found then
    raise exception 'opening batch % not found', p_batch_id using errcode = '23503';
  end if;
  if b.status = 'posted' then
    raise exception 'opening batch % is already posted', p_batch_id using errcode = '23505';
  end if;
  if b.status = 'voided' then
    raise exception 'opening batch % is voided', p_batch_id using errcode = '23514';
  end if;

  select count(*) into v_count from public.opening_balance_lines where batch_id = p_batch_id;
  if v_count = 0 then
    raise exception 'opening batch % has no lines', p_batch_id using errcode = '23514';
  end if;

  select difference into v_diff from public.opening_batch_totals(p_batch_id);
  if v_diff <> 0 then
    raise exception 'opening trial balance does not balance: debits minus credits = %', v_diff
      using errcode = '23514',
            hint = 'Dr must equal Cr before the opening journal can post.';
  end if;

  select jsonb_agg(
           jsonb_build_object(
             'account_id', l.account_id,
             'debit',      l.debit,
             'credit',     l.credit,
             'region',     coalesce(l.branch_id, public.head_office_region(b.company_id))
           ))
    into v_lines
    from public.opening_balance_lines l
   where l.batch_id = p_batch_id;

  v_entry := public.post_journal(
    b.company_id,
    b.as_of_date,
    coalesce(b.description, 'Opening trial balance'),
    'opening_balance_batches', b.id, false,
    v_lines,
    public.head_office_region(b.company_id)
  );

  update public.opening_balance_batches
     set status = 'posted',
         posted_at = now(),
         posted_by = auth.uid(),
         journal_entry_id = v_entry,
         updated_at = now()
   where id = p_batch_id;

  return v_entry;
end;
$function$
-- ===END 21591
-- ===FUNC 21650 sync_status_from_lifecycle()
CREATE OR REPLACE FUNCTION public.sync_status_from_lifecycle()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if tg_op = 'INSERT' and new.lifecycle_state = 'active' then
    new.lifecycle_state := case new.status
      when 'Active'   then 'active'::public.employee_lifecycle_state
      when 'On Leave' then 'on_leave'::public.employee_lifecycle_state
      else 'left'::public.employee_lifecycle_state
    end;
  end if;

  new.status := case new.lifecycle_state
    when 'active'   then 'Active'
    when 'on_leave' then 'On Leave'
    else 'Inactive'
  end;
  return new;
end;
$function$
-- ===END 21650
-- ===FUNC 21653 transition_employee_lifecycle(p_employee_id uuid, p_to_state employee_lifecycle_state, p_reason text, p_eligible_for_rehire boolean, p_notes text)
CREATE OR REPLACE FUNCTION public.transition_employee_lifecycle(p_employee_id uuid, p_to_state employee_lifecycle_state, p_reason text DEFAULT NULL::text, p_eligible_for_rehire boolean DEFAULT NULL::boolean, p_notes text DEFAULT NULL::text)
 RETURNS employee_lifecycle_state
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  e record; v_is_exit boolean; v_is_rehire boolean; v_day date := current_date;
begin
  select * into e from public.employees where id = p_employee_id for update;
  if not found then
    raise exception 'employee % not found', p_employee_id using errcode = '23503';
  end if;
  if e.lifecycle_state = p_to_state then return e.lifecycle_state; end if;
  if not public.lifecycle_transition_allowed(e.lifecycle_state, p_to_state) then
    raise exception 'illegal lifecycle transition % -> %', e.lifecycle_state, p_to_state
      using errcode = '23514';
  end if;
  v_is_exit   := p_to_state in ('left','terminated','fired','absconded');
  v_is_rehire := e.lifecycle_state in ('left','terminated','fired','absconded') and p_to_state = 'active';
  if v_is_exit then
    if coalesce(trim(p_reason), '') = '' then
      raise exception 'exit requires a reason' using errcode = '23514';
    end if;
    if p_eligible_for_rehire is null then
      raise exception 'exit requires an explicit eligible-for-rehire decision' using errcode = '23514';
    end if;
  end if;
  if v_is_rehire then
    if e.blacklisted then
      raise exception 'employee is blacklisted and cannot be rehired'
        using errcode = '23514', hint = e.blacklist_reason;
    end if;
    if e.eligible_for_rehire is false then
      raise exception 'employee was marked not eligible for rehire at last exit' using errcode = '23514';
    end if;
  end if;
  update public.employees set
    lifecycle_state     = p_to_state,
    exit_reason         = case when v_is_exit then p_reason else exit_reason end,
    exit_date           = case when v_is_exit then v_day else exit_date end,
    eligible_for_rehire = case when v_is_exit then p_eligible_for_rehire else eligible_for_rehire end,
    rehire_count        = case when v_is_rehire then rehire_count + 1 else rehire_count end,
    last_working_day    = case when v_is_rehire then null
                               when v_is_exit then coalesce(last_working_day, v_day)
                               else last_working_day end,
    termination_date    = case when v_is_rehire then null
                               when v_is_exit then coalesce(termination_date, v_day)
                               else termination_date end,
    separation_reason   = case when v_is_rehire then null else separation_reason end,
    updated_at          = now()
  where id = p_employee_id;
  if v_is_exit then
    update public.deployments
       set end_date = greatest(start_date, v_day), reason = 'separation', updated_at = now()
     where guard_id = p_employee_id and end_date is null;
  end if;
  insert into public.employee_lifecycle_events
    (company_id, employee_id, from_state, to_state, reason, eligible_for_rehire, changed_by, notes)
  values (e.company_id, p_employee_id, e.lifecycle_state, p_to_state, p_reason,
     case when v_is_exit then p_eligible_for_rehire else null end, auth.uid(), p_notes);
  return p_to_state;
end $function$
-- ===END 21653
-- ===FUNC 21706 sync_competence_from_training()
CREATE OR REPLACE FUNCTION public.sync_competence_from_training()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.kind = 'orientation' then
    update public.employees
       set orientation_done = true,
           orientation_date = coalesce(orientation_date, new.completed_on),
           updated_at = now()
     where id = new.employee_id;
  elsif new.kind in ('weapons_certification', 'weapons_refresher') then
    update public.employees
       set weapons_certified   = true,
           weapons_cert_expiry = new.expires_on,
           updated_at = now()
     where id = new.employee_id;
  end if;
  return new;
end;
$function$
-- ===END 21706
-- ===FUNC 21708 armed_post_blockers(p_employee_id uuid)
CREATE OR REPLACE FUNCTION public.armed_post_blockers(p_employee_id uuid)
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select array_remove(array[
    case when e.lifecycle_state <> 'active' then 'not in active service' end,
    case when e.police_verification_status = 'pending' then 'police verification pending' end,
    case when e.police_verification_status = 'adverse' then 'police verification adverse' end,
    case when e.nadra_verisys_status = 'pending' then 'NADRA Verisys pending' end,
    case when e.nadra_verisys_status = 'adverse' then 'NADRA Verisys adverse' end,
    case when not e.weapons_certified then 'not weapons-certified' end,
    case when e.weapons_certified and e.weapons_cert_expiry is not null
              and e.weapons_cert_expiry < current_date then 'weapons certification expired' end,
    case when e.blacklisted then 'blacklisted' end,
    case when not exists (select 1 from public.guard_documents gd
                          where gd.employee_id = e.id and gd.doc_type = 'weapon_licence'
                            and gd.status in ('on_file','verified'))
         then 'weapon licence not on file' end,
    case when exists (select 1 from public.guard_documents gd
                      where gd.employee_id = e.id and gd.doc_type = 'weapon_licence' and gd.status = 'expired')
         then 'weapon licence expired' end,
    case when coalesce(e.is_ex_serviceman,false)
              and not exists (select 1 from public.guard_documents gd
                              where gd.employee_id = e.id and gd.doc_type = 'discharge_certificate'
                                and gd.status in ('on_file','verified'))
         then 'discharge certificate missing' end
  ], null)
  from public.employees e where e.id = p_employee_id;
$function$
-- ===END 21708
-- ===FUNC 21709 can_work_armed_post(p_employee_id uuid)
CREATE OR REPLACE FUNCTION public.can_work_armed_post(p_employee_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(array_length(public.armed_post_blockers(p_employee_id), 1), 0) = 0;
$function$
-- ===END 21709
-- ===FUNC 21710 auto_standdown_on_adverse_vetting()
CREATE OR REPLACE FUNCTION public.auto_standdown_on_adverse_vetting()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_became_adverse boolean;
  v_which text;
begin
  v_became_adverse :=
       (new.police_verification_status = 'adverse' and old.police_verification_status is distinct from 'adverse')
    or (new.nadra_verisys_status       = 'adverse' and old.nadra_verisys_status       is distinct from 'adverse');

  if v_became_adverse and new.lifecycle_state = 'active' then
    v_which := case when new.police_verification_status = 'adverse'
                        and old.police_verification_status is distinct from 'adverse'
                    then 'police verification' else 'NADRA Verisys' end;
    perform public.transition_employee_lifecycle(
      new.id, 'on_leave', null, null,
      'Auto stand-down: ' || v_which || ' returned adverse');
  end if;
  return new;
end;
$function$
-- ===END 21710
-- ===FUNC 21746 assign_warning_and_escalate()
CREATE OR REPLACE FUNCTION public.assign_warning_and_escalate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_active integer;
begin
  select count(*) into v_active
    from public.disciplinary_warnings
   where employee_id = new.employee_id and not rescinded;
  new.warning_number := least(v_active + 1, 3);
  return new;
end;
$function$
-- ===END 21746
-- ===FUNC 21748 refresh_termination_review()
CREATE OR REPLACE FUNCTION public.refresh_termination_review()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_emp uuid := coalesce(new.employee_id, old.employee_id);
  v_active integer;
begin
  select count(*) into v_active
    from public.disciplinary_warnings
   where employee_id = v_emp and not rescinded;
  update public.employees
     set pending_termination_review = (v_active >= 3),
         updated_at = now()
   where id = v_emp;
  return null;
end;
$function$
-- ===END 21748
-- ===FUNC 21785 assess_clearance(p_employee_id uuid)
CREATE OR REPLACE FUNCTION public.assess_clearance(p_employee_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  g        record;
  v_id     uuid;
  v_ok     boolean;
  v_company uuid;
begin
  select company_id into v_company from public.employees where id = p_employee_id;
  if v_company is null then
    raise exception 'employee % not found', p_employee_id using errcode = '23503';
  end if;

  select * into g from public.employee_clearance_gates(p_employee_id);
  v_ok := g.outstanding_kit_count = 0 and g.outstanding_advance <= 0 and g.open_incident_count = 0;

  select id into v_id from public.clearance_certificates
   where employee_id = p_employee_id and not dues_released
   order by created_at desc limit 1;

  if v_id is null then
    insert into public.clearance_certificates (company_id, employee_id)
    values (v_company, p_employee_id) returning id into v_id;
  end if;

  update public.clearance_certificates set
    kit_returned          = (g.outstanding_kit_count = 0),
    outstanding_kit_count = g.outstanding_kit_count,
    advance_settled       = (g.outstanding_advance <= 0),
    outstanding_advance   = g.outstanding_advance,
    incidents_reviewed    = (g.open_incident_count = 0),
    open_incident_count   = g.open_incident_count,
    undisbursed_salary    = g.undisbursed_salary,
    status                = (case when v_ok then 'cleared' else 'blocked' end)::public.clearance_status,
    cleared_by            = case when v_ok then auth.uid() else cleared_by end,
    updated_at            = now()
  where id = v_id;

  return v_id;
end;
$function$
-- ===END 21785
-- ===FUNC 21786 release_final_dues(p_employee_id uuid)
CREATE OR REPLACE FUNCTION public.release_final_dues(p_employee_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_id uuid; v_status public.clearance_status;
begin
  v_id := public.assess_clearance(p_employee_id);
  select status into v_status from public.clearance_certificates where id = v_id;

  if v_status <> 'cleared' then
    raise exception 'clearance is not complete; final dues cannot be released'
      using errcode = '23514',
            hint = 'Return kit, settle advances, and close incident reviews first.';
  end if;

  update public.clearance_certificates
     set dues_released = true, dues_released_on = current_date, updated_at = now()
   where id = v_id;
end;
$function$
-- ===END 21786
-- ===FUNC 21862 is_payroll_approver()
CREATE OR REPLACE FUNCTION public.is_payroll_approver()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(
    public.current_role()::text in ('super_super_admin', 'super_admin')
    or exists (
      select 1 from public.profiles
       where id = auth.uid() and 'payroll.approve' = any(permissions)),
    false);
$function$
-- ===END 21862
-- ===FUNC 21863 enforce_payroll_run_lock()
CREATE OR REPLACE FUNCTION public.enforce_payroll_run_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_status public.payroll_run_status;
begin
  if new.payroll_run_id is null then return new; end if;

  select status into v_status from public.payroll_runs where id = new.payroll_run_id;
  if v_status is null or v_status in ('draft', 'review') then
    return new;
  end if;

  if new.base_salary   is distinct from old.base_salary
   or new.per_day_salary is distinct from old.per_day_salary
   or new.allowance    is distinct from old.allowance
   or new.bonus        is distinct from old.bonus
   or new.deductions   is distinct from old.deductions
   or new.advance      is distinct from old.advance
   or new.income_tax   is distinct from old.income_tax
   or new.eobi         is distinct from old.eobi
   or new.final_salary is distinct from old.final_salary
   or new.net_salary   is distinct from old.net_salary
   or new.working_days is distinct from old.working_days
   or new.present_days is distinct from old.present_days
   or new.absent_days  is distinct from old.absent_days
   or new.leave_days   is distinct from old.leave_days then
    raise exception 'payroll run is % and locked; payslip figures cannot change', v_status
      using errcode = '23514',
            hint = 'Reopen the run to draft/review before editing pay.';
  end if;
  return new;
end;
$function$
-- ===END 21863
-- ===FUNC 21865 payroll_run_attach(p_run_id uuid)
CREATE OR REPLACE FUNCTION public.payroll_run_attach(p_run_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record; v_count integer;
begin
  select * into r from public.payroll_runs where id = p_run_id;
  if not found then
    raise exception 'payroll run % not found', p_run_id using errcode = '23503';
  end if;
  if r.status <> 'draft' then
    raise exception 'can only attach payslips while the run is a draft' using errcode = '23514';
  end if;

  update public.payslips p
     set payroll_run_id = r.id, updated_at = now()
    from public.employees e
   where p.employee_id = e.id
     and p.company_id = r.company_id
     and p.period_month = r.period_month
     and p.payroll_run_id is null
     and public.employee_payroll_stream(e.category) = r.stream
     and (r.branch_id is null or p.branch_id = r.branch_id);

  get diagnostics v_count = row_count;
  return v_count;
end;
$function$
-- ===END 21865
-- ===FUNC 21866 transition_payroll_run(p_run_id uuid, p_to payroll_run_status, p_reason text)
CREATE OR REPLACE FUNCTION public.transition_payroll_run(p_run_id uuid, p_to payroll_run_status, p_reason text DEFAULT NULL::text)
 RETURNS payroll_run_status
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record; v_allowed boolean; v_count integer; v_unacked integer;
begin
  select * into r from public.payroll_runs where id = p_run_id for update;
  if not found then raise exception 'payroll run % not found', p_run_id using errcode = '23503'; end if;
  v_allowed := (r.status, p_to) in (
    ('draft','review'),('review','draft'),('review','approved'),('approved','review'),
    ('disbursed','completed'),('draft','cancelled'),('review','cancelled'),('approved','cancelled'));
  if not v_allowed then raise exception 'illegal payroll run transition % -> %', r.status, p_to using errcode = '23514'; end if;
  if p_to = 'approved' then
    if not coalesce(public.is_payroll_approver(), false) then
      raise exception 'only a payroll approver (COO/Finance) may approve a run' using errcode = '42501'; end if;
    select count(*) into v_count from public.payslips where payroll_run_id = p_run_id;
    if v_count = 0 then raise exception 'cannot approve a run with no payslips' using errcode = '23514'; end if;
    v_unacked := public.run_unacked_exception_count(p_run_id);
    if v_unacked > 0 then
      raise exception 'run has % unacknowledged exception(s); resolve or accept each before approval', v_unacked using errcode = '23514'; end if;
  end if;
  update public.payroll_runs set
    status = p_to,
    submitted_at = case when p_to = 'review' then now() else submitted_at end,
    approved_by = case when p_to = 'approved' then auth.uid() when p_to = 'review' then null else approved_by end,
    approved_at = case when p_to = 'approved' then now() when p_to = 'review' then null else approved_at end,
    completed_at = case when p_to = 'completed' then now() else completed_at end,
    cancelled_at = case when p_to = 'cancelled' then now() else cancelled_at end,
    cancel_reason = case when p_to = 'cancelled' then p_reason else cancel_reason end,
    updated_at = now()
  where id = p_run_id;
  return p_to;
end; $function$
-- ===END 21866
-- ===FUNC 21867 disburse_payroll_run(p_run_id uuid)
CREATE OR REPLACE FUNCTION public.disburse_payroll_run(p_run_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record; v_count integer;
begin
  select * into r from public.payroll_runs where id = p_run_id for update;
  if not found then
    raise exception 'payroll run % not found', p_run_id using errcode = '23503';
  end if;
  if r.status <> 'approved' then
    raise exception 'payroll run must be approved before disbursement (currently %)', r.status
      using errcode = '23514';
  end if;

  update public.payroll_runs
     set status = 'disbursed', disbursed_at = now(), updated_at = now()
   where id = p_run_id;

  update public.payslips
     set disbursed = true,
         disbursed_at = coalesce(disbursed_at, now()),
         status = 'Cleared',
         updated_at = now()
   where payroll_run_id = p_run_id and not disbursed;

  get diagnostics v_count = row_count;
  return v_count;
end;
$function$
-- ===END 21867
-- ===FUNC 21906 effective_salary(p_employee_id uuid, p_as_of date)
CREATE OR REPLACE FUNCTION public.effective_salary(p_employee_id uuid, p_as_of date)
 RETURNS TABLE(base_salary numeric, allowance numeric, per_day_salary numeric, effective_date date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select h.base_salary, h.allowance, h.per_day_salary, h.effective_date
    from public.employee_salary_history h
   where h.employee_id = p_employee_id
     and h.effective_date <= p_as_of
   order by h.effective_date desc
   limit 1;
$function$
-- ===END 21906
-- ===FUNC 21907 set_employee_salary(p_employee_id uuid, p_effective_date date, p_base_salary numeric, p_allowance numeric, p_per_day_salary numeric, p_reason text)
CREATE OR REPLACE FUNCTION public.set_employee_salary(p_employee_id uuid, p_effective_date date, p_base_salary numeric, p_allowance numeric DEFAULT 0, p_per_day_salary numeric DEFAULT NULL::numeric, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_company uuid;
begin
  select company_id into v_company from public.employees where id = p_employee_id;
  if v_company is null then
    raise exception 'employee % not found', p_employee_id using errcode = '23503';
  end if;

  insert into public.employee_salary_history
    (company_id, employee_id, effective_date, base_salary, allowance, per_day_salary, reason, changed_by)
  values
    (v_company, p_employee_id, p_effective_date, p_base_salary,
     coalesce(p_allowance, 0), p_per_day_salary, p_reason, auth.uid())
  on conflict (employee_id, effective_date) do update set
    base_salary = excluded.base_salary,
    allowance   = excluded.allowance,
    per_day_salary = excluded.per_day_salary,
    reason      = excluded.reason,
    changed_by  = excluded.changed_by;

  if p_effective_date <= current_date
     and p_effective_date = (
       select max(effective_date) from public.employee_salary_history
        where employee_id = p_employee_id and effective_date <= current_date
     ) then
    update public.employees set
      base_salary = p_base_salary,
      allowance   = coalesce(p_allowance, 0),
      per_day_salary = coalesce(p_per_day_salary, per_day_salary),
      updated_at = now()
    where id = p_employee_id;
  end if;
end;
$function$
-- ===END 21907
-- ===FUNC 21908 capture_salary_change()
CREATE OR REPLACE FUNCTION public.capture_salary_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare eff record;
begin
  if tg_op <> 'UPDATE'
     or (new.base_salary is not distinct from old.base_salary
         and new.allowance is not distinct from old.allowance
         and new.per_day_salary is not distinct from old.per_day_salary) then
    return new;
  end if;

  select * into eff from public.effective_salary(new.id, current_date);
  if found
     and eff.base_salary is not distinct from new.base_salary
     and eff.allowance   is not distinct from coalesce(new.allowance, 0)
     and eff.per_day_salary is not distinct from new.per_day_salary then
    return new;
  end if;

  insert into public.employee_salary_history
    (company_id, employee_id, effective_date, base_salary, allowance, per_day_salary, reason, changed_by)
  values
    (new.company_id, new.id, current_date, new.base_salary, coalesce(new.allowance, 0),
     new.per_day_salary, 'Direct edit', auth.uid())
  on conflict (employee_id, effective_date) do update set
    base_salary = excluded.base_salary,
    allowance   = excluded.allowance,
    per_day_salary = excluded.per_day_salary;
  return new;
end;
$function$
-- ===END 21908
-- ===FUNC 21946 sync_payslip_reward_totals()
CREATE OR REPLACE FUNCTION public.sync_payslip_reward_totals()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_payslip    uuid := coalesce(new.payslip_id, old.payslip_id);
  v_earn       numeric;
  v_deduct     numeric;
  p            record;
  v_run_status public.payroll_run_status;
  v_base_net   numeric;
begin
  select coalesce(sum(amount) filter (where kind <> 'deduction'), 0),
         coalesce(sum(amount) filter (where kind = 'deduction'), 0)
    into v_earn, v_deduct
    from public.payslip_reward_lines where payslip_id = v_payslip;

  select * into p from public.payslips where id = v_payslip;
  if not found then return null; end if;

  if p.payroll_run_id is not null then
    select status into v_run_status from public.payroll_runs where id = p.payroll_run_id;
    if v_run_status in ('approved', 'disbursed', 'completed') then
      raise exception 'payroll run is % and locked; reward lines cannot change', v_run_status
        using errcode = '23514';
    end if;
  end if;

  v_base_net := coalesce(p.base_salary,0) + coalesce(p.allowance,0)
              + v_earn - v_deduct - coalesce(p.advance,0)
              - coalesce(p.income_tax,0) - coalesce(p.eobi,0);

  update public.payslips set
    bonus        = v_earn,
    deductions   = v_deduct,
    final_salary = coalesce(p.base_salary,0) + coalesce(p.allowance,0) + v_earn - v_deduct,
    net_salary   = v_base_net,
    updated_at   = now()
  where id = v_payslip;

  return null;
end;
$function$
-- ===END 21946
-- ===FUNC 22106 seed_document_checklist(p_employee_id uuid, p_company_id uuid)
CREATE OR REPLACE FUNCTION public.seed_document_checklist(p_employee_id uuid, p_company_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  insert into public.employee_document_checklist (company_id, employee_id, doc_type)
  select p_company_id, p_employee_id, dt
    from unnest(enum_range(null::public.checklist_doc_type)) dt
  on conflict (employee_id, doc_type) do nothing;
$function$
-- ===END 22106
-- ===FUNC 22107 seed_document_checklist_on_insert()
CREATE OR REPLACE FUNCTION public.seed_document_checklist_on_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.seed_document_checklist(new.id, new.company_id);
  return null;
end;
$function$
-- ===END 22107
-- ===FUNC 22112 enforce_identity_lock()
CREATE OR REPLACE FUNCTION public.enforce_identity_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not old.identity_verified then
    return new;
  end if;

  if coalesce(current_setting('app.identity_amendment', true), '') = '1' then
    return new;
  end if;

  if new.full_name             is distinct from old.full_name
   or new.father_or_husband_name is distinct from old.father_or_husband_name
   or new.cnic_number          is distinct from old.cnic_number
   or new.date_of_birth        is distinct from old.date_of_birth then
    raise exception 'core identity is verified and locked; use an amendment (with reason)'
      using errcode = '23514',
            hint = 'Call amend_employee_identity(employee, field, new_value, reason).';
  end if;
  return new;
end;
$function$
-- ===END 22112
-- ===FUNC 22114 verify_employee_identity(p_employee_id uuid)
CREATE OR REPLACE FUNCTION public.verify_employee_identity(p_employee_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  update public.employees
     set identity_verified = true,
         identity_verified_at = now(),
         identity_verified_by = auth.uid(),
         updated_at = now()
   where id = p_employee_id;
  if not found then
    raise exception 'employee % not found', p_employee_id using errcode = '23503';
  end if;
end;
$function$
-- ===END 22114
-- ===FUNC 22115 unverify_employee_identity(p_employee_id uuid, p_reason text)
CREATE OR REPLACE FUNCTION public.unverify_employee_identity(p_employee_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_company uuid;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'unverifying an identity requires a reason' using errcode = '23514';
  end if;
  select company_id into v_company from public.employees where id = p_employee_id;
  if v_company is null then
    raise exception 'employee % not found', p_employee_id using errcode = '23503';
  end if;

  update public.employees
     set identity_verified = false, identity_verified_at = null,
         identity_verified_by = null, updated_at = now()
   where id = p_employee_id;

  insert into public.audit_log (company_id, table_name, record_id, action, changed_by, changes)
  values (v_company, 'employees', p_employee_id, 'update', auth.uid(),
          jsonb_build_object('kind', 'identity_unverify', 'reason', p_reason));
end;
$function$
-- ===END 22115
-- ===FUNC 22116 amend_employee_identity(p_employee_id uuid, p_field text, p_new_value text, p_reason text)
CREATE OR REPLACE FUNCTION public.amend_employee_identity(p_employee_id uuid, p_field text, p_new_value text, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company uuid;
  v_old     text;
begin
  if p_field not in ('full_name', 'father_or_husband_name', 'cnic_number', 'date_of_birth') then
    raise exception 'field % is not an amendable core identity field', p_field
      using errcode = '22023';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'an amendment requires a reason' using errcode = '23514';
  end if;

  select company_id into v_company from public.employees where id = p_employee_id;
  if v_company is null then
    raise exception 'employee % not found', p_employee_id using errcode = '23503';
  end if;

  execute format('select (%I)::text from public.employees where id = $1', p_field)
     into v_old using p_employee_id;

  perform set_config('app.identity_amendment', '1', true);
  execute format('update public.employees set %I = %L, updated_at = now() where id = %L',
                 p_field, p_new_value, p_employee_id);
  perform set_config('app.identity_amendment', '0', true);

  insert into public.audit_log (company_id, table_name, record_id, action, changed_by, changes)
  values (v_company, 'employees', p_employee_id, 'update', auth.uid(),
          jsonb_build_object(
            'kind', 'identity_amendment',
            'field', p_field,
            'old', v_old,
            'new', p_new_value,
            'reason', p_reason));
end;
$function$
-- ===END 22116
-- ===FUNC 22117 mark_form_signed(p_employee_id uuid, p_signed_on date)
CREATE OR REPLACE FUNCTION public.mark_form_signed(p_employee_id uuid, p_signed_on date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  update public.employees set form_signed_on = p_signed_on, updated_at = now()
   where id = p_employee_id;
  if not found then
    raise exception 'employee % not found', p_employee_id using errcode = '23503';
  end if;
end;
$function$
-- ===END 22117
-- ===FUNC 22166 is_performance_approver()
CREATE OR REPLACE FUNCTION public.is_performance_approver()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(
    public.current_role()::text in ('super_super_admin', 'super_admin')
    or exists (select 1 from public.profiles
                where id = auth.uid() and 'performance.approve' = any(permissions)),
    false);
$function$
-- ===END 22166
-- ===FUNC 22167 set_performance_enrollment(p_employee_id uuid, p_enrolled boolean, p_seat kpi_seat)
CREATE OR REPLACE FUNCTION public.set_performance_enrollment(p_employee_id uuid, p_enrolled boolean, p_seat kpi_seat DEFAULT NULL::kpi_seat)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare e record;
begin
  if not coalesce(public.is_performance_approver(), false) then
    raise exception 'only a performance approver (COO) may change enrollment'
      using errcode = '42501';
  end if;

  select * into e from public.employees where id = p_employee_id;
  if not found then
    raise exception 'employee % not found', p_employee_id using errcode = '23503';
  end if;

  if p_enrolled then
    if e.category <> 'office_staff' then
      raise exception 'only salaried (office_staff) employees can be enrolled'
        using errcode = '23514';
    end if;
    if coalesce(p_seat, e.kpi_seat) is null then
      raise exception 'a KPI seat is required to enrol' using errcode = '23514';
    end if;
  end if;

  update public.employees set
    performance_enrolled = p_enrolled,
    performance_enrolled_on = case when p_enrolled then coalesce(performance_enrolled_on, current_date)
                                   else null end,
    performance_enrolled_by = case when p_enrolled then auth.uid() else null end,
    kpi_seat = coalesce(p_seat, kpi_seat),
    updated_at = now()
  where id = p_employee_id;
end;
$function$
-- ===END 22167
-- ===FUNC 22232 sync_kpi_rag()
CREATE OR REPLACE FUNCTION public.sync_kpi_rag()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d record;
begin
  select direction, green_threshold, amber_threshold into d
    from public.kpi_definitions where id = new.kpi_definition_id;
  new.rag := public.kpi_rag(new.value, d.direction, d.green_threshold, d.amber_threshold);
  new.updated_at := now();
  return new;
end;
$function$
-- ===END 22232
-- ===FUNC 22234 compute_kpi_value(p_employee_id uuid, p_kpi_definition_id uuid, p_period date)
CREATE OR REPLACE FUNCTION public.compute_kpi_value(p_employee_id uuid, p_kpi_definition_id uuid, p_period date)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  d        record;
  e        record;
  v_start  date := date_trunc('month', p_period)::date;
  v_end    date := (date_trunc('month', p_period) + interval '1 month - 1 day')::date;
  v_val    numeric;
begin
  select * into d from public.kpi_definitions where id = p_kpi_definition_id;
  select * into e from public.employees where id = p_employee_id;
  if d.auto_source is null then return null; end if;

  if d.kpi_key = 'vetting_pct' then
    select case when count(*) = 0 then null
                else round(100.0 * count(*) filter (
                       where police_verification_status = 'cleared'
                         and nadra_verisys_status = 'cleared') / count(*), 1) end
      into v_val
      from public.employees g
     where g.company_id = e.company_id
       and (e.branch_id is null or g.branch_id = e.branch_id)
       and g.category in ('client','reliever')
       and g.lifecycle_state in ('active','on_leave');

  elsif d.kpi_key = 'records_completeness' then
    select case when count(*) = 0 then null
                else round(100.0 * count(*) filter (where dc.received) / count(*), 1) end
      into v_val
      from public.employee_document_checklist dc
      join public.employees g on g.id = dc.employee_id
     where g.company_id = e.company_id
       and (e.branch_id is null or g.branch_id = e.branch_id);

  elsif d.kpi_key = 'days_to_invoice' then
    select round(avg(greatest(i.invoice_date - i.period_end, 0)), 1)
      into v_val
      from public.invoices i
     where i.company_id = e.company_id
       and (e.branch_id is null or i.branch_id = e.branch_id)
       and i.invoice_date between v_start and v_end
       and i.period_end is not null;

  elsif d.kpi_key = 'renewal_rate' then
    select case when count(*) = 0 then null
                else round(100.0 * count(*) filter (where c.status = 'active') / count(*), 1) end
      into v_val
      from public.contracts c
      join public.clients cl on cl.id = c.client_id
     where c.company_id = e.company_id
       and (e.branch_id is null or cl.branch_id = e.branch_id);

  elsif d.kpi_key = 'tasks_on_time' then
    v_val := public.tasks_on_time_pct(p_employee_id, p_period);
  end if;

  return v_val;
end;
$function$
-- ===END 22234
-- ===FUNC 22235 run_kpi_computation(p_company_id uuid, p_period date)
CREATE OR REPLACE FUNCTION public.run_kpi_computation(p_company_id uuid, p_period date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r       record;
  v_val   numeric;
  v_month date := date_trunc('month', p_period)::date;
  v_count integer := 0;
begin
  for r in
    select e.id as employee_id, d.id as kpi_definition_id
      from public.employees e
      join public.kpi_definitions d
        on d.company_id = e.company_id and d.seat = e.kpi_seat and d.active
     where e.company_id = p_company_id
       and e.performance_enrolled
       and d.auto_source is not null
  loop
    v_val := public.compute_kpi_value(r.employee_id, r.kpi_definition_id, v_month);

    insert into public.kpi_values
      (company_id, employee_id, kpi_definition_id, period_month, value, is_auto)
    values (p_company_id, r.employee_id, r.kpi_definition_id, v_month, v_val, true)
    on conflict (employee_id, kpi_definition_id, period_month) do update set
      value = excluded.value, is_auto = true, updated_at = now();

    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$function$
-- ===END 22235
-- ===FUNC 22291 kpi_score_for_appraisal(p_employee_id uuid, p_year integer)
CREATE OR REPLACE FUNCTION public.kpi_score_for_appraisal(p_employee_id uuid, p_year integer)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select round(avg(case kv.rag when 'green' then 5 when 'amber' then 3 when 'red' then 1 end), 2)
    from public.kpi_values kv
   where kv.employee_id = p_employee_id
     and extract(year from kv.period_month) = p_year
     and kv.rag is not null;
$function$
-- ===END 22291
-- ===FUNC 22292 sync_appraisal_rating()
CREATE OR REPLACE FUNCTION public.sync_appraisal_rating()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  s      record;
  w_sum  numeric;
  v_num  numeric;
begin
  select * into s from public.performance_settings where company_id = new.company_id;
  if s is null then return new; end if;

  w_sum := s.weight_job_kpi + s.weight_ownership + s.weight_quality
         + s.weight_teamwork + s.weight_initiative;

  if new.score_job_kpi is null or new.score_ownership is null or new.score_quality is null
     or new.score_teamwork is null or new.score_initiative is null or w_sum = 0 then
    new.weighted_score := null;
    new.rating := null;
    new.updated_at := now();
    return new;
  end if;

  v_num := new.score_job_kpi   * s.weight_job_kpi
         + new.score_ownership * s.weight_ownership
         + new.score_quality   * s.weight_quality
         + new.score_teamwork  * s.weight_teamwork
         + new.score_initiative* s.weight_initiative;
  new.weighted_score := round(v_num / w_sum, 3);

  new.rating := case
    when new.weighted_score >= s.rating_outstanding_min then 'outstanding'
    when new.weighted_score >= s.rating_exceeds_min     then 'exceeds'
    when new.weighted_score >= s.rating_meets_min       then 'meets'
    else 'below'
  end::public.appraisal_rating;
  new.updated_at := now();
  return new;
end;
$function$
-- ===END 22292
-- ===FUNC 22294 transition_appraisal(p_appraisal_id uuid, p_to appraisal_status)
CREATE OR REPLACE FUNCTION public.transition_appraisal(p_appraisal_id uuid, p_to appraisal_status)
 RETURNS appraisal_status
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a record; v_allowed boolean;
begin
  select * into a from public.appraisals where id = p_appraisal_id for update;
  if not found then
    raise exception 'appraisal % not found', p_appraisal_id using errcode = '23503';
  end if;

  v_allowed := (a.status, p_to) in
    (('draft','moderated'), ('moderated','draft'),
     ('moderated','approved'), ('approved','moderated'));
  if not v_allowed then
    raise exception 'illegal appraisal transition % -> %', a.status, p_to using errcode = '23514';
  end if;

  if p_to = 'approved' then
    if not coalesce(public.is_performance_approver(), false) then
      raise exception 'only a performance approver (COO) may approve an appraisal'
        using errcode = '42501';
    end if;
    if a.rating is null then
      raise exception 'appraisal has no rating; score all five criteria first'
        using errcode = '23514';
    end if;
  end if;

  update public.appraisals set
    status = p_to,
    moderated_by = case when p_to = 'moderated' then auth.uid() else moderated_by end,
    approved_by  = case when p_to = 'approved' then auth.uid() else approved_by end,
    approved_at  = case when p_to = 'approved' then now() else approved_at end,
    updated_at = now()
  where id = p_appraisal_id;

  if p_to = 'approved' then
    update public.employees
       set last_appraisal_rating = a.rating, last_appraisal_year = a.period_year, updated_at = now()
     where id = a.employee_id;
  end if;

  return p_to;
end;
$function$
-- ===END 22294
-- ===FUNC 22295 run_appreciation(p_company_id uuid, p_effective_date date, p_appraisal_year integer)
CREATE OR REPLACE FUNCTION public.run_appreciation(p_company_id uuid, p_effective_date date, p_appraisal_year integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  s      record;
  e      record;
  v_new  numeric;
  v_count integer := 0;
begin
  select * into s from public.performance_settings where company_id = p_company_id;
  if s is null then
    raise exception 'no performance settings for company %', p_company_id using errcode = '23503';
  end if;

  for e in
    select emp.* from public.employees emp
     where emp.company_id = p_company_id
       and emp.lifecycle_state = 'active'
       and emp.performance_enrolled
       and emp.last_appraisal_year = p_appraisal_year
       and emp.last_appraisal_rating is distinct from 'below'
       and emp.base_salary is not null
  loop
    v_new := round(e.base_salary * (1 + s.appreciation_pct / 100.0), 2);
    perform public.set_employee_salary(
      e.id, p_effective_date, v_new, coalesce(e.allowance, 0), e.per_day_salary,
      'Annual appreciation ' || s.appreciation_pct || '% (' || p_appraisal_year || ')');
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$
-- ===END 22295
-- ===FUNC 22297 region_profit(p_company_id uuid, p_branch_id uuid, p_year integer)
CREATE OR REPLACE FUNCTION public.region_profit(p_company_id uuid, p_branch_id uuid, p_year integer)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(sum(
           case a.account_type
             when 'revenue' then jl.credit - jl.debit
             when 'expense' then -(jl.debit - jl.credit)
             else 0
           end), 0)
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.journal_entry_id
    join public.chart_of_accounts a on a.id = jl.account_id
   where je.company_id = p_company_id
     and extract(year from je.entry_date) = p_year
     and (p_branch_id is null or jl.branch_id = p_branch_id)
     and a.account_type in ('revenue', 'expense');
$function$
-- ===END 22297
-- ===FUNC 22370 bonus_proration(p_employee_id uuid, p_year integer)
CREATE OR REPLACE FUNCTION public.bonus_proration(p_employee_id uuid, p_year integer)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select greatest(0, least(1,
    ( least(coalesce(e.exit_date, make_date(p_year,12,31)), make_date(p_year,12,31))
      - greatest(coalesce(e.performance_enrolled_on, make_date(p_year,1,1)), make_date(p_year,1,1))
      + 1 )::numeric
    / (make_date(p_year,12,31) - make_date(p_year,1,1) + 1)
  ))
  from public.employees e where e.id = p_employee_id;
$function$
-- ===END 22370
-- ===FUNC 22371 generate_bonus_pool(p_company_id uuid, p_year integer, p_scope bonus_pool_scope, p_branch_id uuid)
CREATE OR REPLACE FUNCTION public.generate_bonus_pool(p_company_id uuid, p_year integer, p_scope bonus_pool_scope, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  s          record;
  v_ho       uuid := public.head_office_region(p_company_id);
  v_scope_branch uuid;
  v_cur      numeric;
  v_prior    numeric;
  v_growth   numeric;
  v_pct      numeric;
  v_amount   numeric;
  v_pool     uuid;
  e          record;
  v_weight   numeric;
  v_prorate  numeric;
  v_points   numeric;
  v_total    numeric := 0;
begin
  select * into s from public.performance_settings where company_id = p_company_id;

  if p_scope = 'regional' then
    if p_branch_id is null then
      raise exception 'regional pool requires a branch' using errcode = '23514';
    end if;
    v_scope_branch := p_branch_id;
    v_pct := s.regional_pool_pct;
    v_cur   := public.region_operating_profit(p_company_id, p_branch_id, p_year);
    v_prior := public.region_operating_profit(p_company_id, p_branch_id, p_year - 1);
  else
    v_scope_branch := v_ho;
    v_pct := s.ho_pool_pct;
    v_cur   := public.region_operating_profit(p_company_id, null, p_year);
    v_prior := public.region_operating_profit(p_company_id, null, p_year - 1);
  end if;

  v_growth := v_cur - v_prior;
  v_amount := round(greatest(v_growth, 0) * v_pct / 100.0, 2);

  insert into public.bonus_pools
    (company_id, period_year, scope, branch_id, profit_current, profit_prior,
     growth, pool_pct, pool_amount)
  values
    (p_company_id, p_year, p_scope, case when p_scope='regional' then p_branch_id else null end,
     v_cur, v_prior, v_growth, v_pct, v_amount)
  on conflict (company_id, period_year, scope,
               coalesce(branch_id, '00000000-0000-0000-0000-000000000000'))
    do update set profit_current = excluded.profit_current,
                  profit_prior = excluded.profit_prior,
                  growth = excluded.growth,
                  pool_pct = excluded.pool_pct,
                  pool_amount = excluded.pool_amount,
                  updated_at = now()
  returning id into v_pool;

  delete from public.bonus_pool_allocations where pool_id = v_pool;

  for e in
    select emp.id, emp.base_salary, emp.last_appraisal_rating
      from public.employees emp
     where emp.company_id = p_company_id
       and emp.performance_enrolled
       and emp.category = 'office_staff'
       and emp.branch_id = v_scope_branch
       and (s.leaver_bonus_rule = 'pro_rata' or emp.lifecycle_state = 'active')
  loop
    v_weight := case e.last_appraisal_rating
      when 'outstanding' then s.weight_rating_outstanding
      when 'exceeds'     then s.weight_rating_exceeds
      when 'meets'       then s.weight_rating_meets
      else s.weight_rating_below
    end;
    v_prorate := public.bonus_proration(e.id, p_year);
    v_points  := round(coalesce(e.base_salary,0) * v_weight * v_prorate, 4);
    v_total   := v_total + v_points;

    insert into public.bonus_pool_allocations
      (company_id, pool_id, employee_id, salary, rating, rating_weight, proration, points)
    values (p_company_id, v_pool, e.id, e.base_salary, e.last_appraisal_rating,
            v_weight, v_prorate, v_points);
  end loop;

  if v_total > 0 and v_amount > 0 then
    update public.bonus_pool_allocations
       set share_amount = round(v_amount * points / v_total, 2)
     where pool_id = v_pool;
  else
    update public.bonus_pool_allocations set share_amount = 0 where pool_id = v_pool;
  end if;

  return v_pool;
end;
$function$
-- ===END 22371
-- ===FUNC 22372 approve_bonus_pool(p_pool_id uuid)
CREATE OR REPLACE FUNCTION public.approve_bonus_pool(p_pool_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not coalesce(public.is_performance_approver(), false) then
    raise exception 'only a performance approver (COO) may approve a bonus pool'
      using errcode = '42501';
  end if;
  update public.bonus_pools
     set status = 'approved', approved_by = auth.uid(), approved_at = now(), updated_at = now()
   where id = p_pool_id and status = 'draft';
  if not found then
    raise exception 'pool % not found or not in draft', p_pool_id using errcode = '23514';
  end if;
end;
$function$
-- ===END 22372
-- ===FUNC 22373 pay_bonus_allocation(p_allocation_id uuid, p_payslip_id uuid)
CREATE OR REPLACE FUNCTION public.pay_bonus_allocation(p_allocation_id uuid, p_payslip_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a record; v_pool record;
begin
  select * into a from public.bonus_pool_allocations where id = p_allocation_id;
  if not found then
    raise exception 'allocation % not found', p_allocation_id using errcode = '23503';
  end if;
  select * into v_pool from public.bonus_pools where id = a.pool_id;
  if v_pool.status <> 'approved' then
    raise exception 'bonus pool must be approved before payout (currently %)', v_pool.status
      using errcode = '23514';
  end if;
  if a.paid then
    raise exception 'allocation already paid' using errcode = '23505';
  end if;
  if coalesce(a.share_amount, 0) <= 0 then
    return;
  end if;

  insert into public.payslip_reward_lines (company_id, payslip_id, kind, label, amount)
  values (a.company_id, p_payslip_id, 'bonus',
          'Bonus pool ' || v_pool.period_year || ' (' || v_pool.scope || ')', a.share_amount);

  update public.bonus_pool_allocations set paid = true, paid_payslip_id = p_payslip_id
   where id = p_allocation_id;
end;
$function$
-- ===END 22373
-- ===FUNC 22438 inherit_region_guard_bonus()
CREATE OR REPLACE FUNCTION public.inherit_region_guard_bonus()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  new.branch_id := coalesce(new.branch_id, public.region_for_employee(new.employee_id),
                            public.head_office_region(new.company_id));
  return new;
end;
$function$
-- ===END 22438
-- ===FUNC 22440 accrue_attendance_bonuses(p_company_id uuid, p_period date, p_amount numeric)
CREATE OR REPLACE FUNCTION public.accrue_attendance_bonuses(p_company_id uuid, p_period date, p_amount numeric)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_month date := date_trunc('month', p_period)::date;
  v_start date := v_month;
  v_end   date := (v_month + interval '1 month - 1 day')::date;
  v_count integer;
begin
  with qualifying as (
    select e.id as employee_id, e.company_id
      from public.employees e
     where e.company_id = p_company_id
       and e.category in ('client', 'reliever')
       and e.lifecycle_state = 'active'
       and exists (select 1 from public.attendance_records a
                    where a.employee_id = e.id
                      and a.attendance_date between v_start and v_end)
       and not exists (select 1 from public.attendance_records a
                        where a.employee_id = e.id
                          and a.attendance_date between v_start and v_end
                          and lower(a.status) = 'absent')
  )
  insert into public.guard_bonuses (company_id, employee_id, bonus_type, period_month, amount)
  select company_id, employee_id, 'attendance', v_month, p_amount from qualifying
  on conflict (employee_id, bonus_type, period_month) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$function$
-- ===END 22440
-- ===FUNC 22441 trigger_referral_bonus()
CREATE OR REPLACE FUNCTION public.trigger_referral_bonus()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_amount numeric := 0;
begin
  if new.referred_by_employee_id is null then return new; end if;
  if new.lifecycle_state <> 'active' then return new; end if;
  if new.probation_end_date is null or new.probation_end_date > current_date then return new; end if;

  insert into public.guard_bonuses
    (company_id, employee_id, bonus_type, amount, referred_employee_id, notes)
  values (new.company_id, new.referred_by_employee_id, 'referral', v_amount, new.id,
          'Referral: ' || new.full_name || ' passed probation')
  on conflict (referred_employee_id) where bonus_type = 'referral' do nothing;
  return new;
end;
$function$
-- ===END 22441
-- ===FUNC 22444 accrue_eid_bonuses(p_company_id uuid, p_eid_date date, p_amount numeric)
CREATE OR REPLACE FUNCTION public.accrue_eid_bonuses(p_company_id uuid, p_eid_date date, p_amount numeric)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_count integer; v_month date := date_trunc('month', p_eid_date)::date;
begin
  insert into public.guard_bonuses (company_id, employee_id, bonus_type, period_month, amount, notes)
  select e.company_id, e.id, 'eid', v_month, p_amount, 'Eid bonus'
    from public.employees e
   where e.company_id = p_company_id
     and e.category in ('client', 'reliever')
     and e.lifecycle_state = 'active'
     and (e.probation_end_date is null or e.probation_end_date <= current_date)
  on conflict (employee_id, bonus_type, period_month) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$function$
-- ===END 22444
-- ===FUNC 22445 accrue_long_service_bonus(p_employee_id uuid, p_amount numeric, p_notes text)
CREATE OR REPLACE FUNCTION public.accrue_long_service_bonus(p_employee_id uuid, p_amount numeric, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_id uuid; v_company uuid;
begin
  select company_id into v_company from public.employees where id = p_employee_id;
  if v_company is null then
    raise exception 'employee % not found', p_employee_id using errcode = '23503';
  end if;
  insert into public.guard_bonuses (company_id, employee_id, bonus_type, amount, notes)
  values (v_company, p_employee_id, 'long_service', p_amount,
          coalesce(p_notes, 'Long-service milestone'))
  returning id into v_id;
  return v_id;
end;
$function$
-- ===END 22445
-- ===FUNC 22456 stamp_task_completion()
CREATE OR REPLACE FUNCTION public.stamp_task_completion()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if lower(coalesce(new.status,'')) in ('done', 'completed', 'complete') then
    if new.completed_at is null then new.completed_at := now(); end if;
  else
    new.completed_at := null;
  end if;
  return new;
end;
$function$
-- ===END 22456
-- ===FUNC 22458 tasks_on_time_pct(p_assignee_id uuid, p_period date)
CREATE OR REPLACE FUNCTION public.tasks_on_time_pct(p_assignee_id uuid, p_period date)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with due as (
    select t.* from public.tasks t
     where t.assignee_id = p_assignee_id
       and t.due_date is not null
       and date_trunc('month', t.due_date) = date_trunc('month', p_period)
  )
  select case when count(*) = 0 then null
              else round(100.0 * count(*) filter (
                     where completed_at is not null
                       and completed_at::date <= due_date) / count(*), 1) end
    from due;
$function$
-- ===END 22458
-- ===FUNC 22476 region_for_post(p_post_id uuid)
CREATE OR REPLACE FUNCTION public.region_for_post(p_post_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select branch_id from public.posts where id = p_post_id;
$function$
-- ===END 22476
-- ===FUNC 22561 stamp_visit_completion()
CREATE OR REPLACE FUNCTION public.stamp_visit_completion()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.status = 'completed' and new.completed_at is null then
    new.completed_at := now();
  end if;
  new.updated_at := now();
  return new;
end;
$function$
-- ===END 22561
-- ===FUNC 22606 no_show_count(p_employee_id uuid, p_window_days integer)
CREATE OR REPLACE FUNCTION public.no_show_count(p_employee_id uuid, p_window_days integer)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select count(*)::integer from public.no_show_events
   where employee_id = p_employee_id
     and event_date >= current_date - p_window_days;
$function$
-- ===END 22606
-- ===FUNC 22607 warn_repeat_no_show(p_employee_id uuid)
CREATE OR REPLACE FUNCTION public.warn_repeat_no_show(p_employee_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  s        record;
  v_company uuid;
  v_count  integer;
  v_id     uuid;
begin
  select company_id into v_company from public.employees where id = p_employee_id;
  if v_company is null then
    raise exception 'employee % not found', p_employee_id using errcode = '23503';
  end if;
  select * into s from public.field_ops_settings where company_id = v_company;

  v_count := public.no_show_count(p_employee_id, coalesce(s.repeat_no_show_window_days, 90));
  if v_count < coalesce(s.repeat_no_show_threshold, 3) then
    return null;
  end if;

  insert into public.disciplinary_warnings (company_id, employee_id, reason)
  values (v_company, p_employee_id,
          'Repeat no-shows: ' || v_count || ' in the last '
          || coalesce(s.repeat_no_show_window_days,90) || ' days')
  returning id into v_id;
  return v_id;
end;
$function$
-- ===END 22607
-- ===FUNC 22711 seed_mobilisation_items()
CREATE OR REPLACE FUNCTION public.seed_mobilisation_items()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.contract_mobilisation_items (company_id, mobilisation_id, step)
  select new.company_id, new.id, s
    from unnest(enum_range(null::public.mobilisation_step)) s
  on conflict (mobilisation_id, step) do nothing;
  return null;
end;
$function$
-- ===END 22711
-- ===FUNC 22713 stamp_mobilisation_item()
CREATE OR REPLACE FUNCTION public.stamp_mobilisation_item()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.done and not old.done then
    new.done_at := now();
    new.done_by := auth.uid();
  elsif not new.done then
    new.done_at := null; new.done_by := null;
  end if;
  return new;
end;
$function$
-- ===END 22713
-- ===FUNC 22715 launch_site(p_mobilisation_id uuid)
CREATE OR REPLACE FUNCTION public.launch_site(p_mobilisation_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_open integer;
begin
  select count(*) into v_open
    from public.contract_mobilisation_items
   where mobilisation_id = p_mobilisation_id and not done;
  if v_open > 0 then
    raise exception 'cannot launch: % mobilisation step(s) still open', v_open
      using errcode = '23514',
            hint = 'Complete guards, vetting, kit, post orders and client NOC first.';
  end if;

  update public.contract_mobilisations
     set status = 'launched', launched_at = now(), updated_at = now()
   where id = p_mobilisation_id;
  if not found then
    raise exception 'mobilisation % not found', p_mobilisation_id using errcode = '23503';
  end if;
end;
$function$
-- ===END 22715
-- ===FUNC 22751 inherit_region_from_post()
CREATE OR REPLACE FUNCTION public.inherit_region_from_post()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client uuid;
begin
  v_client := nullif(to_jsonb(new) ->> 'client_id', '')::uuid;
  new.branch_id := coalesce(
    public.region_for_post(new.post_id),
    public.region_for_client(v_client),
    public.head_office_region(new.company_id));
  return new;
end;
$function$
-- ===END 22751
-- ===FUNC 22756 inherit_region_mobilisation()
CREATE OR REPLACE FUNCTION public.inherit_region_mobilisation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_region uuid;
begin
  select coalesce(public.region_for_post(new.post_id),
                  (select cl.branch_id from public.contracts c
                     join public.clients cl on cl.id = c.client_id
                    where c.id = new.contract_id))
    into v_region;
  new.branch_id := coalesce(v_region, public.head_office_region(new.company_id));
  return new;
end;
$function$
-- ===END 22756
-- ===FUNC 22838 stamp_compliance_stage()
CREATE OR REPLACE FUNCTION public.stamp_compliance_stage()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.stage = 'submitted' and new.submitted_date is null then
    new.submitted_date := current_date;
  end if;
  if new.stage = 'issued' and new.issued_date is null then
    new.issued_date := current_date;
  end if;
  new.updated_at := now();
  return new;
end;
$function$
-- ===END 22838
-- ===FUNC 22905 inherit_region_compliance()
CREATE OR REPLACE FUNCTION public.inherit_region_compliance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  new.branch_id := coalesce(new.branch_id, public.head_office_region(new.company_id));
  return new;
end;
$function$
-- ===END 22905
-- ===FUNC 22940 avg_deployed_guards(p_company_id uuid, p_branch_id uuid, p_period date)
CREATE OR REPLACE FUNCTION public.avg_deployed_guards(p_company_id uuid, p_branch_id uuid, p_period date)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select round(
    count(*) filter (where lower(a.status) in ('present','double_duty','relief_cover'))::numeric
    / extract(day from (date_trunc('month', p_period) + interval '1 month - 1 day')), 2)
  from public.attendance_records a
  where a.company_id = p_company_id
    and a.branch_id = p_branch_id
    and a.attendance_date >= date_trunc('month', p_period)::date
    and a.attendance_date < (date_trunc('month', p_period) + interval '1 month')::date;
$function$
-- ===END 22940
-- ===FUNC 22962 ho_overhead_for_month(p_company_id uuid, p_period date)
CREATE OR REPLACE FUNCTION public.ho_overhead_for_month(p_company_id uuid, p_period date)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(sum(jl.debit - jl.credit), 0)
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.journal_entry_id
    join public.chart_of_accounts a on a.id = jl.account_id
   where je.company_id = p_company_id
     and jl.branch_id = public.head_office_region(p_company_id)
     and a.account_type = 'expense'
     and a.system_key not in ('allocated_ho_cost', 'ho_cost_recovery', 'income_tax', 'bonus_expense')
     and je.entry_date >= date_trunc('month', p_period)::date
     and je.entry_date < (date_trunc('month', p_period) + interval '1 month')::date;
$function$
-- ===END 22962
-- ===FUNC 22964 region_operating_profit(p_company_id uuid, p_branch_id uuid, p_year integer)
CREATE OR REPLACE FUNCTION public.region_operating_profit(p_company_id uuid, p_branch_id uuid, p_year integer)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(sum(
           case a.account_type
             when 'revenue' then jl.credit - jl.debit
             when 'expense' then -(jl.debit - jl.credit)
             else 0
           end), 0)
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.journal_entry_id
    join public.chart_of_accounts a on a.id = jl.account_id
   where je.company_id = p_company_id
     and extract(year from je.entry_date) = p_year
     and (p_branch_id is null or jl.branch_id = p_branch_id)
     and a.account_type in ('revenue', 'expense')
     and a.system_key is distinct from 'bonus_expense';
$function$
-- ===END 22964
-- ===FUNC 22992 region_operating_profit_range(p_company_id uuid, p_branch_id uuid, p_start date, p_end date)
CREATE OR REPLACE FUNCTION public.region_operating_profit_range(p_company_id uuid, p_branch_id uuid, p_start date, p_end date)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(sum(
           case a.account_type
             when 'revenue' then jl.credit - jl.debit
             when 'expense' then -(jl.debit - jl.credit)
             else 0
           end), 0)
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.journal_entry_id
    join public.chart_of_accounts a on a.id = jl.account_id
   where je.company_id = p_company_id
     and je.entry_date between p_start and p_end
     and (p_branch_id is null or jl.branch_id = p_branch_id)
     and a.account_type in ('revenue', 'expense')
     and a.system_key is distinct from 'bonus_expense';
$function$
-- ===END 22992
-- ===FUNC 22993 accrue_bonus_reserve(p_company_id uuid, p_period date)
CREATE OR REPLACE FUNCTION public.accrue_bonus_reserve(p_company_id uuid, p_period date)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  s          record;
  fs         record;
  v_month    date := date_trunc('month', p_period)::date;
  v_end      date := (v_month + interval '1 month - 1 day')::date;
  v_year     integer := extract(year from v_month);
  v_cur_start date := make_date(v_year, 1, 1);
  v_prior_start date := make_date(v_year - 1, 1, 1);
  v_prior_end date := (make_date(v_year - 1, extract(month from v_month)::int, 1)
                       + interval '1 month - 1 day')::date;
  rec        record;
  v_ytd      numeric;
  v_ytd_prior numeric;
  v_growth   numeric;
  v_pct      numeric;
  v_target   numeric;
  v_prior_accrued numeric;
  v_delta    numeric;
  v_total_delta numeric := 0;
  v_ho       uuid := public.head_office_region(p_company_id);
  v_accrual_id uuid;
  v_region   uuid;
begin
  select * into s  from public.performance_settings where company_id = p_company_id;
  select * into fs from public.finance_settings     where company_id = p_company_id;

  for rec in
    select 'regional'::public.bonus_pool_scope as scope, b.id as branch_id
      from public.branches b
     where b.company_id = p_company_id and b.kind = 'regional' and b.active
    union all
    select 'head_office'::public.bonus_pool_scope, v_ho
  loop
    if rec.scope = 'regional' then
      v_pct := s.regional_pool_pct;
      v_ytd       := public.region_operating_profit_range(p_company_id, rec.branch_id, v_cur_start, v_end);
      v_ytd_prior := public.region_operating_profit_range(p_company_id, rec.branch_id, v_prior_start, v_prior_end);
    else
      v_pct := s.ho_pool_pct;
      v_ytd       := public.region_operating_profit_range(p_company_id, null, v_cur_start, v_end);
      v_ytd_prior := public.region_operating_profit_range(p_company_id, null, v_prior_start, v_prior_end);
    end if;

    v_growth := v_ytd - v_ytd_prior;
    v_target := round(greatest(v_growth, 0) * v_pct / 100.0
                      * coalesce(fs.bonus_accrual_conservatism_pct, 75) / 100.0, 2);

    select coalesce(max(target_accrual), 0) into v_prior_accrued
      from public.bonus_accruals
     where company_id = p_company_id and scope = rec.scope
       and coalesce(branch_id,'00000000-0000-0000-0000-000000000000')
           = coalesce(rec.branch_id,'00000000-0000-0000-0000-000000000000')
       and period_month < v_month
       and extract(year from period_month) = v_year;

    v_delta := round(v_target - v_prior_accrued, 2);
    v_region := case when rec.scope='regional' then rec.branch_id else v_ho end;

    insert into public.bonus_accruals
      (company_id, branch_id, scope, period_month, profit_ytd, profit_ytd_prior,
       growth_ytd, pool_pct, conservatism_pct, target_accrual, accrued_delta)
    values
      (p_company_id, v_region, rec.scope, v_month, v_ytd, v_ytd_prior, v_growth, v_pct,
       coalesce(fs.bonus_accrual_conservatism_pct,75), v_target, v_delta)
    on conflict (company_id, scope,
                 coalesce(branch_id,'00000000-0000-0000-0000-000000000000'), period_month)
      do update set profit_ytd = excluded.profit_ytd,
                    profit_ytd_prior = excluded.profit_ytd_prior,
                    growth_ytd = excluded.growth_ytd,
                    target_accrual = excluded.target_accrual,
                    accrued_delta = excluded.accrued_delta
      returning id into v_accrual_id;

    perform public.reverse_journal_for_source(p_company_id, 'bonus_accrual', v_accrual_id, v_end);
    perform public.reverse_journal_for_source(p_company_id, 'bonus_reserve_funding', v_accrual_id, v_end);

    if v_delta > 0 then
      perform public.post_journal(
        p_company_id, v_end,
        'Bonus accrual ' || to_char(v_month,'YYYY-MM') || ' (' || rec.scope || ')',
        'bonus_accrual', v_accrual_id, false,
        jsonb_build_array(
          jsonb_build_object('key','bonus_expense',  'debit', v_delta, 'credit', 0, 'region', v_region),
          jsonb_build_object('key','bonus_provision', 'debit', 0, 'credit', v_delta, 'region', v_region)),
        v_region);

      perform public.post_journal(
        p_company_id, v_end,
        'Bonus reserve funding ' || to_char(v_month,'YYYY-MM'),
        'bonus_reserve_funding', v_accrual_id, false,
        jsonb_build_array(
          jsonb_build_object('key','bonus_reserve','debit', v_delta,'credit',0, 'region', v_region),
          jsonb_build_object('key','bank','debit',0,'credit', v_delta, 'region', v_region)),
        v_region);

      v_total_delta := v_total_delta + v_delta;
    end if;
  end loop;

  return v_total_delta;
end;
$function$
-- ===END 22993
-- ===FUNC 22994 trueup_bonus_provision(p_company_id uuid, p_year integer)
CREATE OR REPLACE FUNCTION public.trueup_bonus_provision(p_company_id uuid, p_year integer)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_ho        uuid := public.head_office_region(p_company_id);
  v_provision numeric;
  v_actual    numeric;
  v_diff      numeric;
begin
  select coalesce(sum(jl.credit - jl.debit), 0) into v_provision
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.journal_entry_id
    join public.chart_of_accounts a on a.id = jl.account_id
   where je.company_id = p_company_id and a.system_key = 'bonus_provision';

  select coalesce(sum(pool_amount), 0) into v_actual
    from public.bonus_pools
   where company_id = p_company_id and period_year = p_year
     and status in ('approved', 'paid');

  v_diff := round(v_actual - v_provision, 2);
  if v_diff = 0 then return 0; end if;

  perform public.post_journal(
    p_company_id, make_date(p_year, 12, 31),
    'Bonus provision true-up ' || p_year,
    'bonus_trueup', gen_random_uuid(), false,
    case when v_diff > 0 then
      jsonb_build_array(
        jsonb_build_object('key','bonus_expense', 'debit', v_diff, 'credit', 0),
        jsonb_build_object('key','bonus_provision','debit', 0, 'credit', v_diff))
    else
      jsonb_build_array(
        jsonb_build_object('key','bonus_provision','debit', -v_diff, 'credit', 0),
        jsonb_build_object('key','bonus_expense', 'debit', 0, 'credit', -v_diff))
    end,
    v_ho);

  return v_diff;
end;
$function$
-- ===END 22994
-- ===FUNC 23133 inherit_region_vehicle_log()
CREATE OR REPLACE FUNCTION public.inherit_region_vehicle_log()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  new.branch_id := coalesce(new.branch_id,
    (select branch_id from public.vehicles where id = new.vehicle_id),
    public.head_office_region(new.company_id));
  return new;
end;
$function$
-- ===END 23133
-- ===FUNC 23135 inherit_region_ammo()
CREATE OR REPLACE FUNCTION public.inherit_region_ammo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  new.branch_id := coalesce(new.branch_id,
    (select branch_id from public.inventory_items where id = new.weapon_item_id),
    public.head_office_region(new.company_id));
  return new;
end;
$function$
-- ===END 23135
-- ===FUNC 23137 inherit_region_vehicle()
CREATE OR REPLACE FUNCTION public.inherit_region_vehicle()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  new.branch_id := coalesce(new.branch_id,
    public.region_for_employee(new.assigned_employee_id),
    public.head_office_region(new.company_id));
  return new;
end;
$function$
-- ===END 23137
-- ===FUNC 23181 raise_alert(p_company_id uuid, p_tier alert_tier, p_category text, p_message text, p_ref_table text, p_ref_id uuid, p_branch_id uuid)
CREATE OR REPLACE FUNCTION public.raise_alert(p_company_id uuid, p_tier alert_tier, p_category text, p_message text, p_ref_table text DEFAULT NULL::text, p_ref_id uuid DEFAULT NULL::uuid, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_id uuid;
begin
  insert into public.alerts (company_id, branch_id, tier, category, message, ref_table, ref_id, created_by)
  values (p_company_id, coalesce(p_branch_id, public.head_office_region(p_company_id)),
          p_tier, p_category, p_message, p_ref_table, p_ref_id, auth.uid())
  returning id into v_id;
  return v_id;
end;
$function$
-- ===END 23181
-- ===FUNC 23182 acknowledge_alert(p_alert_id uuid, p_override_reason text)
CREATE OR REPLACE FUNCTION public.acknowledge_alert(p_alert_id uuid, p_override_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a record;
begin
  select * into a from public.alerts where id = p_alert_id;
  if not found then
    raise exception 'alert % not found', p_alert_id using errcode = '23503';
  end if;
  if a.tier = 'blocking' and coalesce(trim(p_override_reason), '') = '' then
    raise exception 'overriding a blocking alert requires a reason' using errcode = '23514';
  end if;
  update public.alerts set
    state = (case when a.tier = 'blocking' then 'overridden' else 'acknowledged' end)::public.alert_state,
    acknowledged_by = auth.uid(), acknowledged_at = now(),
    override_reason = p_override_reason
  where id = p_alert_id;
end;
$function$
-- ===END 23182
-- ===FUNC 23183 check_deploy_guard(p_employee_id uuid)
CREATE OR REPLACE FUNCTION public.check_deploy_guard(p_employee_id uuid)
 RETURNS text[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_block text[];
begin
  v_block := public.armed_post_blockers(p_employee_id);
  if array_length(v_block, 1) > 0 then
    perform public.raise_alert(
      (select company_id from public.employees where id = p_employee_id),
      'blocking', 'deploy_unverified_guard',
      'Guard cannot be deployed to a sensitive/armed post: ' || array_to_string(v_block, ', '),
      'employees', p_employee_id,
      (select branch_id from public.employees where id = p_employee_id));
  end if;
  return v_block;
end;
$function$
-- ===END 23183
-- ===FUNC 23184 sweep_ammo_discrepancy_alerts(p_company_id uuid)
CREATE OR REPLACE FUNCTION public.sweep_ammo_discrepancy_alerts(p_company_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d record; v_count integer := 0;
begin
  for d in select * from public.ammunition_discrepancies where company_id = p_company_id loop
    if not exists (select 1 from public.alerts
                    where category = 'ammo_discrepancy' and ref_id = d.count_id and state = 'open') then
      perform public.raise_alert(p_company_id, 'blocking', 'ammo_discrepancy',
        'Ammunition discrepancy: ' || d.discrepancy || ' rounds unaccounted on '
        || coalesce(d.item_type,'weapon') || coalesce(' #' || d.serial_number, ''),
        'ammunition_counts', d.count_id, d.branch_id);
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$function$
-- ===END 23184
-- ===FUNC 23190 bonus_accrual_missing(p_company_id uuid, p_period date)
CREATE OR REPLACE FUNCTION public.bonus_accrual_missing(p_company_id uuid, p_period date)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select not exists (
    select 1 from public.bonus_accruals
     where company_id = p_company_id
       and period_month = date_trunc('month', p_period)::date);
$function$
-- ===END 23190
-- ===FUNC 23313 inherit_region_from_client_col()
CREATE OR REPLACE FUNCTION public.inherit_region_from_client_col()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  new.branch_id := coalesce(new.branch_id, public.region_for_client(new.client_id),
                            public.head_office_region(new.company_id));
  return new;
end;
$function$
-- ===END 23313
-- ===FUNC 23332 client_service_report(p_client_id uuid, p_start date, p_end date)
CREATE OR REPLACE FUNCTION public.client_service_report(p_client_id uuid, p_start date, p_end date)
 RETURNS TABLE(reports_submitted integer, all_ok_reports integer, exception_reports integer, visits_completed integer, incidents_total integer, incidents_resolved integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    (select count(*)::int from public.daily_ok_reports r
      where r.client_id = p_client_id and r.report_date between p_start and p_end),
    (select count(*)::int from public.daily_ok_reports r
      where r.client_id = p_client_id and r.report_date between p_start and p_end and r.all_ok),
    (select count(*)::int from public.daily_ok_reports r
      where r.client_id = p_client_id and r.report_date between p_start and p_end and not r.all_ok),
    (select count(*)::int from public.supervisor_visits v
      where v.client_id = p_client_id and v.status = 'completed'
        and v.completed_at::date between p_start and p_end),
    (select count(*)::int from public.incidents i
      where i.client_id = p_client_id and i.occurred_at::date between p_start and p_end),
    (select count(*)::int from public.incidents i
      where i.client_id = p_client_id and i.occurred_at::date between p_start and p_end
        and i.status in ('resolved','closed'));
$function$
-- ===END 23332
-- ===FUNC 23347 has_perm(p_perm text)
CREATE OR REPLACE FUNCTION public.has_perm(p_perm text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(
    public.current_role()::text in ('super_super_admin', 'super_admin')
    or exists (select 1 from public.profiles
                where id = auth.uid() and p_perm = any(permissions)),
    false);
$function$
-- ===END 23347
-- ===FUNC 23406 request_approval(p_company_id uuid, p_action_key text, p_ref_table text, p_ref_id uuid, p_amount numeric, p_payload jsonb, p_branch_id uuid)
CREATE OR REPLACE FUNCTION public.request_approval(p_company_id uuid, p_action_key text, p_ref_table text DEFAULT NULL::text, p_ref_id uuid DEFAULT NULL::uuid, p_amount numeric DEFAULT NULL::numeric, p_payload jsonb DEFAULT NULL::jsonb, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare cfg record; v_id uuid; v_auto boolean := false;
begin
  select * into cfg from public.approval_configs
   where company_id = p_company_id and action_key = p_action_key and active;
  if not found then
    raise exception 'no active approval config for action %', p_action_key using errcode = '23503';
  end if;

  if cfg.threshold_amount is not null and coalesce(p_amount, 0) <= cfg.threshold_amount then
    v_auto := true;
  end if;

  insert into public.approval_requests
    (company_id, branch_id, action_key, ref_table, ref_id, amount, payload,
     status, requested_by, decided_by, decided_at)
  values
    (p_company_id, p_branch_id, p_action_key, p_ref_table, p_ref_id, p_amount, p_payload,
     (case when v_auto then 'auto_approved' else 'pending' end)::public.approval_status,
     auth.uid(), case when v_auto then auth.uid() end, case when v_auto then now() end)
  returning id into v_id;
  return v_id;
end;
$function$
-- ===END 23406
-- ===FUNC 23407 decide_approval(p_request_id uuid, p_approve boolean, p_reason text)
CREATE OR REPLACE FUNCTION public.decide_approval(p_request_id uuid, p_approve boolean, p_reason text DEFAULT NULL::text)
 RETURNS approval_status
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record; cfg record;
begin
  select * into r from public.approval_requests where id = p_request_id for update;
  if not found then
    raise exception 'approval request % not found', p_request_id using errcode = '23503';
  end if;
  if r.status not in ('pending', 'recommended') then
    raise exception 'request is already %', r.status using errcode = '23514';
  end if;

  select * into cfg from public.approval_configs
   where company_id = r.company_id and action_key = r.action_key;

  if not coalesce(public.has_perm(cfg.approver_permission), false) then
    raise exception 'you lack the % permission required to decide this action', cfg.approver_permission
      using errcode = '42501';
  end if;

  update public.approval_requests set
    status = (case when p_approve then 'approved' else 'rejected' end)::public.approval_status,
    decided_by = auth.uid(), decided_at = now(), decision_reason = p_reason
  where id = p_request_id;

  return (case when p_approve then 'approved' else 'rejected' end)::public.approval_status;
end;
$function$
-- ===END 23407
-- ===FUNC 23408 is_action_approved(p_ref_table text, p_ref_id uuid, p_action_key text)
CREATE OR REPLACE FUNCTION public.is_action_approved(p_ref_table text, p_ref_id uuid, p_action_key text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.approval_requests
     where ref_table = p_ref_table and ref_id = p_ref_id and action_key = p_action_key
       and status in ('approved', 'auto_approved'));
$function$
-- ===END 23408
-- ===FUNC 23454 journal_on_interregion()
CREATE OR REPLACE FUNCTION public.journal_on_interregion()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_recv uuid; v_pay uuid;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'interregion_transactions', old.id, old.txn_date);
    return old;
  end if;

  if new.txn_type = 'funding' then
    perform public.post_journal(
      new.company_id, new.txn_date,
      'Inter-region funding',
      'interregion_transactions', new.id, false,
      jsonb_build_array(
        jsonb_build_object('key','interregion_receivable','debit',new.amount,'credit',0,'region',new.lender_branch_id),
        jsonb_build_object('key','interregion_payable','debit',0,'credit',new.amount,'region',new.borrower_branch_id)),
      new.lender_branch_id);
  else
    perform public.post_journal(
      new.company_id, new.txn_date,
      'Inter-region repayment',
      'interregion_transactions', new.id, false,
      jsonb_build_array(
        jsonb_build_object('key','interregion_payable','debit',new.amount,'credit',0,'region',new.borrower_branch_id),
        jsonb_build_object('key','interregion_receivable','debit',0,'credit',new.amount,'region',new.lender_branch_id)),
      new.borrower_branch_id);
  end if;
  return new;
end;
$function$
-- ===END 23454
-- ===FUNC 23456 fund_region(p_company_id uuid, p_lender uuid, p_borrower uuid, p_amount numeric, p_approval_request_id uuid, p_auto_settle boolean, p_notes text)
CREATE OR REPLACE FUNCTION public.fund_region(p_company_id uuid, p_lender uuid, p_borrower uuid, p_amount numeric, p_approval_request_id uuid, p_auto_settle boolean DEFAULT false, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_id uuid;
begin
  if not exists (select 1 from public.approval_requests
                  where id = p_approval_request_id and action_key = 'interregion_funding'
                    and status in ('approved','auto_approved')) then
    raise exception 'inter-region funding requires an approved request (COO sign-off)'
      using errcode = '42501';
  end if;

  insert into public.interregion_transactions
    (company_id, lender_branch_id, borrower_branch_id, txn_type, amount,
     auto_settle_from_collections, approval_request_id, notes, created_by)
  values
    (p_company_id, p_lender, p_borrower, 'funding', p_amount, p_auto_settle,
     p_approval_request_id, p_notes, auth.uid())
  returning id into v_id;
  return v_id;
end;
$function$
-- ===END 23456
-- ===FUNC 23461 interregion_net_position(p_company_id uuid, p_branch_id uuid)
CREATE OR REPLACE FUNCTION public.interregion_net_position(p_company_id uuid, p_branch_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(sum(
    case
      when txn_type = 'funding'   and lender_branch_id   = p_branch_id then  amount
      when txn_type = 'funding'   and borrower_branch_id = p_branch_id then -amount
      when txn_type = 'repayment' and lender_branch_id   = p_branch_id then -amount
      when txn_type = 'repayment' and borrower_branch_id = p_branch_id then  amount
      else 0
    end), 0)
  from public.interregion_transactions
  where company_id = p_company_id;
$function$
-- ===END 23461
-- ===FUNC 23466 region_cash_entitlement(p_company_id uuid, p_branch_id uuid)
CREATE OR REPLACE FUNCTION public.region_cash_entitlement(p_company_id uuid, p_branch_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(sum(jl.debit - jl.credit), 0)
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.journal_entry_id
    join public.chart_of_accounts a on a.id = jl.account_id
   where je.company_id = p_company_id
     and jl.branch_id = p_branch_id
     and (
       a.system_key in ('cash', 'bank', 'bonus_reserve')
       or a.parent_id in (select id from public.chart_of_accounts
                           where company_id = p_company_id and system_key in ('cash', 'bank'))
     );
$function$
-- ===END 23466
-- ===FUNC 23477 same_company_branch(p_company_id uuid, p_branch_id uuid)
CREATE OR REPLACE FUNCTION public.same_company_branch(p_company_id uuid, p_branch_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case
    when p_branch_id is not null
     and exists (select 1 from public.branches
                  where id = p_branch_id and company_id = p_company_id)
    then p_branch_id else null end;
$function$
-- ===END 23477
-- ===FUNC 23511 avg_monthly_net_payroll(p_company_id uuid)
CREATE OR REPLACE FUNCTION public.avg_monthly_net_payroll(p_company_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(round(sum(net_salary) / 3.0, 2), 0)
    from public.payslips
   where company_id = p_company_id and disbursed
     and period_month >= (date_trunc('month', current_date) - interval '3 months')::date;
$function$
-- ===END 23511
-- ===FUNC 23512 reserve_target(p_company_id uuid, p_type reserve_type)
CREATE OR REPLACE FUNCTION public.reserve_target(p_company_id uuid, p_type reserve_type)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare p record; v_bal numeric;
begin
  select * into p from public.reserve_policies
   where company_id = p_company_id and reserve_type = p_type;

  if p_type = 'payroll' then
    return round(public.avg_monthly_net_payroll(p_company_id) * coalesce(p.target_months, 1), 2);
  elsif p_type = 'statutory' then
    select coalesce(sum(jl.credit - jl.debit), 0) into v_bal
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.company_id = p_company_id
       and a.system_key in ('eobi_payable', 'wht_payable');
    return greatest(v_bal, coalesce(p.target_fixed, 0));
  elsif p_type = 'bonus' then
    select coalesce(sum(jl.credit - jl.debit), 0) into v_bal
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.company_id = p_company_id and a.system_key = 'bonus_provision';
    return v_bal;
  elsif p_type = 'asset_replacement' then
    select coalesce(sum(jl.credit - jl.debit), 0) into v_bal
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.company_id = p_company_id and a.system_key = 'accum_dep';
    return v_bal;
  else
    return coalesce(p.target_fixed, 0);
  end if;
end;
$function$
-- ===END 23512
-- ===FUNC 23513 fund_reserve(p_company_id uuid, p_type reserve_type, p_amount numeric, p_date date)
CREATE OR REPLACE FUNCTION public.fund_reserve(p_company_id uuid, p_type reserve_type, p_amount numeric, p_date date DEFAULT CURRENT_DATE)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_ho uuid := public.head_office_region(p_company_id); v_entry uuid;
begin
  if p_amount is null or p_amount = 0 then return null; end if;
  v_entry := public.post_journal(
    p_company_id, p_date,
    'Reserve funding (' || p_type || ')',
    'reserve_funding', gen_random_uuid(), false,
    jsonb_build_array(
      jsonb_build_object('key', public.reserve_account_key(p_type), 'debit', p_amount, 'credit', 0),
      jsonb_build_object('key', 'bank', 'debit', 0, 'credit', p_amount)),
    v_ho);
  return v_entry;
end;
$function$
-- ===END 23513
-- ===FUNC 23514 mirror_depreciation_to_reserve(p_company_id uuid, p_period date)
CREATE OR REPLACE FUNCTION public.mirror_depreciation_to_reserve(p_company_id uuid, p_period date)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_month date := date_trunc('month', p_period)::date; v_amount numeric;
begin
  select coalesce(sum(amount), 0) into v_amount
    from public.depreciation_entries
   where company_id = p_company_id and period_month = v_month;
  if v_amount <= 0 then return 0; end if;
  perform public.fund_reserve(p_company_id, 'asset_replacement', v_amount,
                              (v_month + interval '1 month - 1 day')::date);
  return v_amount;
end;
$function$
-- ===END 23514
-- ===FUNC 23515 sweep_receipt_to_reserve(p_company_id uuid, p_receipt_amount numeric)
CREATE OR REPLACE FUNCTION public.sweep_receipt_to_reserve(p_company_id uuid, p_receipt_amount numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare p record; v_sweep numeric;
begin
  select * into p from public.reserve_policies
   where company_id = p_company_id and reserve_type = 'payroll';
  if p.auto_sweep_pct is null or p.auto_sweep_pct = 0 then return 0; end if;
  v_sweep := round(coalesce(p_receipt_amount,0) * p.auto_sweep_pct / 100.0, 2);
  if v_sweep <= 0 then return 0; end if;
  perform public.fund_reserve(p_company_id, 'payroll', v_sweep);
  return v_sweep;
end;
$function$
-- ===END 23515
-- ===FUNC 23524 avg_monthly_overhead(p_company_id uuid)
CREATE OR REPLACE FUNCTION public.avg_monthly_overhead(p_company_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(round(sum(jl.debit - jl.credit) / 3.0, 2), 0)
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.journal_entry_id
    join public.chart_of_accounts a on a.id = jl.account_id
   where je.company_id = p_company_id
     and a.account_type = 'expense'
     and a.system_key like 'opex_%'
     and je.entry_date >= (date_trunc('month', current_date) - interval '3 months')::date;
$function$
-- ===END 23524
-- ===FUNC 23525 statutory_due_soon(p_company_id uuid)
CREATE OR REPLACE FUNCTION public.statutory_due_soon(p_company_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(sum(amount), 0)
    from public.statutory_filings
   where company_id = p_company_id and paid_date is null
     and due_date <= current_date + 30;
$function$
-- ===END 23525
-- ===FUNC 23526 minimum_cash(p_company_id uuid)
CREATE OR REPLACE FUNCTION public.minimum_cash(p_company_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare fs record;
begin
  select * into fs from public.finance_settings where company_id = p_company_id;
  return round(
    public.avg_monthly_net_payroll(p_company_id)
    + public.statutory_due_soon(p_company_id)
    + coalesce(fs.overhead_multiplier, 0.5) * public.avg_monthly_overhead(p_company_id), 2);
end;
$function$
-- ===END 23526
-- ===FUNC 23532 check_disbursement(p_company_id uuid, p_amount numeric, p_is_payroll_or_statutory boolean)
CREATE OR REPLACE FUNCTION public.check_disbursement(p_company_id uuid, p_amount numeric, p_is_payroll_or_statutory boolean DEFAULT false)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_band text;
begin
  select band into v_band from public.danger_level where company_id = p_company_id;

  if coalesce(p_is_payroll_or_statutory, false) then
    return 'allowed';
  end if;

  if v_band = 'red' then
    perform public.raise_alert(p_company_id, 'blocking', 'danger_level_disbursement',
      'Disbursement of ' || p_amount || ' blocked: cash is in the RED danger band. '
      || 'COO override required.', null, null, null);
    return 'blocked';
  end if;
  return 'allowed';
end;
$function$
-- ===END 23532
-- ===FUNC 23533 cash_forecast(p_company_id uuid, p_weeks integer)
CREATE OR REPLACE FUNCTION public.cash_forecast(p_company_id uuid, p_weeks integer DEFAULT 13)
 RETURNS TABLE(week_no integer, week_start date, opening_balance numeric, expected_inflow numeric, expected_outflow numeric, closing_balance numeric, is_breach boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_open      numeric;
  v_min       numeric := public.minimum_cash(p_company_id);
  v_weekly_payroll  numeric;
  v_weekly_overhead numeric;
  i           integer;
  v_ws        date;
  v_we        date;
  v_in        numeric;
  v_out       numeric;
begin
  select available_after_reserves into v_open from public.cash_cockpit where company_id = p_company_id;
  v_open := coalesce(v_open, 0);
  v_weekly_payroll  := round(public.avg_monthly_net_payroll(p_company_id) / 4.33, 2);
  v_weekly_overhead := round(public.avg_monthly_overhead(p_company_id) / 4.33, 2);

  for i in 1 .. greatest(p_weeks, 1) loop
    v_ws := (date_trunc('week', current_date) + ((i - 1) || ' weeks')::interval)::date;
    v_we := v_ws + 6;

    select coalesce(sum(coalesce(inv.total_due, inv.invoice_amount) - inv.amount_received), 0)
      into v_in
      from public.invoices inv
     where inv.company_id = p_company_id
       and inv.amount_received < coalesce(inv.total_due, inv.invoice_amount)
       and greatest(inv.invoice_date + 30, current_date) between v_ws and v_we;

    select coalesce(sum(sf.amount), 0) into v_out
      from public.statutory_filings sf
     where sf.company_id = p_company_id and sf.paid_date is null
       and sf.due_date between v_ws and v_we;
    v_out := v_out + v_weekly_payroll + v_weekly_overhead
           + coalesce((select sum(ch.amount) from public.cheques ch
                        where ch.company_id = p_company_id and ch.status <> 'cleared'
                          and ch.cheque_date between v_ws and v_we), 0);

    week_no := i;
    week_start := v_ws;
    opening_balance := v_open;
    expected_inflow := v_in;
    expected_outflow := v_out;
    closing_balance := v_open + v_in - v_out;
    is_breach := (v_open + v_in - v_out) < v_min;

    v_open := closing_balance;
    return next;
  end loop;
end;
$function$
-- ===END 23533
-- ===FUNC 23534 first_breach_week(p_company_id uuid, p_weeks integer)
CREATE OR REPLACE FUNCTION public.first_breach_week(p_company_id uuid, p_weeks integer DEFAULT 13)
 RETURNS date
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select min(week_start) from public.cash_forecast(p_company_id, p_weeks) where is_breach;
$function$
-- ===END 23534
-- ===FUNC 23540 enforce_contract_lock()
CREATE OR REPLACE FUNCTION public.enforce_contract_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if old.status <> 'active' then
    return new;
  end if;

  if coalesce(current_setting('app.contract_amendment', true), '') = '1' then
    return new;
  end if;

  -- Super-admins may edit an Active contract's terms directly.
  if exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('super_admin', 'super_super_admin')
  ) then
    return new;
  end if;

  if new.rate_per_guard_per_month is distinct from old.rate_per_guard_per_month
   or new.number_of_guards  is distinct from old.number_of_guards
   or new.day_guards        is distinct from old.day_guards
   or new.night_guards      is distinct from old.night_guards
   or new.evening_guards    is distinct from old.evening_guards
   or new.guard_rates       is distinct from old.guard_rates
   or new.start_date        is distinct from old.start_date
   or new.shift_pattern     is distinct from old.shift_pattern
   or new.eobi_amount       is distinct from old.eobi_amount
   or new.annual_escalation_pct is distinct from old.annual_escalation_pct then
    raise exception 'contract is Active and its original terms are locked; change it via a dated addendum'
      using errcode = '23514',
            hint = 'Record an addendum, or use amend_contract() for a logged correction.';
  end if;
  return new;
end;
$function$
-- ===END 23540
-- ===FUNC 23542 amend_contract(p_contract_id uuid, p_field text, p_new_value text, p_reason text)
CREATE OR REPLACE FUNCTION public.amend_contract(p_contract_id uuid, p_field text, p_new_value text, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_company uuid; v_old text;
begin
  if p_field not in ('rate_per_guard_per_month','number_of_guards','day_guards',
                     'night_guards','evening_guards','start_date','shift_pattern',
                     'eobi_amount','annual_escalation_pct') then
    raise exception 'field % is not an amendable contract term', p_field using errcode = '22023';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'a contract amendment requires a reason' using errcode = '23514';
  end if;

  select company_id into v_company from public.contracts where id = p_contract_id;
  if v_company is null then
    raise exception 'contract % not found', p_contract_id using errcode = '23503';
  end if;

  execute format('select (%I)::text from public.contracts where id = $1', p_field)
     into v_old using p_contract_id;

  perform set_config('app.contract_amendment', '1', true);
  execute format('update public.contracts set %I = %L, updated_at = now() where id = %L',
                 p_field, p_new_value, p_contract_id);
  perform set_config('app.contract_amendment', '0', true);

  insert into public.audit_log (company_id, table_name, record_id, action, changed_by, changes)
  values (v_company, 'contracts', p_contract_id, 'update', auth.uid(),
          jsonb_build_object('kind','contract_amendment','field',p_field,
                             'old',v_old,'new',p_new_value,'reason',p_reason));
end;
$function$
-- ===END 23542
-- ===FUNC 23682 acknowledge_payroll_exception(p_payslip_id uuid, p_reason text)
CREATE OR REPLACE FUNCTION public.acknowledge_payroll_exception(p_payslip_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record;
begin
  if coalesce(trim(p_reason), '') = '' then raise exception 'acknowledging an exception requires a reason' using errcode = '23514'; end if;
  select company_id, payroll_run_id into r from public.payslips where id = p_payslip_id;
  if r.payroll_run_id is null then raise exception 'payslip is not attached to a run' using errcode = '23514'; end if;
  insert into public.payroll_run_exception_acks (company_id, payroll_run_id, payslip_id, reason, acknowledged_by)
  values (r.company_id, r.payroll_run_id, p_payslip_id, p_reason, auth.uid())
  on conflict (payslip_id) do update set reason = excluded.reason, acknowledged_by = excluded.acknowledged_by, acknowledged_at = now();
end; $function$
-- ===END 23682
-- ===FUNC 23683 run_unacked_exception_count(p_run_id uuid)
CREATE OR REPLACE FUNCTION public.run_unacked_exception_count(p_run_id uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select count(*)::integer from public.payroll_run_exceptions where payroll_run_id = p_run_id and not acknowledged;
$function$
-- ===END 23683
-- ===FUNC 23687 is_attendance_locked(p_company_id uuid, p_date date)
CREATE OR REPLACE FUNCTION public.is_attendance_locked(p_company_id uuid, p_date date)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p_date < current_date - coalesce((select attendance_backfill_lock_days from public.field_ops_settings where company_id = p_company_id), 1);
$function$
-- ===END 23687
-- ===FUNC 23688 enforce_attendance_backfill()
CREATE OR REPLACE FUNCTION public.enforce_attendance_backfill()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  e  record;
  lb date;
  ub date;
begin
  if public.is_maintenance_session() then
    return new;
  end if;

  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;
  end if;

  select em.join_date, em.exit_date, c.start_date as c_start, c.end_date as c_end
    into e
    from public.employees em
    left join public.contracts c on c.id = em.contract_id
   where em.id = new.employee_id;

  lb := greatest(e.join_date, e.c_start);
  ub := least(e.c_end, e.exit_date);

  if lb is not null and new.attendance_date < lb then
    raise exception
      'attendance for % is before this guard''s service window (starts %)', new.attendance_date, lb
      using errcode = '23514';
  end if;
  if ub is not null and new.attendance_date > ub then
    raise exception
      'attendance for % is after this guard''s service window (ends %)', new.attendance_date, ub
      using errcode = '23514';
  end if;

  if coalesce(current_setting('app.skip_attendance_lock', true), '') = '1' then
    return new;
  end if;

  if public.is_attendance_locked(new.company_id, new.attendance_date)
     and not public.has_perm('attendance.backdate') then
    raise exception
      'backdating attendance to % requires the Backdate Attendance permission', new.attendance_date
      using errcode = '23514';
  end if;

  return new;
end;
$function$
-- ===END 23688
-- ===FUNC 23742 receivable_owner_region(p_client_id uuid)
CREATE OR REPLACE FUNCTION public.receivable_owner_region(p_client_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(c.receivable_owner_branch_id, public.region_for_client(p_client_id))
    from public.clients c where c.id = p_client_id;
$function$
-- ===END 23742
-- ===FUNC 23743 write_off_receivable(p_invoice_id uuid, p_reason text)
CREATE OR REPLACE FUNCTION public.write_off_receivable(p_invoice_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  inv record; v_bearer text; v_region uuid; v_out numeric(16,2); v_bad uuid; v_ar uuid;
begin
  if coalesce(trim(p_reason),'') = '' then
    raise exception 'a write-off reason is required' using errcode='23514';
  end if;
  select * into inv from public.invoices where id = p_invoice_id;
  if not found then raise exception 'invoice % not found', p_invoice_id using errcode='23503'; end if;
  v_out := coalesce(inv.total_due, inv.invoice_amount, 0) - coalesce(inv.amount_received, 0);
  if v_out <= 0 then
    raise exception 'invoice has nothing outstanding to write off' using errcode='23514';
  end if;
  select bad_debt_bearer into v_bearer from public.finance_settings where company_id = inv.company_id;
  if coalesce(v_bearer,'region') = 'head_office' then
    v_region := public.head_office_region(inv.company_id);
  else
    v_region := public.receivable_owner_region(inv.client_id);
  end if;

  v_bad := public.ensure_bad_debt_account(inv.company_id);

  select id into v_ar  from public.chart_of_accounts
    where company_id = inv.company_id and system_key = 'ar' limit 1;
  if v_ar is null then
    raise exception 'company % has no receivables (ar) account', inv.company_id using errcode='23503';
  end if;

  perform public.post_journal(
    inv.company_id, current_date,
    'Bad debt write-off: '||coalesce(inv.invoice_number,'')||' — '||p_reason,
    'invoices', inv.id, false,
    jsonb_build_array(
      jsonb_build_object('account_id', v_bad, 'debit',  v_out, 'credit', 0),
      jsonb_build_object('account_id', v_ar,  'debit', 0,       'credit', v_out)
    ),
    v_region);
  update public.invoices
     set status = 'Written-Off',
         notes  = coalesce(notes,'')||' [written off '||current_date||': '||p_reason||']',
         updated_at = now()
   where id = p_invoice_id;
end;
$function$
-- ===END 23743
-- ===FUNC 23779 log_invoice_reminder(p_invoice_id uuid, p_step_day integer, p_channel text, p_note text)
CREATE OR REPLACE FUNCTION public.log_invoice_reminder(p_invoice_id uuid, p_step_day integer, p_channel text DEFAULT NULL::text, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_company uuid;
begin
  select company_id into v_company from public.invoices where id = p_invoice_id;
  if v_company is null then raise exception 'invoice not found' using errcode='23503'; end if;
  insert into public.invoice_reminders (company_id, invoice_id, step_day, channel, note, sent_by)
  values (v_company, p_invoice_id, p_step_day, p_channel, p_note, auth.uid())
  on conflict (invoice_id, step_day) do nothing;
end;
$function$
-- ===END 23779
-- ===FUNC 23821 update_invoice_structure(p_legal_name text, p_registration_line text, p_legal_address text, p_contact_email text, p_contact_phones jsonb, p_website text, p_tax_ntn text, p_signature_label text, p_logo_url text, p_stamp_url text, p_invoice_settings jsonb)
CREATE OR REPLACE FUNCTION public.update_invoice_structure(p_legal_name text, p_registration_line text, p_legal_address text, p_contact_email text, p_contact_phones jsonb, p_website text, p_tax_ntn text, p_signature_label text, p_logo_url text, p_stamp_url text, p_invoice_settings jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_company uuid; v_role public.user_role;
begin
  v_company := public.current_company_id();
  v_role := public.current_role();
  if v_company is null then raise exception 'No company in context'; end if;
  if v_role not in ('super_admin','super_super_admin') then
    raise exception 'Not authorised to edit invoice structure'; end if;
  update public.companies set
    legal_name = p_legal_name, registration_line = p_registration_line,
    legal_address = p_legal_address, contact_email = p_contact_email,
    contact_phones = coalesce(p_contact_phones,'[]'::jsonb), website = p_website,
    tax_ntn = p_tax_ntn, signature_label = p_signature_label,
    logo_url = p_logo_url, stamp_url = p_stamp_url,
    invoice_settings = coalesce(p_invoice_settings,'{}'::jsonb), updated_at = now()
  where id = v_company;
end; $function$
-- ===END 23821
-- ===FUNC 23827 employee_clearance_gates(p_employee_id uuid)
CREATE OR REPLACE FUNCTION public.employee_clearance_gates(p_employee_id uuid)
 RETURNS TABLE(outstanding_kit_count integer, outstanding_advance numeric, open_incident_count integer, undisbursed_salary numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    (select count(*)::integer from public.issuances i
      where i.employee_id = p_employee_id and i.return_date is null),
    (select coalesce(sum(a.amount), 0) from public.advances a where a.employee_id = p_employee_id)
      - (select coalesce(sum(p.advance), 0) from public.payslips p where p.employee_id = p_employee_id),
    (select count(*)::integer
       from public.incident_guards ig
       join public.incidents inc on inc.id = ig.incident_id
      where ig.employee_id = p_employee_id and inc.status <> 'closed'),
    -- Money we still owe the guard: net salary on payslips not yet disbursed.
    (select coalesce(sum(p.net_salary), 0) from public.payslips p
      where p.employee_id = p_employee_id and not p.disbursed);
$function$
-- ===END 23827
-- ===FUNC 23952 assign_guard_code(p_employee_id uuid)
CREATE OR REPLACE FUNCTION public.assign_guard_code(p_employee_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company uuid;
  v_client  uuid;
  v_existing text;
  v_prefix  text;
  v_n       bigint;
  v_code    text;
begin
  select company_id, client_id, guard_code
    into v_company, v_client, v_existing
  from public.employees where id = p_employee_id;

  if v_company is null then
    raise exception 'Employee % not found', p_employee_id;
  end if;
  if v_existing is not null then
    return v_existing;                       -- already assigned; immutable
  end if;

  select nullif(trim(invoice_settings->>'company_prefix'), '')
    into v_prefix
  from public.companies where id = v_company;

  if v_prefix is null then
    raise exception 'Company prefix is not set. Set your Company Prefix in Invoice Structure settings before adding guards.'
      using errcode = 'check_violation';
  end if;

  v_n := public.next_counter(v_company, 'guard_code');
  v_code := upper(v_prefix) || '-' || lpad(v_n::text, 5, '0');

  update public.employees
     set guard_code = v_code, employee_code = v_code, updated_at = now()
   where id = p_employee_id;

  insert into public.employee_code_history
    (company_id, employee_id, old_code, new_code, client_id, reason, changed_by)
  values
    (v_company, p_employee_id, null, v_code, v_client, 'assigned', auth.uid());

  return v_code;
end;
$function$
-- ===END 23952
-- ===FUNC 23959 assign_display_number(p_employee_id uuid)
CREATE OR REPLACE FUNCTION public.assign_display_number(p_employee_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company uuid; v_client uuid; v_prefix text; v_existing int; v_n bigint;
begin
  select e.company_id, e.client_id, e.display_number
    into v_company, v_client, v_existing
  from public.employees e where e.id = p_employee_id;

  if v_company is null then
    raise exception 'Employee % not found', p_employee_id;
  end if;

  if v_client is null then
    update public.employees set display_number = null where id = p_employee_id;
    return null;
  end if;

  select employee_id_prefix into v_prefix from public.clients where id = v_client;

  if v_prefix is null then
    update public.employees set display_number = null where id = p_employee_id;
    return null;
  end if;

  if v_existing is not null then
    return v_prefix || '-' || lpad(v_existing::text, 3, '0');
  end if;

  v_n := public.next_counter(v_company, 'disp:' || v_client::text);
  update public.employees set display_number = v_n, updated_at = now()
   where id = p_employee_id;
  return v_prefix || '-' || lpad(v_n::text, 3, '0');
end $function$
-- ===END 23959
-- ===FUNC 24241 transition_record_state(p_employee_id uuid, p_action text, p_reason text)
CREATE OR REPLACE FUNCTION public.transition_record_state(p_employee_id uuid, p_action text, p_reason text DEFAULT NULL::text)
 RETURNS record_state
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role    text;
  v_company uuid;
  v_cur     record_state;
  v_new     record_state;
begin
  select role::text into v_role from public.profiles where id = auth.uid();
  select company_id, record_state into v_company, v_cur
    from public.employees where id = p_employee_id;
  if v_company is null then raise exception 'Employee % not found', p_employee_id; end if;

  if p_action = 'ops_verify' then
    if v_cur <> 'draft' then raise exception 'Can only Ops-verify a Draft record (current: %)', v_cur; end if;
    if not (
         v_role in ('ops_manager','ops_director','super_admin','super_super_admin')
         or public.has_perm('employees.ops_verify')
       ) then
      raise exception 'Not authorised to Ops-verify (needs an Ops role or the Ops-verify permission)'; end if;
    v_new := 'ops_verified';
    update public.employees set record_state = v_new, updated_at = now() where id = p_employee_id;
    insert into public.employee_approval_events(company_id, employee_id, from_state, to_state, action, reason, approved_by)
      values (v_company, p_employee_id, v_cur, v_new, 'ops_verify', p_reason, auth.uid());

  elsif p_action = 'finance_approve' then
    if v_cur <> 'ops_verified' then raise exception 'Can only Finance-approve an Ops-verified record (current: %)', v_cur; end if;
    if v_role not in ('finance_director','super_admin','super_super_admin') then
      raise exception 'Only Director Finance may approve'; end if;
    insert into public.employee_approval_events(company_id, employee_id, from_state, to_state, action, reason, approved_by)
      values (v_company, p_employee_id, v_cur, 'finance_approved', 'finance_approve', p_reason, auth.uid());
    v_new := 'active';
    update public.employees set record_state = v_new, updated_at = now() where id = p_employee_id;
    insert into public.employee_approval_events(company_id, employee_id, from_state, to_state, action, reason, approved_by)
      values (v_company, p_employee_id, 'finance_approved', v_new, 'activate', 'auto (system) on finance approval', auth.uid());

  elsif p_action = 'reverse' then
    if p_reason is null or btrim(p_reason) = '' then raise exception 'Reversal requires a reason'; end if;
    if v_cur = 'active' or v_cur = 'finance_approved' then
      if v_role not in ('finance_director','super_admin','super_super_admin') then
        raise exception 'Only Director Finance or super admin may reverse a finance-approved/active record'; end if;
      v_new := 'ops_verified';
    elsif v_cur = 'ops_verified' then
      if v_role not in ('ops_manager','ops_director','super_admin','super_super_admin') then
        raise exception 'Only Ops Manager/Director or super admin may reverse an Ops-verified record'; end if;
      v_new := 'draft';
    else
      raise exception 'Nothing to reverse from Draft';
    end if;
    update public.employees set record_state = v_new, updated_at = now() where id = p_employee_id;
    insert into public.employee_approval_events(company_id, employee_id, from_state, to_state, action, reason, approved_by)
      values (v_company, p_employee_id, v_cur, v_new, 'reverse', p_reason, auth.uid());
  else
    raise exception 'Unknown action %', p_action;
  end if;

  return v_new;
end;
$function$
-- ===END 24241
-- ===FUNC 24300 sync_employee_active_client()
CREATE OR REPLACE FUNCTION public.sync_employee_active_client()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_guard  uuid;
  v_client uuid;
begin
  v_guard := coalesce(NEW.guard_id, OLD.guard_id);

  select d.client_id into v_client
    from public.deployments d
   where d.guard_id = v_guard
   order by (d.end_date is null) desc, d.start_date desc nulls last, d.created_at desc
   limit 1;

  if v_client is null then
    return null;
  end if;

  update public.employees e
     set client_id = v_client,
         display_number = case when v_client is distinct from e.client_id then null else e.display_number end,
         updated_at = now()
   where e.id = v_guard and (e.client_id is distinct from v_client);

  if found then
    perform public.assign_display_number(v_guard);
  end if;

  return null;
end $function$
-- ===END 24300
-- ===FUNC 24302 change_client(p_guard_id uuid, p_new_client_id uuid, p_contract_line_id uuid, p_site_id uuid, p_reason deployment_reason, p_effective_date date)
CREATE OR REPLACE FUNCTION public.change_client(p_guard_id uuid, p_new_client_id uuid, p_contract_line_id uuid DEFAULT NULL::uuid, p_site_id uuid DEFAULT NULL::uuid, p_reason deployment_reason DEFAULT 'relief_cover'::deployment_reason, p_effective_date date DEFAULT NULL::date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company uuid; v_eff date; v_site uuid; v_dep record; v_new_id uuid;
begin
  select company_id into v_company from public.employees where id = p_guard_id;
  if v_company is null then raise exception 'Guard % not found', p_guard_id; end if;
  v_eff  := coalesce(p_effective_date, current_date);
  v_site := coalesce(p_site_id,
    (select id from public.sites where client_id = p_new_client_id and is_default limit 1));
  select * into v_dep from public.deployments
   where guard_id = p_guard_id and end_date is null order by start_date desc limit 1;
  if v_dep.id is not null then
    if v_eff - 1 < v_dep.start_date then
      insert into public.deployments_overlap_backup_0183
      select v_dep.*, now(), 'superseded same-day by change_client';
      delete from public.deployments where id = v_dep.id;
    else
      update public.deployments set end_date = v_eff - 1, updated_at = now() where id = v_dep.id;
    end if;
  end if;
  insert into public.deployments
    (company_id, guard_id, client_id, contract_line_id, site_id, start_date, reason)
  values (v_company, p_guard_id, p_new_client_id, p_contract_line_id, v_site, v_eff, p_reason)
  returning id into v_new_id;
  return v_new_id;
end $function$
-- ===END 24302
-- ===FUNC 24307 guard_completeness(p_employee_id uuid)
CREATE OR REPLACE FUNCTION public.guard_completeness(p_employee_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  e   public.employees%rowtype;
  st  jsonb;
  t1 boolean; t2 boolean; t3 boolean; t4 boolean;
begin
  select * into e from public.employees where id = p_employee_id;
  if e.id is null then return null; end if;

  select coalesce(jsonb_object_agg(doc_type::text, status::text), '{}'::jsonb)
    into st from public.guard_documents where employee_id = p_employee_id;

  t1 := e.full_name is not null
    and e.father_or_husband_name is not null
    and e.cnic_number is not null
    and length(regexp_replace(e.cnic_number, '\D', '', 'g')) = 13
    and e.date_of_birth is not null
    and coalesce(st->>'photograph','missing') in ('on_file','verified')
    and e.phone is not null
    and e.permanent_address is not null;

  t2 := t1
    and e.join_date is not null
    and e.designation is not null
    and e.blood_group is not null
    and exists (select 1 from public.guard_contacts g where g.employee_id=e.id and g.role='emergency_1')
    and exists (select 1 from public.guard_contacts g where g.employee_id=e.id and g.role='next_of_kin')
    and exists (select 1 from public.guard_contacts g where g.employee_id=e.id and g.role='reference_1')
    and exists (select 1 from public.guard_contacts g where g.employee_id=e.id and g.role='reference_2')
    and coalesce(st->>'cnic_copy','missing') in ('on_file','verified')
    and coalesce(st->>'photograph','missing') in ('on_file','verified')
    and coalesce(st->>'police_verification','missing') in ('on_file','verified')
    and (coalesce(st->>'character_certificate','missing') in ('on_file','verified','waived')
         or coalesce(st->>'halaf_nama','missing') in ('on_file','verified','waived'))
    and coalesce(st->>'medical_certificate','missing') in ('on_file','verified')
    and coalesce(st->>'signed_data_form','missing') in ('on_file','verified')
    and not exists (select 1 from public.guard_documents gd
                    where gd.employee_id=e.id and gd.status='expired'
                      and gd.doc_type in ('cnic_copy','photograph','police_verification',
                          'character_certificate','halaf_nama','medical_certificate','signed_data_form'))
    and e.record_state >= 'ops_verified';

  t3 := t2
    and ( (e.account_title is not null and e.bank_name is not null and e.bank_branch_code is not null
           and e.bank_account is not null and e.iban is not null)
          or (e.cash_payment_flag and e.cash_payment_approved_by is not null) )
    and e.probation_period_months is not null
    and e.pay_fixed_on_probation is not null
    and e.final_pay is not null
    and e.eobi_registration_number is not null
    and e.social_security_status is not null
    and e.company_id_card_number is not null
    and e.record_state >= 'finance_approved';

  if e.category::text in ('armed','gunman') then
    t4 := t3
      and e.nadra_verisys_status = 'cleared'
      and coalesce(st->>'weapon_licence','missing') in ('on_file','verified')
      and not exists (select 1 from public.guard_documents gd
                      where gd.employee_id=e.id and gd.doc_type='weapon_licence' and gd.status='expired')
      and e.weapons_certified
      and (not coalesce(e.is_ex_serviceman,false)
           or coalesce(st->>'discharge_certificate','missing') in ('on_file','verified'));
  else
    t4 := null;
  end if;

  return jsonb_build_object(
    'tier1', t1, 'tier2', t2, 'tier3', t3, 'tier4', t4,
    'highest', case when t3 then 3 when t2 then 2 when t1 then 1 else 0 end,
    'armed', (e.category::text in ('armed','gunman'))
  );
end;
$function$
-- ===END 24307
-- ===FUNC 24313 archive_employee(p_employee_id uuid, p_reason text)
CREATE OR REPLACE FUNCTION public.archive_employee(p_employee_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company uuid;
  v_from    employee_lifecycle_state;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'Archiving requires a reason';
  end if;
  select company_id, lifecycle_state into v_company, v_from
    from public.employees where id = p_employee_id;
  if v_company is null then raise exception 'Employee % not found', p_employee_id; end if;

  update public.employees
     set lifecycle_state = 'archived', status = 'Inactive', updated_at = now()
   where id = p_employee_id;

  insert into public.employee_lifecycle_events
    (company_id, employee_id, from_state, to_state, reason, changed_by)
  values (v_company, p_employee_id, v_from, 'archived', p_reason, auth.uid());
end;
$function$
-- ===END 24313
-- ===FUNC 24470 raise_vacancy_on_posting_close()
CREATE OR REPLACE FUNCTION public.raise_vacancy_on_posting_close()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_still_active int;
begin
  if NEW.end_date is not null and (OLD.end_date is null)
     and NEW.reason in ('separation','return_to_pool') then
    select count(*) into v_still_active from public.deployments d
      where d.end_date is null
        and d.guard_id <> NEW.guard_id
        and ( (NEW.contract_line_id is not null and d.contract_line_id = NEW.contract_line_id)
              or (NEW.contract_line_id is null and d.site_id = NEW.site_id) );
    if v_still_active = 0 then
      insert into public.vacancies (company_id, client_id, site_id, contract_line_id, opened_reason, vacated_by_guard_id)
      values (NEW.company_id, NEW.client_id, NEW.site_id, NEW.contract_line_id,
              'Posting closed (' || NEW.reason || ') with no replacement', NEW.guard_id);
    end if;
  end if;
  return NEW;
end $function$
-- ===END 24470
-- ===FUNC 24472 attendance_gate(p_guard uuid, p_date date, p_backdate_limit integer)
CREATE OR REPLACE FUNCTION public.attendance_gate(p_guard uuid, p_date date, p_backdate_limit integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare e public.employees%rowtype; v_reason text; v_has_posting boolean;
begin
  select * into e from public.employees where id = p_guard;
  if e.id is null then return jsonb_build_object('mode','blocked','reason','Guard not found'); end if;

  v_reason := public.attendance_window_block_reason(p_guard, p_date);
  if v_reason is not null then return jsonb_build_object('mode','blocked','reason',v_reason); end if;

  if exists (select 1 from public.accounting_periods ap
             where ap.company_id = e.company_id and ap.period_month = date_trunc('month', p_date)::date) then
    return jsonb_build_object('mode','blocked','reason','Payroll closed for ' || to_char(p_date,'Mon YYYY') || '. Post a reversal instead.');
  end if;

  -- Confirmed + month ended → locked; edit only via Monthly Board override.
  if (date_trunc('month', p_date) + interval '1 month')::date <= current_date
     and exists (
       select 1 from public.attendance_confirmations c
       where c.attendance_date = p_date
         and ((e.client_id is not null and c.client_id = e.client_id)
              or (e.client_id is null and e.category is not null and c.category = e.category::text))
     ) then
    return jsonb_build_object('mode','blocked','reason','Confirmed and the month has ended — locked. Edit it via Override on the Monthly Board.');
  end if;

  if p_date < current_date - p_backdate_limit and not public.has_permission('attendance.backdate') then
    return jsonb_build_object('mode','override_required','reason','Backdated beyond ' || p_backdate_limit || ' days - supervisor override required');
  end if;

  select exists (select 1 from public.deployments d
    where d.guard_id = p_guard and d.start_date <= p_date
      and (d.end_date is null or d.end_date >= p_date)) into v_has_posting;
  if v_has_posting then return jsonb_build_object('mode','allowed','reason',null);
  else return jsonb_build_object('mode','allowed_unposted','reason','No active posting - recorded against pool (not billable)'); end if;
end $function$
-- ===END 24472
-- ===FUNC 24473 client_shift_roster(p_site uuid, p_shift text, p_date date)
CREATE OR REPLACE FUNCTION public.client_shift_roster(p_site uuid, p_shift text, p_date date)
 RETURNS TABLE(guard_id uuid, full_name text, guard_code text, display_number integer, employee_code text, client_id uuid, scheduled_shift text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select e.id, e.full_name, e.guard_code, e.display_number, e.employee_code,
         coalesce(d.client_id, e.client_id) as client_id,
         coalesce(cl.shift_code::text, e.shift) as scheduled_shift
  from public.deployments d
  join public.employees e on e.id = d.guard_id
  left join public.contract_lines cl on cl.id = d.contract_line_id
  where d.site_id = p_site
    and d.start_date <= p_date
    and (d.end_date is null or d.end_date >= p_date)
    and (e.join_date is null or e.join_date <= p_date)
    and (e.last_working_day is null or e.last_working_day >= p_date)
    and e.lifecycle_state <> 'archived'
    and coalesce(cl.shift_code::text, e.shift) = p_shift;
$function$
-- ===END 24473
-- ===FUNC 24499 record_separation(p_guard uuid, p_reason separation_reason, p_last_working_day date, p_termination_date date, p_rehire_eligible boolean, p_note text)
CREATE OR REPLACE FUNCTION public.record_separation(p_guard uuid, p_reason separation_reason, p_last_working_day date, p_termination_date date, p_rehire_eligible boolean, p_note text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  e public.employees%rowtype;
  v_new_state employee_lifecycle_state;
  v_present_after date;
begin
  select * into e from public.employees where id = p_guard for update;
  if e.id is null then raise exception 'Guard % not found', p_guard; end if;
  if p_last_working_day is null then raise exception 'Last working day is required'; end if;
  if coalesce(trim(p_note),'') = '' then raise exception 'A separation reason/note is required'; end if;

  -- Reject a last working day that leaves worked (present) attendance after it.
  select min(ar.attendance_date) into v_present_after
    from public.attendance_records ar
   where ar.employee_id = p_guard
     and ar.attendance_date > p_last_working_day
     and lower(ar.status) in ('present','double_duty','relief_cover');
  if v_present_after is not null then
    raise exception 'Cannot separate on %: this employee is marked present on % (and possibly later). He worked past that date, so change those days to leave/absent or unmark them, or pick a later last working day.',
      p_last_working_day, v_present_after;
  end if;

  v_new_state := case
    when p_reason = 'absconded' then 'absconded'
    when p_reason in ('termination_misconduct','termination_performance') then 'fired'
    else 'left'
  end::employee_lifecycle_state;

  update public.employees set
    separation_reason   = p_reason,
    last_working_day    = p_last_working_day,
    termination_date    = p_termination_date,
    eligible_for_rehire = p_rehire_eligible,
    exit_reason         = p_note,
    exit_date           = coalesce(p_termination_date, p_last_working_day),
    lifecycle_state     = v_new_state,
    updated_at          = now()
  where id = p_guard;

  insert into public.deployments_overlap_backup_0183
  select d.*, now(), 'posting began after last working day - record_separation'
    from public.deployments d
   where d.guard_id = p_guard and d.end_date is null and d.start_date > p_last_working_day;

  delete from public.deployments
   where guard_id = p_guard and end_date is null and start_date > p_last_working_day;

  update public.deployments
     set end_date = p_last_working_day, reason = 'separation', updated_at = now()
   where guard_id = p_guard and end_date is null;

  insert into public.employee_lifecycle_events
    (company_id, employee_id, from_state, to_state, reason, eligible_for_rehire, changed_by, notes)
  values
    (e.company_id, p_guard, e.lifecycle_state, v_new_state,
     'Separation: ' || p_reason::text, p_rehire_eligible, auth.uid(), p_note);
end $function$
-- ===END 24499
-- ===FUNC 24500 rehire_guard(p_guard uuid, p_join_date date, p_client_id uuid, p_contract_line_id uuid, p_site_id uuid)
CREATE OR REPLACE FUNCTION public.rehire_guard(p_guard uuid, p_join_date date, p_client_id uuid, p_contract_line_id uuid DEFAULT NULL::uuid, p_site_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  e public.employees%rowtype;
  v_site uuid;
begin
  select * into e from public.employees where id = p_guard for update;
  if e.id is null then raise exception 'Guard % not found', p_guard; end if;
  if e.eligible_for_rehire is false then
    raise exception 'Guard is not eligible for rehire (marked at last separation)';
  end if;
  if e.blacklisted then
    raise exception 'Guard is blacklisted and cannot be rehired';
  end if;

  v_site := coalesce(p_site_id, (select id from public.sites where client_id = p_client_id and is_default limit 1));

  update public.employees set
    lifecycle_state   = 'active',
    last_working_day  = null,
    termination_date  = null,
    separation_reason = null,
    exit_date         = null,
    exit_reason       = null,
    rehire_count      = rehire_count + 1,
    updated_at        = now()
  where id = p_guard;

  -- Defensive: close any lingering open posting so the new stint is the ONLY
  -- active one (guards separated via legacy paths may still have an open row).
  update public.deployments
     set end_date   = greatest(start_date, p_join_date - 1),
         reason     = 'separation',
         updated_at = now()
   where guard_id = p_guard and end_date is null;

  -- New posting (Phase 4).
  insert into public.deployments
    (company_id, guard_id, client_id, contract_line_id, site_id, start_date, reason, shift_code)
  values (e.company_id, p_guard, p_client_id, p_contract_line_id, v_site, p_join_date, 'new_hire', e.shift);

  insert into public.employee_lifecycle_events
    (company_id, employee_id, from_state, to_state, reason, changed_by, notes)
  values
    (e.company_id, p_guard, e.lifecycle_state, 'active',
     'Rehire (stint #' || (e.rehire_count + 1) || ')', auth.uid(), null);
end $function$
-- ===END 24500
-- ===FUNC 24501 log_clearance_issued(p_guard uuid, p_note text)
CREATE OR REPLACE FUNCTION public.log_clearance_issued(p_guard uuid, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_company uuid; v_state employee_lifecycle_state;
begin
  select company_id, lifecycle_state into v_company, v_state from public.employees where id = p_guard;
  if v_company is null then raise exception 'Guard % not found', p_guard; end if;
  insert into public.employee_lifecycle_events
    (company_id, employee_id, from_state, to_state, reason, changed_by, notes)
  values (v_company, p_guard, v_state, v_state, 'Exit clearance issued', auth.uid(), p_note);
end $function$
-- ===END 24501
-- ===FUNC 24513 attendance_billable_quantity(p_client uuid, p_start date, p_end date)
CREATE OR REPLACE FUNCTION public.attendance_billable_quantity(p_client uuid, p_start date, p_end date)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select round(
    coalesce(sum(case when lower(ar.status) in ('present','double_duty','relief_cover') then 1 else 0 end), 0)::numeric
    / nullif(extract(day from (date_trunc('month', p_start) + interval '1 month - 1 day'))::int, 0)
  , 2)
  from public.attendance_records ar
  where ar.attendance_date between p_start and p_end
    and ar.worked_for_client_id = p_client;
$function$
-- ===END 24513
-- ===FUNC 24527 change_guard_shift(p_guard uuid, p_new_shift text, p_effective_date date)
CREATE OR REPLACE FUNCTION public.change_guard_shift(p_guard uuid, p_new_shift text, p_effective_date date DEFAULT NULL::date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company uuid; v_eff date; v_dep record; v_cur text; v_new_id uuid;
begin
  select company_id into v_company from public.employees where id = p_guard;
  if v_company is null then raise exception 'Guard % not found', p_guard; end if;
  if coalesce(trim(p_new_shift), '') = '' then raise exception 'New shift is required'; end if;
  v_eff := coalesce(p_effective_date, current_date);
  select * into v_dep from public.deployments
   where guard_id = p_guard and end_date is null order by start_date desc limit 1;
  if v_dep.id is null then
    raise exception 'No active posting to change shift for; rehire the guard first';
  end if;
  v_cur := coalesce(v_dep.shift_code, (select shift from public.employees where id = p_guard));
  if v_cur = p_new_shift then
    raise exception 'Guard is already on the % shift', p_new_shift;
  end if;
  if v_eff - 1 < v_dep.start_date then
    insert into public.deployments_overlap_backup_0183
    select v_dep.*, now(), 'superseded same-day by change_guard_shift';
    delete from public.deployments where id = v_dep.id;
  else
    update public.deployments
       set end_date = v_eff - 1, reason = 'shift_change', updated_at = now()
     where id = v_dep.id;
  end if;
  insert into public.deployments
    (company_id, guard_id, client_id, contract_line_id, site_id, start_date, reason, shift_code)
  values (v_company, p_guard, v_dep.client_id,
     (select cl.id from public.contract_lines cl
       where cl.site_id = v_dep.site_id and cl.shift_code::text = p_new_shift limit 1),
     v_dep.site_id, v_eff, 'shift_change', p_new_shift)
  returning id into v_new_id;
  update public.employees set shift = p_new_shift, updated_at = now() where id = p_guard;
  return v_new_id;
end $function$
-- ===END 24527
-- ===FUNC 24582 record_bank_to_custodian(p_bank_account_id uuid, p_custodian_location_id uuid, p_amount numeric, p_date date, p_notes text)
CREATE OR REPLACE FUNCTION public.record_bank_to_custodian(p_bank_account_id uuid, p_custodian_location_id uuid, p_amount numeric, p_date date, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company uuid;
  v_bal     numeric;
  v_acct    uuid;
  v_branch  uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount_must_be_positive';
  end if;

  select balance, company_id into v_bal, v_company
    from public.bank_accounts where id = p_bank_account_id;
  if v_company is null then raise exception 'bank_not_found'; end if;
  if p_amount > v_bal then raise exception 'insufficient_bank_balance'; end if;

  update public.bank_accounts
     set balance = balance - p_amount, updated_at = now()
   where id = p_bank_account_id;

  update public.treasury
     set cash_balance = cash_balance + p_amount, updated_at = now()
   where company_id = v_company;
  if not found then
    insert into public.treasury (company_id, cash_balance) values (v_company, p_amount);
  end if;

  insert into public.bank_transactions
    (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
  values
    (p_bank_account_id, 'withdraw_to_cash', p_amount, p_amount, -p_amount,
     coalesce(nullif(btrim(p_notes), ''), 'Cash withdrawn to custodian'),
     p_custodian_location_id);

  select coa_account_id, branch_id into v_acct, v_branch
    from public.cash_locations where id = p_custodian_location_id;
  if v_acct is null then
    v_acct := public.cash_account_for(v_company, p_custodian_location_id);
  end if;

  perform public.post_journal(
    v_company, coalesce(p_date, current_date),
    coalesce(nullif(btrim(p_notes), ''), 'Cash withdrawn to custodian'),
    'custody_float', p_custodian_location_id, false,
    jsonb_build_array(
      jsonb_build_object('account_id', v_acct,  'debit', p_amount, 'credit', 0),
      jsonb_build_object('key',        'bank',  'debit', 0,        'credit', p_amount)
    ),
    v_branch);
end;
$function$
-- ===END 24582
-- ===FUNC 24586 enforce_company_prefix_lock()
CREATE OR REPLACE FUNCTION public.enforce_company_prefix_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_old text := nullif(trim(OLD.invoice_settings->>'company_prefix'), '');
  v_new text := nullif(trim(NEW.invoice_settings->>'company_prefix'), '');
begin
  if v_old is distinct from v_new then
    if v_old is not null
       and exists (select 1 from public.employees
                    where company_id = OLD.id and guard_code is not null) then
      raise exception 'Company prefix is locked: guards already have permanent codes under "%". It cannot be changed.', v_old
        using errcode = 'check_violation';
    end if;
  end if;
  return NEW;
end;
$function$
-- ===END 24586
-- ===FUNC 24668 guard_super_admin_mutations()
CREATE OR REPLACE FUNCTION public.guard_super_admin_mutations()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_acting public.user_role := public.current_role();
begin
  if v_acting is null or public.is_super_super_admin() then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.role = 'super_admin' then
      raise exception 'Only a Super Super Admin can delete a Super Admin';
    end if;
    return old;
  end if;

  if old.role = 'super_admin' and new.role is distinct from old.role then
    raise exception 'Only a Super Super Admin can change a Super Admin''s role';
  end if;
  if new.role = 'super_admin' and old.role is distinct from 'super_admin' then
    raise exception 'Only a Super Super Admin can grant the Super Admin role';
  end if;

  return new;
end;
$function$
-- ===END 24668
-- ===FUNC 24687 attendance_window_block_reason(p_guard uuid, p_date date)
CREATE OR REPLACE FUNCTION public.attendance_window_block_reason(p_guard uuid, p_date date)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  e public.employees%rowtype;
  c public.contracts%rowtype;
  v_latest_end  date;
  v_open_ended  boolean;
  v_client_name text;
begin
  select * into e from public.employees where id = p_guard;
  if e.id is null then return 'Guard not found'; end if;

  if e.lifecycle_state = 'archived' then
    return 'Record archived';
  end if;
  if e.join_date is not null and p_date < e.join_date then
    return 'Not employed before ' || to_char(e.join_date, 'DD/MM/YYYY');
  end if;
  if e.termination_date is not null and p_date >= e.termination_date then
    return 'Separated on ' || to_char(e.termination_date, 'DD/MM/YYYY')
           || ' — that date and later cannot be marked';
  end if;
  if e.last_working_day is not null and p_date > e.last_working_day then
    return 'Employment ended ' || to_char(e.last_working_day, 'DD/MM/YYYY');
  end if;

  if e.contract_id is not null then
    select * into c from public.contracts where id = e.contract_id;
  end if;

  if c.id is not null then
    -- The guard is pinned to one contract: that contract is the window.
    if c.start_date is not null and p_date < c.start_date then
      return 'Contract ' || c.contract_code || ' starts ' || to_char(c.start_date, 'DD/MM/YYYY');
    end if;
    if coalesce(c.is_infinite, false) = false
       and c.end_date is not null and p_date > c.end_date then
      return 'Contract ' || c.contract_code || ' ended ' || to_char(c.end_date, 'DD/MM/YYYY');
    end if;
  elsif e.client_id is not null then
    -- No contract of their own: fall back to the client's overall coverage.
    select max(k.end_date),
           bool_or(coalesce(k.is_infinite, false) or k.end_date is null)
      into v_latest_end, v_open_ended
      from public.contracts k
     where k.client_id = e.client_id
       and k.status is distinct from 'draft';

    if v_latest_end is not null
       and coalesce(v_open_ended, false) = false
       and p_date > v_latest_end then
      select name into v_client_name from public.clients where id = e.client_id;
      return 'Contract for ' || coalesce(v_client_name, 'this client')
             || ' ended ' || to_char(v_latest_end, 'DD/MM/YYYY');
    end if;
  end if;

  return null;
end $function$
-- ===END 24687
-- ===FUNC 24688 enforce_attendance_window()
CREATE OR REPLACE FUNCTION public.enforce_attendance_window()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_reason text;
begin
  v_reason := public.attendance_window_block_reason(new.employee_id, new.attendance_date);
  if v_reason is not null then
    raise exception 'Attendance cannot be marked for % : %',
      to_char(new.attendance_date, 'DD/MM/YYYY'), v_reason
      using errcode = '23514';
  end if;
  return new;
end $function$
-- ===END 24688
-- ===FUNC 24745 deployment_client_on(p_guard uuid, p_date date)
CREATE OR REPLACE FUNCTION public.deployment_client_on(p_guard uuid, p_date date)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select d.client_id
    from public.deployments d
   where d.guard_id = p_guard
     and d.client_id is not null
     and d.start_date <= p_date
     and (d.end_date is null or d.end_date >= p_date)
   order by d.start_date desc, d.created_at desc
   limit 1;
$function$
-- ===END 24745
-- ===FUNC 24746 payroll_cost_by_client(p_period_month date)
CREATE OR REPLACE FUNCTION public.payroll_cost_by_client(p_period_month date)
 RETURNS TABLE(client_id uuid, cost numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with ps as (
    select p.employee_id,
           sum(p.final_salary)::numeric as salary,
           e.client_id                  as fallback_client
      from public.payslips p
      join public.employees e on e.id = p.employee_id
     where p.period_month = p_period_month
       and e.company_id = public.current_company_id()
     group by p.employee_id, e.client_id
  ),
  days as (
    select a.employee_id,
           coalesce(a.worked_for_client_id, ps.fallback_client) as cid,
           count(*)::numeric as d
      from public.attendance_records a
      join ps on ps.employee_id = a.employee_id
     where a.attendance_date >= p_period_month
       and a.attendance_date < (p_period_month + interval '1 month')
       and lower(a.status) in ('present', 'double_duty', 'relief_cover')
     group by 1, 2
  ),
  totals as (
    select employee_id, sum(d) as total_d from days group by 1
  ),
  split as (
    select days.cid as client_id,
           ps.salary * days.d / nullif(totals.total_d, 0) as cost
      from days
      join totals on totals.employee_id = days.employee_id
      join ps     on ps.employee_id     = days.employee_id
    union all
    select ps.fallback_client, ps.salary
      from ps
     where not exists (
       select 1 from totals t
        where t.employee_id = ps.employee_id and t.total_d > 0
     )
  )
  select client_id, round(sum(cost), 2) as cost
    from split
   where client_id is not null
   group by client_id;
$function$
-- ===END 24746
-- ===FUNC 24769 cheque_bounce()
CREATE OR REPLACE FUNCTION public.cheque_bounce()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
-- ===END 24769
-- ===FUNC 25593 billable_guard_count(p_company uuid)
CREATE OR REPLACE FUNCTION public.billable_guard_count(p_company uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select count(*)::integer from public.employees e
  where e.company_id = p_company
    and coalesce(e.category::text, '') <> 'office_staff'
    and coalesce(e.status::text, 'Active') <> 'Inactive'
$function$
-- ===END 25593
-- ===FUNC 25594 enforce_guard_limit()
CREATE OR REPLACE FUNCTION public.enforce_guard_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_limit integer; v_buffer integer; v_count integer;
begin
  if coalesce(new.category::text, '') = 'office_staff'
     or coalesce(new.status::text, 'Active') = 'Inactive' then
    return null;
  end if;
  select c.guard_limit, coalesce(c.guard_buffer, 0) into v_limit, v_buffer
  from public.companies c where c.id = new.company_id;
  if v_limit is null then return null; end if;
  v_count := public.billable_guard_count(new.company_id);
  if v_count > v_limit + v_buffer then
    raise exception
      'guard_limit_exceeded: your plan covers % guards (plus a % guard buffer) and you now have %. Upgrade your plan to add more.',
      v_limit, v_buffer, v_count using errcode = 'check_violation';
  end if;
  return null;
end;
$function$
-- ===END 25594
-- ===FUNC 25596 ai_credit_available(p_company uuid)
CREATE OR REPLACE FUNCTION public.ai_credit_available(p_company uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select greatest(coalesce(c.ai_credit_monthly, 0) - coalesce(c.ai_credit_used, 0), 0)
       + coalesce(c.ai_credit_topup, 0)
  from public.companies c where c.id = p_company
$function$
-- ===END 25596
-- ===FUNC 25597 ai_credit_spend(p_company uuid, p_amount numeric, p_description text, p_usage_id uuid)
CREATE OR REPLACE FUNCTION public.ai_credit_spend(p_company uuid, p_amount numeric, p_description text DEFAULT NULL::text, p_usage_id uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_monthly numeric; v_used numeric; v_topup numeric;
        v_free numeric; v_from_monthly numeric; v_from_topup numeric;
begin
  if p_amount is null or p_amount <= 0 then return true; end if;
  select coalesce(c.ai_credit_monthly,0), coalesce(c.ai_credit_used,0), coalesce(c.ai_credit_topup,0)
    into v_monthly, v_used, v_topup
  from public.companies c where c.id = p_company for update;
  if not found then return false; end if;
  v_free := greatest(v_monthly - v_used, 0);
  if v_free + v_topup < p_amount then return false; end if;
  v_from_monthly := least(v_free, p_amount);
  v_from_topup := p_amount - v_from_monthly;
  update public.companies
     set ai_credit_used = v_used + v_from_monthly,
         ai_credit_topup = v_topup - v_from_topup,
         updated_at = now()
   where id = p_company;
  insert into public.ai_credit_ledger
    (company_id, kind, amount_pkr, monthly_after, topup_after, description, ai_usage_id)
  values (p_company, 'usage', -p_amount,
     greatest(v_monthly - (v_used + v_from_monthly), 0), v_topup - v_from_topup,
     p_description, p_usage_id);
  return true;
end;
$function$
-- ===END 25597
-- ===FUNC 25598 ai_credit_topup(p_company uuid, p_amount numeric, p_reference text, p_description text)
CREATE OR REPLACE FUNCTION public.ai_credit_topup(p_company uuid, p_amount numeric, p_reference text DEFAULT NULL::text, p_description text DEFAULT NULL::text)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_topup numeric;
begin
  update public.companies
     set ai_credit_topup = coalesce(companies.ai_credit_topup, 0) + p_amount,
         updated_at = now()
   where id = p_company
  returning companies.ai_credit_topup into v_topup;
  insert into public.ai_credit_ledger
    (company_id, kind, amount_pkr, topup_after, description, stripe_reference)
  values (p_company, 'topup', p_amount, v_topup,
          coalesce(p_description, 'AI credit top-up'), p_reference);
  return v_topup;
end;
$function$
-- ===END 25598
-- ===FUNC 25599 ai_credit_reset_period(p_company uuid, p_monthly numeric)
CREATE OR REPLACE FUNCTION public.ai_credit_reset_period(p_company uuid, p_monthly numeric DEFAULT NULL::numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_monthly numeric; v_used numeric; v_new numeric;
begin
  select coalesce(c.ai_credit_monthly,0), coalesce(c.ai_credit_used,0) into v_monthly, v_used
  from public.companies c where c.id = p_company for update;
  if not found then return; end if;
  v_new := coalesce(p_monthly, v_monthly);
  if v_monthly - v_used > 0 then
    insert into public.ai_credit_ledger (company_id, kind, amount_pkr, description)
    values (p_company, 'expiry', -(v_monthly - v_used),
            'Unused monthly AI credit forfeited at period end');
  end if;
  update public.companies
     set ai_credit_monthly = v_new, ai_credit_used = 0, updated_at = now()
   where id = p_company;
  insert into public.ai_credit_ledger (company_id, kind, amount_pkr, monthly_after, description)
  values (p_company, 'monthly_grant', v_new, v_new, 'Monthly AI credit granted');
end;
$function$
-- ===END 25599
-- ===FUNC 25600 billing_summary()
CREATE OR REPLACE FUNCTION public.billing_summary()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object(
    'company_id', c.id,
    'company_name', c.name,
    'billing_status', c.billing_status,
    'active', c.active,
    'guard_limit', c.guard_limit,
    'guard_buffer', c.guard_buffer,
    'guards_used', public.billable_guard_count(c.id),
    'plan_care', c.plan_care,
    'plan_price_pkr', c.plan_price_pkr,
    'current_period_end', c.current_period_end,
    'subscription_expires_at', c.subscription_expires_at,
    'has_subscription', c.stripe_subscription_id is not null,
    'ai_credit_monthly', c.ai_credit_monthly,
    'ai_credit_used', c.ai_credit_used,
    'ai_credit_topup', c.ai_credit_topup,
    'ai_credit_available', public.ai_credit_available(c.id))
  from public.companies c where c.id = public.current_company_id()
$function$
-- ===END 25600
-- ===FUNC 25617 ai_credit_status(p_company uuid)
CREATE OR REPLACE FUNCTION public.ai_credit_status(p_company uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object(
    'enforced', c.guard_limit is not null,
    'available', public.ai_credit_available(c.id),
    'monthly', c.ai_credit_monthly,
    'used', c.ai_credit_used,
    'topup', c.ai_credit_topup)
  from public.companies c where c.id = p_company
$function$
-- ===END 25617
-- ===FUNC 25662 enforce_contract_line_headcount()
CREATE OR REPLACE FUNCTION public.enforce_contract_line_headcount()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_committed int;
  v_active    int;
  v_label     text;
begin
  if new.contract_line_id is null then
    return new;
  end if;
  -- Only a move ONTO a line is checked.
  if tg_op = 'UPDATE' and new.contract_line_id is not distinct from old.contract_line_id then
    return new;
  end if;
  -- An assignment that is not live today consumes no slot.
  if new.status <> 'Active' then
    return new;
  end if;
  if new.assignment_effective_from is not null and new.assignment_effective_from > current_date then
    return new;
  end if;
  if new.assignment_effective_to is not null and new.assignment_effective_to < current_date then
    return new;
  end if;

  select
    greatest(0, l.committed_count + coalesce((
      select sum(case a.change_type::text
                   when 'ADD_HEADCOUNT'    then  abs(coalesce(a.count_delta, 0))
                   when 'REDUCE_HEADCOUNT' then -abs(coalesce(a.count_delta, 0))
                   else 0
                 end)
      from public.contract_addendums a
      where a.contract_line_id = l.id
        and a.effective_from <= current_date
    ), 0)),
    coalesce(nullif(btrim(l.label), ''), l.category::text)
      || coalesce(' (' || l.shift_code::text || ')', '')
  into v_committed, v_label
  from public.contract_lines l
  where l.id = new.contract_line_id;

  if v_committed is null then
    return new;
  end if;

  select count(*)
  into v_active
  from public.employees e
  where e.contract_line_id = new.contract_line_id
    and e.id <> new.id
    and e.status = 'Active'
    and (e.assignment_effective_from is null or e.assignment_effective_from <= current_date)
    and (e.assignment_effective_to is null or e.assignment_effective_to >= current_date);

  if v_active >= v_committed then
    raise exception
      '% is full: the contract commits % and % % already in it. Raise the committed count, or add an addendum, before assigning anyone else.',
      v_label, v_committed, v_active,
      case when v_active = 1 then 'is' else 'are' end
      using errcode = 'check_violation';
  end if;

  return new;
end;
$function$
-- ===END 25662
-- ===FUNC 25832 attendance_payroll(p_start date, p_end date)
CREATE OR REPLACE FUNCTION public.attendance_payroll(p_start date, p_end date)
 RETURNS TABLE(employee_id uuid, worked_shifts numeric, present_days integer, double_duty_shifts integer, earned numeric, leave_days integer, absent_days integer, rate_effective numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with rows as (
    select ar.employee_id, ar.attendance_date, lower(ar.status) as st,
      coalesce(
        (select sh.base_salary from public.employee_salary_history sh
           where sh.employee_id = ar.employee_id and sh.effective_date <= ar.attendance_date
           order by sh.effective_date desc limit 1),
        (select e.base_salary from public.employees e where e.id = ar.employee_id),
        0
      ) as rate,
      extract(day from (date_trunc('month', ar.attendance_date) + interval '1 month - 1 day'))::int as dim
    from public.attendance_records ar
    where ar.attendance_date between p_start and p_end
  )
  select employee_id,
    sum(case when st in ('present','double_duty','relief_cover') then 1 else 0 end)                    as worked_shifts,
    count(distinct attendance_date) filter (where st in ('present','double_duty','relief_cover'))::int as present_days,
    (sum(case when st in ('present','double_duty','relief_cover') then 1 else 0 end)
      - count(distinct attendance_date) filter (where st in ('present','double_duty','relief_cover')))::int
                                                                                                       as double_duty_shifts,
    sum(case when st in ('present','double_duty','relief_cover') then rate / nullif(dim,0) else 0 end) as earned,
    sum(case when st in ('leave','rotation_leave','rest_day') then 1 else 0 end)::int                  as leave_days,
    sum(case when st = 'absent' then 1 else 0 end)::int                                                as absent_days,
    max(rate)                                                                                          as rate_effective
  from rows
  group by employee_id;
$function$
-- ===END 25832
-- ===FUNC 25833 has_permission(p_key text)
CREATE OR REPLACE FUNCTION public.has_permission(p_key text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and (p.role::text in ('super_admin','super_super_admin')
           or p_key = any(coalesce(p.permissions, '{}')))
  );
$function$
-- ===END 25833
-- ===FUNC 25960 generate_fixed_expense_instances(p_month date)
CREATE OR REPLACE FUNCTION public.generate_fixed_expense_instances(p_month date DEFAULT NULL::date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_month   date := date_trunc('month', coalesce(p_month, current_date))::date;
  v_company uuid := public.current_company_id();
  v_count   integer;
begin
  insert into public.fixed_expense_instances (
    company_id, fixed_expense_id, period_month,
    category_id, pl_category, client_id, branch_id, vendor_id,
    description, amount, payment_mode, bank_account_id, due_date, notes, status
  )
  select
    f.company_id, f.id, v_month,
    f.category_id, f.pl_category, f.client_id, f.branch_id, f.vendor_id,
    f.description, f.amount, f.payment_mode, f.bank_account_id,
    case when f.payment_mode = 'Payable'
         then (v_month + ((coalesce(f.due_day, 1) - 1) || ' days')::interval)::date
         else null end,
    f.notes, 'pending'
  from public.fixed_expenses f
  where f.is_active
    and f.start_month <= v_month
    and (f.end_month is null or f.end_month >= v_month)
    and (v_company is null or f.company_id = v_company)
  on conflict (fixed_expense_id, period_month) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end $function$
-- ===END 25960
-- ===FUNC 25972 default_office_staff_branch()
CREATE OR REPLACE FUNCTION public.default_office_staff_branch()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.category = 'office_staff' and new.branch_id is null then
    select b.id into new.branch_id
    from public.branches b
    where b.company_id = new.company_id
    order by b.is_head_office desc nulls last, b.created_at asc
    limit 1;
  end if;
  return new;
end $function$
-- ===END 25972
-- ===FUNC 25975 payroll_cash_by_client(p_start date, p_end date)
CREATE OR REPLACE FUNCTION public.payroll_cash_by_client(p_start date, p_end date)
 RETURNS TABLE(client_id uuid, cost numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with paid as (
    select p.employee_id,
           p.period_month,
           p.net_salary::numeric as salary,
           e.client_id           as fallback_client,
           case
             when p.payment_mode = 'Cheque'
               then case when c.status = 'cleared' then c.cleared_at::date end
             else coalesce(p.disbursed_at::date, p.period_month)
           end as cash_date
      from public.payslips p
      join public.employees e on e.id = p.employee_id
      left join public.cheques c on c.id = p.cheque_id
     where p.disbursed
       and e.company_id = public.current_company_id()
  ),
  ps as (
    select employee_id,
           period_month,
           fallback_client,
           sum(salary) as salary
      from paid
     where cash_date between p_start and p_end
     group by 1, 2, 3
  ),
  days as (
    select a.employee_id,
           ps.period_month,
           coalesce(a.worked_for_client_id, ps.fallback_client) as cid,
           count(*)::numeric as d
      from public.attendance_records a
      join ps on ps.employee_id = a.employee_id
     where a.attendance_date >= ps.period_month
       and a.attendance_date < (ps.period_month + interval '1 month')
       and lower(a.status) in ('present', 'double_duty', 'relief_cover')
     group by 1, 2, 3
  ),
  totals as (
    select employee_id, period_month, sum(d) as total_d from days group by 1, 2
  ),
  split as (
    select days.cid as client_id,
           ps.salary * days.d / nullif(totals.total_d, 0) as cost
      from days
      join totals on totals.employee_id = days.employee_id
                 and totals.period_month = days.period_month
      join ps     on ps.employee_id     = days.employee_id
                 and ps.period_month    = days.period_month
    union all
    select ps.fallback_client, ps.salary
      from ps
     where not exists (
       select 1 from totals t
        where t.employee_id = ps.employee_id
          and t.period_month = ps.period_month
          and t.total_d > 0
     )
  )
  select client_id, round(sum(cost), 2) as cost
    from split
   where client_id is not null
   group by client_id;
$function$
-- ===END 25975
-- ===FUNC 25989 regional_pl(p_month date)
CREATE OR REPLACE FUNCTION public.regional_pl(p_month date)
 RETURNS TABLE(branch_id uuid, region_name text, revenue_accrual numeric, payroll_accrual numeric, expenses_accrual numeric, profit_accrual numeric, revenue_cash numeric, payroll_cash numeric, expenses_cash numeric, profit_cash numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select * from public.regional_pl_range(
    date_trunc('month', p_month)::date,
    (date_trunc('month', p_month) + interval '1 month - 1 day')::date
  );
$function$
-- ===END 25989
-- ===FUNC 25990 regional_general_expenses(p_month date)
CREATE OR REPLACE FUNCTION public.regional_general_expenses(p_month date)
 RETURNS TABLE(branch_id uuid, region_name text, category text, amount numeric, is_payroll boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with cid as (select public.current_company_id() as company_id),
  m as (
    select date_trunc('month', p_month)::date as start_d,
           (date_trunc('month', p_month) + interval '1 month - 1 day')::date as end_d
  ),
  rows as (
    select coalesce(x.branch_id, c.branch_id) as b,
           coalesce(cat.name, 'Uncategorized')::text as category,
           sum(x.amount)::numeric as amount,
           false as is_payroll
      from public.expenses x
      left join public.clients c on c.id = x.client_id
      left join public.expense_categories cat on cat.id = x.category_id
     cross join m, cid
     where x.company_id = cid.company_id
       and x.pl_category = 'operating_expense'
       and x.expense_date between m.start_d and m.end_d
     group by 1, 2
    union all
    select e.branch_id,
           'Office staff salaries'::text,
           sum(ps.final_salary)::numeric,
           true
      from public.payslips ps
      join public.employees e on e.id = ps.employee_id
     cross join m, cid
     where e.company_id = cid.company_id
       and e.category = 'office_staff'
       and ps.period_month = m.start_d
     group by 1
  )
  select rows.b,
         coalesce(br.name, 'Unassigned')::text,
         rows.category,
         rows.amount,
         rows.is_payroll
    from rows
    left join public.branches br on br.id = rows.b
   where rows.amount <> 0
   order by 2, 4 desc, 3;
$function$
-- ===END 25990
-- ===FUNC 26019 regional_pl_range(p_start date, p_end date)
CREATE OR REPLACE FUNCTION public.regional_pl_range(p_start date, p_end date)
 RETURNS TABLE(branch_id uuid, region_name text, revenue_accrual numeric, payroll_accrual numeric, expenses_accrual numeric, profit_accrual numeric, revenue_cash numeric, payroll_cash numeric, expenses_cash numeric, profit_cash numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with cid as (select public.current_company_id() as company_id),
  inv as (
    select coalesce(i.branch_id, c.branch_id) as b, sum(i.invoice_amount)::numeric as amt
      from public.invoices i left join public.clients c on c.id = i.client_id cross join cid
     where i.company_id = cid.company_id and i.invoice_date between p_start and p_end group by 1
  ),
  rcp as (
    select coalesce(p.branch_id, c.branch_id) as b, sum(p.amount)::numeric as amt
      from public.invoice_payments p left join public.clients c on c.id = p.client_id cross join cid
     where p.company_id = cid.company_id and p.payment_date between p_start and p_end group by 1
  ),
  pay_a as (
    select e.branch_id as b, sum(ps.final_salary)::numeric as amt
      from public.payslips ps join public.employees e on e.id = ps.employee_id cross join cid
     where e.company_id = cid.company_id
       and ps.period_month between date_trunc('month', p_start)::date and p_end group by 1
  ),
  pay_c as (
    select e.branch_id as b, sum(ps.net_salary)::numeric as amt
      from public.payslips ps join public.employees e on e.id = ps.employee_id
      left join public.cheques ch on ch.id = ps.cheque_id cross join cid
     where e.company_id = cid.company_id and ps.disbursed
       and (case when ps.payment_mode = 'Cheque'
                 then case when ch.status = 'cleared' then ch.cleared_at::date end
                 else coalesce(ps.disbursed_at::date, ps.period_month) end)
           between p_start and p_end group by 1
  ),
  exp_a as (
    select coalesce(x.branch_id, c.branch_id) as b, sum(x.amount)::numeric as amt
      from public.expenses x left join public.clients c on c.id = x.client_id cross join cid
     where x.company_id = cid.company_id and x.expense_date between p_start and p_end group by 1
  ),
  exp_c as (
    select coalesce(x.branch_id, c.branch_id) as b, sum(x.amount)::numeric as amt
      from public.expenses x left join public.clients c on c.id = x.client_id
      left join public.cheques ch on ch.id = x.cheque_id cross join cid
     where x.company_id = cid.company_id
       and (case when x.payment_mode in ('Cash','Bank') then x.expense_date
                 when x.payment_mode = 'Cheque'
                   then case when ch.status = 'cleared' then ch.cleared_at::date end
                 when x.payment_mode = 'Payable' and x.payable_status = 'Paid' then x.paid_at::date end)
           between p_start and p_end group by 1
  ),
  regions as (
    select b.id, b.name::text from public.branches b cross join cid where b.company_id = cid.company_id
    union
    select null::uuid, 'Unassigned'::text
     where exists (select 1 from inv where b is null) or exists (select 1 from rcp where b is null)
        or exists (select 1 from pay_a where b is null) or exists (select 1 from pay_c where b is null)
        or exists (select 1 from exp_a where b is null) or exists (select 1 from exp_c where b is null)
  )
  select r.id, r.name,
    coalesce(inv.amt,0), coalesce(pay_a.amt,0), coalesce(exp_a.amt,0),
    coalesce(inv.amt,0) - coalesce(pay_a.amt,0) - coalesce(exp_a.amt,0),
    coalesce(rcp.amt,0), coalesce(pay_c.amt,0), coalesce(exp_c.amt,0),
    coalesce(rcp.amt,0) - coalesce(pay_c.amt,0) - coalesce(exp_c.amt,0)
  from regions r
  left join inv on inv.b is not distinct from r.id
  left join rcp on rcp.b is not distinct from r.id
  left join pay_a on pay_a.b is not distinct from r.id
  left join pay_c on pay_c.b is not distinct from r.id
  left join exp_a on exp_a.b is not distinct from r.id
  left join exp_c on exp_c.b is not distinct from r.id
  order by r.name;
$function$
-- ===END 26019
-- ===FUNC 26021 operating_expense_detail(p_month date)
CREATE OR REPLACE FUNCTION public.operating_expense_detail(p_month date)
 RETURNS TABLE(branch_id uuid, region_name text, category text, expense_id uuid, expense_date date, description text, client_name text, vendor_name text, payment_mode text, amount numeric, is_derived boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with cid as (select public.current_company_id() as company_id),
  m as (
    select date_trunc('month', p_month)::date as start_d,
           (date_trunc('month', p_month) + interval '1 month - 1 day')::date as end_d
  ),
  rows as (
    select coalesce(x.branch_id, c.branch_id) as b,
           coalesce(cat.name, 'Uncategorized')::text as category,
           x.id as expense_id, x.expense_date, x.description,
           c.name::text as client_name, v.name::text as vendor_name,
           x.payment_mode::text, x.amount::numeric, false as is_derived
      from public.expenses x
      left join public.clients c on c.id = x.client_id
      left join public.vendors v on v.id = x.vendor_id
      left join public.expense_categories cat on cat.id = x.category_id
     cross join m, cid
     where x.company_id = cid.company_id
       and x.pl_category = 'operating_expense'
       and x.expense_date between m.start_d and m.end_d
    union all
    select e.branch_id, 'Office staff salaries'::text, null::uuid, m.start_d,
           count(*)::text || ' office staff', null::text, null::text, null::text,
           sum(ps.final_salary)::numeric, true
      from public.payslips ps join public.employees e on e.id = ps.employee_id
     cross join m, cid
     where e.company_id = cid.company_id and e.category = 'office_staff'
       and ps.period_month = m.start_d
     group by e.branch_id, m.start_d
  )
  select rows.b, coalesce(br.name, 'Unassigned')::text, rows.category, rows.expense_id,
         rows.expense_date, rows.description, rows.client_name, rows.vendor_name,
         rows.payment_mode, rows.amount, rows.is_derived
    from rows left join public.branches br on br.id = rows.b
   order by 2, 3, 5, 10 desc;
$function$
-- ===END 26021
-- ===FUNC 26046 partnership_allocation(p_start date, p_end date, p_basis text)
CREATE OR REPLACE FUNCTION public.partnership_allocation(p_start date, p_end date, p_basis text DEFAULT 'revenue'::text)
 RETURNS TABLE(row_kind text, branch_id uuid, region_name text, partner_id uuid, partner_name text, share_pct numeric, own_profit numeric, ho_allocated numeric, base_amount numeric, amount numeric, residual numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with cid as (select public.current_company_id() as company_id),
  cfg as (select public.partner_basis_for_report(p_basis) as basis),
  raw as (
    select r.branch_id,
           r.region_name,
           coalesce(b.is_head_office, false) as is_ho,
           case when cfg.basis = 'cash' then r.profit_cash  else r.profit_accrual  end as profit,
           case when cfg.basis = 'cash' then r.revenue_cash else r.revenue_accrual end as revenue
      from public.regional_pl_range(p_start, p_end) r
      left join public.branches b on b.id = r.branch_id
      cross join cfg
  ),
  ho as (
    select coalesce(sum(profit) filter (where is_ho), 0) as ho_profit,
           coalesce(sum(greatest(revenue, 0)) filter (where not is_ho), 0) as rev_base
      from raw
  ),
  adj as (
    select raw.branch_id, raw.region_name, raw.is_ho, raw.profit as own_profit,
           case
             when ho.rev_base <= 0 then 0
             when raw.is_ho then -raw.profit
             else ho.ho_profit * greatest(raw.revenue, 0) / ho.rev_base
           end as ho_allocated
      from raw cross join ho
  ),
  pl as (
    select branch_id, region_name, is_ho, own_profit, ho_allocated,
           own_profit + ho_allocated as profit
      from adj
  ),
  reg_p as (
    select p.id, p.name, p.branch_id, p.profit_share_percent
      from public.partners p cross join cid
     where p.company_id = cid.company_id and p.scope = 'BRANCH'
       and p.is_active and p.branch_id is not null
       and (p.start_month is null or p.start_month <= p_end)
  ),
  eq_p as (
    select p.id, p.name, p.profit_share_percent
      from public.partners p cross join cid
     where p.company_id = cid.company_id and p.scope = 'COMPANY' and p.is_active
       and (p.start_month is null or p.start_month <= p_end)
  ),
  cs_cash as (select client_id, branch_id, net from public.client_statement_loaded(p_start, p_end, 'cash')),
  cs_rev  as (select client_id, branch_id, net from public.client_statement_loaded(p_start, p_end, 'revenue')),
  per_client as (
    select rp.id as partner_id, rp.branch_id,
           coalesce(o.share_percent, rp.profit_share_percent) as pct,
           case cfg.basis
             when 'cash'    then coalesce(csc.net, 0)
             when 'revenue' then coalesce(csr.net, 0)
           end as client_net
      from reg_p rp
      cross join cfg
      left join cs_rev  csr on csr.branch_id = rp.branch_id
      left join cs_cash csc on csc.branch_id = rp.branch_id
                           and csc.client_id = csr.client_id
      left join lateral (
        select s.share_percent
          from public.partner_client_shares s
         where s.partner_id = rp.id and s.client_id = csr.client_id
           and s.effective_month <= p_start
         order by s.effective_month desc
         limit 1
      ) o on true
  ),
  partner_take as (
    select rp.id as partner_id, rp.branch_id,
           round(coalesce((select sum(pc.client_net * pc.pct / 100)
                             from per_client pc
                            where pc.partner_id = rp.id), 0), 2) as amount
      from reg_p rp join pl on pl.branch_id = rp.branch_id
  ),
  reg_alloc as (
    select pl.branch_id, pl.region_name, pl.own_profit, pl.ho_allocated, pl.profit,
           coalesce((select sum(pt.amount) from partner_take pt where pt.branch_id = pl.branch_id), 0) as taken
      from pl
  ),
  pool as (select coalesce(sum(profit - taken), 0) as residual from reg_alloc)
  select 'REGION'::text, ra.branch_id, ra.region_name,
         null::uuid, null::text, null::numeric,
         ra.own_profit, ra.ho_allocated, ra.profit, ra.taken, ra.profit - ra.taken
    from reg_alloc ra
  union all
  select 'REGIONAL_PARTNER'::text, pl.branch_id, pl.region_name,
         reg_p.id, reg_p.name, reg_p.profit_share_percent,
         pl.own_profit, pl.ho_allocated, pl.profit,
         pt.amount, null::numeric
    from reg_p
    join pl on pl.branch_id = reg_p.branch_id
    join partner_take pt on pt.partner_id = reg_p.id
  union all
  select 'EQUITY_PARTNER'::text, null::uuid, null::text,
         eq_p.id, eq_p.name, eq_p.profit_share_percent,
         null::numeric, null::numeric, pool.residual,
         round(pool.residual * eq_p.profit_share_percent / 100, 2), null::numeric
    from eq_p cross join pool
  union all
  select 'UNALLOCATED_HO'::text, null::uuid, null::text, null::uuid, null::text,
         null::numeric, null::numeric, null::numeric,
         ho.ho_profit, ho.ho_profit, null::numeric
    from ho where ho.rev_base <= 0 and ho.ho_profit <> 0
  union all
  select 'UNALLOCATED'::text, null::uuid, null::text, null::uuid, null::text,
         100 - coalesce((select sum(profit_share_percent) from eq_p), 0),
         null::numeric, null::numeric, pool.residual,
         pool.residual - coalesce((select sum(round(pool.residual * profit_share_percent / 100, 2)) from eq_p), 0),
         null::numeric
    from pool;
$function$
-- ===END 26046
-- ===FUNC 26063 client_statement_loaded(p_start date, p_end date, p_basis text)
CREATE OR REPLACE FUNCTION public.client_statement_loaded(p_start date, p_end date, p_basis text DEFAULT 'revenue'::text)
 RETURNS TABLE(client_id uuid, client_name text, client_code text, branch_id uuid, region_name text, revenue numeric, direct_payroll numeric, direct_expenses numeric, regional_overhead numeric, ho_share numeric, net numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with cid as (select public.current_company_id() as company_id),
  cash as (select lower(p_basis) = 'cash' as on_cash),
  cl as (
    select c.id, c.name::text as name, c.client_code::text as code, c.branch_id
      from public.clients c cross join cid
     where c.company_id = cid.company_id
  ),
  ip as (
    select coalesce(p.client_id, i.client_id) as client_id, sum(p.amount)::numeric as amt
      from public.invoice_payments p
      left join public.invoices i on i.id = p.invoice_id
     cross join cid
     where p.company_id = cid.company_id and p.payment_date between p_start and p_end
       and coalesce(p.client_id, i.client_id) is not null
     group by 1
  ),
  iv as (
    select i.client_id, sum(i.invoice_amount)::numeric as amt
      from public.invoices i cross join cid
     where i.company_id = cid.company_id
       and coalesce(i.period_start, i.invoice_date) between p_start and p_end
       and i.client_id is not null
     group by 1
  ),
  rev as (
    select cl.id as client_id,
           case when cash.on_cash then coalesce(ip.amt, 0) else coalesce(iv.amt, 0) end as amt
      from cl cross join cash
      left join ip on ip.client_id = cl.id
      left join iv on iv.client_id = cl.id
  ),
  paid as (
    select ps.employee_id, ps.period_month,
           case when cash.on_cash then ps.net_salary else ps.final_salary end::numeric as salary,
           e.client_id as fallback_client, e.branch_id as emp_branch,
           case when cash.on_cash then
                  case when ps.payment_mode = 'Cheque'
                       then case when ch.status = 'cleared' then ch.cleared_at::date end
                       else coalesce(ps.disbursed_at::date, ps.period_month) end
                else ps.period_month end as eff_date,
           case when cash.on_cash then ps.disbursed else true end as counts
      from public.payslips ps
      join public.employees e on e.id = ps.employee_id
      left join public.cheques ch on ch.id = ps.cheque_id
      cross join cid cross join cash
     where e.company_id = cid.company_id
  ),
  ps as (
    select employee_id, period_month, fallback_client, emp_branch, sum(salary) as salary
      from paid where counts and eff_date between p_start and p_end group by 1,2,3,4
  ),
  days as (
    select a.employee_id, ps.period_month,
           coalesce(a.worked_for_client_id, ps.fallback_client) as cid2,
           count(*)::numeric as d
      from public.attendance_records a join ps on ps.employee_id = a.employee_id
     where a.attendance_date >= ps.period_month
       and a.attendance_date < (ps.period_month + interval '1 month')
       and lower(a.status) in ('present','double_duty','relief_cover')
     group by 1,2,3
  ),
  totals as (select employee_id, period_month, sum(d) as total_d from days group by 1,2),
  pay_split as (
    select days.cid2 as client_id, ps.emp_branch,
           ps.salary * days.d / nullif(totals.total_d, 0) as cost
      from days
      join totals on totals.employee_id = days.employee_id and totals.period_month = days.period_month
      join ps on ps.employee_id = days.employee_id and ps.period_month = days.period_month
    union all
    select ps.fallback_client, ps.emp_branch, ps.salary from ps
     where not exists (select 1 from totals t
        where t.employee_id = ps.employee_id and t.period_month = ps.period_month and t.total_d > 0)
  ),
  pay_client as (select client_id, sum(cost) as amt from pay_split where client_id is not null group by 1),
  pay_overhead as (select emp_branch as b, sum(cost) as amt from pay_split where client_id is null group by 1),
  exp_rows as (
    select x.client_id, x.branch_id, x.amount::numeric as amount,
           case when cash.on_cash then
                  case when x.payment_mode in ('Cash','Bank') then x.expense_date
                       when x.payment_mode = 'Cheque'
                         then case when ch.status = 'cleared' then ch.cleared_at::date end
                       when x.payment_mode = 'Payable' and x.payable_status = 'Paid' then x.paid_at::date end
                else x.expense_date end as eff_date
      from public.expenses x
      left join public.cheques ch on ch.id = x.cheque_id
      cross join cid cross join cash
     where x.company_id = cid.company_id
  ),
  exp_client as (
    select client_id, sum(amount) as amt from exp_rows
     where client_id is not null and eff_date between p_start and p_end group by 1
  ),
  exp_overhead as (
    select branch_id as b, sum(amount) as amt from exp_rows
     where client_id is null and eff_date between p_start and p_end group by 1
  ),
  overhead as (
    select b, sum(amt) as amt from (
      select b, amt from pay_overhead union all select b, amt from exp_overhead
    ) u group by 1
  ),
  ho as (
    select coalesce(sum(o.amt), 0) as pool from overhead o
      join public.branches br on br.id = o.b where br.is_head_office
  ),
  region_overhead as (
    select o.b, o.amt from overhead o left join public.branches br on br.id = o.b
     where coalesce(br.is_head_office, false) = false
  ),
  rev_total as (select coalesce(sum(amt), 0) as amt from rev),
  rev_region as (
    select cl.branch_id as b, coalesce(sum(rev.amt), 0) as amt, count(*) as n_clients
      from cl join rev on rev.client_id = cl.id group by cl.branch_id
  )
  select cl.id, cl.name, cl.code, cl.branch_id,
    coalesce(br.name, 'Unassigned')::text,
    round(coalesce(rev.amt, 0), 2),
    round(coalesce(pay_client.amt, 0), 2),
    round(coalesce(exp_client.amt, 0), 2),
    round(coalesce(ro.amt, 0) * case
        when coalesce(rr.amt, 0) > 0 then coalesce(rev.amt, 0) / rr.amt
        when coalesce(rr.n_clients, 0) > 0 then 1.0 / rr.n_clients else 0 end, 2),
    round(ho.pool * case when rt.amt > 0 then coalesce(rev.amt, 0) / rt.amt else 0 end, 2),
    round(coalesce(rev.amt, 0) - coalesce(pay_client.amt, 0) - coalesce(exp_client.amt, 0)
      - coalesce(ro.amt, 0) * case
          when coalesce(rr.amt, 0) > 0 then coalesce(rev.amt, 0) / rr.amt
          when coalesce(rr.n_clients, 0) > 0 then 1.0 / rr.n_clients else 0 end
      - ho.pool * case when rt.amt > 0 then coalesce(rev.amt, 0) / rt.amt else 0 end, 2)
  from cl
  cross join ho
  cross join rev_total rt
  left join public.branches br on br.id = cl.branch_id
  left join rev on rev.client_id = cl.id
  left join pay_client on pay_client.client_id = cl.id
  left join exp_client on exp_client.client_id = cl.id
  left join region_overhead ro on ro.b is not distinct from cl.branch_id
  left join rev_region rr on rr.b is not distinct from cl.branch_id
  order by cl.name;
$function$
-- ===END 26063
-- ===FUNC 26148 change_category(p_guard_id uuid, p_new_category text, p_new_client_id uuid, p_contract_line_id uuid, p_effective_date date, p_site_id uuid)
CREATE OR REPLACE FUNCTION public.change_category(p_guard_id uuid, p_new_category text, p_new_client_id uuid DEFAULT NULL::uuid, p_contract_line_id uuid DEFAULT NULL::uuid, p_effective_date date DEFAULT NULL::date, p_site_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company uuid; v_eff date; v_site uuid; v_start date;
begin
  if p_new_category not in ('client','office_staff','reliever') then
    raise exception 'Invalid category %', p_new_category;
  end if;
  select company_id into v_company from public.employees where id = p_guard_id;
  if v_company is null then raise exception 'Employee % not found', p_guard_id; end if;

  v_eff := coalesce(p_effective_date, current_date);

  select start_date into v_start from public.deployments
    where guard_id = p_guard_id and end_date is null;
  update public.deployments
     set end_date = greatest(coalesce(v_start, v_eff - 1), v_eff - 1), updated_at = now()
   where guard_id = p_guard_id and end_date is null;

  if p_new_category = 'client' then
    if p_new_client_id is null then
      raise exception 'Select a client to move this employee to';
    end if;
    v_site := coalesce(
      p_site_id,
      (select id from public.sites where client_id = p_new_client_id and is_default limit 1)
    );
    if p_site_id is not null and not exists (
      select 1 from public.sites where id = p_site_id and client_id = p_new_client_id
    ) then
      raise exception 'Site % does not belong to client %', p_site_id, p_new_client_id;
    end if;
    insert into public.deployments
      (company_id, guard_id, client_id, contract_line_id, site_id, start_date, reason)
    values (v_company, p_guard_id, p_new_client_id, p_contract_line_id, v_site, v_eff, 'new_hire');
    update public.employees
       set category = 'client',
           contract_line_id = p_contract_line_id,
           contract_id = (select contract_id from public.contract_lines where id = p_contract_line_id),
           updated_at = now()
     where id = p_guard_id;
  else
    update public.employees
       set category = p_new_category::public.employee_category,
           contract_id = null, contract_line_id = null,
           assignment_effective_from = null, assignment_effective_to = null,
           updated_at = now()
     where id = p_guard_id;
  end if;
end $function$
-- ===END 26148
-- ===FUNC 26424 employee_advance_outstanding(p_period_start date)
CREATE OR REPLACE FUNCTION public.employee_advance_outstanding(p_period_start date)
 RETURNS TABLE(employee_id uuid, outstanding numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with cid as (select public.current_company_id() as company_id),
  adv as (
    select a.employee_id, sum(a.amount)::numeric as total
      from public.advances a cross join cid
     where a.company_id = cid.company_id
       and a.advance_date < (p_period_start + interval '1 month')
     group by a.employee_id
  ),
  rec as (
    select p.employee_id, sum(p.advance)::numeric as recovered
      from public.payslips p
      join public.employees e on e.id = p.employee_id
     cross join cid
     where e.company_id = cid.company_id
       and p.period_month < p_period_start
     group by p.employee_id
  )
  select coalesce(adv.employee_id, rec.employee_id) as employee_id,
         greatest(coalesce(adv.total, 0) - coalesce(rec.recovered, 0), 0) as outstanding
    from adv
    full join rec on rec.employee_id = adv.employee_id;
$function$
-- ===END 26424
-- ===FUNC 26513 enforce_attendance_month_lock()
CREATE OR REPLACE FUNCTION public.enforce_attendance_month_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_emp uuid; v_date date; v_client uuid; v_cat text;
begin
  if public.is_maintenance_session() then
    return case when TG_OP = 'DELETE' then OLD else NEW end;
  end if;
  if TG_OP = 'DELETE' then v_emp := OLD.employee_id; v_date := OLD.attendance_date;
  else v_emp := NEW.employee_id; v_date := NEW.attendance_date; end if;
  select client_id, category into v_client, v_cat from public.employees where id = v_emp;
  if v_client is not null then
    if exists (select 1 from public.attendance_month_verifications v
               where v.client_id = v_client and v.period_month = date_trunc('month', v_date)::date) then
      raise exception 'This month is OPS-verified for this client and locked. Un-verify it to edit attendance.';
    end if;
  elsif v_cat is not null then
    if exists (select 1 from public.attendance_month_verifications v
               where v.category = v_cat and v.period_month = date_trunc('month', v_date)::date) then
      raise exception 'This month is OPS-verified for this group and locked. Un-verify it to edit attendance.';
    end if;
  end if;
  return case when TG_OP = 'DELETE' then OLD else NEW end;
end;
$function$
-- ===END 26513
-- ===FUNC 26674 enforce_confirmed_month_end_lock()
CREATE OR REPLACE FUNCTION public.enforce_confirmed_month_end_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_emp uuid; v_date date; v_shift text; v_client uuid; v_cat text; v_override boolean;
begin
  if public.is_maintenance_session() then
    return case when TG_OP='DELETE' then OLD else NEW end;
  end if;
  if TG_OP='DELETE' then
    v_emp:=OLD.employee_id; v_date:=OLD.attendance_date; v_shift:=OLD.worked_shift; v_override:=false;
  else
    v_emp:=NEW.employee_id; v_date:=NEW.attendance_date; v_shift:=NEW.worked_shift;
    v_override:=coalesce(NEW.supervisor_override,false);
  end if;
  if v_override then return case when TG_OP='DELETE' then OLD else NEW end; end if;
  if (date_trunc('month', v_date) + interval '1 month')::date > current_date then
    return case when TG_OP='DELETE' then OLD else NEW end;
  end if;
  select client_id, category into v_client, v_cat from public.employees where id=v_emp;
  if exists (
    select 1 from public.attendance_confirmations c
    where c.attendance_date=v_date and c.shift_code=v_shift
      and ((v_client is not null and c.client_id=v_client)
           or (v_client is null and v_cat is not null and c.category=v_cat))
  ) then
    raise exception 'This shift is confirmed and the month has ended — locked. Edit it via Override on the Monthly Board.';
  end if;
  return case when TG_OP='DELETE' then OLD else NEW end;
end;
$function$
-- ===END 26674
-- ===FUNC 26719 purge_attendance_after_separation()
CREATE OR REPLACE FUNCTION public.purge_attendance_after_separation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare cutoff date;
begin
  cutoff := least(
    coalesce(new.last_working_day, 'infinity'::date),
    coalesce(new.termination_date - 1, 'infinity'::date)
  );
  if cutoff = 'infinity'::date then return new; end if;
  if coalesce(old.last_working_day,'infinity'::date) = coalesce(new.last_working_day,'infinity'::date)
     and coalesce(old.termination_date,'infinity'::date) = coalesce(new.termination_date,'infinity'::date)
  then return new; end if;

  delete from attendance_records a
  where a.employee_id = new.id
    and a.attendance_date > cutoff
    and not exists (select 1 from accounting_periods ap
                    where ap.company_id = new.company_id
                      and ap.period_month = date_trunc('month', a.attendance_date)::date)
    and not exists (select 1 from attendance_month_verifications v
                    where v.period_month = date_trunc('month', a.attendance_date)::date
                      and (v.client_id = new.client_id
                           or (v.category is not null and v.category = new.category::text)));
  return new;
end $function$
-- ===END 26719
-- ===FUNC 26734 renew_contract(p_contract_id uuid, p_start_date date, p_end_date date, p_is_infinite boolean)
CREATE OR REPLACE FUNCTION public.renew_contract(p_contract_id uuid, p_start_date date, p_end_date date DEFAULT NULL::date, p_is_infinite boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  src public.contracts%rowtype;
  new_id uuid;
begin
  select * into src from public.contracts where id = p_contract_id;
  if src.id is null then
    raise exception 'Contract not found' using errcode = '23503';
  end if;

  if p_start_date is null then
    raise exception 'A renewal needs a start date' using errcode = '23514';
  end if;
  if not coalesce(p_is_infinite, false) and p_end_date is null then
    raise exception 'A renewal needs an end date, or must be marked open-ended'
      using errcode = '23514';
  end if;
  if not coalesce(p_is_infinite, false) and p_end_date < p_start_date then
    raise exception 'The renewal end date cannot be before its start date'
      using errcode = '23514';
  end if;

  insert into public.contracts (
    company_id, client_id, contract_type,
    start_date, end_date, is_infinite,
    number_of_guards, shift_pattern, rate_per_guard_per_month,
    allowed_leaves_per_month, eobi_deduction, eobi_amount,
    annual_escalation_pct, auto_invoice_enabled, renewal_terms,
    day_guards, night_guards, evening_guards, guard_rates,
    notice_period_days, status
  ) values (
    src.company_id, src.client_id, src.contract_type,
    p_start_date,
    case when coalesce(p_is_infinite, false) then null else p_end_date end,
    coalesce(p_is_infinite, false),
    src.number_of_guards, src.shift_pattern, src.rate_per_guard_per_month,
    src.allowed_leaves_per_month, src.eobi_deduction, src.eobi_amount,
    src.annual_escalation_pct, src.auto_invoice_enabled, src.renewal_terms,
    src.day_guards, src.night_guards, src.evening_guards, src.guard_rates,
    src.notice_period_days, 'active'
  )
  returning id into new_id;

  -- required_on_ground is a generated column: it recomputes itself and must not
  -- be written to explicitly.
  insert into public.contract_lines (
    company_id, contract_id, category, label, location,
    committed_count, unit_rate, cost_components, taxable,
    site_id, shift_code, billed_qty, relief_allowance,
    relief_mode, billing_rate, client_ot_rate,
    effective_from, effective_to
  )
  select
    l.company_id, new_id, l.category, l.label, l.location,
    l.committed_count, l.unit_rate, l.cost_components, l.taxable,
    l.site_id, l.shift_code, l.billed_qty, l.relief_allowance,
    l.relief_mode, l.billing_rate, l.client_ot_rate,
    l.effective_from, l.effective_to
  from public.contract_lines l
  where l.contract_id = p_contract_id;

  update public.contracts set status = 'expired' where id = p_contract_id;
  update public.employees set contract_id = new_id where contract_id = p_contract_id;

  return new_id;
end $function$
-- ===END 26734
-- ===FUNC 27046 partner_client_breakdown(p_partner_id uuid, p_start date, p_end date)
CREATE OR REPLACE FUNCTION public.partner_client_breakdown(p_partner_id uuid, p_start date, p_end date)
 RETURNS TABLE(client_id uuid, client_name text, client_code text, basis text, client_net numeric, share_percent numeric, is_override boolean, amount numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with cfg as (select public.partner_basis_for_report(null) as basis),
  p as (
    select id, branch_id, profit_share_percent, scope
      from public.partners
     where id = p_partner_id
  ),
  cs as (
    select s.client_id, s.client_name, s.client_code, s.branch_id, s.net
      from p, cfg, lateral public.client_statement_loaded(p_start, p_end, cfg.basis) s
     where p.scope = 'BRANCH' and s.branch_id = p.branch_id
  )
  select cs.client_id, cs.client_name, cs.client_code,
         cfg.basis,
         cs.net,
         coalesce(o.share_percent, p.profit_share_percent) as share_percent,
         (o.share_percent is not null) as is_override,
         round(cs.net * coalesce(o.share_percent, p.profit_share_percent) / 100, 2) as amount
    from cs
    cross join p
    cross join cfg
    left join lateral (
      select s.share_percent
        from public.partner_client_shares s
       where s.partner_id = p.id and s.client_id = cs.client_id
         and s.effective_month <= p_start
       order by s.effective_month desc
       limit 1
    ) o on true
   order by cs.client_name;
$function$
-- ===END 27046
-- ===FUNC 27050 partner_ledger(p_partner_id uuid, p_start date, p_end date)
CREATE OR REPLACE FUNCTION public.partner_ledger(p_partner_id uuid, p_start date DEFAULT NULL::date, p_end date DEFAULT NULL::date)
 RETURNS TABLE(entry_date date, particulars text, cash_paid numeric, remuneration numeric, balance numeric, source text, entry_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_opening numeric; v_from date; v_to date; v_coa uuid; v_company uuid; v_pstart date;
begin
  select coalesce(pr.opening_balance, 0),
         coalesce(p_start, pr.opening_balance_date, pr.start_month, date_trunc('month', now())::date),
         coalesce(p_end, (date_trunc('month', now()) + interval '1 month - 1 day')::date),
         pr.coa_account_id, pr.company_id,
         coalesce(pr.opening_balance_date, pr.start_month)
    into v_opening, v_from, v_to, v_coa, v_company, v_pstart
    from public.partners pr where pr.id = p_partner_id;
  if v_opening is null then return; end if;
  return query
  with ploc as (
    select id from public.cash_locations
     where custodian_partner_id = p_partner_id and coalesce(company_id, v_company) = v_company
  ),
  months as (
    select generate_series(
             greatest(date_trunc('month', v_from),
                      date_trunc('month', coalesce(v_pstart, (now() - interval '24 months')::date))),
             least(date_trunc('month', v_to), date_trunc('month', now())),
             interval '1 month')::date as m
  ),
  remun as (
    select (m + interval '1 month - 1 day')::date as x_date,
           'BAL TILL ' || upper(to_char(m, 'DDth "OF" MON YYYY')) as x_part, 0::numeric as x_cash,
           coalesce((select a.amount from public.partnership_allocation(
               m, (m + interval '1 month - 1 day')::date, 'revenue') a
              where a.partner_id = p_partner_id limit 1), 0) as x_remun,
           'ALLOCATION'::text as x_src, null::uuid as x_eid
      from months
  ),
  cash as (
    select e.date as x_date,
           case e.payment_method when 'FUEL_CARD' then 'FUEL CARD' when 'BANK_TRANSFER' then 'BANK TRANSFER'
             when 'CHEQUE' then 'CHEQUE' else 'CASH PAID' end
           || case when e.description is null or e.description = '' then '' else ' — ' || e.description end as x_part,
           case when e.type = 'CONTRIBUTION' then -e.amount else e.amount end as x_cash,
           0::numeric as x_remun, e.type as x_src, e.id as x_eid
      from public.partner_account_entries e
     where e.partner_id = p_partner_id and e.type in ('DRAWING','CONTRIBUTION')
       and e.date between v_from and v_to
  ),
  other as (
    select je.entry_date as x_date,
           coalesce(nullif(je.description, ''), initcap(replace(coalesce(je.source_table, 'manual'), '_', ' '))) as x_part,
           (coalesce(jl.debit, 0) - coalesce(jl.credit, 0)) as x_cash,
           0::numeric as x_remun, 'GL:' || upper(coalesce(je.source_table, 'MANUAL')) as x_src, null::uuid as x_eid
      from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_entry_id
     where v_coa is not null and jl.account_id = v_coa
       and coalesce(je.source_table, '') <> 'partner_account_entries'
       and je.entry_date between v_from and v_to
  ),
  custody as (
    select ip.payment_date::date, 'CLIENT CASH — ' || coalesce(c.name, 'client'),
           -ip.amount, 0::numeric, 'CUSTODY:CLIENT_CASH'::text, null::uuid
      from public.invoice_payments ip join ploc on ploc.id = ip.custodian_location_id
      left join public.clients c on c.id = ip.client_id
     where ip.payment_date between v_from and v_to
    union all
    select e.expense_date::date, 'EXPENSE — ' || coalesce(nullif(e.description,''), 'expense'),
           e.amount, 0::numeric, 'CUSTODY:EXPENSE'::text, null::uuid
      from public.expenses e join ploc on ploc.id = e.custodian_location_id
     where e.expense_date between v_from and v_to
    union all
    select a.advance_date::date, 'ADVANCE', a.amount, 0::numeric, 'CUSTODY:ADVANCE'::text, null::uuid
      from public.advances a join ploc on ploc.id = a.custodian_location_id
     where a.advance_date between v_from and v_to
    union all
    select ch.cheque_date::date, 'CHEQUE #' || coalesce(ch.cheque_number,''),
           -ch.amount, 0::numeric, 'CUSTODY:CHEQUE'::text, null::uuid
      from public.cheques ch join ploc on ploc.id = ch.custodian_location_id
     where ch.cheque_type = 'cash' and ch.status = 'cleared' and ch.cheque_date between v_from and v_to
    union all
    select t.date::date, 'TRANSFER IN', -t.amount, 0::numeric, 'CUSTODY:TRANSFER_IN'::text, null::uuid
      from public.custody_transfers t join ploc on ploc.id = t.to_location_id where t.date between v_from and v_to
    union all
    select t.date::date, 'TRANSFER OUT', t.amount, 0::numeric, 'CUSTODY:TRANSFER_OUT'::text, null::uuid
      from public.custody_transfers t join ploc on ploc.id = t.from_location_id where t.date between v_from and v_to
    union all
    select bt.created_at::date, coalesce(nullif(bt.description,''), 'Bank / cash movement'),
           -bt.cash_delta, 0::numeric, 'CUSTODY:BANK'::text, null::uuid
      from public.bank_transactions bt join ploc on ploc.id::text = bt.reference_id
     where bt.kind in ('withdraw_to_cash','payroll') and bt.created_at::date between v_from and v_to
  ),
  pbank as (
    select bt.created_at::date,
           upper(bt.kind) || case when bt.description is null or bt.description = '' then '' else ' — ' || bt.description end
             || ' (' || ba.bank_name || ')',
           -bt.account_delta, 0::numeric, 'BANK:' || upper(bt.kind), null::uuid
      from public.bank_accounts ba join public.bank_transactions bt on bt.bank_account_id = ba.id
     where ba.owner_partner_id = p_partner_id
  ),
  merged as (
    select x_date, x_part, x_cash, x_remun, x_src, x_eid from remun where x_remun <> 0
    union all select x_date, x_part, x_cash, x_remun, x_src, x_eid from cash
    union all select x_date, x_part, x_cash, x_remun, x_src, x_eid from other
    union all select * from custody
    union all select * from pbank
  ),
  ordered as ( select m.*, row_number() over (order by m.x_date, m.x_src desc) as rn from merged m )
  select o.x_date, o.x_part, o.x_cash, o.x_remun,
         v_opening + sum(o.x_remun - o.x_cash) over (order by o.rn rows between unbounded preceding and current row),
         o.x_src, o.x_eid
    from ordered o order by o.rn;
end $function$
-- ===END 27050
-- ===FUNC 27191 enforce_journal_immutable()
CREATE OR REPLACE FUNCTION public.enforce_journal_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if public.is_maintenance_session() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception
    'Posted journal rows are immutable. Reverse the entry instead, or run under a maintenance session.'
    using errcode = '23514';
end;
$function$
-- ===END 27191
-- ===FUNC 27195 ledger_checks(p_company_id uuid)
CREATE OR REPLACE FUNCTION public.ledger_checks(p_company_id uuid)
 RETURNS TABLE(check_name text, expected numeric, actual numeric, difference numeric, passed boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with tb as (
    select coalesce(sum(jl.debit), 0) dr, coalesce(sum(jl.credit), 0) cr
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
     where je.company_id = p_company_id
  ),
  onesided as (
    select count(*)::numeric n
      from public.journal_entries je
      join lateral (
        select coalesce(sum(debit), 0) dr, coalesce(sum(credit), 0) cr
          from public.journal_lines where journal_entry_id = je.id
      ) x on true
     where je.company_id = p_company_id and x.dr <> x.cr
  ),
  bal as (
    select a.system_key, coalesce(sum(jl.debit - jl.credit), 0) net
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.company_id = p_company_id
     group by a.system_key
  ),
  ar_sub as (
    select coalesce((select sum(i.invoice_amount) from public.invoices i
                      where i.company_id = p_company_id
                        and coalesce(i.status, '') <> 'Written-Off'), 0)
         - coalesce((select sum(p.amount + coalesce(p.withholding_amount, 0))
                       from public.invoice_payments p
                      where p.company_id = p_company_id), 0) bal
  ),
  adv_sub as (
    select coalesce((select sum(a.amount) from public.advances a
                      where a.company_id = p_company_id), 0)
         - coalesce((select sum(ps.advance) from public.payslips ps
                      where ps.company_id = p_company_id), 0) bal
  ),
  wht_sub as (
    select coalesce((select sum(coalesce(p.withholding_amount, 0))
                       from public.invoice_payments p
                      where p.company_id = p_company_id), 0) bal
  ),
  payroll_owed as (
    select coalesce(sum(ps.net_salary) filter (where not ps.disbursed), 0) owed
      from public.payslips ps where ps.company_id = p_company_id
  ),
  ho_clients as (
    select count(distinct i.client_id)::numeric n
      from public.invoices i
      join public.branches b on b.id = i.branch_id
     where i.company_id = p_company_id and b.is_head_office
  ),
  gate_residue as (
    select count(*)::numeric n from public.attendance_records a
     where a.company_id = p_company_id and a.status = 'blocked'
  )
  select 'trial_balance_debits_equal_credits'::text, tb.dr, tb.cr, tb.dr - tb.cr, tb.dr = tb.cr from tb
  union all
  select 'no_one_sided_entries', 0, onesided.n, onesided.n, onesided.n = 0 from onesided
  union all
  select 'ar_control_equals_open_invoices', ar_sub.bal,
         coalesce((select net from bal where system_key = 'ar'), 0),
         coalesce((select net from bal where system_key = 'ar'), 0) - ar_sub.bal,
         coalesce((select net from bal where system_key = 'ar'), 0) = ar_sub.bal
    from ar_sub
  union all
  select 'employee_advances_control_not_in_client_ar', adv_sub.bal,
         coalesce((select net from bal where system_key = 'employee_advances_receivable'), 0),
         coalesce((select net from bal where system_key = 'employee_advances_receivable'), 0) - adv_sub.bal,
         coalesce((select net from bal where system_key = 'employee_advances_receivable'), 0) = adv_sub.bal
    from adv_sub
  union all
  select 'wht_receivable_equals_deductions_less_cprs', wht_sub.bal,
         coalesce((select net from bal where system_key = 'wht_receivable'), 0),
         coalesce((select net from bal where system_key = 'wht_receivable'), 0) - wht_sub.bal,
         coalesce((select net from bal where system_key = 'wht_receivable'), 0) = wht_sub.bal
    from wht_sub
  union all
  select 'salaries_payable_equals_undisbursed_net_pay', payroll_owed.owed,
         coalesce((select -net from bal where system_key = 'salaries_payable'), 0),
         coalesce((select -net from bal where system_key = 'salaries_payable'), 0) - payroll_owed.owed,
         coalesce((select -net from bal where system_key = 'salaries_payable'), 0) = payroll_owed.owed
    from payroll_owed
  union all
  select 'no_billing_clients_on_head_office', 0, ho_clients.n, ho_clients.n, ho_clients.n = 0
    from ho_clients
  union all
  select 'no_gate_mode_in_attendance_status', 0, gate_residue.n, gate_residue.n, gate_residue.n = 0
    from gate_residue;
$function$
-- ===END 27195
-- ===FUNC 27241 post_journal(p_company_id uuid, p_date date, p_description text, p_source_table text, p_source_id uuid, p_is_reversal boolean, p_lines jsonb, p_region_id uuid, p_manual boolean)
CREATE OR REPLACE FUNCTION public.post_journal(p_company_id uuid, p_date date, p_description text, p_source_table text, p_source_id uuid, p_is_reversal boolean, p_lines jsonb, p_region_id uuid DEFAULT NULL::uuid, p_manual boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_entry_id uuid;
  v_line     jsonb;
  v_acct_id  uuid;
  v_key      text;
  v_debit    numeric;
  v_credit   numeric;
  v_region   uuid;
  v_any      boolean := false;
  v_user     uuid;
  v_dr_total numeric := 0;
  v_cr_total numeric := 0;
begin
  begin v_user := auth.uid(); exception when others then v_user := null; end;

  p_region_id := coalesce(p_region_id, public.head_office_region(p_company_id));
  v_entry_id := gen_random_uuid();

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_debit  := coalesce((v_line->>'debit')::numeric, 0);
    v_credit := coalesce((v_line->>'credit')::numeric, 0);

    if v_debit = 0 and v_credit = 0 then continue; end if;

    v_key := v_line->>'key';
    v_acct_id := coalesce(
      nullif(v_line->>'account_id', '')::uuid,
      public.coa_id(p_company_id, v_key)
    );

    if v_acct_id is null then
      raise exception
        'post_journal: cannot resolve account for company % (system_key=%, source=%/%). Seed the chart of accounts.',
        p_company_id, coalesce(v_key, '<null>'), p_source_table, p_source_id
        using errcode = '23503';
    end if;

    v_region := coalesce(nullif(v_line->>'region', '')::uuid, p_region_id);

    if not v_any then
      insert into public.journal_entries
        (id, company_id, entry_date, description, source_table, source_id,
         is_reversal, manual, posted_by, status, posting_period)
      values
        (v_entry_id, p_company_id, p_date, p_description, p_source_table, p_source_id,
         p_is_reversal, coalesce(p_manual, false), v_user, 'posted',
         date_trunc('month', p_date)::date);
      v_any := true;
    end if;

    insert into public.journal_lines
      (journal_entry_id, account_id, debit, credit, branch_id,
       client_id, employee_id, partner_id, contract_id, cost_center)
    values
      (v_entry_id, v_acct_id, v_debit, v_credit, v_region,
       nullif(v_line->>'client_id',   '')::uuid,
       nullif(v_line->>'employee_id', '')::uuid,
       nullif(v_line->>'partner_id',  '')::uuid,
       nullif(v_line->>'contract_id', '')::uuid,
       nullif(v_line->>'cost_center', ''));

    v_dr_total := v_dr_total + v_debit;
    v_cr_total := v_cr_total + v_credit;
  end loop;

  if not v_any then return null; end if;

  if v_dr_total <> v_cr_total then
    raise exception
      'post_journal: entry does not balance (debits % <> credits %) for source %/%',
      v_dr_total, v_cr_total, p_source_table, p_source_id
      using errcode = '23514';
  end if;

  return v_entry_id;
end;
$function$
-- ===END 27241
-- ===FUNC 27242 post_manual_journal(p_entry_date date, p_description text, p_debit_account_id uuid, p_credit_account_id uuid, p_amount numeric, p_branch_id uuid)
CREATE OR REPLACE FUNCTION public.post_manual_journal(p_entry_date date, p_description text, p_debit_account_id uuid, p_credit_account_id uuid, p_amount numeric, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_company uuid := public.current_company_id();
begin
  if v_company is null then
    raise exception 'Not authorised for any company';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Amount must be greater than zero';
  end if;
  if p_debit_account_id is null or p_credit_account_id is null then
    raise exception 'Select both a debit and a credit account';
  end if;
  if p_debit_account_id = p_credit_account_id then
    raise exception 'Debit and credit accounts must differ';
  end if;

  perform 1 from public.chart_of_accounts
   where id in (p_debit_account_id, p_credit_account_id)
     and company_id = v_company
  having count(*) = 2;
  if not found then
    raise exception 'Account not found for this company';
  end if;

  return public.post_journal(
    v_company, p_entry_date,
    coalesce(nullif(btrim(p_description), ''), 'Manual adjustment'),
    null, null, false,
    jsonb_build_array(
      jsonb_build_object('account_id', p_debit_account_id,  'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_credit_account_id, 'debit', 0,        'credit', p_amount)
    ),
    p_branch_id,
    true);
end;
$function$
-- ===END 27242
-- ===FUNC 27246 record_invoice_payment(p_invoice_id uuid, p_amount numeric, p_payment_date date, p_payment_mode text, p_bank_account_id uuid, p_notes text, p_withholding numeric)
CREATE OR REPLACE FUNCTION public.record_invoice_payment(p_invoice_id uuid, p_amount numeric, p_payment_date date, p_payment_mode text, p_bank_account_id uuid, p_notes text, p_withholding numeric DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company        uuid;
  v_client         uuid;
  v_caller_company uuid := public.current_company_id();
  v_total          numeric := 0;
  v_wht_total      numeric := 0;
  v_wht            numeric := coalesce(p_withholding, 0);
  v_first_pay      uuid;
  v_pay_id         uuid;
  v_touched        int := 0;
  v_client_name    text;
  v_desc           text;
  v_wht_share      numeric;
  rec              record;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Payment amount must be greater than zero';
  end if;
  if p_payment_mode not in ('Cash', 'Bank') then
    raise exception 'Invalid payment mode';
  end if;
  if p_payment_date is null then
    raise exception 'Payment date is required';
  end if;
  if v_wht < 0 then
    raise exception 'Withholding amount cannot be negative';
  end if;

  select company_id, client_id into v_company, v_client
  from public.invoices where id = p_invoice_id;
  if v_company is null then
    raise exception 'Invoice not found';
  end if;
  if v_caller_company is distinct from v_company then
    raise exception 'Not authorised for this company';
  end if;

  if p_payment_mode = 'Bank' then
    if p_bank_account_id is null then
      raise exception 'Select a bank account for Bank payments';
    end if;
    perform 1 from public.bank_accounts where id = p_bank_account_id and company_id = v_company;
    if not found then
      raise exception 'Bank account not found for this company';
    end if;
  end if;

  for rec in
    with u as (
      select i.id,
             (i.invoice_amount - i.amount_received) as outstanding,
             row_number() over (order by i.invoice_date, i.invoice_number) as rn,
             count(*) over () as n,
             coalesce(sum(i.invoice_amount - i.amount_received)
                        over (order by i.invoice_date, i.invoice_number
                              rows between unbounded preceding and 1 preceding), 0) as cum_before
      from public.invoices i
      where i.client_id = v_client
        and (i.invoice_amount - i.amount_received) > 0.0001
    )
    select id,
           case when rn = n then (p_amount + v_wht - cum_before)
                else greatest(0, least(outstanding, p_amount + v_wht - cum_before)) end as settle
    from u
    order by rn
  loop
    continue when rec.settle <= 0.0001;
    v_wht_share := case when (p_amount + v_wht) > 0
                        then round(rec.settle * v_wht / (p_amount + v_wht), 2) else 0 end;

    insert into public.invoice_payments
      (company_id, invoice_id, amount, withholding_amount, payment_date,
       payment_mode, bank_account_id, notes)
    values
      (v_company, rec.id, rec.settle - v_wht_share, v_wht_share, p_payment_date,
       p_payment_mode, p_bank_account_id, nullif(btrim(p_notes), ''))
    returning id into v_pay_id;

    if v_first_pay is null then v_first_pay := v_pay_id; end if;

    update public.invoices
      set amount_received = amount_received + rec.settle, updated_at = now()
      where id = rec.id;

    v_total     := v_total + (rec.settle - v_wht_share);
    v_wht_total := v_wht_total + v_wht_share;
    v_touched   := v_touched + 1;
  end loop;

  if v_touched = 0 then
    insert into public.invoice_payments
      (company_id, invoice_id, amount, withholding_amount, payment_date,
       payment_mode, bank_account_id, notes)
    values
      (v_company, p_invoice_id, p_amount, v_wht, p_payment_date,
       p_payment_mode, p_bank_account_id, nullif(btrim(p_notes), ''))
    returning id into v_pay_id;
    v_first_pay := v_pay_id;
    update public.invoices
      set amount_received = amount_received + p_amount + v_wht, updated_at = now()
      where id = p_invoice_id;
    v_total     := p_amount;
    v_wht_total := v_wht;
    v_touched   := 1;
  end if;

  if p_payment_mode = 'Bank' then
    update public.bank_accounts set balance = balance + v_total, updated_at = now()
      where id = p_bank_account_id;
  else
    update public.treasury set cash_balance = cash_balance + v_total, updated_at = now()
      where company_id = v_company;
    if not found then
      insert into public.treasury (company_id, cash_balance) values (v_company, v_total);
    end if;
  end if;

  select name into v_client_name from public.clients where id = v_client;
  v_desc := 'Payment received (' || lower(p_payment_mode) || ') · '
            || coalesce(v_client_name, 'Client') || ' · '
            || v_touched || ' invoice' || case when v_touched = 1 then '' else 's' end
            || ' (oldest first)'
            || case when v_wht_total > 0 then ' · WHT ' || v_wht_total else '' end;

  insert into public.bank_transactions
    (company_id, bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
  values
    (v_company, p_bank_account_id, 'receipt', v_total,
     case when p_payment_mode = 'Cash' then v_total else 0 end,
     case when p_payment_mode = 'Bank' then v_total else 0 end,
     v_desc, v_first_pay::text);

  return jsonb_build_object(
    'total_applied', v_total,
    'withholding_applied', v_wht_total,
    'invoices_touched', v_touched);
end;
$function$
-- ===END 27246
-- ===FUNC 27248 journal_on_expense_settlement()
CREATE OR REPLACE FUNCTION public.journal_on_expense_settlement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_date     date;
  v_cr       jsonb;
  v_was_paid boolean := coalesce(old.payable_status, '') = 'Paid';
  v_is_paid  boolean := coalesce(new.payable_status, '') = 'Paid';
begin
  if coalesce(new.payment_mode, '') <> 'Payable' then
    return new;
  end if;

  if v_was_paid and not v_is_paid then
    perform public.reverse_journal_for_source(
      old.company_id, 'expense_settlements', old.id,
      coalesce(old.paid_at::date, old.expense_date));
    return new;
  end if;

  if not v_is_paid or v_was_paid then
    return new;
  end if;

  v_date := coalesce(new.paid_at::date, current_date);

  v_cr := case
    when coalesce(new.paid_via, '') = 'Cash' then jsonb_build_object(
      'account_id', public.cash_account_for(new.company_id, new.cash_location_id),
      'debit', 0, 'credit', new.amount)
    else jsonb_build_object('key', 'bank', 'debit', 0, 'credit', new.amount)
  end;

  perform public.post_journal(
    new.company_id, v_date,
    'Payable settled' || coalesce(' — ' || new.description, ''),
    'expense_settlements', new.id, false,
    jsonb_build_array(
      jsonb_build_object('key', 'ap', 'debit', new.amount, 'credit', 0,
                         'client_id', new.client_id)
    ) || jsonb_build_array(v_cr),
    new.branch_id
  );
  return new;
end;
$function$
-- ===END 27248
-- ===FUNC 27250 journal_on_cheque()
CREATE OR REPLACE FUNCTION public.journal_on_cheque()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_acct   uuid;
  v_branch uuid;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'cheques', old.id, old.cheque_date);
    return old;
  end if;

  if new.direction <> 'outgoing' or new.cheque_type <> 'cash' then
    return new;
  end if;

  if old.status = 'cleared' and new.status <> 'cleared' then
    perform public.reverse_journal_for_source(new.company_id, 'cheques', new.id, old.cheque_date);
    return new;
  end if;

  if new.status <> 'cleared' or old.status = 'cleared' then
    return new;
  end if;

  select coa_account_id, branch_id into v_acct, v_branch
    from public.cash_locations where id = new.custodian_location_id;
  if v_acct is null then
    v_acct := public.cash_account_for(new.company_id, new.custodian_location_id);
  end if;

  perform public.post_journal(
    new.company_id, new.cheque_date,
    'Cash cheque #' || coalesce(new.cheque_number, '') || ' cleared to custodian',
    'cheques', new.id, false,
    jsonb_build_array(
      jsonb_build_object('account_id', v_acct, 'debit', new.amount, 'credit', 0),
      jsonb_build_object('key',       'bank',  'debit', 0,          'credit', new.amount)
    ),
    coalesce(v_branch, new.branch_id));
  return new;
end;
$function$
-- ===END 27250
-- ===FUNC 27255 post_payslip_accrual(p_id uuid)
CREATE OR REPLACE FUNCTION public.post_payslip_accrual(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  ps        record;
  v_cat     text;
  v_key     text;
  v_lines   jsonb := '[]'::jsonb;
  v_emp     jsonb;
  sp        record;
  v_rows    int;
  v_i       int := 0;
  v_alloc   numeric;
  v_running numeric := 0;
begin
  select * into ps from public.payslips where id = p_id;
  if not found then return; end if;

  select e.category into v_cat from public.employees e where e.id = ps.employee_id;
  v_key := case when v_cat = 'office_staff' then 'opex_office_payroll' else 'cos_payroll' end;
  v_emp := jsonb_build_object('employee_id', ps.employee_id);

  select count(*) into v_rows from public.payslip_client_split(p_id);

  if coalesce(ps.final_salary, 0) <> 0 and v_rows > 0 then
    for sp in select * from public.payslip_client_split(p_id)
               order by weight desc, client_id nulls last
    loop
      v_i := v_i + 1;
      if v_i = v_rows then
        v_alloc := ps.final_salary - v_running;
      else
        v_alloc := round(ps.final_salary * sp.weight, 2);
        v_running := v_running + v_alloc;
      end if;
      if v_alloc <> 0 then
        v_lines := v_lines || jsonb_build_array(
          v_emp || jsonb_build_object('key', v_key, 'debit', v_alloc, 'credit', 0,
                                      'client_id', sp.client_id));
      end if;
    end loop;
  end if;

  v_lines := v_lines || jsonb_build_array(
    v_emp || jsonb_build_object('key', 'salaries_payable', 'debit', 0, 'credit', ps.final_salary));

  if coalesce(ps.eobi_employer, 0) > 0 then
    v_i := 0; v_running := 0;
    for sp in select * from public.payslip_client_split(p_id)
               order by weight desc, client_id nulls last
    loop
      v_i := v_i + 1;
      if v_i = v_rows then
        v_alloc := ps.eobi_employer - v_running;
      else
        v_alloc := round(ps.eobi_employer * sp.weight, 2);
        v_running := v_running + v_alloc;
      end if;
      if v_alloc <> 0 then
        v_lines := v_lines || jsonb_build_array(
          v_emp || jsonb_build_object('key', 'cos_statutory', 'debit', v_alloc, 'credit', 0,
                                      'client_id', sp.client_id));
      end if;
    end loop;
    v_lines := v_lines || jsonb_build_array(
      v_emp || jsonb_build_object('key', 'eobi_payable', 'debit', 0, 'credit', ps.eobi_employer));
  end if;

  if coalesce(ps.advance, 0) > 0 then
    v_lines := v_lines || jsonb_build_array(
      v_emp || jsonb_build_object('key', 'salaries_payable', 'debit', ps.advance, 'credit', 0),
      v_emp || jsonb_build_object('key', 'employee_advances_receivable', 'debit', 0, 'credit', ps.advance));
  end if;

  if coalesce(ps.eobi, 0) > 0 then
    v_lines := v_lines || jsonb_build_array(
      v_emp || jsonb_build_object('key', 'salaries_payable', 'debit', ps.eobi, 'credit', 0),
      v_emp || jsonb_build_object('key', 'eobi_payable',     'debit', 0, 'credit', ps.eobi));
  end if;

  if coalesce(ps.income_tax, 0) > 0 then
    v_lines := v_lines || jsonb_build_array(
      v_emp || jsonb_build_object('key', 'salaries_payable',   'debit', ps.income_tax, 'credit', 0),
      v_emp || jsonb_build_object('key', 'salary_tax_payable', 'debit', 0, 'credit', ps.income_tax));
  end if;

  perform public.post_journal(
    ps.company_id, ps.period_month,
    'Payroll accrual — ' || left(ps.period_month::text, 7),
    'payslips', ps.id, false, v_lines, ps.branch_id);
end;
$function$
-- ===END 27255
-- ===FUNC 27256 post_payslip_disbursement(p_id uuid)
CREATE OR REPLACE FUNCTION public.post_payslip_disbursement(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  ps       record;
  v_client uuid;
  v_date   date;
  v_cr     jsonb;
  v_dim    jsonb;
begin
  select * into ps from public.payslips where id = p_id;
  if not found or not ps.disbursed or coalesce(ps.net_salary, 0) = 0 then return; end if;

  select e.client_id into v_client from public.employees e where e.id = ps.employee_id;
  v_dim := jsonb_build_object('employee_id', ps.employee_id, 'client_id', v_client);

  v_date := case
    when ps.payment_mode = 'Cheque'
      then coalesce((select ch.cleared_at::date from public.cheques ch
                      where ch.id = ps.cheque_id and ch.status = 'cleared'),
                    ps.disbursed_at::date, ps.period_month)
    else coalesce(ps.disbursed_at::date, ps.period_month)
  end;

  v_cr := case
    when ps.payment_mode = 'Cash' then jsonb_build_object(
      'account_id', public.cash_account_for(ps.company_id, ps.cash_location_id),
      'debit', 0, 'credit', ps.net_salary)
    else jsonb_build_object('key', 'bank', 'debit', 0, 'credit', ps.net_salary)
  end;

  perform public.post_journal(
    ps.company_id, v_date,
    'Payroll disbursed — ' || left(ps.period_month::text, 7),
    'payslips_disbursement', ps.id, false,
    jsonb_build_array(
      v_dim || jsonb_build_object('key', 'salaries_payable', 'debit', ps.net_salary, 'credit', 0)
    ) || jsonb_build_array(v_dim || v_cr),
    ps.branch_id);
end;
$function$
-- ===END 27256
-- ===FUNC 27259 payslip_client_split(p_id uuid)
CREATE OR REPLACE FUNCTION public.payslip_client_split(p_id uuid)
 RETURNS TABLE(client_id uuid, weight numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with ps as (
    select p.employee_id, p.period_month, e.client_id as fallback
      from public.payslips p
      join public.employees e on e.id = p.employee_id
     where p.id = p_id
  ),
  days as (
    select coalesce(a.worked_for_client_id, ps.fallback) as cid, count(*)::numeric as d
      from ps
      join public.attendance_records a on a.employee_id = ps.employee_id
       and a.attendance_date >= ps.period_month
       and a.attendance_date <  (ps.period_month + interval '1 month')
       and lower(a.status) in ('present', 'double_duty', 'relief_cover')
     group by 1
  ),
  tot as (select coalesce(sum(d), 0) as t from days)
  select days.cid, days.d / tot.t
    from days cross join tot where tot.t > 0
  union all
  select ps.fallback, 1::numeric
    from ps cross join tot where tot.t = 0;
$function$
-- ===END 27259
-- ===FUNC 27260 repost_payslip_accruals_for_month(p_company_id uuid, p_period_month date)
CREATE OR REPLACE FUNCTION public.repost_payslip_accruals_for_month(p_company_id uuid, p_period_month date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare p record; v_n integer := 0;
begin
  for p in select id from public.payslips
            where company_id = p_company_id and period_month = p_period_month
  loop
    perform public.reverse_journal_for_source(p_company_id, 'payslips', p.id, p_period_month);
    perform public.post_payslip_accrual(p.id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$function$
-- ===END 27260
-- ===FUNC 27261 ledger_payroll_by_client(p_company_id uuid, p_period_month date)
CREATE OR REPLACE FUNCTION public.ledger_payroll_by_client(p_company_id uuid, p_period_month date)
 RETURNS TABLE(client_id uuid, cost numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select jl.client_id, round(sum(jl.debit - jl.credit), 2)
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.journal_entry_id
    join public.chart_of_accounts a on a.id = jl.account_id
   where je.company_id = p_company_id
     and je.source_table = 'payslips'
     and je.status = 'posted'
     and je.posting_period = date_trunc('month', p_period_month)::date
     and a.system_key in ('cos_payroll', 'opex_office_payroll')
     and jl.client_id is not null
   group by jl.client_id;
$function$
-- ===END 27261
-- ===FUNC 27300 attendance_billing_suggestion(p_client_id uuid, p_period_start date, p_period_end date)
CREATE OR REPLACE FUNCTION public.attendance_billing_suggestion(p_client_id uuid, p_period_start date, p_period_end date)
 RETURNS TABLE(guard_days integer, standard_days integer, contract_rate numeric, suggested numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with days as (select (p_period_end - p_period_start + 1)::int as std),
  present as (
    select count(*)::int as gd from public.attendance_records a
     where a.worked_for_client_id = p_client_id
       and a.attendance_date between p_period_start and p_period_end
       and lower(a.status) = 'present'
  ),
  rate as (
    select coalesce(max(ct.rate_per_guard_per_month), 0) as r from public.contracts ct
     where ct.client_id = p_client_id and coalesce(ct.status::text,'active') = 'active'
  )
  select present.gd, days.std, rate.r,
         round(rate.r * present.gd / nullif(days.std,0), 2)
    from present, days, rate;
$function$
-- ===END 27300
-- ===FUNC 27301 attendance_leave_history(p_window_start date, p_until date)
CREATE OR REPLACE FUNCTION public.attendance_leave_history(p_window_start date, p_until date)
 RETURNS TABLE(employee_id uuid, month_key text, cnt integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select employee_id,
         to_char(date_trunc('month', attendance_date), 'YYYY-MM-DD') as month_key,
         count(*)::int as cnt
  from public.attendance_records
  where lower(status) in ('leave', 'rotation_leave', 'rest_day')
    and attendance_date >= p_window_start
    and attendance_date < p_until
  group by employee_id, date_trunc('month', attendance_date)
$function$
-- ===END 27301
-- ===FUNC 27310 branch_revenue_for_month(p_company_id uuid, p_branch_id uuid, p_period date, p_basis text)
CREATE OR REPLACE FUNCTION public.branch_revenue_for_month(p_company_id uuid, p_branch_id uuid, p_period date, p_basis text DEFAULT 'revenue'::text)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(
    case when lower(coalesce(p_basis, 'revenue')) = 'cash' then
      (select sum(pay.amount)
         from public.invoice_payments pay
         join public.invoices i on i.id = pay.invoice_id
        where i.company_id = p_company_id
          and i.branch_id = p_branch_id
          and pay.payment_date >= date_trunc('month', p_period)::date
          and pay.payment_date <  (date_trunc('month', p_period) + interval '1 month')::date)
    else
      (select sum(il.amount)
         from public.invoice_lines il
         join public.invoices i on i.id = il.invoice_id
        where i.company_id = p_company_id
          and i.branch_id = p_branch_id
          and coalesce(i.period_start, i.invoice_date) >= date_trunc('month', p_period)::date
          and coalesce(i.period_start, i.invoice_date) <  (date_trunc('month', p_period) + interval '1 month')::date)
    end, 0);
$function$
-- ===END 27310
-- ===FUNC 27312 run_ho_cost_allocation(p_company_id uuid, p_period date, p_basis text)
CREATE OR REPLACE FUNCTION public.run_ho_cost_allocation(p_company_id uuid, p_period date, p_basis text DEFAULT 'revenue'::text)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_month     date := date_trunc('month', p_period)::date;
  v_ho        uuid := public.head_office_region(p_company_id);
  v_basis     text := lower(coalesce(p_basis, 'revenue'));
  v_cost      numeric;
  v_total     numeric := 0;
  r           record;
  v_lines     jsonb := '[]'::jsonb;
  v_alloc     numeric;
  v_alloc_sum numeric := 0;
  v_run       uuid;
  v_top       uuid;
  v_residual  numeric;
begin
  v_cost := public.ho_overhead_for_month(p_company_id, v_month);

  select id into v_run from public.ho_allocation_runs
   where company_id = p_company_id and period_month = v_month;
  if v_run is not null then
    perform public.reverse_journal_for_source(p_company_id, 'ho_allocation', v_run,
      (v_month + interval '1 month - 1 day')::date);
  end if;

  select coalesce(sum(public.branch_revenue_for_month(p_company_id, b.id, v_month, v_basis)), 0)
    into v_total
    from public.branches b
   where b.company_id = p_company_id and b.active;

  if v_run is null then
    insert into public.ho_allocation_runs
      (company_id, period_month, basis, ho_cost, total_deployed)
    values (p_company_id, v_month, v_basis, v_cost, v_total) returning id into v_run;
  else
    update public.ho_allocation_runs
       set basis = v_basis, ho_cost = v_cost, total_deployed = v_total, updated_at = now()
     where id = v_run;
  end if;

  if v_cost <= 0 or v_total <= 0 then
    update public.ho_allocation_runs
       set allocated_total = 0,
           unallocated = greatest(coalesce(v_cost, 0), 0)
     where id = v_run;
    return 0;
  end if;

  select b.id into v_top
    from public.branches b
   where b.company_id = p_company_id and b.active
   order by public.branch_revenue_for_month(p_company_id, b.id, v_month, v_basis) desc, b.id
   limit 1;

  for r in
    select b.id,
           public.branch_revenue_for_month(p_company_id, b.id, v_month, v_basis) as revenue
      from public.branches b
     where b.company_id = p_company_id and b.active and b.id <> v_top
  loop
    v_alloc := round(v_cost * greatest(coalesce(r.revenue, 0), 0) / v_total, 2);
    if v_alloc <> 0 then
      v_alloc_sum := v_alloc_sum + v_alloc;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'key', 'allocated_ho_cost', 'debit', v_alloc, 'credit', 0, 'region', r.id));
    end if;
  end loop;

  v_residual := v_cost - v_alloc_sum;
  if v_residual <> 0 then
    v_alloc_sum := v_alloc_sum + v_residual;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'key', 'allocated_ho_cost', 'debit', v_residual, 'credit', 0, 'region', v_top));
  end if;

  if v_alloc_sum <> v_cost then
    raise exception
      'HO allocation does not exhaust the pool: allocated % of % for %',
      v_alloc_sum, v_cost, v_month
      using errcode = '23514';
  end if;

  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'key', 'ho_cost_recovery', 'debit', 0, 'credit', v_alloc_sum, 'region', v_ho));

  perform public.post_journal(
    p_company_id, (v_month + interval '1 month - 1 day')::date,
    'Head-office cost allocation ' || to_char(v_month, 'YYYY-MM'),
    'ho_allocation', v_run, false, v_lines, v_ho);

  update public.ho_allocation_runs
     set allocated_total = v_alloc_sum, unallocated = 0
   where id = v_run;
  return v_alloc_sum;
end;
$function$
-- ===END 27312
-- ===FUNC 27314 post_invoice_journal(p_invoice_id uuid)
CREATE OR REPLACE FUNCTION public.post_invoice_journal(p_invoice_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  inv       record;
  v_gross   numeric;
  v_tax     numeric;
  v_revenue numeric;
  v_rev_key text;
  v_date    date;
begin
  select * into inv from public.invoices where id = p_invoice_id;
  if not found then return; end if;

  v_date    := coalesce(inv.period_start, inv.invoice_date);
  v_gross   := inv.invoice_amount;
  v_tax     := coalesce(inv.tax_added_total, 0);
  v_revenue := v_gross - v_tax;

  v_rev_key := 'revenue_security';
  begin
    select case when c.client_type = 'guard_deployment' then 'revenue_guard' else 'revenue_security' end
      into v_rev_key
      from public.clients c where c.id = inv.client_id;
  exception when others then null;
  end;

  perform public.post_journal(
    inv.company_id, v_date,
    'Invoice ' || coalesce(inv.invoice_number, inv.id::text),
    'invoices', inv.id, false,
    jsonb_build_array(
      jsonb_build_object('key', 'ar', 'debit', v_gross, 'credit', 0,
                         'client_id', inv.client_id, 'contract_id', inv.contract_id),
      jsonb_build_object('key', v_rev_key, 'debit', 0, 'credit', v_revenue,
                         'client_id', inv.client_id, 'contract_id', inv.contract_id),
      jsonb_build_object('key', 'sales_tax_payable', 'debit', 0, 'credit', v_tax,
                         'client_id', inv.client_id)
    ),
    inv.branch_id
  );
end;
$function$
-- ===END 27314
-- ===FUNC 27316 billing_clients_on_head_office(p_company_id uuid)
CREATE OR REPLACE FUNCTION public.billing_clients_on_head_office(p_company_id uuid)
 RETURNS TABLE(client_id uuid, client_name text, invoices bigint, invoiced numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select c.id, c.name, count(distinct i.id), coalesce(sum(il.amount), 0)
    from public.invoices i
    join public.branches b on b.id = i.branch_id
    join public.clients c on c.id = i.client_id
    left join public.invoice_lines il on il.invoice_id = i.id
   where i.company_id = p_company_id and b.is_head_office
   group by c.id, c.name
   order by 4 desc;
$function$
-- ===END 27316
-- ===FUNC 27317 applied_migration_names()
CREATE OR REPLACE FUNCTION public.applied_migration_names()
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(array_agg(m.name order by m.version), '{}')
    from supabase_migrations.schema_migrations m;
$function$
-- ===END 27317
-- ===FUNC 27318 reject_gate_mode_as_status()
CREATE OR REPLACE FUNCTION public.reject_gate_mode_as_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if public.is_maintenance_session() then
    return new;
  end if;

  if new.status = 'blocked'
     and (tg_op = 'INSERT' or new.status is distinct from old.status) then
    raise exception
      '"blocked" is a gate refusal, not an attendance status — act on attendance_gate()''s mode instead of recording it'
      using errcode = '23514',
            hint = 'attendance_gate() returns allowed / allowed_unposted / override_required / blocked. A blocked day must not be marked at all.';
  end if;

  return new;
end;
$function$
-- ===END 27318
-- ===FUNC 27320 attendance_gate_mode_residue(p_company_id uuid)
CREATE OR REPLACE FUNCTION public.attendance_gate_mode_residue(p_company_id uuid)
 RETURNS TABLE(employee_id uuid, full_name text, guard_code text, rows bigint, first_day date, last_day date, join_date date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select e.id, e.full_name, e.guard_code, count(*),
         min(a.attendance_date), max(a.attendance_date), e.join_date
    from public.attendance_records a
    join public.employees e on e.id = a.employee_id
   where a.company_id = p_company_id and a.status = 'blocked'
   group by e.id, e.full_name, e.guard_code, e.join_date
   order by count(*) desc;
$function$
-- ===END 27320
-- ===FUNC 27321 applied_migration_digests()
CREATE OR REPLACE FUNCTION public.applied_migration_digests()
 RETURNS TABLE(name text, digest text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select m.name, md5(array_to_string(m.statements, E'\n'))
    from supabase_migrations.schema_migrations m
   order by m.version;
$function$
-- ===END 27321
-- ===FUNC 27327 ensure_bad_debt_account(p_company_id uuid)
CREATE OR REPLACE FUNCTION public.ensure_bad_debt_account(p_company_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_id uuid;
begin
  select id into v_id from public.chart_of_accounts
   where company_id = p_company_id and system_key = 'bad_debt_expense'
   limit 1;
  if v_id is not null then return v_id; end if;

  insert into public.chart_of_accounts
    (company_id, account_code, account_name, account_type, normal_side,
     system_key, active, system_account)
  values
    (p_company_id, '6750', 'Bad Debt Expense', 'expense', 'debit',
     'bad_debt_expense', true, true)
  returning id into v_id;

  return v_id;
end;
$function$
-- ===END 27327
-- ===FUNC 27328 auto_bad_debt_account_on_company_insert()
CREATE OR REPLACE FUNCTION public.auto_bad_debt_account_on_company_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.ensure_bad_debt_account(new.id);
  return new;
end;
$function$
-- ===END 27328
-- ===FUNC 27334 partner_basis_for_report(p_basis text)
CREATE OR REPLACE FUNCTION public.partner_basis_for_report(p_basis text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_policy text;
begin
  select fs.partner_remuneration_basis into v_policy
    from public.finance_settings fs
   where fs.company_id = public.current_company_id();

  if v_policy is null then
    raise exception 'No partner remuneration basis configured for this company — apply migration 0230'
      using errcode = '23502';
  end if;

  if p_basis is not null and lower(p_basis) <> v_policy then
    raise exception
      'Report basis "%" disagrees with this company''s partner remuneration basis "%" — one of the two is wrong, and a figure mixing them is meaningless',
      p_basis, v_policy
      using errcode = '22023',
            hint = 'Draw the report on the company basis, or change the company basis deliberately in finance_settings.';
  end if;

  return v_policy;
end;
$function$
-- ===END 27334