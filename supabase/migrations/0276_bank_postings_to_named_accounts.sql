-- 0276 — Bank postings land on the NAMED bank account, not the control.
--
-- THE DEFECT
--
-- Four posting functions credited or debited `key = 'bank'` — the
-- undifferentiated control account — while the source row carried a perfectly
-- good `bank_account_id`. Every bank sub-account therefore held exactly its
-- opening balance and nothing else, and the control carried **−728,456.00** of
-- movement belonging to named accounts.
--
-- This is the same defect 0264 fixed on the cash side, and it survived on the
-- bank side for the same reason it survived there: no check could see it.
-- bank_control_equals_bank_accounts sums the whole subtree, so parent/child
-- misrouting cancels; bank_accounts_equal_transaction_deltas never touches the
-- GL. 0271's per-account check is what made it visible — 1,616,923 per account
-- against 938,467 for the subtree, a 678,456 difference that was invisible by
-- construction rather than by defect.
--
-- ROUTING IS FULLY DETERMINABLE, and this was measured, not assumed. Every
-- bank-mode row already names its account:
--
--   expenses          3 of 3 Bank-mode rows carry bank_account_id
--   advances          1 of 1
--   invoice_payments  3 of 3
--   payslips         38 of 38 disbursed Bank-mode rows
--
-- ONE HELPER, NOT FOUR CASE EXPRESSIONS. settlement_account() is the single
-- place that decides which asset account a settlement touches. Four copies of
-- the same case expression is how the four drifted apart in the first place —
-- journal_on_expense listed 'Cheque' explicitly, journal_on_advance caught it in
-- an else, and post_payslip_disbursement additionally re-dated it.
--
-- DIRECTION MATTERS FOR CHEQUES, and it is a parameter rather than an
-- assumption. An OUTGOING cheque is a liability until it clears (0269), so it
-- credits Unpresented Cheques. An INCOMING cheque's invoice_payments row is
-- created BY cheque_apply_balance at clearing, so the money is already in the
-- bank and it debits the named bank account. Sharing one helper without the
-- flag would silently route received cheques into a payables liability.
--
-- BACKFILL: yes — 45 live entries are reversed and reposted below, per the
-- standing rule from 0269.

create or replace function public.settlement_account(
  p_company_id uuid, p_payment_mode text, p_bank_account_id uuid,
  p_custodian_location_id uuid, p_outgoing boolean default true)
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $function$
  select case
    when p_payment_mode = 'Cash'
      then public.cash_account_for(p_company_id, p_custodian_location_id)
    when p_payment_mode = 'Cheque' and coalesce(p_outgoing, true)
      then public.coa_id(p_company_id, 'unpresented_cheques')
    else public.bank_account_gl(p_company_id, p_bank_account_id)
  end;
$function$;

comment on function public.settlement_account(uuid, text, uuid, uuid, boolean) is
  'The asset (or, for an outgoing cheque, liability) account a settlement touches: the custodian''s cash account, Unpresented Cheques, or the NAMED bank sub-account. One place, so the posting functions cannot drift apart. p_outgoing distinguishes a cheque written from a cheque received.';

-- ---------------------------------------------------------------------------
-- The four call sites. Bodies are otherwise unchanged from 0269.
-- ---------------------------------------------------------------------------

create or replace function public.journal_on_expense()
returns trigger
language plpgsql
as $function$
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
       or old.custodian_location_id is distinct from new.custodian_location_id
       or old.bank_account_id is distinct from new.bank_account_id      -- 0276
       or old.expense_date is distinct from new.expense_date then       -- 0258
      perform public.reverse_journal_for_source(new.company_id, 'expenses', new.id, old.expense_date);
    else
      return new;
    end if;
  end if;

  select name into v_cat_name from public.expense_categories where id = new.category_id;
  v_exp_key := public.map_expense_to_coa_key(coalesce(v_cat_name, ''), new.pl_category::text, new.client_id);

  v_cr_line := case
    when new.payment_mode in ('Cash', 'Bank', 'Cheque') then jsonb_build_object(
      'account_id', public.settlement_account(new.company_id, new.payment_mode,
                                              new.bank_account_id, new.custodian_location_id, true),
      'debit', 0, 'credit', new.amount)
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
$function$;

