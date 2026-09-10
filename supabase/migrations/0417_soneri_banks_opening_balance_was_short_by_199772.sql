-- 0417: Soneri Bank's opening balance is 775,855.23, not 576,083.00.
--
-- Given by the user as the figure standing at 1 September 2026. The account
-- carries no date on its opening — `bank_accounts.opening_balance` is a scalar —
-- so the date is recorded here and nowhere else. See the note on the batch at
-- the bottom of this header, which is the one place a date does exist and does
-- not say the 1st.
--
-- THIS IS NOT A MONEY MOVEMENT, and the difference decides how it is written.
-- `apply_money_delta()` (0380) is the only way a balance moves, and every screen
-- was taken off direct balance writes for it. This is not that: no money entered
-- the account, the figure it started from was wrong. Routing it through
-- `apply_money_delta` would file a 199,772.23 bank_transactions row for a
-- deposit that never happened — and would then be double-counted, because:
--
--   bank_ops.movement = sum(balance - opening_balance)
--   bank_tx.delta     = sum(account_delta) where kind <> 'opening'
--   check             = movement equals delta   (bank_accounts_equal_transaction_deltas)
--
-- Moving BOTH columns by the same amount leaves `balance - opening_balance`
-- untouched and the check reads exactly as it did before. Moving the balance
-- alone through the helper would leave the opening wrong and log a fiction.
-- Asserted below on both sides rather than argued: the check's own two operands
-- are read before and after and must be unchanged.
--
-- The balance moves with the opening because Soneri has posted no operational
-- movement — its only bank_transactions row is a pending MIU cheque carrying
-- account_delta 0, and balance still equals opening exactly. Were that not so
-- this migration would be wrong to touch `balance` at all, so it refuses unless
-- the two are equal going in.
--
-- THE DRAFT OPENING BATCH IS EDITED TOO, and this is the half that would
-- otherwise rot. `opening_balance_batches` holds one unposted batch whose seven
-- lines were copied out of these very columns — the Soneri line's own note says
-- `bank_accounts.opening_balance — Soneri Bank — 0021302080546878`. Nothing
-- regenerates it: `OpeningBalances.tsx` inserts and deletes lines by hand. Left
-- alone, the batch would post 576,083.00 into the general ledger against a bank
-- account holding 775,855.23, and it would post it as a correct-looking balanced
-- entry. The balancing Opening Balance Equity credit moves by the same
-- 199,772.23 so the batch stays balanced, which `post_opening_balances` requires
-- and which is asserted here anyway.
--
-- DEFERRED — the batch's `as_of_date` is 2026-09-03 and the user said the 1st.
-- It is NOT moved here: it dates all seven lines, including four other banks, a
-- custodian and 27 clients' receivables, none of which was asked about. If the
-- opening is meant to stand at 1 September the whole batch should move, and
-- that is a separate decision about the other six lines. Until it is taken, the
-- ledger will open this company on the 3rd.
--
-- Nothing here is company-wide: every statement is scoped to the one account
-- resolved by bank name and account number, and refuses if that is not exactly
-- one row.
do $$
declare
  v_acct      uuid;
  v_company   uuid;
  v_batch     uuid;
  v_open      numeric;
  v_bal       numeric;
  v_delta     constant numeric := 199772.23;
  v_target    constant numeric := 775855.23;
  v_line_acct uuid;
  v_eq_acct   uuid;
  v_move_before numeric;
  v_move_after  numeric;
  v_tx_before   numeric;
  v_tx_after    numeric;
  v_dr        numeric;
  v_cr        numeric;
  v_n         int;
