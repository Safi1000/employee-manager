-- 0255 — G0.3. Carve-outs for advances, cheques and expenses, in the same
-- subtraction form as payslips (0237) and invoices (0253).
--
-- NOT APPLIED TO PRODUCTION. Dev only.
--
-- WHY THESE THREE NEEDED ANYTHING AT ALL
--
-- enforce_period_lock guards seven tables. Four of them had been reasoned about
-- and exercised: payslips and invoices have carve-outs, invoice_payments has one
-- deliberately removed, journal_entries has none by design. advances, cheques
-- and expenses had never been exercised by any suite on either environment, and
-- they refuse EVERYTHING in a closed month.
--
-- Refusing everything sounds like the safe default. It is the over-reach 0237
-- identified for invoices.amount_received, stated once more:
--
--   locking a row confuses "this row is DATED in a closed period" with
--   "this is a POSTING into a closed period". Only the second is what
--   period close means.
--
-- Measured on dev, in a closed month, rolled back:
--
--   cheque pending -> cleared        refused by [cheques]
--   cheque notes-only edit           refused by [cheques]
--
-- The second is plainly wrong: writing a note on a July cheque in August is not
-- a posting into July. The first is NOT plainly wrong, and is left refused —
-- see below, because the reason is the interesting part.
--
-- WHAT IS PERMITTED, AND WHY EACH LIST IS SHORT
--
-- Derived from what each table's journal trigger actually reads, checked against
-- the live prosrc rather than against comments:
--
--   journal_on_advance   reposts on  amount, branch_id, cash_location_id
--   journal_on_expense   reposts on  amount, payment_mode, category_id,
--                                    branch_id, cash_location_id
--   journal_on_cheque    posts on the transition into 'cleared', AT cheque_date
--
-- and against the region triggers, which matter because they widen the set
-- silently: inherit_region_expense fires on client_id and inherit_region_advance
-- on employee_id/client_id, both writing branch_id — which IS in the repost set.
-- So changing a client on an expense does repost, through a trigger that is not
-- the journal trigger. That was a suspected defect until it was probed; it is
-- not one, and it is written down here so it is not re-suspected.
--
--   advances  : notes, updated_at
--   expenses  : notes, receipt_path, receipt_file_name, drive_file_id,
--               drive_view_url, updated_at,
--               payable_status, paid_via, paid_bank_account_id, paid_at
--   cheques   : notes, attachment_path, attachment_file_name, drive_file_id,
--               drive_view_url, updated_at
--
-- THE SETTLEMENT COLUMNS ARE IN, AND THE CLEARING COLUMNS ARE OUT. THAT IS THE
-- WHOLE POINT OF THIS MIGRATION.
--
-- Both are the same workflow: a document dated in July, completed in August.
-- They are treated differently because the two posting functions disagree about
-- which date the completion posts at.
--
--   journal_on_expense_settlement  posts at coalesce(new.paid_at, current_date)
--   journal_on_cheque              posts at new.cheque_date
--
-- Settling a July payable in August therefore posts into AUGUST, which is open,
-- which is correct, and which makes the settlement columns genuinely GL-neutral
-- with respect to the closed month. Clearing a July cheque in August posts into
-- JULY. Permitting `status` here would let the carve-out wave it through and
-- leave trg_journal_entries_period_lock to refuse it — the wrong-lock pathology
-- 0237 removed carve-out (b) for and 0253 removed from invoices. So `status`
-- stays refused, by the lock that names itself, until the posting date is fixed.
--
-- That fix is G3's, not this migration's: unpresented cheques post Dr expense /
-- Cr Unpresented Cheques at issue and Dr Unpresented / Cr Bank AT CLEARANCE.
-- Once clearing posts at the clearance date, `status` and `cleared_at` become
-- as GL-neutral as the settlement columns are now, and belong in this list.
-- Until then a July cheque cannot be cleared after July closes, and that is a
-- known, named operational limit rather than an oversight.
--
-- ONE EDGE RECORDED RATHER THAN SMOOTHED OVER
--
-- Withdrawing a settlement (payable_status Paid -> not Paid) reverses at
-- coalesce(old.paid_at, old.expense_date). With paid_at set — every path in the
-- app sets it — that is the open month. With paid_at NULL it falls back to
-- expense_date and lands in the closed month, where the journal lock refuses it
-- and names [journal_entries]. Same wrong-lock shape, reachable only through a
-- row whose paid_at was never written. Not fixed here; fixing it means changing
-- what the reversal dates against, which is a posting-rules decision.
--
-- REACH: accounting_periods is empty on both environments. No path in this repo
-- has executed any of these branches. Structural, as 0237 and 0253 were.