create or replace function public.journal_on_advance()
returns trigger
language plpgsql
as $function$
declare v_cr_line jsonb;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'advances', old.id, old.advance_date);
    return old;
  end if;

  if tg_op = 'UPDATE' then
    -- Every field the posting below reads. See 0256 before shortening this.
    if old.amount           is distinct from new.amount
       or old.branch_id        is distinct from new.branch_id
       or old.custodian_location_id is distinct from new.custodian_location_id
       or old.bank_account_id  is distinct from new.bank_account_id      -- 0276
       or old.payment_mode     is distinct from new.payment_mode
       or old.advance_date     is distinct from new.advance_date
       or old.employee_id      is distinct from new.employee_id
       or old.client_id        is distinct from new.client_id then
      perform public.reverse_journal_for_source(new.company_id, 'advances', new.id, old.advance_date);
    else
      return new;
    end if;
  end if;

  v_cr_line := jsonb_build_object(
    'account_id', public.settlement_account(new.company_id, new.payment_mode,
                                            new.bank_account_id, new.custodian_location_id, true),
    'debit', 0, 'credit', new.amount);

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
$function$;

create or replace function public.journal_on_invoice_payment()
returns trigger
language plpgsql
as $function$
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
       or old.custodian_location_id is distinct from new.custodian_location_id
       or old.bank_account_id is distinct from new.bank_account_id      -- 0276
       or old.payment_date is distinct from new.payment_date then       -- 0258
      perform public.reverse_journal_for_source(new.company_id, 'invoice_payments', new.id, old.payment_date);
    else
      return new;
    end if;
  end if;

  v_wht := coalesce(new.withholding_amount, 0);
  v_client := coalesce(new.client_id, (select i.client_id from public.invoices i where i.id = new.invoice_id));

  -- p_outgoing = FALSE. Money coming IN. A received cheque is already banked by
  -- the time this row exists, so it must NOT route to Unpresented Cheques.
  v_dr_line := jsonb_build_object(
    'account_id', public.settlement_account(new.company_id, new.payment_mode,
                                            new.bank_account_id, new.custodian_location_id, false),
    'debit', new.amount, 'credit', 0);

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
$function$;

