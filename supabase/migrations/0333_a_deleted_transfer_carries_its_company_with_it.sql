-- 0333 — a deleted bank transfer carries its company with it.
--
-- TWO DEFECTS, AND THEY MASK EACH OTHER. That is the part worth reading twice,
-- because it is the second time this project has met the shape: A DEFECT THAT
-- PREVENTS A CODE PATH FROM RUNNING ALSO PREVENTS ITS DEFECTS FROM SHOWING.
-- (The first was United Bank's two errors cancelling into a passing check.)
--
-- DEFECT 1 — the tenant guard reads the company off rows the statement is
-- deleting. 0287 injected this into sync_bank_transfer_journal:
--
--   if p_pair_id is not null then
--     perform public.assert_same_company(
--       (select distinct bt.company_id from public.bank_transactions bt
--         where bt.transfer_pair_id = p_pair_id));
--   end if;
--
-- AFTER-ROW triggers fire once the statement's deletes are done. When both legs
-- of a pair go in one statement — which is what deleting a transfer means —
-- that subselect finds nothing, returns NULL, and assert_same_company refuses
-- with its deliberately unhelpful `Row not found`. Deleting a transfer in the
-- app hits exactly this. It was found by a company teardown, but it is not
-- specific to one.
--
-- DEFECT 2 — underneath it, the function would leave an orphan journal entry.
-- The body already handles an empty pair:
--
--   if v_co is null then
--     return 'no legs';
--   end if;
--
-- but that returns BEFORE the block that reverses the existing entry. So the
-- moment defect 1 is fixed, deleting a transfer succeeds and leaves its journal
-- entry standing — a posted entry whose source rows no longer exist. Fixing
-- only the guard would have traded a loud failure for a silent one.
--
-- THE FIX, AND BOTH HALVES NEED THE SAME THING. The trigger knows the company:
-- it is on the row, in OLD for a delete and NEW otherwise. The function should
-- not have to re-derive it from a table that the statement is in the middle of
-- emptying. So the company is PASSED IN:
--
--   * a new two-argument sync_bank_transfer_journal(p_pair_id, p_company_id)
--     carries the logic. Its guard still lets the pair's own rows decide where
--     they exist, and falls back to the passed company where they do not — so
--     a pair belonging to another company is still refused, and a deleted one
--     no longer refuses itself. Its no-legs branch reverses instead of
--     returning, which is only possible because the company arrived as an
--     argument;
--   * the one-argument form stays, keeping 0287's guard VERBATIM and then
--     delegating. Its behaviour is unchanged, including the refusal when the
--     pair is gone — for a caller with only a pair id that is still the right
--     answer, because it has no company to offer. Nothing in src/ or the edge
--     functions calls it today, but the signature is public and removing it
--     would be a wider change than this file is for;
--   * journal_on_bank_transaction calls the two-argument form.
--
-- SURGERY, NOT RESTATEMENT. sync_bank_transfer_journal has two authors — 0272
-- wrote it, 0287 injected the guard — so no single file holds its true text.
-- The two-argument form is built BY TRANSFORMING THE LIVE DEFINITION, not by
-- copying 0272's body: that way every edit made since, including 0287's and any
-- nobody has told us about, travels into the new function. Three anchors, each
-- asserted to appear exactly once.

-- ---------------------------------------------------------------------------
-- 0. What tenant_guard_gaps() answers BEFORE the change, as a reading.
--
-- This file creates a NEW security-definer function with two uuid parameters,
-- and tenant_guard_gaps() requires every one of them to be covered. A guard
-- that named only p_company_id would leave p_pair_id uncovered and turn
-- tenant_guard_covers_every_parameter red — the check 0327 moved into
-- ledger_checks_base precisely so it cannot be silenced. Before = after, read
-- rather than asserted against a literal (0304/0310/0327).
-- ---------------------------------------------------------------------------
create temp table _0333_gaps_before on commit drop as
  select count(*) as n from public.tenant_guard_gaps();

-- ---------------------------------------------------------------------------
-- 1. The two-argument form, built from the live one-argument definition.
-- ---------------------------------------------------------------------------
do $two_arg$
declare
  v_src  text;
  v_hits int;
  v_sig_old constant text := 'public.sync_bank_transfer_journal(p_pair_id uuid)';
  v_sig_new constant text := 'public.sync_bank_transfer_journal(p_pair_id uuid, p_company_id uuid)';
  v_guard_pat constant text :=
    $p$if p_pair_id is not null then perform public\.assert_same_company\(\(select distinct bt\.company_id from public\.bank_transactions bt where bt\.transfer_pair_id = p_pair_id\)\); end if;$p$;
  v_guard_new constant text :=
    $p$-- tenant guard [bespoke, 0287; amended 0333]: the pair's own rows are the
  -- best evidence of which company it belongs to, and where they exist they
  -- still decide — a pair owned by another company is still refused. But an
  -- AFTER DELETE trigger runs once the statement has removed them, and the
  -- NULL that follows refused a legitimate delete. Fall back to the company
  -- the caller passed, which it always knows.
  if p_pair_id is not null then perform public.assert_same_company(coalesce((select distinct bt.company_id from public.bank_transactions bt where bt.transfer_pair_id = p_pair_id), p_company_id)); end if;$p$;
  v_legs_pat constant text := $p$if v_co is null then\r?\n\s*return 'no legs';\r?\n\s*end if;$p$;
  v_legs_new constant text :=
$p$if v_co is null then
    -- 0333. No legs left means the pair has been DELETED, and the entry it
    -- posted must come off with it. Returning here — which is what this branch
    -- used to do — leaves a posted journal entry whose source rows are gone.
    -- Reversing needs the company, which is the second reason it is now an
    -- argument rather than a lookup.
    v_co := p_company_id;
    if v_co is null then
      return 'no legs';
    end if;
    select je.entry_date into v_date
      from public.journal_entries je
     where je.company_id = v_co
       and je.source_table = 'bank_transfers' and je.source_id = p_pair_id
       and je.is_reversal = false
       and not exists (select 1 from public.journal_entries r
                        where r.reversal_of_entry_id = je.id)
     limit 1;
    if v_date is null then
      return 'no legs';
    end if;
    perform public.reverse_journal_for_source(v_co, 'bank_transfers', p_pair_id, v_date);
    return 'reversed';
  end if;$p$;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p
   where p.oid = 'public.sync_bank_transfer_journal(uuid)'::regprocedure;

  if v_src is null then
    raise exception '0333 FAILED: public.sync_bank_transfer_journal(uuid) does not exist';
  end if;

  if to_regprocedure('public.sync_bank_transfer_journal(uuid, uuid)') is not null then
    raise notice '0333: the two-argument form already exists, leaving it alone';
    return;
  end if;

  -- (i) the signature
  v_hits := (length(v_src) - length(replace(v_src, v_sig_old, ''))) / length(v_sig_old);
  if v_hits <> 1 then
    raise exception '0333 FAILED: the one-argument signature appears % times, expected exactly 1', v_hits;
  end if;
  v_src := replace(v_src, v_sig_old, v_sig_new);

  -- (ii) 0287's guard, replaced by one that trusts the caller
  v_hits := (select count(*) from regexp_matches(v_src, v_guard_pat, 'g'));
  if v_hits <> 1 then
    raise exception
      '0333 FAILED: 0287''s injected guard appears % times in sync_bank_transfer_journal, expected exactly 1 — refusing rather than guessing which one to replace', v_hits;
  end if;
  v_src := regexp_replace(v_src, v_guard_pat, v_guard_new);

  -- (iii) the no-legs branch, which must reverse rather than return
  v_hits := (select count(*) from regexp_matches(v_src, v_legs_pat, 'g'));
  if v_hits <> 1 then
    raise exception
      '0333 FAILED: the no-legs branch appears % times, expected exactly 1', v_hits;
  end if;
  v_src := regexp_replace(v_src, v_legs_pat, v_legs_new);

  execute v_src;
end
$two_arg$;

-- ---------------------------------------------------------------------------
-- 2. The one-argument form becomes a delegator.
--
-- It keeps the old derivation, so a caller that has only a pair id behaves
-- exactly as it did — including refusing when the pair is gone, which for that
-- caller is still the right answer: it has no company to offer.
-- ---------------------------------------------------------------------------
create or replace function public.sync_bank_transfer_journal(p_pair_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $delegate$
begin
  -- tenant guard [bespoke, 0287]: kept VERBATIM. The two-argument form's guard
  -- is conditional on a non-null company, so delegating a NULL through it would
  -- skip the check entirely — this delegator would have quietly dropped 0287's
  -- guard for every caller that has only a pair id. The proof's control caught
  -- exactly that on the first attempt.
  if p_pair_id is not null then perform public.assert_same_company((select distinct bt.company_id from public.bank_transactions bt where bt.transfer_pair_id = p_pair_id)); end if;

  return public.sync_bank_transfer_journal(
    p_pair_id,
    (select distinct bt.company_id
       from public.bank_transactions bt
      where bt.transfer_pair_id = p_pair_id));
end
$delegate$;

-- ---------------------------------------------------------------------------
-- 3. The trigger passes the company it already has.
-- ---------------------------------------------------------------------------
do $trigger_fn$
declare
  v_src  text;
  v_hits int;
  v_pat  constant text := $p$perform public\.sync_bank_transfer_journal\(v_pair\);$p$;
  v_new  constant text :=
$p$-- 0333. The company comes off the ROW, in the same shape this function
  -- already uses for the pair id, because NEW is unassigned during a DELETE.
  perform public.sync_bank_transfer_journal(
    v_pair,
    case when tg_op = 'DELETE' then old.company_id else new.company_id end);$p$;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p where p.oid = 'public.journal_on_bank_transaction()'::regprocedure;

  if v_src ~ 'sync_bank_transfer_journal\(\s*v_pair\s*,' then
    raise notice '0333: journal_on_bank_transaction already passes the company, leaving it alone';
    return;
  end if;

  v_hits := (select count(*) from regexp_matches(v_src, v_pat, 'g'));
  if v_hits <> 1 then
    raise exception
      '0333 FAILED: the sync call appears % times in journal_on_bank_transaction, expected exactly 1', v_hits;
  end if;

  execute regexp_replace(v_src, v_pat, v_new);
end
$trigger_fn$;

-- ---------------------------------------------------------------------------
-- PROOF
--
-- STATIC: both signatures exist, the two-argument form guards on p_company_id
-- and no longer derives the company from bank_transactions, the one-argument
-- form still exists, and the trigger passes two arguments.
--
-- BEHAVIOURAL, and it needs an identity. assert_same_company returns EARLY when
-- there is no JWT — `v_uid is null and v_jwt_role not in ('authenticated','anon')`
-- is how migrations, psql and pg_cron get through it. So a probe run with no
-- claims would sail past the very guard this file is about and prove nothing.
-- The probe therefore adopts a real profile of the company under test, which is
-- what made the defect visible in the first place.
--
-- Then, inside a subtransaction that unwinds (0321):
--
--   (a) with no legs and NO company passed — the one-argument form — the guard
--       still refuses, asserting on the MESSAGE. That is the control: it shows
--       the guard is live and that what changed is the company being supplied,
--       not the guard being weakened.
--   (b) with no legs and the company passed, the two-argument form does NOT
--       raise. Defect 1.
--   (c) an entry is posted against a pair id, the legs are then absent, and the
--       two-argument form must REVERSE it and say so — not return 'no legs'.
--       Defect 2, which only became reachable once (b) worked.
--   (d) with nothing posted and no legs, it returns 'no legs' — so (c) is not
--       just "it always reverses something".
-- ---------------------------------------------------------------------------
do $proof$
declare
  v_co       uuid;
  v_uid      uuid;
  v_pair     uuid := gen_random_uuid();
  v_empty    uuid := gen_random_uuid();
  v_dr       uuid;
  v_cr       uuid;
  v_src      text;
  v_a        text := '(not run)';
  v_b        text := '(not run)';
  v_c        text := '(not run)';
  v_d        text := '(not run)';
  v_rev      int  := -1;
  v_gaps     int;
  v_outcome  text;
  v_mode     text;
begin
  ---------------------------------------------------------------------------
  -- STATIC
  ---------------------------------------------------------------------------
  if to_regprocedure('public.sync_bank_transfer_journal(uuid, uuid)') is null then
    raise exception '0333 FAILED: the two-argument form was not created';
  end if;
  if to_regprocedure('public.sync_bank_transfer_journal(uuid)') is null then
    raise exception '0333 FAILED: the one-argument form is gone — other callers would break';
  end if;

  v_src := pg_get_functiondef('public.sync_bank_transfer_journal(uuid, uuid)'::regprocedure);
  -- The guard must be the null-safe form: the pair's rows decide where they
  -- exist, p_company_id where they do not. Asserting the whole expression
  -- rather than either half, because each half alone is one of the two wrong
  -- answers — dropping the subselect loses the cross-tenant check, dropping the
  -- fallback keeps the defect.
  if v_src !~ 'assert_same_company\(coalesce\(\(select distinct bt\.company_id from public\.bank_transactions bt where bt\.transfer_pair_id = p_pair_id\), p_company_id\)\)' then
    raise exception
      '0333 FAILED: the two-argument form does not carry the null-safe guard covering both p_pair_id and p_company_id';
  end if;
  if position('reverse_journal_for_source' in v_src) = 0 then
    raise exception '0333 FAILED: the two-argument form cannot reverse anything';
  end if;

  v_src := pg_get_functiondef('public.journal_on_bank_transaction()'::regprocedure);
  if v_src !~ 'sync_bank_transfer_journal\(\s*v_pair\s*,' then
    raise exception '0333 FAILED: journal_on_bank_transaction still calls the one-argument form';
  end if;

  -- The new function must not open a tenant-guard gap. Both of its uuid
  -- parameters are covered by the one guard, which names them both.
  select count(*) into v_gaps from public.tenant_guard_gaps();
  if v_gaps <> (select n from _0333_gaps_before) then
    raise exception
      '0333 FAILED: tenant_guard_gaps() answers % , was % before this migration — the new function left a parameter uncovered: %',
      v_gaps, (select n from _0333_gaps_before),
      (select string_agg(function_name || '.' || parameter_name, ', ') from public.tenant_guard_gaps());
  end if;

  ---------------------------------------------------------------------------
  -- BEHAVIOURAL
  ---------------------------------------------------------------------------
  select p.id, p.company_id into v_uid, v_co
    from public.profiles p
    join public.companies c on c.id = p.company_id
   where p.company_id is not null and c.archived_at is null
   order by p.created_at
   limit 1;

  select id into v_dr from public.chart_of_accounts where company_id = v_co order by id limit 1;
  select id into v_cr from public.chart_of_accounts where company_id = v_co and id <> v_dr order by id limit 1;

  if v_uid is null or v_dr is null or v_cr is null then
    v_mode := 'STATIC ONLY — no profile with an un-archived company, or fewer than two accounts to post between';
  else
    v_mode := 'STATIC AND BEHAVIOURAL';
    begin
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
      perform set_config('request.jwt.claim.sub', v_uid::text, true);
      if public.current_company_id() is distinct from v_co then
        raise exception '0333 FAILED: the probe identity does not resolve to the company under test';
      end if;

      -- (a) control: the one-argument form, no legs, still refuses.
      begin
        perform public.sync_bank_transfer_journal(v_empty);
        v_a := 'WENT THROUGH';
      exception when others then
        v_a := sqlerrm;
      end;
      if v_a not like '%Row not found%' then
        raise exception
          '0333 FAILED: the one-argument form did not refuse for a pair with no legs. Got: %. The guard is not live, so nothing below proves anything.', v_a;
      end if;

      -- (b) the two-argument form, same input, must NOT refuse.
      begin
        v_b := public.sync_bank_transfer_journal(v_empty, v_co);
      exception when others then
        raise exception
          '0333 FAILED: the two-argument form still refuses when the legs are gone: %', sqlerrm;
      end;

      -- (d) and with nothing posted it says so, rather than reversing at large.
      v_d := v_b;
      if v_d <> 'no legs' then
        raise exception
          '0333 FAILED: with no legs and nothing posted the answer should be "no legs", got %', v_d;
      end if;

      -- (c) an entry that exists must be REVERSED, not abandoned.
      perform public.post_journal(
        v_co, current_date, 'Bank transfer', 'bank_transfers', v_pair, false,
        jsonb_build_array(
          jsonb_build_object('account_id', v_dr, 'debit', 100, 'credit', 0),
          jsonb_build_object('account_id', v_cr, 'debit', 0,   'credit', 100)),
        null);

      v_c := public.sync_bank_transfer_journal(v_pair, v_co);
      if v_c <> 'reversed' then
        raise exception
          '0333 FAILED: a posted transfer entry with no legs left was not reversed — got %. This is the orphan the guard used to hide.', v_c;
      end if;
      select count(*) into v_rev
        from public.journal_entries
       where company_id = v_co and source_table = 'bank_transfers'
         and source_id = v_pair and is_reversal = true;
      if v_rev < 1 then
        raise exception '0333 FAILED: it answered "reversed" but no reversal entry exists';
      end if;

      raise exception 'PROBE_ROLLBACK';
    exception when others then
      v_outcome := sqlerrm;
    end;

    if v_outcome <> 'PROBE_ROLLBACK' then
      raise exception '0333 FAILED (behavioural probe): %', v_outcome;
    end if;

    if exists (select 1 from public.journal_entries where source_id in (v_pair, v_empty)) then
      raise exception '0333 FAILED: the probe did not unwind — a journal entry survived';
    end if;
  end if;

  raise notice
    '0333 OK (%): one-argument form still refuses without a company [%]; two-argument form returns [%] for an empty pair; a posted entry whose legs are gone is [%] with % reversal entry/entries; nothing survived the probe.',
    v_mode, left(v_a, 40), v_d, v_c, v_rev;
end
$proof$;

comment on function public.sync_bank_transfer_journal(uuid, uuid) is
  'Posts, reposts or reverses the journal entry for a bank transfer pair. 0333: takes the company as an argument, because an AFTER DELETE trigger cannot read it off rows the statement has already removed, and reverses the entry when no legs remain rather than leaving it orphaned.';
