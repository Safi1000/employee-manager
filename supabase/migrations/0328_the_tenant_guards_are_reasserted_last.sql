-- 0328 — 0287's tenant guards, reasserted after every migration that restates
-- one of the functions it injects into.
--
-- WHY A SECOND FILE RATHER THAN EDITING 0287
--
-- 0287 is correct. Its problem is its NUMBER. It injects guards into sixteen
-- SECURITY DEFINER functions by surgery, and three of those are restated
-- wholesale by later files:
--
--   ledger_checks           0288, 0313, 0316   -> p_company_id
--   record_invoice_payment  0315               -> p_custodian_location_id
--   settlement_account      0317               -> p_company_id,
--                                                 p_bank_account_id,
--                                                 p_custodian_location_id
--
-- Five (function, parameter) pairs. A restatement discards the injection, so on
-- a NUMERIC-order replay into a fresh database those five are simply absent.
--
-- Production does not have them, and the reason is not design: 0286, 0287 and
-- 0288 were all applied AFTER 0313-0317, so the injection landed on top. The
-- boundary holds by an accident of ordering, which is not a boundary.
--
-- This file is that ordering, written down. It carries 0287's map, 0287's
-- guard text and 0287's skip, and it is numbered after the last restater so a
-- replay reaches it last.
--
-- IT IS A PROVABLE NO-OP WHERE THE GUARDS ARE ALREADY THERE. The loop skips any
-- parameter tenant_guard_covered() already recognises — 0287's own idempotency
-- test, kept — so on production it injects nothing and says so. The mechanism
-- is not new: it was run by hand against dev on 2026-09-02 after 0315 and 0317
-- stripped these same guards, and the result was proved by digest equality with
-- production's function bodies, not by inspection.
--
-- WHAT THIS DOES NOT DO, AND WHERE THE REAL FIX LIVES
--
-- It closes the five that exist today. It does NOT stop the next migration from
-- restating one of the sixteen and reopening the hole, because nothing in the
-- database can see a file that has not been written yet.
--
-- Two things cover that, and both are logged rather than built:
--
--   * a CI replay that builds from supabase/migrations/ in numeric order and
--     asserts tenant_guard_gaps() = 0. That is the only thing that catches the
--     NEXT instance, and the next one will not be ledger_checks.
--   * a repo check that refuses a migration containing
--     `create or replace function public.ledger_checks` — the CLAUDE.md rule
--     enforced instead of remembered.
--
-- What 0327 already did is the half that matters most: the check that reports
-- these gaps now lives in ledger_checks_base, which nothing restates, so the
-- failure is loud rather than silent even when it does recur.

-- ---------------------------------------------------------------------------
-- The map. 0287's, unchanged — including the two comments that record
-- decisions, because those are the parts a reader would otherwise re-litigate.
-- ---------------------------------------------------------------------------
create temp table _tg328 (
  fname   text not null,
  param   text not null,
  kind    text not null,          -- 'claimed' | 'resolved' | 'bespoke'
  tbl     text,                   -- for 'resolved'
  expr    text,                   -- for 'bespoke'
  primary key (fname, param)
) on commit drop;

