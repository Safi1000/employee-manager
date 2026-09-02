-- 0321 — a column that records something that happened cannot be dated ahead.
--
-- No date column anywhere in the finance path had an upper bound. The survey
-- that produced this migration found one future-dated payment on production
-- (2026-09-15, created 2026-08-31, a sandbox fixture) whose journal entry
-- landed in a period nobody has reached.
--
-- THE RULE IS NOT "NO FUTURE DATES", AND THAT DISTINCTION IS THE MIGRATION.
--
--   A column recording something that HAPPENED is bounded.
--   A column recording something SCHEDULED is not.
--
-- Bounded here:
--   invoice_payments.payment_date       a receipt records money that arrived
--   expenses.expense_date               an expense records a cost incurred
--   advances.advance_date               an advance records money handed over
--   custody_transfers.date              a transfer records cash that moved
--   partner_account_entries.date        an entry records a movement
--
-- Deliberately NOT bounded, each for a reason that would have been broken by a
-- blanket rule:
--   cheques.cheque_date      A post-dated cheque is an ordinary instrument and
--                            its date is genuinely ahead. 0269 already moved
--                            the clearing posting to cleared_at, so a forward
--                            cheque_date drags no journal entry with it.
--   expenses.due_date        A payable due next month is a schedule.
--   invoices.invoice_date    An invoice dated ahead does NOT produce an entry
--                            dated ahead: A4 posts revenue at period_start.
--                            Production demonstrates it — FIX-SEP-COINCIDE
--                            (2026-09-30) and FIX-SEP-CROSS (2026-10-01) both
--                            post at 2026-09-01. run_auto_invoices dates
--                            invoice_date to the PREVIOUS month, never ahead.
--   payslips.period_month    A month label, not an event date. Its natural
--   payroll_runs.period_month  bound is the current month, not the current day.
--
-- WHY A TRIGGER AND NOT A CHECK CONSTRAINT.
-- Not because Postgres refuses `check (d <= current_date)` — it was probed on
-- dev and Postgres ACCEPTS it. Three measured reasons:
--   1. ADD CONSTRAINT validates existing rows, and one row on each database
--      already violates it. NOT VALID would leave a constraint nothing
--      enforces, which is worse than none.
--   2. A CHECK cannot tell "you are setting this date" from "you are editing
--      an unrelated field on an old row", so a pre-existing future-dated row
--      becomes permanently uneditable — the rule punishing the wrong action.
--   3. A trigger carries a legible message and honours
--      is_maintenance_session(), which is how enforce_period_lock already
--      behaves. One bypass, not two.
--
-- The one violating row is NOT corrected here. A trigger governs new writes;
-- deciding what to do with an existing fixture is not a migration's call.

create or replace function public.enforce_not_future_date()
returns trigger
language plpgsql
as $fn$
declare
  v_col  text := tg_argv[0];
  v_noun text := tg_argv[1];
  v_new  date;
  v_old  date;
begin
  -- Same single bypass as the period lock: app.ledger_maintenance = 'on' AND a
  -- superuser/bypassrls session_user.
  if public.is_maintenance_session() then
    return new;
  end if;

  execute format('select ($1).%I::date', v_col) into v_new using new;

  if tg_op = 'UPDATE' then
    execute format('select ($1).%I::date', v_col) into v_old using old;
    -- An update that does not touch the date makes no claim about the date.
    -- Without this, a row that predates the rule could never be annotated,
    -- corrected or attached to again.
    if v_old is not distinct from v_new then
      return new;
    end if;
  end if;

  if v_new > current_date then
    raise exception
      'This % is dated % — a date in the future. It records something that has already happened, so its date must be on or before today (%). [%.%]',
      v_noun, v_new, current_date, tg_table_name, v_col
      using errcode = 'P0001';
  end if;

  return new;
end;
$fn$;

comment on function public.enforce_not_future_date() is
  '0321: refuses a future date on a column that records a past event. tg_argv[0] is the column, tg_argv[1] the noun for the message. Deliberately not applied to cheque_date, due_date, invoice_date or the period_month columns — see the migration header for why each is different.';

drop trigger if exists trg_invoice_payments_not_future on public.invoice_payments;
create trigger trg_invoice_payments_not_future
  before insert or update on public.invoice_payments
  for each row execute function public.enforce_not_future_date('payment_date', 'payment');

drop trigger if exists trg_expenses_not_future on public.expenses;
create trigger trg_expenses_not_future
  before insert or update on public.expenses
  for each row execute function public.enforce_not_future_date('expense_date', 'expense');

