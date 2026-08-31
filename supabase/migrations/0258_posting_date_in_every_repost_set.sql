-- 0258 — The date a trigger posts at is a date it compares. All eight of them.
--
-- NOT APPLIED TO PRODUCTION. Dev only.
--
-- ONE DEFECT, EIGHT PLACES, ONE SHAPE.
--
-- Every one of these functions reverses at `old.<date>` and posts at
-- `new.<date>`, and none of them compared the two. So a row whose date moved,
-- and nothing else, took the early return: no reversal, no repost, and a
-- general ledger entry left in the month the row no longer claims.
--
--   EXPENSE posted at    : 2026-08-01   (expense_date 2026-08-01)
--   moved expense_date to  2026-07-01
--     journal entries now : 1
--     latest entry_date   : 2026-08-01   <-- STILL THE OLD MONTH
--
-- The expense claims July; the P&L charges August. Nothing errors.
--
-- The fix is the same edit in nine call sites: the reversal date joins the
-- comparison set. Stated as a property rather than eight fixes:
--
--   FOR EVERY journal_on_* TRIGGER, THE DATE IT POSTS AT IS A DATE IT COMPARES.
--
-- supabase/tests/repost_sets.sql asserts that property behaviourally — it moves
-- a row's date and requires the old month to be vacated — rather than asserting
-- eight separate things.
--
-- RUPEE EFFECT: ZERO, EVERYWHERE. Measured before this migration on both
-- databases, counting live entries (not reversals, not reversed) whose
-- entry_date differs from their source row's date column:
--
--   source table              rows  posted at a different date   rupees
--   advances                     1                           0     0.00
--   cash_deposits                0                           0     0.00
--   custody_transfers            1                           0     0.00
--   expenses                     5                           0     0.00
--   fixed_assets                 0                           0     0.00
--   invoice_payments             6                           0     0.00
--   partner_account_entries      0                           0     0.00
--   cheques                      3                           0     0.00
--   expense_settlements          5                           0     0.00
--
-- Identical on prod and dev. No date has ever been moved on a posted row, so
-- there is nothing to backfill and no control account is currently wrong
-- because of this. The defect is real, reachable, and has not fired.
--
-- TWO OF THE NINE ARE NOT A ONE-LINE EDIT, AND THAT IS THE INTERESTING PART.
--
-- journal_on_cheque and journal_on_expense_settlement are not shaped like the
-- others: neither has a general "did anything relevant change" test. Both are
-- driven by a STATUS TRANSITION — pending->cleared, Pending->Paid — and both
-- return early when the status did not move. A date change on an
-- already-cleared cheque, or an already-settled payable, hits that early return.
--
-- So for those two the date test cannot be another `or` in a list; it has to be
-- a third branch alongside "entering the state" and "leaving the state":
-- STAYING in the state while the date moves. Written as one `or` each, they
-- would have compiled, looked consistent with the other seven, and changed
-- nothing.
--
-- WHAT THIS MIGRATION DOES NOT DO
--
-- The other columns in docs/REPOST_SET_AUDIT.md — paid_via and amount on the
-- settlement, payment_mode on invoice_payment, custodian_location_id and
-- cheque_type on cheques, pl_category on expenses — are left alone. They are
-- different defects that happen to live in the same functions, and folding them
-- in would make this migration untestable as one property.
--
-- advances is already correct: 0256 added advance_date when it fixed
-- payment_mode. partner_account_entries gets its date here; 0257 gave it
-- partner_id and deliberately left the date to this migration.

-- ---------------------------------------------------------------------------
-- 1. cash_deposits — deposit_date
-- ---------------------------------------------------------------------------
create or replace function public.journal_on_cash_deposit()
returns trigger
language plpgsql
as $function$
declare v_from record;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'cash_deposits', old.id, old.deposit_date);
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.amount is distinct from new.amount
       or old.cash_location_id is distinct from new.cash_location_id
       or old.deposit_date is distinct from new.deposit_date then   -- 0258
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
$function$;

-- ---------------------------------------------------------------------------
-- 2. custody_transfers — date
-- ---------------------------------------------------------------------------
create or replace function public.journal_on_custody_transfer()
returns trigger
language plpgsql
as $function$
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
       or old.to_location_id is distinct from new.to_location_id
       or old.date is distinct from new.date then                   -- 0258
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
$function$;

-- ---------------------------------------------------------------------------
-- 3. fixed_assets — acquisition_date
-- ---------------------------------------------------------------------------
create or replace function public.journal_on_fixed_asset()
returns trigger
language plpgsql
as $function$
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
       or old.branch_id is distinct from new.branch_id
       or old.acquisition_date is distinct from new.acquisition_date then   -- 0258
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
$function$;