insert into _tg328 (fname, param, kind, tbl, expr) values
  -- [claimed]: the parameter IS the caller's tenant claim.
  ('bank_account_gl',                  'p_company_id', 'claimed', null, null),
  ('bank_held_operational',            'p_company_id', 'claimed', null, null),
  ('custodian_held_operational',       'p_company_id', 'claimed', null, null),
  ('ensure_unpresented_cheques_account','p_company_id','claimed', null, null),
  ('ledger_checks',                    'p_company_id', 'claimed', null, null),
  ('ledger_checks_base',               'p_company_id', 'claimed', null, null),
  ('negative_custodian_balances',      'p_company_id', 'claimed', null, null),
  ('payroll_attendance_drift',         'p_company_id', 'claimed', null, null),
  ('profit_allocation_over_allocated', 'p_company_id', 'claimed', null, null),
  ('profit_allocation_review',         'p_company_id', 'claimed', null, null),
  ('settlement_account',               'p_company_id', 'claimed', null, null),
  ('unposted_source_rows',             'p_company_id', 'claimed', null, null),

  -- [resolved]: look the owning company up from the object.
  ('bank_account_gl',           'p_bank_account_id',       'resolved', 'bank_accounts',          null),
  ('record_invoice_payment',    'p_custodian_location_id', 'resolved', 'cash_locations',         null),
  -- NOT payroll_runs. See 0287's header: a name-keyed map would have resolved a
  -- profit-allocation run against payroll_runs and refused every real call.
  ('reverse_profit_allocation', 'p_run_id',                'resolved', 'profit_allocation_runs', null),
  ('settlement_account',        'p_bank_account_id',       'resolved', 'bank_accounts',          null),
  ('settlement_account',        'p_custodian_location_id', 'resolved', 'cash_locations',         null),
  ('sync_cheque_journal',       'p_cheque_id',             'resolved', 'cheques',                null),

  -- [bespoke]: not a primary key. Fails closed on zero rows and on two companies.
  ('sync_bank_transfer_journal','p_pair_id', 'bespoke', null,
   'select distinct bt.company_id from public.bank_transactions bt where bt.transfer_pair_id = p_pair_id');

-- ---------------------------------------------------------------------------
-- Reassert. 0287's injector, including its language-sql conversion and its
-- tenant_guard_covered() skip.
--
-- It lives in pg_temp rather than inline because the PROOF has to run it a
-- second time, against a guard it deliberately breaks. On both databases today
-- this migration injects NOTHING — production and dev already read zero gaps —
-- so without exercising it on a real gap, the migration's only action would
-- never run and "0 gaps afterwards" would be true of doing nothing at all.
--
-- pg_temp is dropped with the session, so this leaves no new schema object.
-- ---------------------------------------------------------------------------
create function pg_temp.reassert_tenant_guards(p_only text default null)
returns int
language plpgsql
as $fn$
declare
  r       record;
  v_guard text;
  v_body  text;
  v_src   text;
  v_lang  text;
  v_ret   text;
  v_set   boolean;
  v_def   text;
  v_hdr   text;
  v_rest  text;
  v_oid   oid;
  p1      int;
  p2      int;
  v_done  int := 0;
  v_seen  int := 0;