create or replace function public.enforce_period_lock()
returns trigger
language plpgsql
as $function$
declare
  -- payslips: disbursement fields only. 0237 (c).
  c_payslip_open constant text[] := array[
    'disbursed', 'disbursed_at', 'amount_paid', 'status', 'payment_mode',
    'bank_account_id', 'cheque_id', 'cash_location_id', 'notes', 'updated_at'
  ];
  -- invoices: the receipt, the status, the attached document. 0253.
  c_invoice_open constant text[] := array[
    'amount_received', 'status', 'notes', 'updated_at',
    'attachment_path', 'attachment_file_name', 'drive_file_id', 'drive_view_url'
  ];
  -- advances: nothing about an advance completes later. Only annotation. 0255.
  c_advance_open constant text[] := array[
    'notes', 'updated_at'
  ];
  -- expenses: annotation, the receipt document, and the payable settlement,
  -- which posts at paid_at and therefore into the open month. 0255.
  c_expense_open constant text[] := array[
    'notes', 'updated_at',
    'receipt_path', 'receipt_file_name', 'drive_file_id', 'drive_view_url',
    'payable_status', 'paid_via', 'paid_bank_account_id', 'paid_at'
  ];
  -- cheques: annotation and document ONLY. status/cleared_at are deliberately
  -- absent because clearing posts at cheque_date. See the header, and G3.
  c_cheque_open constant text[] := array[
    'notes', 'updated_at',
    'attachment_path', 'attachment_file_name', 'drive_file_id', 'drive_view_url'
  ];
  v_open     text[];
  v_date_col text;
  v_new_date date;
  v_old_date date;
  v_company  uuid;
begin
  v_date_col := tg_argv[0];

  if public.current_company_id() is null and not public.is_ssa_unscoped() then
    return coalesce(new, old);
  end if;

  -- (b) the invoice_payments INSERT carve-out is deliberately absent. 0237.
  --
  -- One dispatch for all five carve-out tables, so a table added here cannot be
  -- given a list that nothing consults, and a list cannot be given a table that
  -- never reads it. The previous shape repeated the same three lines per table.
  if tg_op = 'UPDATE' then
    v_open := case tg_table_name
                when 'payslips' then c_payslip_open
                when 'invoices' then c_invoice_open
                when 'advances' then c_advance_open
                when 'expenses' then c_expense_open
                when 'cheques'  then c_cheque_open
                else null
              end;
    if v_open is not null
       and (to_jsonb(old) - v_open) is not distinct from (to_jsonb(new) - v_open) then
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
  'Period close enforcement for seven tables. Five carry a carve-out stated as a subtraction, so a column added to any of them tomorrow is protected by default: payslips (disbursement), invoices (receipt/status/document), advances (annotation), expenses (annotation/document/payable settlement), cheques (annotation/document only - clearing is excluded because journal_on_cheque posts at cheque_date; see 0255 and G3). invoice_payments INSERT has no carve-out (0237) and journal_entries never had one. The [table] suffix on each refusal names the trigger that refused.';

-- ---------------------------------------------------------------------------
-- Disjointness, per table.
-- ---------------------------------------------------------------------------
-- 0253's assertion generalised: no carve-out may permit a column its own table's
-- posting function reads to decide WHAT or WHERE to post. Written out rather
-- than grepped from prosrc, because a prosrc grep is not a check (§9.6). The
-- duplication is the cost, and this assertion is what makes the duplication
-- visible when somebody widens a list without re-reading the trigger.
do $assert_disjoint$
declare
  v_bad text := '';
  r record;
begin
  for r in
    select * from (values
      ('invoices', array['amount_received','status','notes','updated_at','attachment_path','attachment_file_name','drive_file_id','drive_view_url'],
                   array['invoice_amount','tax_added_total','period_start','invoice_date','client_id','branch_id']),
      ('advances', array['notes','updated_at'],
                   array['amount','branch_id','cash_location_id','payment_mode','employee_id','client_id']),
      ('expenses', array['notes','updated_at','receipt_path','receipt_file_name','drive_file_id','drive_view_url','payable_status','paid_via','paid_bank_account_id','paid_at'],
                   array['amount','payment_mode','category_id','branch_id','cash_location_id','client_id']),
      ('cheques',  array['notes','updated_at','attachment_path','attachment_file_name','drive_file_id','drive_view_url'],
                   array['status','cleared_at','amount','cheque_date','direction','cheque_type','custodian_location_id','branch_id'])
    ) as t(tbl, permitted, reposts)
  loop
    if exists (select 1 from unnest(r.permitted) p where p = any (r.reposts)) then
      v_bad := v_bad || r.tbl || ': '
            || (select string_agg(p, ', ') from unnest(r.permitted) p where p = any (r.reposts)) || '; ';
    end if;
  end loop;

  if v_bad <> '' then
    raise exception
      'A period-lock carve-out permits a column its posting function reads: %. See 0255.', v_bad
      using errcode = '23514';
  end if;
end
$assert_disjoint$;

-- Wiring, re-asserted: every carve-out above is written against a specific date
-- column, and the cheques decision in particular is written against cheque_date.
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
