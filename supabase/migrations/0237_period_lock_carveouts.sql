-- 0237 — One period lock for both environments, with the three carve-outs
-- resolved individually.
--
-- WHY THIS EXISTS AT ALL
--
-- Production and dev have been enforcing different period-close rules. Prod's
-- enforce_period_lock() carries three carve-outs dev has never had, added by
-- three migrations that exist ONLY as schema_migrations rows on production and
-- have no repo file under any spelling:
--
--   allow_disbursement_and_invoice_payment_in_closed_period   20260629153920
--   allow_invoice_receivable_update_in_closed_period          20260630133438
--   narrow_invoice_receivable_period_lock_exemption           20260630133606
--
-- They arrived out of band, which is why nobody reviewed them. Dev, built from
-- the repo, could never have received them, so dev's lock is STRICTER than
-- production's. That is the dangerous direction: dev refuses, a test asserting
-- the refusal passes, and production quietly allows the thing.
--
-- Each carve-out is a separate question and they get separate answers.
--
-- Note before reading on: accounting_periods is EMPTY on both environments.
-- Zero months have ever been closed, so none of this has ever executed against
-- real data. The reasoning below is structural, not empirical, and the
-- end-to-end Period Close exercise is a required pre-go-live item.

-- ---------------------------------------------------------------------------
-- (a) invoices.amount_received — KEPT. Dev was over-reaching.
-- ---------------------------------------------------------------------------
-- trg_invoices_period_lock keys on invoice_date. A July invoice paid in August
-- is therefore checked against JULY, and without this carve-out the August
-- receipt fails against a month that closed correctly.
--
-- amount_received is a cumulative column that changes by design after close.
-- Locking it confuses "this row is DATED in a closed period" with "this is a
-- POSTING into a closed period". Only the second is what period close means.
--
-- It is also GL-neutral, which settles it: journal_on_invoice reposts only when
-- invoice_amount, tax_added_total, period_start, invoice_date, client_id or
-- branch_id change. amount_received is not in that list, so this update touches
-- no journal entry at all. Nothing enters or leaves the closed period.
--
-- The condition stays an allowlist of must-be-unchanged fields. status may
-- change freely (a receipt moves an invoice to Paid) because it is not listed.

-- ---------------------------------------------------------------------------
-- (b) invoice_payments INSERT — REMOVED. It cannot succeed.
-- ---------------------------------------------------------------------------
-- An August receipt against a July invoice has payment_date in August, and
-- trg_invoice_payments_period_lock keys on payment_date, so it never meets the
-- lock. The carve-out is only reachable when someone backdates payment_date
-- into a closed month — precisely what the lock exists to refuse.
--
-- And it does not even achieve that. journal_on_invoice_payment posts via
-- post_journal(..., new.payment_date, ...), so the journal entry lands in the
-- closed month and trg_journal_entries_period_lock — which has no carve-out —
-- refuses it. Same transaction, so the whole thing aborts anyway.
--
-- The carve-out therefore never let a backdated receipt through. It only moved
-- the failure from a clear message on invoice_payments to a confusing one on
-- journal_entries. A carve-out on one table that a downstream lock refuses
-- anyway is not a policy decision; it is a worse error message.

-- ---------------------------------------------------------------------------
-- (c) payslips — NARROWED, from "everything" to a named list.
-- ---------------------------------------------------------------------------
-- The old test was `period_month unchanged -> return new`, which returns
-- immediately and permits EVERY other column: final_salary, net_salary,
-- base_salary, bonus, deductions, advance, income_tax, eobi included.
--
-- Most of those are caught anyway, because journal_on_payslip reverses and
-- reposts the accrual at old.period_month and the journal lock refuses it. But
-- "most" was doing real work in that sentence and should not have to. The
-- protection was accidental and lived in a different function.
--
-- So the permitted set is now named explicitly, and anything outside it falls
-- through to the lock. Stated as a subtraction from the row rather than as a
-- list of protected columns deliberately: a column added to payslips tomorrow
-- is PROTECTED by default rather than silently permitted. Widening this list is
-- then a visible edit to this file, which is what a carve-out should cost.
--
-- period_month is not in the list, so moving a payslip between months is now
-- refused here rather than relying on the same accidental backstop.

-- ---------------------------------------------------------------------------
-- Also: the refusal now names the table that refused.
-- ---------------------------------------------------------------------------
-- Every raise below carried an identical message regardless of which trigger
-- fired. That makes the carve-outs untestable: an edit to payslips.final_salary
-- in a closed month raises the same text whether the payslips lock refused it
-- or the journal lock did, so a test asserting on the refusal passes even if the
-- payslips carve-out is wide open. The table name is appended so a test can
-- assert WHICH lock fired. This is the F5 rule from the fixture audit — assert
-- on the message, not on the fact that something raised — applied to the
-- message so it carries enough to assert on.

create or replace function public.enforce_period_lock()
returns trigger
language plpgsql
as $function$
declare
  -- The ONLY columns a payslip may change inside a closed month. Everything
  -- else falls through to the lock. See (c) above before adding to this list.
  c_payslip_open constant text[] := array[
    'disbursed', 'disbursed_at', 'amount_paid', 'status', 'payment_mode',
    'bank_account_id', 'cheque_id', 'cash_location_id', 'notes', 'updated_at'
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

  -- (a) invoices: a receipt updating the cumulative received total, and nothing
  -- else that would move the invoice itself.
  if tg_table_name = 'invoices' and tg_op = 'UPDATE' then
    if old.amount_received  is distinct from     new.amount_received
       and old.invoice_amount   is not distinct from new.invoice_amount
       and old.invoice_date     is not distinct from new.invoice_date
       and old.client_id        is not distinct from new.client_id
       and old.withholding_tax  is not distinct from new.withholding_tax
       and old.invoice_number   is not distinct from new.invoice_number
    then
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
  'Period close enforcement. Carve-outs: invoices.amount_received (cumulative, GL-neutral) and payslip disbursement fields only. See 0237 for why the invoice_payments INSERT carve-out was removed. The [table] suffix on each refusal names the trigger that refused, so a test can tell them apart.';

-- The triggers are unchanged and are asserted rather than assumed, because the
-- carve-outs above are written against specific date columns: (a) only makes
-- sense while invoices key on invoice_date, and (b)'s argument only holds while
-- invoice_payments key on payment_date.
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
      'Period lock wiring changed — expected trigger(s) missing or on a different date column: %. 0237''s carve-outs are written against these columns; re-read them before changing the wiring.',
      v_missing using errcode = '23514';
  end if;
end
$assert_wiring$;