begin
  for r in select * from _tg328
            where p_only is null or fname = p_only
            order by fname, param
  loop
    select p.oid, p.prosrc, l.lanname, p.prorettype::regtype::text, p.proretset
      into v_oid, v_src, v_lang, v_ret, v_set
      from pg_proc p join pg_language l on l.oid = p.prolang
     where p.pronamespace = 'public'::regnamespace and p.proname::text = r.fname;

    if v_oid is null then
      raise exception
        '0328 FAILED: public.% does not exist. The map names a function this database does not have — do not skip it silently.', r.fname;
    end if;
    v_seen := v_seen + 1;

    if public.tenant_guard_covered(v_src, r.param) then
      continue;                      -- idempotent replay: already guarded
    end if;

    if r.kind = 'claimed' then
      v_guard := format(
        E'  -- tenant guard [claimed, 0287]: %I IS the caller''s tenant claim\n'
        '  if %I is not null then perform public.assert_same_company(%I); end if;' || E'\n',
        r.param, r.param, r.param);
    elsif r.kind = 'resolved' then
      v_guard := format(
        E'  -- tenant guard [resolved, 0287]: owning company from %I via public.%I\n'
        '  if %I is not null then perform public.assert_same_company((select company_id from public.%I where id = %I)); end if;' || E'\n',
        r.param, r.tbl, r.param, r.tbl, r.param);
    else
      v_guard := format(
        E'  -- tenant guard [bespoke, 0287]: %I is not a primary key; see 0287\n'
        '  if %I is not null then perform public.assert_same_company((%s)); end if;' || E'\n',
        r.param, r.param, r.expr);
    end if;

    if v_lang = 'plpgsql' then
      p1     := regexp_instr(v_src, '\mbegin\M', 1, 1, 0, 'i');
      v_body := left(v_src, p1 + 4) || E'\n' || v_guard || substr(v_src, p1 + 5);
    else
      -- Convert to plpgsql, the three shapes from 0242 PART 5.
      v_body := rtrim(rtrim(v_src), E' \t\r\n;');
      if v_ret = 'void' then
        v_body := E'\n#variable_conflict use_column\nbegin\n' || v_guard || v_body || E';\nend\n';
      elsif v_set then
        v_body := E'\n#variable_conflict use_column\nbegin\n' || v_guard || E'  return query\n' || v_body || E';\nend\n';
      else
        v_body := E'\n#variable_conflict use_column\nbegin\n' || v_guard || E'  return (\n' || v_body || E');\nend\n';
      end if;
    end if;

    v_def  := pg_get_functiondef(v_oid);
    p1     := strpos(v_def, '$function$');
    v_rest := substr(v_def, p1 + 10);
    p2     := strpos(v_rest, '$function$');
    v_hdr  := left(v_def, p1 - 1);

    if v_lang = 'sql' then
      v_hdr := regexp_replace(v_hdr, '\mLANGUAGE sql\M', 'LANGUAGE plpgsql', 'i');
    end if;

    execute v_hdr || '$function$' || v_body || '$function$' || substr(v_rest, p2 + 10);
    v_done := v_done + 1;
  end loop;

  if p_only is null and v_seen <> 19 then
    raise exception '0328 FAILED: % of 19 mapped parameters were examined', v_seen;
  end if;
  return v_done;
end
$fn$;

do $reassert$
declare v_done int;
begin
  v_done := pg_temp.reassert_tenant_guards();
  raise notice '0328: examined 19 mapped parameters, reasserted % guard(s)', v_done;
end
$reassert$;

-- ---------------------------------------------------------------------------
-- PROOF
--
--   A. every parameter in the map is now covered, named individually — a total
--      would let one gap and one spurious cover cancel.
--   B. the detector agrees: tenant_guard_gaps() is empty, and the check 0327
--      moved into the base reports the same zero.
--   C. a SECOND pass injects nothing. Without this, "0 gaps" is equally
--      consistent with an injector that rewrites every function on every run,
--      which would make the migration non-idempotent and silently rewrite
--      bodies on production.
--   D. the guards actually FIRE. A guard that is present but unreachable reads
--      identically to one that works, and this project has shipped that twice
--      (a comment claiming a guard, and a check green for the wrong reason).
-- ---------------------------------------------------------------------------
do $proof$
declare
  r         record;
  v_missing text := '';
  v_gaps    int;
  v_second  int := 0;
  v_src     text;
  v_outcome text;
  v_co      uuid;
  v_other   uuid;
  v_reported numeric;
