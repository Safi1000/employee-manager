-- 0389 — record_bank_transfer(): the debit, the credit and both audit lines in
--         one transaction.
--
-- ===========================================================================
-- THE LAST BALANCE MOVE STILL MADE IN A BROWSER
-- ===========================================================================
--
-- handleTransfer did FIVE round trips with nothing around them:
--
--   1. applyBankDelta(from, -amount)     <- money leaves
--   2. applyBankDelta(to,   +amount)     <- money arrives
--   3. logTransaction(from leg)
--   4. logTransaction(to leg)
--   5. update bank_transactions set transfer_pair_id
--
-- A failure, a refusal or a closed laptop between 1 and 2 DESTROYS MONEY. Not
-- "leaves a record inconsistent" — the company's total bank balance is lower
-- than it was and nothing anywhere says why. A failure between 2 and 3 leaves
-- both balances right and the transaction log missing the movement entirely,
-- so the next reconciliation cannot explain either side.
--
-- This is not the cross-key defect the eight flows had — a transfer needs
-- accounting.edit and nothing else, so no half of it can be refused for want
-- of a second permission. It is the same shape one layer down: SEVERAL WRITES
-- THAT ARE ONLY CORRECT TOGETHER, ISSUED SEPARATELY.
--
-- Worth saying plainly, because it says where to look next: the two HARDER
-- cash-and-bank moves on this screen were already atomic RPCs —
-- record_bank_to_custodian() for a withdrawal and record_cash_deposit() for a
-- deposit. The simple one was the one left in the browser. Difficulty is not
-- what predicts this; whether somebody happened to reach for an RPC is.
--
-- ===========================================================================
-- WHAT IS DELIBERATELY NOT ADDED
-- ===========================================================================
--
-- NO OVERDRAW REFUSAL. The old path did not check, and 0366 removed exactly
-- that kind of check from the expense form on purpose: it measured a
-- company-wide cached scalar, and an overdrawn account is a fact the ledger
-- already holds rather than a thing to prevent at the keyboard. Adding one
-- here would be a new refusal smuggled in under a transaction fix, and an
-- operator who could move money yesterday would find they cannot today. If
-- transfers should refuse an overdraw, that is its own decision.
--
-- The two accounts must differ and must belong to the same company. Both were
-- checked in the browser, where a stale form can get round them; the company
-- check was not made at all — RLS would have caught a foreign account, but as
-- a silent zero-row UPDATE on the second leg, i.e. after the first leg had
-- already committed.

