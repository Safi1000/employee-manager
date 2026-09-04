-- 0390 — set_cash_opening_balance(): the last read-modify-write on a balance
--         in the codebase, and the "set once" rule the browser was keeping.
--
-- ===========================================================================
-- THE RACE, IN ITS PUREST FORM, ON THE CASH BALANCE ITSELF
-- ===========================================================================
--
-- handleSetCashOpening wrote:
--
--     .update({ cash_balance: cashBalance + amt })
--
-- where `cashBalance` is REACT STATE — a number read when the screen last
-- loaded, possibly minutes ago, possibly before an expense on another tab took
-- money out. Every other balance write in this codebase now does its
-- arithmetic inside the UPDATE, under the row lock; this one did it in a
-- browser and posted the answer.
--
-- It also wrote the `opening` ledger line in a SECOND round trip, so a refusal
-- there left the balance moved and nothing explaining it.
--
-- ===========================================================================
-- AND THE LOCK WAS ONLY EVER A UI STATE
-- ===========================================================================
--
-- The screen decides whether the opening may be set by looking for an existing
-- `opening` row with no bank account:
--
--     setCashOpeningLocked(Boolean(openingTx))
--
-- That is a correct rule and it lived entirely in the browser. A second tab, a
-- stale tab, or one direct API call sets the opening again — and because the
-- write ADDS (`cashBalance + amt`), setting it twice does not overwrite it, it
-- DOUBLES it. The cash balance goes up by the opening amount a second time and
-- the only trace is a second `opening` row that nothing was looking for.
--
-- So this migration moves the rule to where it can be enforced, twice over:
--
--   * The function refuses a second opening, with a message that says the
--     figure already recorded rather than just "no".
--   * A UNIQUE PARTIAL INDEX makes it impossible regardless of the function —
--     the structural version, because a check inside one function is only
--     enforced for callers who go through that function. Prod has exactly one
--     such row per company today, so the index takes without a repair.
--
-- ===========================================================================
-- WHY THERE IS NO p_company_id
-- ===========================================================================
--
-- current_company_id() already resolves coalesce(view_as_company, company_id),
-- which is the same expression the screen computes for treasuryCompanyId. A
-- parameter would be a claim to check against the session; the session IS the
-- answer. Fewer claimed parameters is fewer guards that can be got wrong.

-- ---------------------------------------------------------------------------
-- The structural half. Partial and UNIQUE: one cash opening per company, where
-- "cash opening" is exactly what the screen looks for.
-- ---------------------------------------------------------------------------
do $$
declare v_dupes int;
begin
  select count(*) into v_dupes from (
    select company_id from public.bank_transactions
     where kind = 'opening' and bank_account_id is null
     group by company_id having count(*) > 1) d;
  if v_dupes > 0 then
    raise exception
      '0390 REFUSED: % company(ies) already carry more than one cash opening row. The index would fail; the duplicates are a real double-count and need deciding before it can be prevented.', v_dupes;
  end if;
end $$;

create unique index if not exists bank_transactions_one_cash_opening_per_company
  on public.bank_transactions (company_id)
  where kind = 'opening' and bank_account_id is null;

comment on index public.bank_transactions_one_cash_opening_per_company is
  '0390: a company has at most ONE cash opening balance. The Accounting screen derived its "Opening locked" state from the existence of this row and enforced it nowhere else, so a second tab or a direct API call could set the opening again — and because the old write ADDED to the balance rather than replacing it, setting it twice doubled the cash. Enforced here rather than only inside set_cash_opening_balance(), because a check inside one function binds only the callers who use it.';

create or replace function public.set_cash_opening_balance(p_amount numeric)
returns numeric
language plpgsql
set search_path to 'public'
as $function$
declare
  v_company uuid := public.current_company_id();
  v_existing numeric;
  v_balance  numeric;
begin
  if v_company is null then
    -- The screen says this in the same words. Said here too, because the
    -- browser is not the only caller and "null value in column company_id"
    -- is an error about a column for what is really a missing selection.
    raise exception
      'No company is selected, so there is no cash balance to open. Pick a company with the "Viewing as" selector first.'
      using errcode = 'P0001';
  end if;
  if p_amount is null or p_amount < 0 then
    raise exception 'An opening cash balance must be zero or more.' using errcode = 'P0001';
  end if;

  -- SET ONCE. Reported with the figure already recorded: "you cannot do this"
  -- is a refusal, "this is already 9,874 and here is why you cannot add to it"
  -- is an answer.
  select cash_delta into v_existing
    from public.bank_transactions
   where company_id = v_company and kind = 'opening' and bank_account_id is null
   limit 1;
  if found then
    raise exception
      'The opening cash balance is already set, at PKR %. It is recorded once and cannot be set again. Nothing has been recorded.', v_existing
      using errcode = '23505',
            hint = 'Cash that arrived after the opening is recorded as a deposit or a receipt, not as another opening.';
  end if;

  -- The treasury row is created here rather than left to apply_money_delta, so
  -- that an opening of ZERO — a legitimate answer, "we had no cash" — still
  -- leaves a row behind. apply_money_delta is a deliberate no-op at zero.
  insert into public.treasury (company_id, cash_balance)
  values (v_company, 0)
  on conflict (company_id) do nothing;

  if p_amount > 0 then
    -- One call: the arithmetic under the row lock, the row count asserted, and
    -- the ledger line written in the same transaction.
    perform public.apply_money_delta(
      v_company, 'Cash', null, p_amount, 'opening', 'Opening cash balance', null);
  else
    -- Zero moves nothing, and apply_money_delta returns before it logs. The
    -- marker row is still written, or the "set once" rule never engages and a
    -- zero opening could be replaced by a real one tomorrow.
    insert into public.bank_transactions
      (company_id, bank_account_id, kind, amount, cash_delta, account_delta, description)
    values (v_company, null, 'opening', 0, 0, 0, 'Opening cash balance');
  end if;

  select cash_balance into v_balance from public.treasury where company_id = v_company;
  return v_balance;