begin
  -- A
  for r in select * from _tg328 order by fname, param loop
    select p.prosrc into v_src from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname::text = r.fname;
    if not public.tenant_guard_covered(v_src, r.param) then
      v_missing := v_missing || r.fname || '.' || r.param || ' ';
    end if;
  end loop;
  if v_missing <> '' then
    raise exception '0328 FAILED: still uncovered after the reassert: %', v_missing;
  end if;

  -- B
  select count(*) into v_gaps from public.tenant_guard_gaps();
  if v_gaps <> 0 then
    raise exception '0328 FAILED: tenant_guard_gaps() reports % gap(s) after the reassert', v_gaps;
  end if;
  select actual into v_reported from public.ledger_checks(
    (select id from public.companies order by name limit 1))
   where check_name = 'tenant_guard_covers_every_parameter';
  if v_reported is distinct from 0 then
    raise exception '0328 FAILED: the check reports % while tenant_guard_gaps() reports 0 — they disagree', v_reported;
  end if;

  -- C
  for r in select * from _tg328 order by fname, param loop
    select p.prosrc into v_src from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname::text = r.fname;
    if not public.tenant_guard_covered(v_src, r.param) then
      v_second := v_second + 1;
    end if;
  end loop;
  if v_second <> 0 then
    raise exception '0328 FAILED: a second pass would inject % more guard(s) — the skip is not working', v_second;
  end if;

  -- D. The reasserted guard on settlement_account must REFUSE a bank account
  --    belonging to another company AND still ACCEPT its own. Both halves, and
  --    the second is the one that matters: a guard that refuses everything
  --    passes a test that only checks refusal (report 9.11), and this project
  --    has shipped exactly that.
  --
  --    The caller must be a REAL user of v_co. A migration carries no JWT
  --    claims, so assert_same_company returns early for trusted backend callers
  --    by design (0242c) and the guard would never be on the path. Planting a
  --    random sub is no better: current_company_id() would be null and the
  --    guard would refuse BOTH calls, which is the false pass this checks for.
  select c.id into v_co
    from public.companies c
    join public.profiles p on coalesce(p.view_as_company, p.company_id) = c.id
   where exists (select 1 from public.bank_accounts b where b.company_id = c.id)
   order by c.name limit 1;
  select id into v_other from public.companies c
   where c.id is distinct from v_co
     and exists (select 1 from public.bank_accounts b where b.company_id = c.id)
   order by c.name limit 1;

  if v_co is null or v_other is null then
    raise notice '0328: proof D not exercised — needs two companies that each have a profile and a bank account';
  else
    perform set_config('request.jwt.claims',
      json_build_object(
        'sub', (select p.id from public.profiles p
                 where coalesce(p.view_as_company, p.company_id) = v_co limit 1),
        'role', 'authenticated')::text, true);

    -- A super-admin is allowed across companies by design (is_ssa_unscoped),
    -- so a cross-tenant call would be ACCEPTED correctly and (ii) below would
    -- go red for the right behaviour. Detected and skipped rather than left to
    -- produce a false failure.
    if public.is_ssa_unscoped() then
      perform set_config('request.jwt.claims', '', true);
      raise notice '0328: proof D not exercised — the only available profile is unscoped super-admin, which crosses companies by design';
      v_co := null;
    end if;
  end if;

  if v_co is not null and v_other is not null then
    -- (i) its OWN bank account is accepted.
    v_outcome := null;
    begin
      perform public.settlement_account(v_co, 'Bank',
        (select id from public.bank_accounts where company_id = v_co limit 1), null, true);
      v_outcome := 'ACCEPTED';
    exception when others then
      v_outcome := sqlerrm;
    end;
    if v_outcome is distinct from 'ACCEPTED' then
      perform set_config('request.jwt.claims', '', true);
      raise exception
        '0328 FAILED: settlement_account refused a bank account belonging to the CALLER''s own company (%) — the reasserted guard refuses everything, which is not a guard', v_outcome;
    end if;

    -- (ii) another company's is refused.
    v_outcome := null;
    begin
      perform public.settlement_account(v_co, 'Bank',
        (select id from public.bank_accounts where company_id = v_other limit 1), null, true);
      v_outcome := 'ACCEPTED';
    exception when others then
      v_outcome := sqlerrm;
    end;
    perform set_config('request.jwt.claims', '', true);

    if v_outcome = 'ACCEPTED' then
      raise exception
        '0328 FAILED: settlement_account accepted a bank account belonging to another company — the guard is present but not firing';
    end if;
    if position('Row not found' in v_outcome) = 0 then
      raise exception
        '0328 FAILED: the cross-tenant call was refused for the WRONG reason: %', v_outcome;
    end if;
  end if;

  raise notice '0328 OK: 19 mapped parameters covered, tenant_guard_gaps() empty, a second pass injects nothing, and the reasserted guard refuses a cross-tenant object';
end
$proof$;

