-- 0256 — journal_on_advance reposts on every field its posting reads.
--
-- NOT APPLIED TO PRODUCTION. Dev only.
--
-- THE DEFECT
--
-- journal_on_advance chooses its credit line from payment_mode:
--
--   when new.payment_mode = 'Cash' then cash_account_for(company, cash_location_id)
--   else                                 the 'bank' control account
--
-- and its repost condition watched amount, branch_id and cash_location_id.
-- payment_mode was read and not watched. Measured on dev, open month, rolled
-- back:
--
--   credit line after INSERT (Cash) : a44fb748…  (= cash_account_for(location))
--   credit line after UPDATE (Bank) : a44fb748…  (STILL the cash location)
--   journal entries for the advance : 1
--
-- The money left the bank and the ledger said it left the cash box. Both of the
-- control accounts G1 and G2 are about to reconcile would have been wrong, in
-- opposite directions, by the amount of every advance whose mode was corrected
-- after entry.
--
-- HOW MUCH IT HAS COST SO FAR: NOTHING. Measured on both databases, by netting
-- credits and debits per account per advance so reversals cancel:
--
--   prod : 1 advance, 2,000.00, credited to bank, payment_mode 'Bank'  — correct
--   dev  : 1 advance, 2,000.00, credited to bank, payment_mode 'Bank'  — correct
--
-- Zero advances have ever switched mode. The rupee effect on the cash control
-- and the bank control is 0.00 before this migration and 0.00 after it, on both
-- environments, and no backfill is required. The defect is real and has never
-- fired. That is worth stating precisely rather than leaving "fixed" to imply
-- damage was undone: G1's residuals are NOT contaminated by this.
--
-- THE FIX, AND WHY IT IS WIDER THAN payment_mode
--
-- The repost set now contains every field the posting reads:
--
--   amount              already there — both line amounts
--   branch_id           already there — the posting's region argument
--   cash_location_id    already there — the Cash credit account
--   payment_mode        NEW — chooses Cash vs bank
--   advance_date        NEW — the date the entry is posted at
--   employee_id         NEW — a dimension on the receivable line
--   client_id           NEW — a dimension on the receivable line
--
-- advance_date is included because it is the same defect on the same function,
-- proven by the same method: the posting is dated new.advance_date and the
-- condition never compared it, so moving an advance between months left the
-- entry in the old month. Fixing payment_mode and leaving that would be fixing
-- the instance rather than the function.
--
-- With this, journal_on_advance becomes the SECOND trigger of twelve whose
-- repost set covers everything its posting reads. journal_on_invoice is the
-- first, and only because G0.2 forced that audit. The other nine are inventoried
-- in docs/REPOST_SET_AUDIT.md and are NOT fixed here — each one changes GL
-- behaviour and deserves its own decision.

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
       or old.cash_location_id is distinct from new.cash_location_id
       or old.payment_mode     is distinct from new.payment_mode
       or old.advance_date     is distinct from new.advance_date
       or old.employee_id      is distinct from new.employee_id
       or old.client_id        is distinct from new.client_id then
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
$function$;

comment on function public.journal_on_advance() is
  'Posts the employee advance. Its repost condition covers every field the posting reads - amount, branch_id, cash_location_id, payment_mode, advance_date, employee_id, client_id. 0256 added the last four; before that a Cash->Bank correction left the credit on the cash location. See docs/REPOST_SET_AUDIT.md for the nine triggers still narrower than their postings.';
