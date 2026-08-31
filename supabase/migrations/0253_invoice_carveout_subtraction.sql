-- 0253 — G0.2. The invoices period-lock carve-out is stated as a subtraction,
-- the way 0237 stated the payslips one, instead of as six pinned columns.
--
-- NOT APPLIED TO PRODUCTION. Dev only. Prod is closed without named approval.
--
-- WHAT 0237 SHIPPED
--
--   if old.amount_received  is distinct from     new.amount_received
--      and old.invoice_amount   is not distinct from new.invoice_amount
--      and old.invoice_date     is not distinct from new.invoice_date
--      and old.client_id        is not distinct from new.client_id
--      and old.withholding_tax  is not distinct from new.withholding_tax
--      and old.invoice_number   is not distinct from new.invoice_number
--   then return new; end if;
--
-- `invoices` has 33 columns. Six are named. TWENTY-SEVEN ride along with any
-- update that also moves amount_received, inside a closed month, unchecked:
-- subtotal, total_due, tax_added_total, tax_withheld_total, previous_balance,
-- period_start, period_end, branch_id, contract_id, financial_year,
-- invoice_group, amount_in_words, remit_account, override_reason, variable_grid,
-- generated, and the rest.
--
-- `total_due` is the cumulative column whose misuse started the ledger
-- investigation. It is the single worst column to have left open here.
--
-- THE PART THAT MAKES THIS MORE THAN AN OVERSIGHT
--
-- 0237 justified the carve-out with a list, and then did not pin the list. Its
-- own comment reads:
--
--   "journal_on_invoice reposts only when invoice_amount, tax_added_total,
--    period_start, invoice_date, client_id or branch_id change. amount_received
--    is not in that list, so this update touches no journal entry at all."
--
-- That description of journal_on_invoice is correct — verified against the live
-- prosrc, not against the comment. But of those six columns the carve-out pins
-- only three. `tax_added_total`, `period_start` and `branch_id` are named in the
-- argument for why the carve-out is GL-neutral and are left out of the guard
-- that is supposed to keep it GL-neutral.
--
-- WHY tax_added_total IS REFUSED TODAY, AND WHY THAT IS NOT A DEFENCE
--
-- Update a closed-month invoice changing amount_received AND tax_added_total.
-- Trace it:
--
--   1. enforce_period_lock — the carve-out PASSES it. tax_added_total is not
--      pinned, so the branch returns new and the invoices lock is satisfied.
--   2. journal_on_invoice — sees tax_added_total changed, calls
--      reverse_journal_for_source at coalesce(old.period_start, old.invoice_date),
--      then post_invoice_journal.
--   3. trg_journal_entries_period_lock — has no carve-out. The write lands in
--      the closed month and is refused.
--
-- Same transaction, so the edit aborts. The refusal is real. But it is not the
-- invoices lock deciding tax_added_total is protected — it is an unrelated
-- function in a different file happening to catch it, and the message names
-- `[journal_entries]` for an edit the user made to an invoice.
--
-- That is carve-out (b)'s pathology exactly, which 0237 REMOVED for this reason:
-- "not a policy decision; it is a worse error message." And it is (c)'s
-- pathology exactly: "most of those are caught anyway ... but 'most' was doing
-- real work in that sentence and should not have to."
--
-- 0237 identified this failure shape twice, corrected it twice, and left the
-- third instance standing in the carve-out it was writing at the time.
--
-- period_start and branch_id behave identically: permitted here, refused
-- downstream, wrong table named.
--
-- subtotal, total_due, tax_withheld_total and previous_balance have no
-- downstream backstop at all. journal_on_invoice does not repost on them, so
-- nothing anywhere refuses them. They change silently in a closed month.
--
-- MEASURED, NOT REASONED
--
-- Probed on dev against SANDBOX TESTING ORG, in a closed month, rolled back.
-- Each column moved in the same statement as a receipt, which is the only shape
-- that reaches the carve-out at all — the branch opens with `old.amount_received
-- is distinct from new.amount_received`, so any of these touched ALONE falls
-- through and is refused. The first probe missed that and reported everything
-- safe; the shape is what makes the defect reachable.
--
--   total_due            ACCEPTED   118000 -> 118001, in a closed month
--   subtotal             ACCEPTED
--   tax_withheld_total   ACCEPTED
--   previous_balance     ACCEPTED
--   contract_id          ACCEPTED
--   tax_added_total      refused by [journal_entries]   <- wrong lock
--   period_start         refused by [journal_entries]   <- wrong lock
--   branch_id            refused by [journal_entries]   <- wrong lock
--   invoice_amount       refused by [invoices]          <- correct, pinned
--   withholding_tax      refused by [invoices]          <- correct, pinned
--
-- Five columns that no lock anywhere refused, and three refused by a trigger on
-- a different table than the one the user edited.
--
-- THE FIX
--
-- 0237's own remedy for (c), applied to (a): name what a receipt may touch and
-- subtract it, so a column added to invoices tomorrow is PROTECTED by default
-- rather than silently permitted, and widening the list costs a visible edit to
-- this file.
--
-- The permitted set was derived from the call sites, not guessed:
--
--   record_invoice_payment (live prosrc)     amount_received, updated_at
--   Accounting.tsx:1637                      amount_received, notes, updated_at
--   Invoices.tsx:856, :894                   amount_received, updated_at
--   Invoices.tsx:667                         status, updated_at
--   Invoices.tsx:494, :639                   drive_file_id, drive_view_url,
--                                            attachment_file_name,
--                                            attachment_path, updated_at
--
-- The document columns are in the list deliberately. Attaching the scan of a
-- July invoice in August is a normal act, it is GL-neutral, and blocking it
-- would be the over-reach 0237 accused dev of in carve-out (a).
--
-- status stays permitted for the reason 0237 gave: a receipt moves an invoice
-- to Paid.
--
-- Not in the list, and therefore now refused inside a closed month: subtotal,
-- total_due, tax_added_total, tax_withheld_total, previous_balance,
-- period_start, period_end, branch_id, contract_id, invoice_amount,
-- invoice_date, client_id, withholding_tax, invoice_number, and the rest.
--
-- NOTE ON REACH: accounting_periods is empty on both environments. Zero months
-- have ever been closed, so no code path in this repo has ever executed either
-- version of this branch. This is a structural correction, and the end-to-end
-- Period Close exercise remains the required pre-go-live item.