-- ---------------------------------------------------------------------------
-- PROOF E — the replay, rehearsed.
--
-- On both databases today this migration injects nothing, because both already
-- read zero gaps. So every assertion above is equally consistent with an
-- injector that does nothing at all. This reproduces the actual failure —
-- 0317's restatement of settlement_account, which drops three guards — and
-- requires three things in order:
--
--   1. the detector goes LOUD (tenant_guard_gaps() reports exactly those three)
--   2. the CHECK goes RED, from ledger_checks_base where 0327 put it, which is
--      the property that makes a replay visible rather than silent
--   3. this migration's injector puts them back
--
-- Then it unwinds through a deliberate raise (0321). The function is restated
-- from 0317's own file text, so this is the real event and not an approximation
-- of it.
-- ---------------------------------------------------------------------------
do $replay$
declare
  v_co       uuid;
  v_gaps     int;
  v_red      boolean;
  v_fixed    int;
  v_after    int;
  v_outcome  text;
  v_stage    text := 'not started';
begin
  select id into v_co from public.companies order by name limit 1;

  begin
    -- 1. Restate settlement_account WITHOUT the guards — exactly what 0317 does.
    execute $strip$
      create or replace function public.settlement_account(
        p_company_id uuid, p_payment_mode text, p_bank_account_id uuid,
        p_custodian_location_id uuid, p_outgoing boolean default true)
      returns uuid language plpgsql stable security definer set search_path to 'public'
      as $f$
      begin
        if p_payment_mode = 'Cash' then
          return public.cash_account_for(p_company_id, p_custodian_location_id);
        elsif p_payment_mode = 'Bank' then
          return public.bank_account_gl(p_company_id, p_bank_account_id);
        end if;
        raise exception 'Unrecognised payment mode %', coalesce(p_payment_mode, '<null>');
      end;
      $f$;
    $strip$;

    select count(*) into v_gaps from public.tenant_guard_gaps()
     where function_name = 'settlement_account';
    if v_gaps <> 3 then
      v_stage := format('the detector reported %s gaps on settlement_account, expected 3', v_gaps);
      raise exception 'STAGE_FAILED';
    end if;

    -- 2. And the CHECK goes red — this is 0327's contribution, and the reason a
    --    replay is now visible instead of silent.
    select not passed into v_red from public.ledger_checks(v_co)
     where check_name = 'tenant_guard_covers_every_parameter';
    if not coalesce(v_red, false) then
      v_stage := 'the tenant-guard check stayed GREEN while three guards were missing';
      raise exception 'STAGE_FAILED';
    end if;

    -- 3. This migration's injector puts them back.
    v_fixed := pg_temp.reassert_tenant_guards('settlement_account');
    if v_fixed <> 3 then
      v_stage := format('the injector reasserted %s guards, expected 3', v_fixed);
      raise exception 'STAGE_FAILED';
    end if;
    select count(*) into v_after from public.tenant_guard_gaps();
    if v_after <> 0 then
      v_stage := format('%s gaps remained after the injector ran', v_after);
      raise exception 'STAGE_FAILED';
    end if;

    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome = 'STAGE_FAILED' then
    raise exception '0328 FAILED (replay rehearsal): %', v_stage;
  end if;
  if v_outcome <> 'REPLAY_ROLLBACK' then
    raise exception '0328 FAILED (replay rehearsal) at "%": %', v_stage, v_outcome;
  end if;

  -- and it unwound: the real body is back, guards intact.
  select count(*) into v_after from public.tenant_guard_gaps();
  if v_after <> 0 then
    raise exception '0328 FAILED: the rehearsal did not unwind — % gap(s) remain', v_after;
  end if;

  raise notice '0328 OK (replay rehearsal): stripping settlement_account''s guards made the detector report 3 and the check go RED, the injector restored all three, and the probe unwound';
end
$replay$;

-- The injector was scaffolding for this migration and its proofs, not a new
-- control. _tg328 goes at commit; the function is dropped explicitly so a
-- pooled session cannot carry it forward to a later, unrelated transaction.
drop function pg_temp.reassert_tenant_guards(text);