drop trigger if exists trg_advances_not_future on public.advances;
create trigger trg_advances_not_future
  before insert or update on public.advances
  for each row execute function public.enforce_not_future_date('advance_date', 'advance');

drop trigger if exists trg_custody_transfers_not_future on public.custody_transfers;
create trigger trg_custody_transfers_not_future
  before insert or update on public.custody_transfers
  for each row execute function public.enforce_not_future_date('date', 'custody transfer');

drop trigger if exists trg_partner_account_entries_not_future on public.partner_account_entries;
create trigger trg_partner_account_entries_not_future
  before insert or update on public.partner_account_entries
  for each row execute function public.enforce_not_future_date('date', 'partner account entry');

-- ---------------------------------------------------------------------------
-- Proof.
--
-- Each guarded table is exercised BOTH ways against a real row: a forward date
-- must be refused, and a today date must be accepted. Only the refusal half
-- tests the trigger; only the acceptance half proves it is not a control that
-- fires on every input (report 9.11).
--
-- The refusal is asserted on its MESSAGE, not on the fact that something
-- raised. These same tables carry enforce_period_lock, and three earlier tests
-- in this project passed against the wrong trigger.
--
-- EVERY PROBE RUNS INSIDE A SUBTRANSACTION THAT IS ALWAYS ROLLED BACK, using
-- the deliberate-exception idiom the test harness uses. The first draft of this
-- block did the accepted-case probe for real and then "restored" the old date.
-- That is not a restore: changing a source date makes the app reverse and
-- repost its journal entry, and changing it back reverses and reposts again.
-- It left 16 entries and 32 lines of self-cancelling noise on dev. A probe that
-- writes has to unwind through the transaction, not through a compensating
-- write — a compensating write is another event, and the ledger records it.
-- ---------------------------------------------------------------------------
do $proof$
declare
  r record;
  v_id uuid;
  v_outcome text;
  v_tested int := 0;
  v_skipped text[] := '{}';
begin
  for r in
    select * from (values
      ('invoice_payments',        'payment_date'),
      ('expenses',                'expense_date'),
      ('advances',                'advance_date'),
      ('custody_transfers',       'date'),
      ('partner_account_entries', 'date')
    ) as t(tbl, col)
  loop
    execute format(
      'select id from public.%I where %I::date <= current_date order by %I desc limit 1',
      r.tbl, r.col, r.col)
      into v_id;

    if v_id is null then
      v_skipped := v_skipped || format('%s (no row dated today or earlier)', r.tbl);
      continue;
    end if;

    -- (a) a forward date must be REFUSED, with THIS rule's message. The
    -- exception unwinds the subtransaction, so nothing is written either way.
    v_outcome := null;
    begin
      execute format('update public.%I set %I = current_date + 30 where id = $1', r.tbl, r.col)
        using v_id;
      v_outcome := 'ACCEPTED';
    exception when others then
      v_outcome := sqlerrm;
    end;

    if v_outcome = 'ACCEPTED' then
      raise exception '0321 FAILED: %.% accepted a date 30 days ahead', r.tbl, r.col;
    end if;
    if position('a date in the future' in v_outcome) = 0 then
      raise exception '0321 FAILED: %.% refused a forward date for the WRONG reason: %', r.tbl, r.col, v_outcome;
    end if;

    -- (b) today must be ACCEPTED — a guard that refuses everything is not a
    -- guard, it is an outage. The deliberate raise at the end is what makes
    -- this probe leave nothing behind: reaching it means the update passed.
    v_outcome := null;
    begin
      execute format('update public.%I set %I = current_date where id = $1', r.tbl, r.col)
        using v_id;
      raise exception 'PROBE_ACCEPTED_ROLLBACK';
    exception when others then
      v_outcome := sqlerrm;
    end;

    if v_outcome <> 'PROBE_ACCEPTED_ROLLBACK' then
      raise exception '0321 FAILED: %.% refused TODAY as a date: %', r.tbl, r.col, v_outcome;
    end if;

    v_tested := v_tested + 1;
  end loop;

  -- Vacuity. A loop that tested nothing reports no failures either.
  if v_tested = 0 then
    raise exception '0321 FAILED: no table had a row to exercise, so nothing above was tested';
  end if;

  raise notice '0321 OK: % of 5 tables exercised both ways, nothing written. Skipped: %',
    v_tested, coalesce(array_to_string(v_skipped, ', '), 'none');
end
$proof$;
