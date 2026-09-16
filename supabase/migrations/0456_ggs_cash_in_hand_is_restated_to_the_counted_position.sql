-- 0456 — GGS's cash in hand is restated from 85,838.00 to -103,931.00.
--
-- Authorised by name: the counted cash position for GUARDS AND GUIDES (PVT) LTD
-- is a deficit of 103,931, and the books say 85,838. This migration moves the
-- difference, -189,769.00, so the Cash in Hand card reads the counted figure.
--
-- WHY AN ADJUSTMENT AND NOT A RESTATED OPENING. The first draft of this file
-- rewrote the `opening` row's cash_delta instead. That would have meant
-- overriding two guards 0390 put on set_cash_opening_balance and 0454 re-stated
-- ("an opening must be zero or more", "it is recorded once"), and — worse —
-- asserting a claim about history that nobody has made: that the company STARTED
-- 189,769 short. Nothing establishes that. What is actually known is that today's
-- count disagrees with today's book by 189,769, which is a correction dated
-- today, not a different past.
--
-- So this uses the instrument the schema already has for exactly this: a
-- `cash_adjustment` transaction through apply_money_delta(), the one definition
-- of how a cash balance moves (0380). Consequences of that choice, all intended:
--
--   * No guard is overridden and set_cash_opening_balance is untouched. A future
--     opening still cannot be negative and still cannot be re-set.
--   * The correction is VISIBLE — a dated, described, signed row in the cash
--     transaction log, which a silent rewrite of the opening would not have been.
--   * It is reversible by posting the opposite adjustment. Rewriting history is
--     not.
--   * The row and the balance move in ONE transaction under the row lock, because
--     apply_money_delta is what does both.
--
-- The opening row is deliberately LEFT at 0.00. The "Opening: PKR 0" line on the
-- Accounting screen reads that row's cash_delta and will keep saying 0, which is
-- honest: the opening was never established (it is the zero-branch stub written
-- 2026-09-03), and this migration does not claim to have established it.
-- DEFERRED: what GGS's opening cash actually was is unasked and still owed an
-- answer. If it is ever established, it is a separate change and the adjustment
-- posted here should be revisited so the correction is not double-counted.
--
-- NOTE ON A PRE-EXISTING DISCREPANCY, which this file neither caused nor hides:
-- treasury.cash_balance (85,838.00) and sum(bank_transactions.cash_delta)
-- (87,231.00) already disagree by 1,393.00 on this company. treasury is running
-- arithmetic maintained under the row lock by apply_money_delta, not a fold of
-- the transaction table, so the two are not required to agree and nothing here
-- asserts that they do. This migration targets treasury.cash_balance, which is
-- what the screen reads. The 1,393.00 gap survives it unchanged and is DEFERRED.
--
-- IDEMPOTENCY (whole file, per the project rule). apply_money_delta INSERTS, so a
-- naive replay would subtract 189,769 twice. Two things prevent it: the movement
-- is tagged with a reference_id unique to this migration and skipped outright if
-- that tag is already present, and the delta is computed as "target minus what
-- the balance actually is now" rather than hardcoded, so it is self-correcting
-- and lands on the target rather than past it.

do $mig$
declare
  v_company constant uuid    := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';  -- GUARDS AND GUIDES (PVT) LTD
  v_target  constant numeric := -103931;
  v_ref     constant text    := 'migration-0456-cash-restatement';
  v_current numeric;
  v_delta   numeric;
begin
  if exists (select 1 from public.bank_transactions
              where company_id = v_company and reference_id = v_ref) then
    raise notice '0456: already applied (reference_id %). Nothing to do.', v_ref;
    return;
  end if;

  -- Lock the treasury row BEFORE reading the figure the delta is computed from.
  -- Reading a balance, computing against it and writing later is the race this
  -- project removed from the frontend; a migration is not exempt from it.
  select cash_balance into v_current
    from public.treasury
   where company_id = v_company
   for update;

  if not found then
    raise exception
      '0456 FAILED: GGS has no treasury row, so there is no cash balance to '
      'restate. Nothing has been changed.';
  end if;

  v_delta := v_target - v_current;

  if v_delta = 0 then
    raise notice '0456: cash is already at %. Nothing to do.', v_target;
    return;
  end if;

  -- The one definition of how cash moves (0380). It updates treasury under the
  -- lock we already hold and writes the matching transaction row in the same
  -- statement, so the balance and its evidence cannot diverge.
  perform public.apply_money_delta(
    v_company,
    'Cash',
    null,
    v_delta,
    'cash_adjustment',
    'Cash in hand restated to the counted position (0456)',
    v_ref);
end $mig$;

-- ── verification ───────────────────────────────────────────────────────────────
-- Assert on the thing that can break, not on the thing that moved. That a row was
-- inserted was never in doubt. What can break is the balance landing anywhere
-- other than the counted figure — short, or double-applied — so the target is
-- asserted ABSOLUTELY rather than as a difference from a before-count, which
-- would pass whether or not it landed where it was aimed.
do $mig$
declare
  v_company constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_ref     constant text := 'migration-0456-cash-restatement';
  v_balance numeric;
  v_n       int;
begin
  select cash_balance into v_balance
    from public.treasury where company_id = v_company;
  if v_balance is distinct from -103931 then
    raise exception
      '0456 FAILED: GGS cash_balance is %, expected -103931.', v_balance;
  end if;

  -- Exactly one correction row, which is the assertion that catches a double
  -- application even if the arithmetic happened to agree.
  select count(*) into v_n
    from public.bank_transactions
   where company_id = v_company and reference_id = v_ref;
  if v_n <> 1 then
    raise exception
      '0456 FAILED: found % rows tagged %, expected exactly 1.', v_n, v_ref;
  end if;

  -- The opening stub is explicitly NOT touched. Asserting it stayed 0 is what
  -- stops a later edit of this file from quietly turning an adjustment back into
  -- a rewritten history.
  select cash_delta into v_balance
    from public.bank_transactions
   where company_id = v_company and kind = 'opening' and bank_account_id is null;
  if v_balance is distinct from 0 then
    raise exception
      '0456 FAILED: the opening row is now %, expected it to be left at 0. This '
      'migration corrects the balance and must not restate the opening.', v_balance;
  end if;
end $mig$;

-- Tenant guard assertion. This migration defines no function and adds no guard,
-- so it is tempting to call it not-applicable — but "my change could not possibly
-- have opened a hole" is the reasoning that preceded 0348, 0352 and 0363. The
-- detector is cheap and it is the only thing that actually knows.
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
  '— the two are not required to agree, and on GGS they differ by 1,393.00 from '
  'before 0456. DEFERRED: where that 1,393.00 originated, and whether treasury '
  'should be reconcilable to the transaction table at all, is unasked. 0456 '
  'restated GGS cash to a counted -103,931.00 via a cash_adjustment and left both '
  'that gap and the 0.00 opening stub untouched.';