create or replace function public.post_payslip_disbursement(p_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  ps       record;
  v_client uuid;
  v_date   date;
  v_cr     jsonb;
  v_dim    jsonb;
begin
  -- tenant guard [resolved]: owning company looked up from p_id via public.payslips (0242)
  if p_id is not null then perform public.assert_same_company((select company_id from public.payslips where id = p_id)); end if;

  select * into ps from public.payslips where id = p_id;
  if not found or not ps.disbursed or coalesce(ps.net_salary, 0) = 0 then return; end if;

  select e.client_id into v_client from public.employees e where e.id = ps.employee_id;
  v_dim := jsonb_build_object('employee_id', ps.employee_id, 'client_id', v_client);

  -- 0269: posts at disbursed_at for every mode; a cheque routes through
  -- Unpresented Cheques rather than deferring the whole entry.
  v_date := coalesce(ps.disbursed_at::date, ps.period_month);

  v_cr := jsonb_build_object(
    'account_id', public.settlement_account(ps.company_id, ps.payment_mode,
                                            ps.bank_account_id, ps.custodian_location_id, true),
    'debit', 0, 'credit', ps.net_salary);

  perform public.post_journal(
    ps.company_id, v_date,
    'Payroll disbursed — ' || left(ps.period_month::text, 7),
    'payslips_disbursement', ps.id, false,
    jsonb_build_array(
      v_dim || jsonb_build_object('key', 'salaries_payable', 'debit', ps.net_salary, 'credit', 0)
    ) || jsonb_build_array(v_dim || v_cr),
    ps.branch_id);
end;
$function$;

-- journal_on_fixed_asset is left on `key`-based resolution: fixed_assets has a
-- bank_account_id but ZERO rows, so repointing it would be a change nothing has
-- ever exercised. Named here so the omission is a decision, not an oversight.

-- ---------------------------------------------------------------------------
-- The repost. Reverse and repost in the current period, swapping ONLY the bank
-- control line for the named account. Lines are copied, so nothing else can
-- change. 45 live entries, netting −728,456.00.
-- ---------------------------------------------------------------------------

do $$
declare
  r        record;
  v_ctl    uuid;
  v_target uuid;
  v_lines  jsonb;
  v_co     uuid;
  v_done   int := 0;
  v_skip   int := 0;
  v_before numeric;
  v_after  numeric;
begin
  for v_co in select id from public.companies loop
    select id into v_ctl from public.chart_of_accounts
     where company_id = v_co and system_key = 'bank' limit 1;
    continue when v_ctl is null;

    select coalesce(sum(jl.debit - jl.credit), 0) into v_before
      from public.journal_lines jl where jl.account_id = v_ctl;

    for r in
      select je.id as entry_id, je.entry_date, je.description, je.source_table, je.source_id,
             case je.source_table
               when 'expenses'              then (select e.bank_account_id from public.expenses e where e.id = je.source_id)
               when 'advances'              then (select a.bank_account_id from public.advances a where a.id = je.source_id)
               when 'invoice_payments'      then (select p.bank_account_id from public.invoice_payments p where p.id = je.source_id)
               when 'payslips_disbursement' then (select ps.bank_account_id from public.payslips ps where ps.id = je.source_id)
             end as bank_account_id
        from public.journal_entries je
       where je.company_id = v_co
         and je.is_reversal = false
         and not exists (select 1 from public.journal_entries x where x.reversal_of_entry_id = je.id)
         and je.source_table in ('expenses', 'advances', 'invoice_payments', 'payslips_disbursement')
         and exists (select 1 from public.journal_lines jl
                      where jl.journal_entry_id = je.id and jl.account_id = v_ctl)
    loop
      v_target := public.bank_account_gl(v_co, r.bank_account_id);

      -- No named account, or it resolves back to the control: posting again
      -- would change nothing and churn the ledger. Leave it and count it.
      if r.bank_account_id is null or v_target is null or v_target = v_ctl then
        v_skip := v_skip + 1;
        continue;
      end if;

      select jsonb_agg(
               jsonb_strip_nulls(jsonb_build_object(
                 'account_id', case when jl.account_id = v_ctl then v_target else jl.account_id end,
                 'debit', jl.debit, 'credit', jl.credit,
                 'region', jl.branch_id,
                 'client_id', jl.client_id, 'employee_id', jl.employee_id,
                 'partner_id', jl.partner_id, 'contract_id', jl.contract_id,
                 'cost_center', jl.cost_center)))
        into v_lines
        from public.journal_lines jl where jl.journal_entry_id = r.entry_id;

      perform public.reverse_journal_for_source(v_co, r.source_table, r.source_id, r.entry_date);
      perform public.post_journal(
        v_co, current_date,
        r.description || ' (bank routed to the named account — 0276)',
        r.source_table, r.source_id, false, v_lines,
        (select jl.branch_id from public.journal_lines jl
          where jl.journal_entry_id = r.entry_id and jl.branch_id is not null limit 1));
      v_done := v_done + 1;
    end loop;

    select coalesce(sum(jl.debit - jl.credit), 0) into v_after
      from public.journal_lines jl where jl.account_id = v_ctl;

    if v_done > 0 or v_skip > 0 then
      raise notice '0276: company % — % reposted, % skipped; bank control % -> %',
        v_co, v_done, v_skip, v_before, v_after;
    end if;
    v_done := 0; v_skip := 0;
  end loop;
end $$;

-- Prove it: the bank control must now carry nothing but what genuinely has no
-- named account, and the trial balance must still balance.
do $$
declare v_co uuid := (select id from public.companies where name = 'SANDBOX TESTING ORG');
        v_ctl_bal numeric; v_dr numeric; v_cr numeric;
begin
  if v_co is null then return; end if;

  select coalesce(sum(jl.debit - jl.credit), 0) into v_ctl_bal
    from public.journal_lines jl
    join public.chart_of_accounts c on c.id = jl.account_id
   where c.company_id = v_co and c.system_key = 'bank';

  select coalesce(sum(jl.debit), 0), coalesce(sum(jl.credit), 0) into v_dr, v_cr
    from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_entry_id
   where je.company_id = v_co;

  raise notice '0276: bank control balance now %, trial balance % / %', v_ctl_bal, v_dr, v_cr;

  if v_dr <> v_cr then
    raise exception '0276: trial balance no longer balances: % vs %', v_dr, v_cr;
  end if;
end $$;