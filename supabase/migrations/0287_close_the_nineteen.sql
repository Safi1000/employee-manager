-- 0287 — Close the nineteen tenant-guard gaps the ledger work reopened.
--
-- DEV ONLY.
--
-- WHERE THE NINETEEN CAME FROM
--
-- 0252 closed 29 parameters and left tenant_guard_gaps() green. Migrations
-- 0253-0284 then added SECURITY DEFINER functions with tenant-scoped
-- parameters and nothing reported it, because nothing called the detector.
-- 0286 wired it into ledger_checks() and the number became visible: 19.
--
-- This migration closes them. It is deliberately separate from 0286: wiring a
-- detector and fixing what it finds are different changes, and a check that is
-- green the moment it is written proves nothing.
--
-- THE MAP IS KEYED BY (FUNCTION, PARAMETER), AND THAT IS THE POINT
--
-- 0242 and 0252 keyed their resolver maps by PARAMETER NAME alone. That was
-- safe while every p_run_id meant the same thing. It no longer is:
--
--   0242's map:                  p_run_id -> payroll_runs
--   reverse_profit_allocation:   p_run_id -> profit_allocation_runs
--
-- A name-keyed map would have resolved a profit-allocation run against
-- payroll_runs, found nothing, and refused every legitimate call — a guard that
-- looks correct in review and silently breaks the feature. This is exactly the
-- failure 0242's own header warns about ("guessing it from the name is how you
-- end up resolving p_client_id against employees"), arriving for real.
--
-- So the map below is keyed by both. Adding a function whose parameter name
-- collides with an existing one is now a new row, not a silent reuse.
--
-- TWO THINGS FOUND WHILE READING, WHICH ARE NOT COVERAGE GAPS
--
-- 1. reverse_profit_allocation WAS ALREADY GUARDED. It looks the run up and
--    calls assert_same_company(v_run.company_id). The check flagged it only
--    because the guard does not mention p_run_id. Acting on that report without
--    reading it would have added a redundant second guard.
--
--    But reading it found a real defect of a different kind: it raises
--    'Allocation run not found' BEFORE the guard, so a missing id and a
--    foreign id answer differently. That is an existence oracle — the same
--    defect 0242b fixed in record_invoice_payment. The guard added here goes in
--    FIRST, so both cases now answer 'Row not found' identically, and the
--    original check below it becomes unreachable with a foreign id.
--
-- 2. sync_cheque_journal returns the string 'no such cheque' for an unknown id.
--    Same shape, milder: it returns rather than raises. The guard now answers
--    first. Its callers are triggers running as postgres, which the guard
--    exempts, so trigger behaviour is unchanged.
--
-- ONE BESPOKE RESOLVER
--
-- sync_bank_transfer_journal takes p_pair_id, which is not a primary key: it is
-- bank_transactions.transfer_pair_id, and a pair is two rows. The standard
-- `where id = p_param` template does not apply. The resolver uses
-- `select distinct company_id`, which is deliberate on both edges — no rows
-- gives NULL and the guard refuses; two DIFFERENT companies in one pair makes
-- the scalar subquery raise rather than pick one. Both fail closed.
--
-- TEN OF THE NINETEEN ARE `language sql`
--
-- A SQL function cannot raise, so those are converted to plpgsql exactly as
-- 0242 did, with #variable_conflict use_column for the RETURNS TABLE cases.
-- Checked before accepting the cost: none of the ten appears in a view, an RLS
-- policy, a CHECK constraint, an index expression or a column default, so
-- nothing loses inlining that depends on it. That precondition is re-asserted
-- below rather than trusted from the audit.

-- ---------------------------------------------------------------------------
-- PART 1. The map. HAND-WRITTEN AND REVIEWED.
-- ---------------------------------------------------------------------------

create temp table _tg3 (
  fname   text not null,
  param   text not null,
  kind    text not null,          -- 'claimed' | 'resolved' | 'bespoke'
  tbl     text,                   -- for 'resolved'
  expr    text,                   -- for 'bespoke'
  primary key (fname, param)
) on commit drop;

insert into _tg3 (fname, param, kind, tbl, expr) values
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
  -- NOT payroll_runs. See the header.
  ('reverse_profit_allocation', 'p_run_id',                'resolved', 'profit_allocation_runs', null),
  ('settlement_account',        'p_bank_account_id',       'resolved', 'bank_accounts',          null),
  ('settlement_account',        'p_custodian_location_id', 'resolved', 'cash_locations',         null),
  ('sync_cheque_journal',       'p_cheque_id',             'resolved', 'cheques',                null),

  -- [bespoke]: not a primary key. Fails closed on zero rows and on two companies.
  ('sync_bank_transfer_journal','p_pair_id', 'bespoke', null,
   'select distinct bt.company_id from public.bank_transactions bt where bt.transfer_pair_id = p_pair_id');

-- ---------------------------------------------------------------------------
-- PART 2. Preconditions.
-- ---------------------------------------------------------------------------

