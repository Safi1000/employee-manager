-- Auto-populate company_id on insert from caller's profile when not provided.
-- Lets existing pages keep inserting rows without code changes.
-- SSA inserts must still pass company_id explicitly (their current_company_id() is null).

create or replace function public.fill_company_id()
returns trigger language plpgsql as $$
begin
  if new.company_id is null then
    new.company_id := public.current_company_id();
  end if;
  return new;
end;
$$;

do $$
declare
  t text;
  per_company_tables text[] := array[
    'locations','clients','employees','attendance_records','employee_documents',
    'inventory_items','issuances','bank_accounts','bank_transactions',
    'expense_categories','vendors','expenses','invoices','invoice_payments',
    'payslips','advances','important_dates','recurring_alerts'
  ];
begin
  foreach t in array per_company_tables loop
    execute format('drop trigger if exists trg_%I_fill_company on public.%I', t, t);
    execute format(
      'create trigger trg_%I_fill_company before insert on public.%I
         for each row execute function public.fill_company_id()', t, t
    );
  end loop;
end $$;