end;
$function$;

comment on function public.set_cash_opening_balance(numeric) is
  '0390: records a company''s opening cash balance, once, in one transaction — the treasury row, the balance move under the row lock, and the `opening` ledger line together. Replaces a browser-side `cash_balance + <React state>` read-modify-write plus a separate log insert. Takes no company: current_company_id() already resolves coalesce(view_as_company, company_id), which is what the screen computed. Refuses a second opening by name, and bank_transactions_one_cash_opening_per_company makes it impossible for callers that never reach this function. An opening of zero is legitimate and still writes the marker row.';

grant execute on function public.set_cash_opening_balance(numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- PROVE IT.
--
-- The refusal arm runs against REAL STATE and needs no setup: GGS already has
-- its opening, so the second-opening refusal is exercised as it actually
-- stands. The success arm then has to manufacture the "not yet set" state,
-- which means removing that row inside the block — everything here rolls back,
-- and skipping the arm instead would be a test reporting success without
-- having run.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co    uuid;
  v_uid   uuid;
  v_bal0  numeric;
  v_bal1  numeric;
  v_ret   numeric;
  v_n     int;
begin
  select id into v_co from public.companies where name like 'GUARDS%' limit 1;
  if v_co is null then select id into v_co from public.companies order by created_at limit 1; end if;
  select id into v_uid from public.profiles where company_id = v_co limit 1;
  if v_co is null or v_uid is null then
    raise exception '0390 FAILED: no company with a profile to probe against.';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);

  -- 1. Already set -> refused, BY MESSAGE. Asserting only that something
  --    raised would pass against a NOT NULL violation or a missing company.
  if not exists (select 1 from public.bank_transactions
                  where company_id = v_co and kind = 'opening' and bank_account_id is null) then
    raise exception '0390 FAILED: the probe company has no opening set, so the refusal arm is not exercised.';
  end if;
  begin
    perform public.set_cash_opening_balance(500);
    raise exception '0390 FAILED: a second opening balance was accepted.';
  exception when others then
    if sqlerrm not like '%already set%' then
      raise exception '0390 FAILED: the second opening raised "%", not the refusal being tested.', sqlerrm;
    end if;
  end;

  -- 2. Not yet set -> the balance moves by exactly the amount, once, and one
  --    marker row appears. The precondition is restored rather than skipped;
  --    this block rolls back.
  delete from public.bank_transactions
   where company_id = v_co and kind = 'opening' and bank_account_id is null;

  select cash_balance into v_bal0 from public.treasury where company_id = v_co;
  v_ret := public.set_cash_opening_balance(4321.09);
  select cash_balance into v_bal1 from public.treasury where company_id = v_co;

  if v_bal1 <> v_bal0 + 4321.09 then
    raise exception '0390 FAILED: cash is % and should be %.', v_bal1, v_bal0 + 4321.09;
  end if;
  if v_ret <> v_bal1 then
    raise exception '0390 FAILED: the function returned % and the balance is %.', v_ret, v_bal1;
  end if;

  select count(*) into v_n from public.bank_transactions
   where company_id = v_co and kind = 'opening' and bank_account_id is null;
  if v_n <> 1 then
    raise exception '0390 FAILED: % opening row(s) after setting it, expected 1.', v_n;
  end if;

  -- 3. And the index, not just the function. This is the half that binds a
  --    caller who never goes near set_cash_opening_balance().
  begin
    insert into public.bank_transactions
      (company_id, bank_account_id, kind, amount, cash_delta, account_delta, description)
    values (v_co, null, 'opening', 1, 1, 0, 'PROBE 0390 second opening, direct');
    raise exception '0390 FAILED: a second opening row was inserted directly. The unique index is not doing its job.';
  exception when unique_violation then
    null;   -- the index refused it, which is the point
  end;

  raise exception
    'ROLLBACK_PROBE 0390 OK: a second opening is refused by message and by index; a first opening moves cash % -> % exactly once.',
    v_bal0, v_bal1;
exception when others then
  if sqlerrm not like 'ROLLBACK_PROBE%' then raise; end if;
  raise notice '%', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- The tail required of every migration (scripts/migration-template.sql).
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0390 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
