-- 0327 — the tenant-guard check moves into ledger_checks_base, where a
-- restatement cannot silence it.
--
-- THE FAILURE THIS REMOVES, AND WHY IT OUTRANKS THE GAPS THEMSELVES
--
-- 0287 injects tenant guards into sixteen SECURITY DEFINER functions by
-- surgery. Three of those are restated wholesale by later files — ledger_checks
-- (0288, 0313, 0316), record_invoice_payment (0315), settlement_account (0317)
-- — and a restatement discards the injection. Five (function, parameter) pairs.
--
-- Production does not have those five holes, and the only reason is the order
-- the block was applied in: 0286, 0287 and 0288 all went on AFTER 0313-0317,
-- so 0287's injection landed on top of the restatements. 0318 exists because of
-- that ordering and its header records it. What nobody wrote down is that the
-- same ordering is the only thing holding the guards up.
--
-- Replay the repo in NUMERIC order into an empty database and the ordering is
-- gone. The five guards are stripped — and so is the check that would report
-- them, because tenant_guard_covers_every_parameter lives in a hand-listed arm
-- of ledger_checks, and 0313's and 0316's hand-lists do not include it. 0318
-- restores the two OTHER checks those files dropped, not this one.
--
-- THE DETECTOR IS DESTROYED BY THE SAME ACT THAT CREATES THE GAPS. That is what
-- makes it silent rather than merely broken: each restatement also restates the
-- canary, so the canary agrees with the shortened suite and nothing goes red. A
-- fresh environment would be less guarded than production with no way to tell.
--
-- WHAT THIS MIGRATION DOES, AND WHAT IT DELIBERATELY DOES NOT
--
-- It moves the check from ledger_checks into ledger_checks_base. **No migration
-- file in this repo restates ledger_checks_base** — checked, not assumed — so a
-- future restatement of ledger_checks inherits the check through the base it
-- reads instead of deciding its fate.
--
-- It does NOT close the five gaps. That is 0328, deliberately separate: wiring
-- a detector so it cannot be silenced, and fixing what it finds, are different
-- changes, and a check that is green the moment it is written proves nothing
-- (the same separation 0286 and 0287 were given).
--
-- THE COUNT DOES NOT MOVE. ledger_checks reads every base row except the base's
-- own canary, so a check added to base and removed from ledger_checks arrives
-- by a different route and is counted once either way: 29 checks + canary,
-- before and after. The base's own canary does move, 12 -> 13, and it is READ
-- and incremented rather than written as a literal (0304/0310).

-- ---------------------------------------------------------------------------
-- 0. What the suite answers BEFORE the move, as a reading.
--
-- Not a literal. Dev answers 28 rows and production 30, because dev is behind
-- on 0313/0316/0316b/0318 — so a migration asserting "30" would refuse on dev
-- for a reason having nothing to do with whether the move worked. The property
-- is that this migration does not change the length of the suite, which is
-- before = after, exactly as the guards n guides post-condition should have
-- been written and was not.
-- ---------------------------------------------------------------------------
create temp table _0327_before on commit drop as
  select c.id as company_id, (select count(*) from public.ledger_checks(c.id)) as rows
    from public.companies c;

-- ---------------------------------------------------------------------------
-- 1. The check moves INTO ledger_checks_base.
-- ---------------------------------------------------------------------------
do $into_base$
declare
  v_src text;
  v_n   int;
  v_hits int;
  v_anchor constant text :=
'  union all
  select ''checks_evaluated'', rows_before_canary.n, rows_before_canary.n, 0, true
    from rows_before_canary;';
  v_new constant text :=
'  union all
  -- 0327. Moved here from a hand-listed arm of ledger_checks. It lives in the
  -- base because nothing restates the base, so a restatement of ledger_checks
  -- can no longer drop the one check that reports missing tenant guards.
  -- Schema-wide, not company-scoped: tenant_guard_gaps() takes no company.
  select ''tenant_guard_covers_every_parameter'', 0, tg.n, tg.n, tg.n = 0
    from (select count(*)::numeric n from public.tenant_guard_gaps()) tg
  union all
  select ''checks_evaluated'', rows_before_canary.n, rows_before_canary.n, 0, true
    from rows_before_canary;';
begin
  select pg_get_functiondef('public.ledger_checks_base(uuid)'::regprocedure) into v_src;

  if position('tenant_guard_covers_every_parameter' in v_src) > 0 then
    raise notice '0327: already in the base, leaving ledger_checks_base alone';
    return;
  end if;

  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 1 then
    raise exception
      '0327 FAILED: the canary anchor appears % times in ledger_checks_base, expected exactly 1 — do not guess where the check belongs', v_hits;
  end if;
  v_src := replace(v_src, v_anchor, v_new);

  -- The base's own canary, read rather than assumed.
  v_n := (regexp_match(v_src, 'rows_before_canary as \(select (\d+)::numeric n\)'))[1]::int;
  if v_n is null then
    raise exception '0327 FAILED: the base canary is not in the expected shape — do not guess';
  end if;
  v_src := regexp_replace(v_src, 'rows_before_canary as \(select \d+::numeric n\)',
                          'rows_before_canary as (select ' || (v_n + 1) || '::numeric n)');

  execute v_src;
  raise notice '0327: ledger_checks_base canary % -> %', v_n, v_n + 1;
end
$into_base$;