create or replace function public.record_bank_transfer(
  p_from_bank_account_id uuid,
  p_to_bank_account_id   uuid,
  p_amount               numeric,
  p_date                 date,
  p_notes                text default null
) returns uuid
language plpgsql
set search_path to 'public'
as $function$
declare
  v_pair    uuid := gen_random_uuid();
  v_from    record;
  v_to      record;
  v_desc    text;
  v_n       int;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'A transfer needs an amount greater than zero.' using errcode = 'P0001';
  end if;
  if p_from_bank_account_id is null or p_to_bank_account_id is null then
    raise exception 'A transfer needs two accounts. Nothing has been recorded.' using errcode = 'P0001';
  end if;
  if p_from_bank_account_id = p_to_bank_account_id then
    raise exception 'A transfer needs two different accounts. Nothing has been recorded.' using errcode = '23514';
  end if;
  if p_date is null then
    raise exception 'A transfer needs a date. Nothing has been recorded.' using errcode = 'P0001';
  end if;

  -- tenant guard [resolved]: owning company looked up from p_from_bank_account_id
  -- via public.bank_accounts (0242)
  select id, company_id, bank_name into v_from
    from public.bank_accounts where id = p_from_bank_account_id;
  if v_from.id is null then
    raise exception 'The account money is leaving does not exist, or you cannot see it. Nothing has been recorded.'
      using errcode = 'P0001';
  end if;
  perform public.assert_same_company(v_from.company_id);

  select id, company_id, bank_name into v_to
    from public.bank_accounts where id = p_to_bank_account_id;
  if v_to.id is null then
    raise exception 'The account money is going to does not exist, or you cannot see it. Nothing has been recorded.'
      using errcode = 'P0001';
  end if;

  -- Both ends, compared to each other and not just to the session. A transfer
  -- across companies is not a transfer, it is two unrelated movements, and it
  -- would otherwise show up as a silent zero-row UPDATE on the second leg —
  -- after the first leg had already committed, under the old path.
  if v_to.company_id is distinct from v_from.company_id then
    raise exception 'Those two accounts belong to different companies. Nothing has been recorded.'
      using errcode = '42501';
  end if;

  v_desc := 'Transfer ' || coalesce(v_from.bank_name, '?') || ' → ' || coalesce(v_to.bank_name, '?')
         || coalesce(' · ' || nullif(btrim(p_notes), ''), '');

  -- ONE MOVEMENT, TWO ENDS. Both legs go through apply_money_delta, so both
  -- assert their own row count and raise: the second leg being refused now
  -- takes the first leg with it instead of leaving the money in mid-air.
  -- They share a reference_id, which is what pairs them below.
  perform public.apply_money_delta(
    v_from.company_id, 'Bank', p_from_bank_account_id, -p_amount,
    'transfer', v_desc, v_pair::text);
  perform public.apply_money_delta(
    v_to.company_id, 'Bank', p_to_bank_account_id, p_amount,
    'transfer', v_desc, v_pair::text);

  -- transfer_pair_id is what the reconciliation screens read to show a
  -- transfer as one line rather than two unexplained ones.
  --
  -- created_at carries the TRANSFER DATE at noon, not the wall clock. Noon and
  -- not midnight so the date survives being rendered in any timezone — a
  -- midnight timestamp shows as the previous day for anyone west of the
  -- database. The hour itself means nothing. (The old path did the same thing
  -- with local noon in the browser; this is noon in the database, which is a
  -- few hours' difference and the same date either way.)
  update public.bank_transactions
     set transfer_pair_id = v_pair,
         created_at = p_date + time '12:00'
   where reference_id = v_pair::text;
  get diagnostics v_n = row_count;

  if v_n <> 2 then
    raise exception
      'A transfer must produce exactly two ledger lines and this one produced %. Nothing has been recorded.', v_n
      using errcode = 'P0001';
  end if;

  return v_pair;
end;
$function$;

comment on function public.record_bank_transfer(uuid, uuid, numeric, date, text) is
  '0389: moves money between two bank accounts of one company — debit, credit and both audit lines in a single transaction. SECURITY INVOKER: accounting.edit is still required, and is now required for the whole movement rather than for each leg separately. Replaces five unprotected round trips in Accounting.tsx, where a failure between the debit and the credit destroyed money outright. Returns the transfer_pair_id. Deliberately does NOT refuse an overdraw — the old path did not, and an overdrawn account is a fact the ledger holds rather than something to prevent at the keyboard (see 0366).';

grant execute on function public.record_bank_transfer(uuid, uuid, numeric, date, text) to authenticated;

-- ---------------------------------------------------------------------------
-- PROVE IT, against two real accounts, rolled back.
--
-- The assertion that matters is CONSERVATION: after a transfer the two
-- balances have moved by equal and opposite amounts, so the company's total is
-- unchanged. That is the property the old path could break, and it is the one
-- thing neither leg can demonstrate on its own — each leg "succeeds".
--
-- Then the refusals, asserted ON THEIR MESSAGES: same account, and a second
-- account belonging to another company. A test that only checked something
-- raised would pass against the wrong error, which this project has been
-- caught by four times.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co    uuid;
  v_uid   uuid;
  v_a     uuid; v_b uuid;
  v_a0 numeric; v_b0 numeric; v_a1 numeric; v_b1 numeric;
  v_other uuid;
  v_pair  uuid;
  v_n     int;
begin
  select id into v_co from public.companies order by created_at limit 1;
  select id into v_uid from public.profiles where company_id = v_co limit 1;
  select id into v_a from public.bank_accounts where company_id = v_co order by created_at limit 1;
  select id into v_b from public.bank_accounts where company_id = v_co and id <> v_a order by created_at limit 1;
  if v_co is null or v_uid is null or v_a is null or v_b is null then
    raise exception '0389 FAILED: two bank accounts in one company are needed to probe a transfer.';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);

  select balance into v_a0 from public.bank_accounts where id = v_a;
  select balance into v_b0 from public.bank_accounts where id = v_b;

  v_pair := public.record_bank_transfer(v_a, v_b, 1234.56, current_date, 'PROBE 0389');

  select balance into v_a1 from public.bank_accounts where id = v_a;
  select balance into v_b1 from public.bank_accounts where id = v_b;
  if v_a1 <> v_a0 - 1234.56 then
    raise exception '0389 FAILED: the source is % and should be %.', v_a1, v_a0 - 1234.56;
  end if;
  if v_b1 <> v_b0 + 1234.56 then
    raise exception '0389 FAILED: the destination is % and should be %.', v_b1, v_b0 + 1234.56;
  end if;
  if (v_a1 + v_b1) <> (v_a0 + v_b0) then
    raise exception
      '0389 FAILED: the two balances now total % and started at %. A transfer must not create or destroy money.',
      v_a1 + v_b1, v_a0 + v_b0;
  end if;

  -- Two lines, paired, dated by the transfer date and not by the clock.
  select count(*) into v_n from public.bank_transactions
   where transfer_pair_id = v_pair and kind = 'transfer';
  if v_n <> 2 then
    raise exception '0389 FAILED: % paired ledger line(s), expected 2.', v_n;
  end if;
  if exists (select 1 from public.bank_transactions
              where transfer_pair_id = v_pair and created_at::date <> current_date) then
    raise exception '0389 FAILED: a leg is not dated by the transfer date.';
  end if;
  if (select sum(account_delta) from public.bank_transactions where transfer_pair_id = v_pair) <> 0 then
    raise exception '0389 FAILED: the two legs do not sum to zero in the log.';
  end if;

  -- Refusal 1: one account, twice.
  begin
    perform public.record_bank_transfer(v_a, v_a, 10, current_date, 'PROBE 0389 same');
    raise exception '0389 FAILED: a transfer to the same account was accepted.';
  exception when others then
    if sqlerrm not like '%two different accounts%' then
      raise exception '0389 FAILED: the same-account transfer raised "%", not the refusal being tested.', sqlerrm;
    end if;
  end;

  -- Refusal 2: an account in another company. Skipped only if this database
  -- has one company — and skipping is SAID, not silently passed.
  select id into v_other from public.bank_accounts where company_id <> v_co limit 1;
  if v_other is null then
    raise notice '0389: only one company has bank accounts here, so the cross-company refusal is NOT exercised.';
  else
    begin
      perform public.record_bank_transfer(v_a, v_other, 10, current_date, 'PROBE 0389 cross');
      raise exception '0389 FAILED: a cross-company transfer was accepted.';
    exception when others then
      if sqlerrm not like '%different companies%' and sqlerrm not like '%another company%'
         and sqlerrm not like '%cannot see it%' then
        raise exception '0389 FAILED: the cross-company transfer raised "%", not the refusal being tested.', sqlerrm;
      end if;
    end;
  end if;

  raise exception
    'ROLLBACK_PROBE 0389 OK: % -> % conserved the total at %, two paired legs summing to zero, both refusals by message.',
    v_a0, v_a1, v_a0 + v_b0;
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
    raise exception '0389 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