begin
  -- The account, by natural key. No generated id is written into this file.
  select b.id, b.company_id, b.opening_balance, b.balance
    into v_acct, v_company, v_open, v_bal
    from public.bank_accounts b
   where b.bank_name = 'Soneri Bank'
     and b.account_number = '0021302080546878';
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception '0417: Soneri Bank 0021302080546878 resolves to % account(s), expected 1', v_n;
  end if;

  if v_open <> 576083.00 then
    raise exception '0417: opening balance is %, expected the 576083.00 this corrects — someone has already changed it', v_open;
  end if;
  if v_bal <> v_open then
    raise exception '0417: balance % has moved away from opening % — this account now carries operational movement and the balance must not be dragged with the opening', v_bal, v_open;
  end if;
  if v_open + v_delta <> v_target then
    raise exception '0417: % + % is not the % given', v_open, v_delta, v_target;
  end if;

  -- The check's two operands, before.
  select coalesce(sum(b.balance - coalesce(b.opening_balance, 0)), 0) into v_move_before
    from public.bank_accounts b where b.company_id = v_company;
  select coalesce(sum(t.account_delta) filter (where t.kind <> 'opening'), 0) into v_tx_before
    from public.bank_transactions t where t.company_id = v_company;

  update public.bank_accounts
     set opening_balance = v_target,
         balance         = v_target,
         updated_at      = now()
   where id = v_acct;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception '0417: updated % bank_accounts rows, expected 1', v_n;
  end if;

  -- The draft batch. Refuse if there is not exactly one unposted batch holding a
  -- line for this account: a posted batch is a journal entry and correcting one
  -- is a reversal, not an update, and that is not what this migration does.
  select l.batch_id, l.account_id into v_batch, v_line_acct
    from public.opening_balance_lines l
    join public.opening_balance_batches ba on ba.id = l.batch_id
    join public.chart_of_accounts a on a.id = l.account_id
   where ba.company_id = v_company
     and ba.status = 'draft'
     and ba.journal_entry_id is null
     and a.account_code = '1010.01';
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception '0417: found % draft opening line(s) for account 1010.01, expected 1 — refusing to guess which opening this is', v_n;
  end if;

  update public.opening_balance_lines
     set debit = v_target
   where batch_id = v_batch and account_id = v_line_acct and debit = 576083.00;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception '0417: the Soneri opening line did not read 576083.00 — updated % row(s)', v_n;
  end if;

  select a.id into v_eq_acct
    from public.chart_of_accounts a
   where a.company_id = v_company and a.system_key = 'opening_balance_equity';
  if v_eq_acct is null then
    raise exception '0417: no opening_balance_equity account — the batch cannot be rebalanced';
  end if;

  update public.opening_balance_lines
     set credit = credit + v_delta
   where batch_id = v_batch and account_id = v_eq_acct;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception '0417: rebalanced % equity line(s), expected 1', v_n;
  end if;

  -- Assert the things that can break.
  --
  -- One: the batch still balances. A batch that no longer does is refused by
  -- post_opening_balances later, in a session that will not know why.
  select coalesce(sum(debit), 0), coalesce(sum(credit), 0) into v_dr, v_cr
    from public.opening_balance_lines where batch_id = v_batch;
  if v_dr <> v_cr then
    raise exception '0417: batch is out by % — debits % credits %', v_dr - v_cr, v_dr, v_cr;
  end if;
  if v_dr <> 29815807.23 then
    raise exception '0417: batch totals %, expected 29815807.23', v_dr;
  end if;

  -- Two: the bank reconciliation check reads exactly as it did. Both operands
  -- are re-read rather than assumed — the point of moving the two columns
  -- together is that neither side may have shifted, and only the operands can
  -- say so.
  select coalesce(sum(b.balance - coalesce(b.opening_balance, 0)), 0) into v_move_after
    from public.bank_accounts b where b.company_id = v_company;
  select coalesce(sum(t.account_delta) filter (where t.kind <> 'opening'), 0) into v_tx_after
    from public.bank_transactions t where t.company_id = v_company;

  if v_move_after <> v_move_before or v_tx_after <> v_tx_before then
    raise exception '0417: bank movement moved from %/% to %/% — this was supposed to change neither',
      v_move_before, v_tx_before, v_move_after, v_tx_after;
  end if;
  if v_move_after <> v_tx_after then
    raise exception '0417: bank_accounts_equal_transaction_deltas is now out by %', v_move_after - v_tx_after;
  end if;

  -- Three: no bank_transactions row was filed. Named explicitly because the
  -- whole argument of the header is that none should be.
  select count(*) into v_n from public.bank_transactions
   where bank_account_id = v_acct and abs(account_delta) = v_delta;
  if v_n <> 0 then
    raise exception '0417: % transaction row(s) logged for a correction that moved no money', v_n;
  end if;

  raise notice '0417: Soneri opening and balance set to %, draft batch line and equity moved by %', v_target, v_delta;
end $$;

-- TENANT GUARD ASSERTION NOT APPLICABLE: this migration defines no function and
-- adds no parameter, so it introduces no guard to gap. The detector is asserted
-- anyway — a green run is evidence about the database, not only about this file.
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception 'REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