-- ---------------------------------------------------------------------------
-- 2. The hand-listed arm comes OUT of ledger_checks.
--
-- Surgery against the live definition, as always: ledger_checks has many
-- authors and no canonical file (CLAUDE.md).
-- ---------------------------------------------------------------------------
do $out_of_checks$
declare
  v_src text;
  v_hits int;
  v_anchor constant text :=
'    select ''tenant_guard_covers_every_parameter''::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.tenant_guard_gaps()
    union all
';
begin
  select pg_get_functiondef('public.ledger_checks(uuid)'::regprocedure) into v_src;

  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  if v_hits = 0 then
    raise notice '0327: ledger_checks no longer lists the arm, leaving it alone';
    return;
  end if;
  if v_hits <> 1 then
    raise exception
      '0327 FAILED: the tenant-guard arm appears % times in ledger_checks, expected exactly 1', v_hits;
  end if;

  v_src := replace(v_src, v_anchor, '');
  execute v_src;
end
$out_of_checks$;

-- ---------------------------------------------------------------------------
-- PROOF
--
-- The count is unchanged, the check is still answered, AND — the property this
-- migration exists for — a restatement of ledger_checks that forgets every
-- hand-listed arm can no longer silence it. That last one is proved by DOING
-- it: ledger_checks is replaced with the barest possible restatement inside a
-- subtransaction, the check is required to still be there, and the whole thing
-- unwinds through a deliberate raise (0321).
--
-- Without that third probe this migration would be asserting its own input:
-- "the check is present after I moved it" is true of the old arrangement too.
-- ---------------------------------------------------------------------------
do $proof$
declare
  v_co       uuid;
  v_rows     int;
  v_base     int;
  v_present  int;
  v_gaps     int;
  v_reported numeric;
  v_outcome  text;
  v_survived boolean := false;
begin
  select id into v_co from public.companies order by name limit 1;
  if v_co is null then
    raise exception '0327 FAILED: no company to evaluate against';
  end if;

  -- (a) the base now answers it, and its own canary agrees with its own length.
  select count(*) into v_base from public.ledger_checks_base(v_co);
  if not exists (select 1 from public.ledger_checks_base(v_co)
                  where check_name = 'tenant_guard_covers_every_parameter') then
    raise exception '0327 FAILED: ledger_checks_base does not answer the tenant-guard check';
  end if;
  if not (select passed from public.ledger_checks_base(v_co) where check_name = 'checks_evaluated') then
    raise exception '0327 FAILED: the base canary is red — its count and its length disagree';
  end if;

  -- (b) ledger_checks answers it exactly ONCE, on every company, and the suite
  --     did not change length. Twice would mean the arm was left in as well.
  for v_co in select id from public.companies loop
    select count(*) into v_rows from public.ledger_checks(v_co);
    if v_rows <> (select rows from _0327_before b where b.company_id = v_co) then
      raise exception '0327 FAILED: ledger_checks returns % rows, was % before the move — the suite changed length',
        v_rows, (select rows from _0327_before b where b.company_id = v_co);
    end if;
    select count(*) into v_present from public.ledger_checks(v_co)
     where check_name = 'tenant_guard_covers_every_parameter';
    if v_present <> 1 then
      raise exception '0327 FAILED: the tenant-guard check appears % times, expected exactly 1', v_present;
    end if;
    if not (select passed from public.ledger_checks(v_co) where check_name = 'checks_evaluated') then
      raise exception '0327 FAILED: the canary is red after the move';
    end if;
  end loop;

  -- (c) it still reports the REAL number, not a constant.
  select count(*) into v_gaps from public.tenant_guard_gaps();
  select actual into v_reported from public.ledger_checks(
    (select id from public.companies order by name limit 1))
   where check_name = 'tenant_guard_covers_every_parameter';
  if v_reported is distinct from v_gaps::numeric then
    raise exception '0327 FAILED: the check reports % while tenant_guard_gaps() answers %', v_reported, v_gaps;
  end if;

  -- (d) THE POINT. A restatement that forgets every hand-listed arm must no
  --     longer be able to drop this check.
  begin
    execute $restate$
      create or replace function public.ledger_checks(p_company_id uuid)
      returns table(check_name text, expected numeric, actual numeric,
                    difference numeric, passed boolean)
      language sql stable security definer set search_path to 'public'
      as $f$
        select b.check_name, b.expected, b.actual, b.difference, b.passed
          from public.ledger_checks_base(p_company_id) b
         where b.check_name <> 'checks_evaluated';
      $f$;
    $restate$;

    v_survived := exists (
      select 1 from public.ledger_checks((select id from public.companies order by name limit 1))
       where check_name = 'tenant_guard_covers_every_parameter');

    raise exception 'PROBE_ROLLBACK';
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome <> 'PROBE_ROLLBACK' then
    raise exception '0327 FAILED (restatement probe): %', v_outcome;
  end if;
  if not v_survived then
    raise exception
      '0327 FAILED: a restatement of ledger_checks still drops the tenant-guard check — the move did not achieve its purpose';
  end if;

  -- and the probe unwound: the real function is back, at its original length.
  select id into v_co from public.companies order by name limit 1;
  select count(*) into v_rows from public.ledger_checks(v_co);
  if v_rows <> (select rows from _0327_before b where b.company_id = v_co) then
    raise exception '0327 FAILED: the probe did not unwind — ledger_checks returns % rows, was %',
      v_rows, (select rows from _0327_before b where b.company_id = v_co);
  end if;

  raise notice
    '0327 OK: the check answers from the base, the suite is the same length (% rows), it reports the real gap count (%), and a bare restatement of ledger_checks can no longer drop it',
    v_rows, v_gaps;
end
$proof$;
