-- 0312 — ledger_checks(p_company_id) carries the tenant guard it is missing.
--
-- APPLIED TO DEV AND THEN TO PRODUCTION, 2026-09-01, out of the numeric run.
--
-- WHY THIS EXISTS, AND WHY IT IS NOT AN EDIT TO 0248
--
-- Block 2 of the ledger deployment applies 0239 through 0266 to production in
-- numeric order. 0239 landed. It redefines ledger_checks as a `language sql`
-- SECURITY DEFINER function taking p_company_id, with no
-- `assert_same_company(p_company_id)` in its body — which is precisely the
-- shape tenant_guard_gaps() exists to report. Production had that parameter
-- guarded (0285 carried 0252's map in); 0239 clobbered the guard.
--
-- The next file in the run, 0248, ends its verification with:
--
--     select count(*) into v_n from public.tenant_guard_gaps();
--     if v_n > 0 then raise exception '0248 FAILED: ...'; end if;
--
-- so 0248 aborts. That assertion is correct and it caught a real gap on the
-- first database that looked at it. Loosening it would be rewarding a control
-- for working, so the gap is closed instead.
--
-- 0287 WILL LATER FIND THIS ALREADY CLOSED — AND THEN OPEN IT AGAIN
--
-- ledger_checks.p_company_id is entry five in 0287's hand-written map of the
-- nineteen. 0287's PART 3 re-reads the catalogue for every entry and skips any
-- parameter that `tenant_guard_covered` already reports as guarded, so this
-- migration does not collide with it.
--
-- Its PART 2b is stricter: the map and the live gap list must agree EXACTLY,
-- in both directions, or 0287 refuses. So it matters that between here and
-- there the gap REOPENS on its own, without anybody arranging it:
--
--   0254, 0259, 0262, 0266, 0269, 0271, 0275, 0282, 0284 and 0286 each
--   `create or replace` ledger_checks as `language sql`, with no guard.
--
-- The first of those, 0254, discards this migration's work four files later.
-- That is not a defect in this migration; it is the reason production converges
-- back onto dev's state rather than diverging from it. The guard installed here
-- is needed for exactly the window 0248 -> 0254, and 0287 closes it for good.
--
-- Between 0254 and 0287 nothing asserts a zero gap count, so nothing else
-- trips on the reopened gap. Checked file by file, not assumed.
--
-- THE GENERAL FORM, WHICH IS THE PART WORTH KEEPING
--
--   A DETECTOR ADDED AFTER A DEFECT DOES NOT SEE THE INTERVAL IN WHICH THE
--   DEFECT WAS INTRODUCED. REPLAYING THAT INTERVAL ON ANOTHER DATABASE IS THE
--   FIRST TIME ANYTHING LOOKS AT IT.
--
-- This gap was real on dev too, from 0239 until 0287 closed it. Nothing saw it
-- there, because the thing that looks — tenant_guard_gaps() wired into
-- ledger_checks — arrives at 0286. Production is not anomalous. It is the
-- deployment replaying dev's own blind interval with the lights on.
--
-- WHAT IT DOES
--
-- The same transformation 0287 would apply to this one entry, generated the
-- same way rather than hand-written, so the body that survives is whatever
-- 0239 actually installed rather than a copy of it that can drift:
--
--   * re-read ledger_checks from pg_proc;
--   * if the parameter is already covered, do nothing (idempotent replay);
--   * convert `language sql` -> plpgsql, the RETURNS TABLE shape from 0242
--     PART 5, with #variable_conflict use_column;
--   * inject the [claimed] guard as the first statement.
--
-- AND IT ASSERTS NO ENVIRONMENT-SPECIFIC NUMBER
--
-- ledger_checks returns a different number of rows on each database and at
-- every point in this deployment, so the check that the conversion preserved
-- behaviour is a BEFORE/AFTER comparison of the full result set for every
-- company, not a row count written by hand. The INPUT vs READING rule: the
-- snapshot is an input this migration creates.

-- ---------------------------------------------------------------------------
-- The snapshot, taken before anything is replaced.
-- ---------------------------------------------------------------------------

create temporary table zz_0312_before on commit drop as
  select c.id as company_id, l.check_name, l.expected, l.actual, l.difference, l.passed
    from public.companies c, lateral public.ledger_checks(c.id) l;

-- ---------------------------------------------------------------------------
-- Generation.
-- ---------------------------------------------------------------------------

do $gen$
declare
  v_oid   oid;
  v_src   text;
  v_lang  text;
  v_set   boolean;
  v_guard text;
  v_body  text;
  v_def   text;
  v_hdr   text;
  v_rest  text;
  p1      int;
  p2      int;
begin
  select p.oid, p.prosrc, l.lanname, p.proretset
    into v_oid, v_src, v_lang, v_set
    from pg_proc p join pg_language l on l.oid = p.prolang
   where p.pronamespace = 'public'::regnamespace
     and p.proname = 'ledger_checks';

  if v_oid is null then
    raise exception '0312 REFUSES: public.ledger_checks does not exist';
  end if;

  if public.tenant_guard_covered(v_src, 'p_company_id') then
    raise notice '0312: ledger_checks.p_company_id is already covered — nothing to do';
    return;
  end if;

  v_guard :=
    E'  -- tenant guard [claimed, 0312]: p_company_id IS the caller''s tenant claim\n'
    '  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;' || E'\n';

  if v_lang = 'plpgsql' then
    p1 := regexp_instr(v_src, '\mbegin\M', 1, 1, 0, 'i');
    if p1 = 0 then
      raise exception '0312 REFUSES: cannot find the plpgsql BEGIN of ledger_checks';
    end if;
    v_body := left(v_src, p1 + 4) || E'\n' || v_guard || substr(v_src, p1 + 5);
  elsif v_lang = 'sql' then
    if not v_set then
      raise exception '0312 REFUSES: ledger_checks is language sql but not set-returning — the conversion shape does not apply';
    end if;
    v_body := rtrim(rtrim(v_src), E' \t\r\n;');
    v_body := E'\n#variable_conflict use_column\nbegin\n' || v_guard
              || E'  return query\n' || v_body || E';\nend\n';
  else
    raise exception '0312 REFUSES: ledger_checks is language %, which this migration does not know how to rewrite', v_lang;
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

  raise notice '0312: guard injected into ledger_checks (was language %)', v_lang;
end
$gen$;

-- ---------------------------------------------------------------------------
-- Verification.
-- ---------------------------------------------------------------------------

do $verify$
declare
  v_outcome text;
begin
  begin
    declare
      v_n int; v_co uuid; v_other uuid; v_p uuid; v_msg text; v_ok boolean;
    begin
      -- 1. THE GAP LIST IS EMPTY. This is the condition 0248 asserts, and the
      -- only reason this file exists.
      select count(*) into v_n from public.tenant_guard_gaps();
      if v_n > 0 then
        raise exception '0312 FAILED: % parameter(s) still uncovered', v_n;
      end if;

      -- 2. THE FUNCTION STILL ANSWERS IDENTICALLY, for every company and every
      -- column, in both directions. A guard that silenced the check layer would
      -- also make the gap list empty.
      select count(*) into v_n from (
        select * from zz_0312_before
        except all
        select c.id, l.check_name, l.expected, l.actual, l.difference, l.passed
          from public.companies c, lateral public.ledger_checks(c.id) l) d;
      if v_n <> 0 then
        raise exception '0312 FAILED: % check row(s) lost or changed by the conversion', v_n;
      end if;

      select count(*) into v_n from (
        select c.id, l.check_name, l.expected, l.actual, l.difference, l.passed
          from public.companies c, lateral public.ledger_checks(c.id) l
        except all
        select * from zz_0312_before) d;
      if v_n <> 0 then
        raise exception '0312 FAILED: % check row(s) appeared', v_n;
      end if;

      -- 3. THE CANARY IS GREEN ON EVERY COMPANY.
      select count(*) into v_n
        from public.companies c, lateral public.ledger_checks(c.id) l
       where l.check_name = 'checks_evaluated' and not l.passed;
      if v_n <> 0 then
        raise exception '0312 FAILED: the canary is red on % compan(ies)', v_n;
      end if;

      -- 4. NON-VACUITY. Strip the guard; the detector must report exactly one.
      -- Restore it and require the count back to zero, so a failure here cannot
      -- leave the database holding a stripped function.
      declare
        v_src text; v_new text; v_def text; v_hdr text; v_rest text;
        v_oid oid; q1 int; q2 int; v_after int;
      begin
        select p.oid, p.prosrc into v_oid, v_src from pg_proc p
         where p.pronamespace = 'public'::regnamespace and p.proname = 'ledger_checks';
        -- Marker-agnostic on purpose. On dev this file replays against a
        -- ledger_checks that 0287 already guarded and whose comment says
        -- [claimed, 0287]; a probe keyed to this migration's own number would
        -- report VACUOUS there and fail a database that is already correct.
        v_new := regexp_replace(v_src,
                   '[^\n]*tenant guard \[claimed[^\n]*\n[^\n]*assert_same_company[^\n]*\n', '', 'g');
        if v_new = v_src then
          raise exception 'PROBE VACUOUS: no [claimed] guard found in ledger_checks to strip';
        end if;
        v_def  := pg_get_functiondef(v_oid);
        q1     := strpos(v_def, '$function$'); v_rest := substr(v_def, q1 + 10);
        q2     := strpos(v_rest, '$function$'); v_hdr  := left(v_def, q1 - 1);
        execute v_hdr || '$function$' || v_new || '$function$' || substr(v_rest, q2 + 10);
        select count(*) into v_after from public.tenant_guard_gaps();
        if v_after <> 1 then
          raise exception 'PROBE INSENSITIVE: stripped the guard and the detector reported %', v_after;
        end if;
        execute v_hdr || '$function$' || v_src || '$function$' || substr(v_rest, q2 + 10);
        select count(*) into v_after from public.tenant_guard_gaps();
        if v_after <> 0 then
          raise exception 'PROBE DID NOT RESTORE: % gap(s) left behind', v_after;
        end if;
      end;

      -- 5. IT PERMITS AND IT REFUSES, as a real tenant identity. Zero gaps is a
      -- statement about the SOURCE of a function; this is a statement about
      -- what it does when called.
      select c.id into v_co from public.companies c
       where exists (select 1 from public.profiles p
                      where p.company_id = c.id
                        and coalesce(p.role::text,'') <> 'super_super_admin')
       order by c.created_at limit 1;
      select p.id into v_p from public.profiles p
       where p.company_id = v_co and coalesce(p.role::text,'') <> 'super_super_admin' limit 1;
      select c.id into v_other from public.companies c where c.id <> v_co limit 1;
      if v_co is null or v_p is null or v_other is null then
        raise exception '0312 cannot self-test: needs two companies and a non-super profile';
      end if;

      perform set_config('request.jwt.claims',
        json_build_object('sub', v_p::text, 'role', 'authenticated')::text, true);

      select count(*) into v_n from public.ledger_checks(v_co);
      if v_n = 0 then
        raise exception '0312 FAILED: ledger_checks(OWN) returned nothing for an authenticated caller';
      end if;

      v_ok := false;
      begin
        perform public.ledger_checks(v_other);
      exception when others then
        get stacked diagnostics v_msg = message_text;
        v_ok := (v_msg = 'Row not found');
      end;
      if not v_ok then
        raise exception '0312 FAILED: ledger_checks(FOREIGN) was not refused (msg: %)',
          coalesce(v_msg, '<no error>');
      end if;

      perform set_config('request.jwt.claims', null, true);
      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0312 verification failed: %', v_outcome;
  end if;
end
$verify$;
