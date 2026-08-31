-- 0236: Give every company a Bad Debt Expense account, and stop
-- write_off_receivable() posting to a null account when it is missing.
--
-- THE BUG
--   0109b seeds the account at code '6700' with system_key 'bad_debt_expense',
--   guarded by `where not exists (... system_key = 'bad_debt_expense')`. But
--   '6700' is already **Loss on Asset Disposal** (system_key 'loss_disposal') in
--   every company, and chart_of_accounts is unique on (company_id, account_code).
--   The guard checks the system_key, the constraint fires on the code, so the
--   insert never succeeded — not in production, not anywhere. No company has ever
--   had a bad_debt_expense account.
--
--   write_off_receivable() then does `select id into v_bad ... where system_key =
--   'bad_debt_expense'`, leaves v_bad null, and hands post_journal a debit line
--   with a null account_id. The write-off either fails outright or books a
--   one-sided entry against nothing.
--
-- THE FIX
--   Use code '6750', which is free (6600 Bonus, 6700 Loss on Disposal, 6800
--   Allocated HO Cost, 6850 HO Cost Recovery), and route creation through an
--   ensure_* helper in the style already used by ensure_cash_location_account
--   and ensure_partner_capital_account. seed_chart_of_accounts() is deliberately
--   NOT rewritten to add a row: it is a 70-line literal list, and reproducing it
--   to change one line risks corrupting the canonical seed. The trigger below
--   covers new companies instead.

create or replace function public.ensure_bad_debt_account(p_company_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
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
$function$;

-- Existing companies.
do $$
declare r record;
begin
  for r in select id from public.companies loop
    perform public.ensure_bad_debt_account(r.id);
  end loop;
end $$;

-- New companies. seed_chart_of_accounts() runs from its own AFTER INSERT
-- trigger; this one runs alongside it and is idempotent either way.
create or replace function public.auto_bad_debt_account_on_company_insert()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.ensure_bad_debt_account(new.id);
  return new;
end;
$function$;

drop trigger if exists trg_zzz_bad_debt_account on public.companies;
create trigger trg_zzz_bad_debt_account
  after insert on public.companies
  for each row execute function public.auto_bad_debt_account_on_company_insert();

-- write_off_receivable(): resolve the account through the helper so it can never
-- post a null debit line again. Body is otherwise the production definition as
-- 0110 left it.
create or replace function public.write_off_receivable(p_invoice_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
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
$function$;