-- ---------------------------------------------------------------------------
-- 4. expenses — expense_date
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
       or old.cash_location_id is distinct from new.cash_location_id
       or old.expense_date is distinct from new.expense_date then   -- 0258
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
$function$;

-- ---------------------------------------------------------------------------
-- 5. invoice_payments — payment_date
-- ---------------------------------------------------------------------------
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
       or old.cash_location_id is distinct from new.cash_location_id
       or old.payment_date is distinct from new.payment_date then   -- 0258
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
$function$;

-- ---------------------------------------------------------------------------
-- 6. partner_account_entries — date  (partner_id came from 0257)
-- ---------------------------------------------------------------------------
create or replace function public.journal_on_partner_entry()
returns trigger
language plpgsql
as $function$
declare
  p          record;
  v_capital  uuid;
  v_region   uuid;
  v_cash     jsonb;
  v_lines    jsonb;
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
       or old.bank_account_id is distinct from new.bank_account_id
       or old.partner_id is distinct from new.partner_id            -- 0257
       or old.date is distinct from new.date then                   -- 0258
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
      v_cash    || jsonb_build_object('debit', new.amount, 'credit', 0),
      jsonb_build_object('account_id', v_capital, 'debit', 0, 'credit', new.amount))
    when 'DRAWING' then jsonb_build_array(
      jsonb_build_object('account_id', v_capital, 'debit', new.amount, 'credit', 0),
      v_cash    || jsonb_build_object('debit', 0, 'credit', new.amount))
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
$function$;

-- ---------------------------------------------------------------------------
-- 7. cheques — cheque_date. NOT a one-line edit; see the header.
-- ---------------------------------------------------------------------------
create or replace function public.journal_on_cheque()
returns trigger
language plpgsql
as $function$
declare
  v_acct   uuid;
  v_branch uuid;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'cheques', old.id, old.cheque_date);
    return old;
  end if;

  -- Only outgoing CASH cheques move money the rest of the system does not post.
  if new.direction <> 'outgoing' or new.cheque_type <> 'cash' then
    return new;
  end if;

  -- Clearance withdrawn or bounced: reverse.
  if old.status = 'cleared' and new.status <> 'cleared' then
    perform public.reverse_journal_for_source(new.company_id, 'cheques', new.id, old.cheque_date);
    return new;
  end if;

  -- 0258. The third branch: STAYING cleared while the date moves. This function
  -- is driven by a status transition, so a date change on an already-cleared
  -- cheque previously hit the early return below and the entry kept the old
  -- date. An `or` in a condition list would not have reached this case.
  if old.status = 'cleared' and new.status = 'cleared'
     and old.cheque_date is distinct from new.cheque_date then
    perform public.reverse_journal_for_source(new.company_id, 'cheques', new.id, old.cheque_date);
    -- fall through and repost at new.cheque_date
  elsif new.status <> 'cleared' or old.status = 'cleared' then
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
$function$;

-- ---------------------------------------------------------------------------
-- 8. expense settlements — paid_at. Also not a one-line edit.
-- ---------------------------------------------------------------------------
create or replace function public.journal_on_expense_settlement()
returns trigger
language plpgsql
as $function$
declare
  v_date   date;
  v_cr     jsonb;
  v_was_paid boolean := coalesce(old.payable_status, '') = 'Paid';
  v_is_paid  boolean := coalesce(new.payable_status, '') = 'Paid';
begin
  if coalesce(new.payment_mode, '') <> 'Payable' then
    return new;
  end if;

  -- Settlement withdrawn: reverse.
  if v_was_paid and not v_is_paid then
    perform public.reverse_journal_for_source(
      old.company_id, 'expense_settlements', old.id,
      coalesce(old.paid_at::date, old.expense_date));
    return new;
  end if;

  -- 0258. The third branch: STAYING settled while the settlement date moves.
  -- Same shape as the cheque case above, and same reason it could not be an
  -- extra `or`.
  if v_was_paid and v_is_paid
     and coalesce(old.paid_at::date, old.expense_date)
         is distinct from coalesce(new.paid_at::date, new.expense_date) then
    perform public.reverse_journal_for_source(
      old.company_id, 'expense_settlements', old.id,
      coalesce(old.paid_at::date, old.expense_date));
    -- fall through and repost at the new settlement date
  elsif not v_is_paid or v_was_paid then
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
$function$;