create or replace function public.enforce_period_lock()
returns trigger
language plpgsql
as $function$
declare
  -- The ONLY columns a payslip may change inside a closed month. Everything
  -- else falls through to the lock. See 0237 (c) before adding to this list.
  c_payslip_open constant text[] := array[
    'disbursed', 'disbursed_at', 'amount_paid', 'status', 'payment_mode',
    'bank_account_id', 'cheque_id', 'cash_location_id', 'notes', 'updated_at'
  ];
  -- The ONLY columns an invoice may change inside a closed month: the receipt
  -- itself, its status, and the attached document. Everything else falls
  -- through to the lock. See 0253 before adding to this list — in particular,
  -- nothing in c_invoice_repost may ever appear here.
  c_invoice_open constant text[] := array[
    'amount_received', 'status', 'notes', 'updated_at',
    'attachment_path', 'attachment_file_name', 'drive_file_id', 'drive_view_url'
  ];
  v_date_col text;
  v_new_date date;
  v_old_date date;
  v_company  uuid;
begin
  v_date_col := tg_argv[0];

  if public.current_company_id() is null and not public.is_ssa_unscoped() then
    return coalesce(new, old);
  end if;

  -- (c) payslips: disbursement-only edits pass; anything touching pay does not.
  if tg_table_name = 'payslips' and tg_op = 'UPDATE' then
    if (to_jsonb(old) - c_payslip_open) is not distinct from (to_jsonb(new) - c_payslip_open) then
      return new;
    end if;
  end if;

  -- (b) the invoice_payments INSERT carve-out is deliberately absent.

  -- (a) invoices: a receipt, a status move, or a document attachment — and
  -- nothing else. Stated as a subtraction so a new column is protected by
  -- default. A no-op UPDATE passes, which is correct and is the instance-eleven
  -- lesson from the fixture audit.
  if tg_table_name = 'invoices' and tg_op = 'UPDATE' then
    if (to_jsonb(old) - c_invoice_open) is not distinct from (to_jsonb(new) - c_invoice_open) then
      return new;
    end if;
  end if;

  if tg_op = 'DELETE' then
    execute format('select ($1).%I::date, ($1).company_id', v_date_col)
      into v_old_date, v_company using old;
    if public.is_period_closed(v_company, v_old_date) then
      raise exception
        'Period for % is closed. Deleting this row is not allowed; reopen the month in Period Close first. [%]',
        v_old_date, tg_table_name using errcode = 'P0001';
    end if;
    return old;
  end if;

  execute format('select ($1).%I::date, ($1).company_id', v_date_col)
    into v_new_date, v_company using new;
  if public.is_period_closed(v_company, v_new_date) then
    raise exception
      'Period for % is closed. New / edited transactions in a closed month are not allowed; reopen the month in Period Close to continue. [%]',
      v_new_date, tg_table_name using errcode = 'P0001';
  end if;

  if tg_op = 'UPDATE' then
    execute format('select ($1).%I::date', v_date_col) into v_old_date using old;
    if v_old_date is distinct from v_new_date
       and public.is_period_closed(v_company, v_old_date) then
      raise exception
        'Source period for % is closed. Moving a transaction out of a closed month requires reopening it first. [%]',
        v_old_date, tg_table_name using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$function$;