do $pre$
declare
  v_bad text;
begin
  -- 2a. Every resolved table exists and carries company_id.
  select string_agg(m.fname || '.' || m.param || ' -> ' || m.tbl, ', ')
    into v_bad
    from _tg3 m
   where m.kind = 'resolved'
     and not exists (select 1 from information_schema.columns c
                      where c.table_schema = 'public' and c.table_name = m.tbl
                        and c.column_name = 'company_id');
  if v_bad is not null then
    raise exception '0287 map is wrong — no public.<table>.company_id for: %', v_bad;
  end if;

  -- 2b. The map matches the gap list EXACTLY, in both directions. If the
  -- database has moved since this was written, stop rather than guess.
  select string_agg(x.msg, '; ') into v_bad from (
    select 'IN GAPS, NOT IN MAP: ' || g.function_name || '.' || g.parameter_name as msg
      from public.tenant_guard_gaps() g
     where not exists (select 1 from _tg3 m where m.fname = g.function_name and m.param = g.parameter_name)
    union all
    select 'IN MAP, NOT A GAP: ' || m.fname || '.' || m.param
      from _tg3 m
     where not exists (select 1 from public.tenant_guard_gaps() g
                        where g.function_name = m.fname and g.parameter_name = m.param)
  ) x;
  if v_bad is not null then
    raise exception '0287 refuses to run: the map and the live gap list disagree — %', v_bad;
  end if;

  -- 2c. No target is depended on by a view, policy, CHECK, index or default.
  -- Converting a language-sql function to plpgsql would break those.
  select string_agg(distinct m.fname, ', ') into v_bad
    from _tg3 m
   where (select count(*) from pg_views v where v.schemaname='public' and v.definition ~ ('\m'||m.fname||'\M')) > 0
      or (select count(*) from pg_policy pol
           where pg_get_expr(pol.polqual,pol.polrelid) ~ ('\m'||m.fname||'\M')
              or coalesce(pg_get_expr(pol.polwithcheck,pol.polrelid),'') ~ ('\m'||m.fname||'\M')) > 0
      or (select count(*) from pg_constraint k where k.contype='c'
           and pg_get_constraintdef(k.oid) ~ ('\m'||m.fname||'\M')) > 0
      or (select count(*) from pg_index i where pg_get_indexdef(i.indexrelid) ~ ('\m'||m.fname||'\M')) > 0
      or (select count(*) from pg_attrdef d where pg_get_expr(d.adbin,d.adrelid) ~ ('\m'||m.fname||'\M')) > 0;
  if v_bad is not null then
    raise exception '0287 cannot convert %: depended on by a view, policy, constraint, index or default', v_bad;
  end if;

  -- 2d. Injection safety for the plpgsql targets, as 0242 PART 4b.
  select string_agg(x.proname, ', ') into v_bad
    from (
      select p.proname, p.prosrc, regexp_instr(p.prosrc, '\mbegin\M', 1, 1, 0, 'i') b
        from pg_proc p join pg_language l on l.oid = p.prolang
       where p.pronamespace='public'::regnamespace and l.lanname='plpgsql'
         and p.proname::text in (select fname from _tg3)
    ) x
   where x.b = 0
      or (length(left(x.prosrc, x.b - 1))
          - length(replace(left(x.prosrc, x.b - 1), '''', ''))) % 2 = 1;
  if v_bad is not null then
    raise exception '0287 cannot safely inject into: %', v_bad;
  end if;
end
$pre$;

-- ---------------------------------------------------------------------------
-- PART 3. Generation.
--
-- Source is re-read from the catalogue on every iteration — the 0252 lesson.
-- settlement_account has three gaps and bank_account_gl two; building each
-- rewrite from a snapshot taken before the loop would silently lose all but the
-- last.
-- ---------------------------------------------------------------------------

do $gen$
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
begin
  for r in select * from _tg3 order by fname, param
  loop
    select p.oid, p.prosrc, l.lanname, p.prorettype::regtype::text, p.proretset
      into v_oid, v_src, v_lang, v_ret, v_set
      from pg_proc p join pg_language l on l.oid = p.prolang
     where p.pronamespace = 'public'::regnamespace and p.proname::text = r.fname;

    if public.tenant_guard_covered(v_src, r.param) then
      continue;                      -- idempotent replay
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

  raise notice '0287 guarded % parameter(s)', v_done;
end
$gen$;

-- ---------------------------------------------------------------------------
-- PART 4. Verification.
--
-- Zero gaps is necessary and nowhere near sufficient. The conversions rewrote
-- ten functions from SQL to plpgsql, including ledger_checks itself, so the
-- suite has to prove those still WORK — refusing correctly while returning
-- nothing would be a silent outage of the whole check layer.
-- ---------------------------------------------------------------------------

do $verify$
declare
  v_outcome text;
begin
  begin
    declare
      v_n int; v_co uuid; v_other uuid; v_p uuid; v_msg text; v_ok boolean;
      v_rows int; v_canary boolean;
    begin
      -- 1. The gap list is empty.
      select count(*) into v_n from public.tenant_guard_gaps();
      if v_n > 0 then
        raise exception '0287 FAILED: % parameter(s) still uncovered', v_n;
      end if;

      -- 2. NON-VACUITY: the check must still be able to report. Strip one of
      -- the guards this migration added and require the count to rise.
      declare
        v_src text; v_new text; v_def text; v_hdr text; v_rest text;
        v_oid oid; q1 int; q2 int; v_after int;
      begin
        select p.oid, p.prosrc into v_oid, v_src from pg_proc p
         where p.pronamespace='public'::regnamespace and p.proname='unposted_source_rows';
        v_new := regexp_replace(v_src, '[^\n]*0287[^\n]*\n[^\n]*assert_same_company[^\n]*\n', '', 'g');
        if v_new = v_src then
          raise exception 'PROBE VACUOUS: no 0287 guard found in unposted_source_rows';
        end if;
        v_def := pg_get_functiondef(v_oid);
        q1 := strpos(v_def,'$function$'); v_rest := substr(v_def,q1+10);
        q2 := strpos(v_rest,'$function$'); v_hdr := left(v_def,q1-1);
        execute v_hdr || '$function$' || v_new || '$function$' || substr(v_rest,q2+10);
        select count(*) into v_after from public.tenant_guard_gaps();
        if v_after <> 1 then
          raise exception 'PROBE INSENSITIVE: stripped a 0287 guard and the check reported %', v_after;
        end if;
        -- put it back; the outer block must end green
        execute v_hdr || '$function$' || v_src || '$function$' || substr(v_rest,q2+10);
        select count(*) into v_after from public.tenant_guard_gaps();
        if v_after <> 0 then
          raise exception 'PROBE DID NOT RESTORE: % gap(s) left behind', v_after;
        end if;
      end;

      -- 3. THE CONVERTED FUNCTIONS STILL WORK. ledger_checks is the one that
      -- matters: it was language sql, it is now plpgsql, and every other check
      -- in this project is read through it.
      select c.id into v_co from public.companies c where c.name = 'SANDBOX TESTING ORG';
      select p.id into v_p from public.profiles p
       where p.company_id = v_co and coalesce(p.role::text,'') <> 'super_super_admin' limit 1;
      if v_p is null then
        select p.id into v_p from public.profiles p where p.company_id = v_co limit 1;
      end if;
      select c.id into v_other from public.companies c where c.id <> v_co limit 1;

      select count(*) into v_rows from public.ledger_checks(v_co);
      if v_rows <> 20 then
        raise exception '0287 FAILED: ledger_checks returned % rows after conversion, expected 20', v_rows;
      end if;
      select passed into v_canary from public.ledger_checks(v_co) where check_name = 'checks_evaluated';
      if not v_canary then
        raise exception '0287 FAILED: the ledger_checks canary is red after conversion';
      end if;

      -- 4. PERMITTING: as a real tenant identity, own company still works.
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_p::text, 'role', 'authenticated')::text, true);

      select count(*) into v_rows from public.ledger_checks(v_co);
      if v_rows <> 20 then
        raise exception '0287 FAILED: ledger_checks(OWN) returned % rows for an authenticated caller', v_rows;
      end if;
      perform public.unposted_source_rows(v_co);
      perform public.custodian_held_operational(v_co);
      perform public.settlement_account(v_co, 'Cash', null, null, true);

      -- 5. REFUSING: another company is refused, identically.
      v_ok := false;
      begin
        perform public.ledger_checks(v_other);
      exception when others then
        get stacked diagnostics v_msg = message_text;
        v_ok := (v_msg = 'Row not found');
      end;
      if not v_ok then
        raise exception '0287 FAILED: ledger_checks(FOREIGN) was not refused (msg: %)',
          coalesce(v_msg, '<no error>');
      end if;

      v_ok := false;
      begin
        perform public.unposted_source_rows(v_other);
      exception when others then
        get stacked diagnostics v_msg = message_text;
        v_ok := (v_msg = 'Row not found');
      end;
      if not v_ok then
        raise exception '0287 FAILED: unposted_source_rows(FOREIGN) was not refused';
      end if;

      -- 6. NO ORACLE on the reordered guard: a missing allocation run and a
      -- foreign one must answer identically. This is the defect found while
      -- reading reverse_profit_allocation.
      v_ok := false;
      begin
        perform public.reverse_profit_allocation('00000000-0000-0000-0000-000000000000'::uuid);
      exception when others then
        get stacked diagnostics v_msg = message_text;
        v_ok := (v_msg = 'Row not found');
      end;
      if not v_ok then
        raise exception '0287 FAILED: a non-existent allocation run answers % — still an oracle',
          coalesce(v_msg, '<no error>');
      end if;

      perform set_config('request.jwt.claims', null, true);
      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0287 verification failed: %', v_outcome;
  end if;
end
$verify$;
