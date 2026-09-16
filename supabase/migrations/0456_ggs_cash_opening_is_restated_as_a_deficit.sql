-- 0456 — GGS's opening cash balance is restated from 0 to a deficit of 103,931.
--
-- A data correction to ONE company's opening row, authorised by name. It is a
-- migration rather than a console UPDATE because it deliberately overrides two
-- guards that 0390 put on set_cash_opening_balance (and that 0454 re-stated),
-- and an override that leaves no record teaches the next reader the guards are
-- advisory. They are not. They are overridden HERE, once, for this row:
--
--   1. "An opening cash balance must be zero or more."  The guard is right about
--      the ordinary case: an opening you TYPE is a count of physical cash, and
--      you cannot count minus money. This figure is not a count. It is the
--      carried-forward position of a book that was already short, which is a
--      real state and the only one that reconciles to what GGS actually holds.
--   2. "It is recorded once and cannot be set again."  The row was written on
--      2026-09-03 at 0.00 — the zero-branch insert, i.e. the opening was never
--      actually established, only stubbed. Restating a stub is what that guard
--      exists to prevent when the figure was real, and is exactly what has to
--      happen when it was not.
--
-- Neither guard is relaxed in the function. A future opening still cannot be
-- negative and still cannot be re-set through the RPC. That is deliberate: this
-- is a correction, not a new policy. If negative openings become ordinary,
-- change set_cash_opening_balance on purpose and say so there.
--
-- The screen: Accounting.tsx derives the "Opening: PKR …" card from this row's
-- cash_delta (there is no second opening flag since 0280), so restating
-- cash_delta IS the user-visible change. amount follows apply_money_delta's
-- convention — abs() of the delta, with cash_delta carrying the sign.
--
-- treasury.cash_balance moves by the DIFFERENCE, not to a recomputed total.
-- Note well: treasury.cash_balance (85,838.00) and sum(bank_transactions.
-- cash_delta) (87,231.00) already disagree by 1,393.00 on this company, and have
-- since before this migration. treasury is maintained as running arithmetic
-- under the row lock by apply_money_delta, not as a fold of the transaction
-- table, so the two are not required to agree and nothing here asserts that they
-- do. Moving by the difference PRESERVES that pre-existing 1,393.00 gap rather
-- than silently absorbing it into this correction, which is the honest
-- disposition: this migration did not cause it and must not hide it.
-- DEFERRED: where that 1,393.00 came from, and whether treasury should be
-- reconcilable to the transaction table at all, is unasked and still owed an
-- answer. It is NOT settled by this file.
--
-- Idempotency (whole file, per the project rule): the restatement is written as
-- "set to target, move treasury by target − current". On replay current already
-- equals target, the difference is zero, and both writes are no-ops in effect.
-- There is no way to subtract 103,931 twice.

do $mig$
declare
  v_company  constant uuid    := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';  -- GUARDS AND GUIDES (PVT) LTD
  v_target   constant numeric := -103931;
  v_tx_id    uuid;
  v_current  numeric;
  v_diff     numeric;
  v_n        int;
begin
  -- Lock the opening row first: the figure is read, differenced and written, and
  -- a concurrent set_cash_opening_balance racing between the read and the write
  -- is the same defect this project removed from the frontend.
  select id, cash_delta into v_tx_id, v_current
    from public.bank_transactions
   where company_id = v_company
     and kind = 'opening'
     and bank_account_id is null
   for update;

  if not found then
    raise exception
      '0456 FAILED: GGS has no cash opening row to restate. Expected exactly one '
      '(kind=opening, bank_account_id is null). Nothing has been changed.';
  end if;

  -- "Exactly one" is the precondition the SELECT above cannot state on its own —
  -- it would silently take the first of several. If there are two openings, the
  -- premise of this correction is wrong and it must not guess which to amend.
  select count(*) into v_n
    from public.bank_transactions
   where company_id = v_company and kind = 'opening' and bank_account_id is null;
  if v_n <> 1 then
    raise exception
      '0456 FAILED: expected exactly 1 cash opening row for GGS, found %. Refusing '
      'to guess which one is the opening. Nothing has been changed.', v_n;
  end if;

  v_diff := v_target - v_current;

  update public.bank_transactions
     set cash_delta  = v_target,
         amount      = abs(v_target),
         description = 'Opening cash balance'
   where id = v_tx_id;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception '0456 FAILED: opening row update touched % rows, expected 1.', v_n;
  end if;

  -- Only touch treasury when the figure actually moved. On replay v_diff is 0 and
  -- the balance is left exactly as it is.
  if v_diff <> 0 then
    update public.treasury
       set cash_balance = cash_balance + v_diff
     where company_id = v_company;
    get diagnostics v_n = row_count;
    if v_n <> 1 then
      raise exception
        '0456 FAILED: treasury update touched % rows for GGS, expected 1. The '
        'opening row and the balance must move together or not at all.', v_n;
    end if;
  end if;
end $mig$;

-- ── verification ───────────────────────────────────────────────────────────────
-- Assert on the thing that can break, not on the thing that moved. What can break
-- here is the PAIR: the opening reading the target while the balance did not
-- follow it, or followed it twice. So both are named absolutely.
do $mig$
declare
  v_company constant uuid    := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_opening numeric;
  v_amount  numeric;
  v_balance numeric;
begin
  select cash_delta, amount into v_opening, v_amount
    from public.bank_transactions
   where company_id = v_company and kind = 'opening' and bank_account_id is null;

  if v_opening <> -103931 then
    raise exception '0456 FAILED: opening cash_delta is %, expected -103931.', v_opening;
  end if;
  if v_amount <> 103931 then
    raise exception
      '0456 FAILED: opening amount is %, expected 103931 (abs of the delta, per '
      'apply_money_delta''s convention).', v_amount;
  end if;

  select cash_balance into v_balance from public.treasury where company_id = v_company;
  if v_balance <> -18093 then
    raise exception
      '0456 FAILED: GGS cash_balance is %, expected -18093 (85838 − 103931). The '
      'opening moved without the balance following it.', v_balance;
  end if;
end $mig$;

-- Tenant guard assertion. This migration defines no function and adds no guard,
-- so it is tempting to call it not-applicable — but "my change could not possibly
-- have opened a hole" is exactly the reasoning that preceded 0348, 0352 and 0363.
-- The detector is cheap and it is the only thing that actually knows.
do $mig$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception 'REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $mig$;

comment on table public.treasury is
  'Per-company cash position. cash_balance is running arithmetic maintained under '
  'the row lock by apply_money_delta(), NOT a fold of bank_transactions.cash_delta '
  '— the two are not required to agree and on GGS they differ by 1,393.00 from '
  'before 0456. DEFERRED: whether treasury should be reconcilable to the '
  'transaction table, and where that 1,393.00 originated, is unasked. 0456 '
  'preserved the gap rather than absorbing it.';