comment on function public.enforce_period_lock() is
  'Period close enforcement. Carve-outs are stated as subtractions, so a column added to invoices or payslips tomorrow is protected by default: payslips permit disbursement fields only, invoices permit the receipt, the status and the attached document only. See 0237 for why the invoice_payments INSERT carve-out was removed and 0253 for why the invoices carve-out stopped pinning columns by name. The [table] suffix on each refusal names the trigger that refused, so a test can tell them apart.';

-- ---------------------------------------------------------------------------
-- The disjointness assertion.
-- ---------------------------------------------------------------------------
-- 0237's error was permitting a column its own justification depended on being
-- unchanged. The invariant that would have caught it: NO COLUMN THAT
-- journal_on_invoice REPOSTS ON MAY APPEAR IN THE CARVE-OUT. Assert it here so
-- widening c_invoice_open by one careless entry fails at migration time rather
-- than becoming a silent hole with a confusing downstream refusal.
--
-- c_invoice_repost is written out rather than read from journal_on_invoice's
-- prosrc on purpose: a prosrc grep is not a check (§9.6, seven instances). It
-- is duplicated, and the duplication is the cost of not grepping. The wiring
-- assertion below is what makes the duplication safe — it fails if
-- journal_on_invoice stops existing or moves — and the honest limitation is
-- that it cannot detect a NEW column being added to journal_on_invoice's
-- repost list. That is recorded as a follow-up, not papered over: the real fix
-- is one shared list both functions read, and it is deferred only because
-- journal_on_invoice compares tax_added_total through coalesce(...,0) and a
-- naive shared-list rewrite would repost on NULL -> 0 where today it does not.
do $assert_disjoint$
declare
  c_invoice_repost constant text[] := array[
    'invoice_amount', 'tax_added_total', 'period_start',
    'invoice_date', 'client_id', 'branch_id'
  ];
  c_invoice_open constant text[] := array[
    'amount_received', 'status', 'notes', 'updated_at',
    'attachment_path', 'attachment_file_name', 'drive_file_id', 'drive_view_url'
  ];
  v_overlap text;
begin
  select string_agg(x, ', ') into v_overlap
    from unnest(c_invoice_open) x where x = any (c_invoice_repost);

  if v_overlap is not null then
    raise exception
      'The invoices period-lock carve-out permits column(s) journal_on_invoice reposts on: %. A GL-neutral carve-out cannot include a column that moves the GL. See 0253.',
      v_overlap using errcode = '23514';
  end if;

  if to_regprocedure('public.journal_on_invoice()') is null then
    raise exception
      'journal_on_invoice() is gone. 0253''s carve-out is justified by what that function reposts on; re-derive the permitted set before proceeding.'
      using errcode = '23514';
  end if;
end
$assert_disjoint$;

-- The trigger wiring assertion from 0237, unchanged and re-asserted, because
-- the carve-out above is still written against invoices keying on invoice_date.
do $assert_wiring$
declare
  v_missing text;
begin
  select string_agg(x.tbl || '(' || x.col || ')', ', ')
    into v_missing
    from (values
      ('advances', 'advance_date'), ('cheques', 'cheque_date'),
      ('expenses', 'expense_date'), ('invoice_payments', 'payment_date'),
      ('invoices', 'invoice_date'), ('journal_entries', 'entry_date'),
      ('payslips', 'period_month')
    ) as x(tbl, col)
   where not exists (
     select 1 from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and not t.tgisinternal
        and t.tgfoid = 'public.enforce_period_lock'::regproc
        and c.relname = x.tbl
        and pg_get_triggerdef(t.oid) like '%enforce_period_lock(''' || x.col || ''')%');

  if v_missing is not null then
    raise exception
      'Period lock wiring changed — expected trigger(s) missing or on a different date column: %. The carve-outs are written against these columns; re-read them before changing the wiring.',
      v_missing using errcode = '23514';
  end if;
end
$assert_wiring$;
