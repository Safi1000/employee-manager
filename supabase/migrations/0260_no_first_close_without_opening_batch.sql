-- 0260 — A company cannot close its first period without a posted opening batch.
--
-- NOT APPLIED TO PRODUCTION. Dev only. Prod is closed to changes without
-- named approval.
--
-- WHY
--
-- SANDBOX ran for three months with 7,510,101.00 of bank money sitting in
-- bank_accounts.opening_balance and nothing in the general ledger, and every
-- reconciliation stayed as green as it had ever been, because the two checks
-- that would have caught it (0239) did not exist yet and the one that did
-- compared the GL against MOVEMENT — a basis chosen precisely to paper over
-- the missing openings.
--
-- The first period close is the moment that stops being recoverable. After it,
-- enforce_period_lock refuses the very entries that would fix it, so an opening
-- balance omitted before the first close has to be corrected by reopening a
-- closed period — which is a decision with an audit trail, not a keystroke.
--
-- So the check belongs at the close, not in a runbook.
--
-- SHAPE
--
-- The gate fires only on a company's FIRST close. Subsequent closes are not its
-- business: by then either the openings are posted or the company deliberately
-- has none, and re-asking every month would be noise.
--
-- "Posted" is the required status. A draft batch is an intention; only
-- post_opening_balances() writes the journal entry, and only after proving
-- Dr = Cr via opening_batch_totals().
--
-- NOTHING IS GRANDFATHERED, BECAUSE THERE IS NOTHING TO GRANDFATHER.
-- accounting_periods is empty on BOTH environments — 0 rows on prod, 0 on dev —
-- so no existing close is affected and no exemption clause is needed. Had there
-- been rows, this would have needed one; recorded so the next reader knows the
-- absence was checked rather than assumed.
--
-- THE ONE COMPANY THIS INCONVENIENCES
--
-- A company that genuinely opens at zero has nothing to put in a batch, and
-- post_opening_balances() refuses a batch with no lines. Its escape is to post
-- a single 0.00 / 0.00 line, which balances and satisfies the gate. That is a
-- deliberate choice of an explicit "we opened at nothing" record over a silent
-- exemption — the assertion is the point, and an empty batch asserts it.

create or replace function public.require_opening_batch_before_first_close()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- Only the first close is gated.
  if exists (
    select 1 from public.accounting_periods p
     where p.company_id = new.company_id
       and p.id is distinct from new.id
  ) then
    return new;
  end if;

  if not exists (
    select 1 from public.opening_balance_batches b
     where b.company_id = new.company_id
       and b.status = 'posted'
  ) then
    raise exception
      'cannot close the first period for this company without a posted opening balance batch'
      using errcode = '23514',
            hint = 'Create an opening_balance_batches row with its opening_balance_lines, then post it with post_opening_balances(). A company opening at zero should post a single 0.00/0.00 line so the fact is recorded.';
  end if;

  return new;
end;
$function$;

comment on function public.require_opening_batch_before_first_close() is
  'Refuses a company''s FIRST accounting_periods row unless a posted opening_balance_batches row exists. Later closes pass unconditionally. Added in 0260 after SANDBOX carried 7,510,101.00 of unjournalised bank openings for three months.';

drop trigger if exists trg_bbb_first_close_needs_openings on public.accounting_periods;

create trigger trg_bbb_first_close_needs_openings
  before insert on public.accounting_periods
  for each row
  execute function public.require_opening_batch_before_first_close();
