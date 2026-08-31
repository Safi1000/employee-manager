-- supabase/tests/tenant_guard.sql
--
-- Proves 0242 / 0242b / 0242c: a session authenticated for company A is
-- refused against another company's rows, on EVERY guarded function.
--
-- Result on dev at the time of writing:
--
--   population=135 seeded=10
--   NEG[exercised=135 pass=135 fail=0 noguard=0 nofixture=0]
--   POS[pass=129 fail=0 skip=6]
--   gaps=0
--
-- THIS SUITE FOUND THE BUG THAT MADE THE WHOLE FIX A NO-OP
--
-- 0242 shipped a guard that never fired. It exempted trusted backends with
-- `current_user not in ('authenticated','anon')`, and SECURITY DEFINER SETS
-- current_user to the function owner — so inside all 135 guarded functions
-- current_user was 'postgres' and the guard returned immediately, for every
-- caller. 0242's own verification passed the whole time, because it asserted
-- that each function CALLS assert_same_company, which a no-op satisfies.
--
-- This suite reported 60 of 60 negative cases returning normally on its first
-- run. That is the entire argument for demonstrating a refusal instead of
-- inspecting for one. 0242c fixed the signal; see it for what replaced it.
--
-- HOW THIS RUNS AS A REAL TENANT
--
-- SECURITY DEFINER functions get no caller RLS, so running as postgres proves
-- nothing — postgres passes everything. The suite binds a real identity:
--
--   select set_config('request.jwt.claims', json with sub = <profile in A>);
--   set local role authenticated;
--
-- and then REFUSES TO CONTINUE unless current_company_id() actually resolves
-- to A and the profile is not SSA-unscoped. An SSA-unscoped profile is
-- permitted everywhere, so a suite that picked one would report 135 passes
-- and mean none of them.
--
-- WHAT EACH FUNCTION GETS, AND WHY BOTH DIRECTIONS
--
--   NEGATIVE  the guarded parameter set to another company's row
--             -> must raise exactly 'Row not found'
--   POSITIVE  the same parameter set to the caller's OWN row
--             -> must NOT raise 'Row not found'
--
-- A refusal-only suite would score a perfect pass against a guard that refuses
-- everybody, which is not a fix but an outage. Any OTHER error in the positive
-- direction is accepted: business rules, wrong state, a dummy argument the
-- function rejects. The assertion is narrow on purpose — the tenant guard did
-- not fire.
--
-- FOUR THINGS THIS SUITE LEARNED THE HARD WAY
--
-- 1. THE POPULATION IS THE POPULATION. An earlier version derived the expected
--    count from `prosrc like '%assert_same_company%'`. Removing a guard then
--    shrank the expected count to match and the suite reported all-pass over a
--    smaller set. It now enumerates SECURITY DEFINER functions taking a uuid,
--    minus the commented exemptions, and a member with no guard is a FAILURE
--    (NO-GUARD), never an absence.
--
-- 2. FIXTURES ARE RESOLVED BEFORE THE ROLE SWITCH. After `set local role
--    authenticated` the suite's own reads are subject to RLS and cannot see
--    company B at all, which silently turned all 76 resolved cases into NO
--    FIXTURE and looked like a data shortage.
--
-- 3. THE GUARDED PARAMETER IS NOT ALWAYS THE FIRST. post_manual_journal takes
--    a date first and the guarded account id third. Putting the uuid in
--    position 1 produces a signature error that reads exactly like a guard
--    failure. The position is read from proargnames.
--
-- 4. OTHER UUID ARGUMENTS ARE NULL, NOT FABRICATED. A fabricated uuid is
--    foreign by construction, so a second guard on it refuses first and the
--    result says nothing about the guard under test. That is what made
--    post_manual_journal appear to refuse its own company.
--
-- SEEDING, AND WHY IT IS NOT CHEATING
--
-- Ten tables are entirely EMPTY on dev — alerts, bonus_pools,
-- approval_requests, payroll_runs, fixed_assets, contract_mobilisations,
-- opening_balance_batches, bonus_pool_allocations, posts, appraisals. Without
-- fixtures, 14 of the 135 would report NO FIXTURE, which is not a pass: the
-- guard refuses a missing row and a foreign row with the SAME message by
-- design, so an absent row proves only the existence-oracle property. The
-- suite seeds a minimal row owned by another company and rolls it back, so
-- the refusal it observes is a genuine TENANT refusal.
--
-- PROVING THE GUARD CAN FAIL
--
-- Run the block at the foot after the main suite. It strips the guard from
-- effective_salary, confirms the suite goes red on exactly that function and
-- tenant_guard_gaps() reports it, then rolls everything back. Verified:
--
--   BREAK -> gaps=1 (effective_salary)
--            NEG[exercised=135 pass=134 fail=1 noguard=1] gaps=1
--
-- Everything below runs in one transaction and is rolled back by a deliberate
-- exception at the end. The positive controls call real write functions and
-- the seeder inserts real rows; nothing survives.

-- ---------------------------------------------------------------------------
-- Argument filler. Type-appropriate NON-NULL literals, because a STRICT
-- function handed a NULL returns NULL without running its body at all — a
-- NULL-filled suite would report a false result on every strict function.
-- These values are meaningless on purpose; they exist only to get past the
-- call boundary so the guard, which is the first statement in every guarded
-- body, can run.
-- ---------------------------------------------------------------------------
create or replace function public._tg_dummy(p_type oid)
returns text language plpgsql stable as $dummy$
declare v_name text := p_type::regtype::text; v_label text;
begin
  if exists (select 1 from pg_type t where t.oid = p_type and t.typtype = 'e') then
    select e.enumlabel into v_label from pg_enum e
     where e.enumtypid = p_type order by e.enumsortorder limit 1;
    return quote_literal(v_label) || '::' || v_name;
  end if;
  return case v_name
    when 'uuid'                        then quote_literal('00000000-0000-0000-0000-000000000000') || '::uuid'
    when 'text'                        then quote_literal('x')
    when 'character varying'           then quote_literal('x')
    when 'date'                        then 'current_date'
    when 'boolean'                     then 'false'
    when 'smallint'                    then '1'
    when 'integer'                     then '1'
    when 'bigint'                      then '1'
    when 'numeric'                     then '1'
    when 'double precision'            then '1'
    when 'jsonb'                       then quote_literal('{}') || '::jsonb'
    when 'json'                        then quote_literal('{}') || '::json'
    when 'text[]'                      then 'array[]::text[]'
    when 'timestamp with time zone'    then 'now()'
    when 'timestamp without time zone' then 'now()::timestamp'
    else 'null::' || v_name
  end;
end
$dummy$;

-- ---------------------------------------------------------------------------
-- Minimal-row seeder. Fills every NOT NULL column that has no default: the
-- company columns with the requested owner, foreign keys with any existing
-- parent, everything else with a dummy. Pointing a foreign key at a parent in
-- a different company does not weaken the test — the guard reads the CHILD's
-- company_id, which is the value under test.
--
-- Returns NULL rather than raising if a row cannot be built, so an
-- unseedable table shows up as NO FIXTURE and is reported, never skipped
-- silently.
-- ---------------------------------------------------------------------------
create or replace function public._tg_seed(p_tbl text, p_company uuid)
returns uuid language plpgsql as $seed$
declare
  c record; cols text := ''; vals text := ''; v_id uuid; v_val text;
begin
  for c in
    select a.attname, a.atttypid,
           (select confrelid::regclass::text from pg_constraint k
             where k.conrelid = a.attrelid and k.contype = 'f' and a.attnum = any(k.conkey) limit 1) as reftbl
      from pg_attribute a
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where a.attrelid = ('public.'||p_tbl)::regclass and a.attnum > 0 and not a.attisdropped
       and a.attnotnull and d.adbin is null
     order by a.attnum
  loop
    if c.attname = 'company_id' or c.reftbl = 'companies' then
      v_val := quote_literal(p_company) || '::uuid';
    elsif c.reftbl is not null then
      execute format('select id from %s limit 1', c.reftbl) into v_id;
      if v_id is null then return null; end if;
      v_val := quote_literal(v_id) || '::uuid';
    else
      v_val := public._tg_dummy(c.atttypid);
    end if;
    if cols <> '' then cols := cols || ', '; vals := vals || ', '; end if;
    cols := cols || quote_ident(c.attname);
    vals := vals || v_val;
  end loop;
  if position('company_id' in cols) = 0 then
    cols := cols || case when cols = '' then '' else ', ' end || 'company_id';
    vals := vals || case when vals = '' then '' else ', ' end || quote_literal(p_company) || '::uuid';
  end if;
  execute format('insert into public.%I (%s) values (%s) returning id', p_tbl, cols, vals) into v_id;
  return v_id;
exception when others then
  return null;
end
$seed$;

-- ---------------------------------------------------------------------------
-- The suite.
-- ---------------------------------------------------------------------------
create or replace function public._tg_run()
returns void language plpgsql as $suite$
declare
  v_a uuid; v_other uuid; v_profile uuid; r record;
  v_types oid[]; v_argsql text; v_call text;
  v_msg text; i int; v_pos int;
  v_pass int := 0; v_fail int := 0; v_nofix int := 0; v_noguard int := 0;
  v_pos_pass int := 0; v_pos_fail int := 0; v_pos_skip int := 0;
  v_exercised int := 0; v_expected int; v_failures text := ''; v_gaps int;
  v_nofix_list text := ''; v_out text; v_tbl text; v_param text;
  v_fid uuid; v_oid2 uuid; v_seeded int := 0;
begin
  -- Company A is the one with the most profiles, so the positive controls have
  -- the best chance of real fixtures.
  select company_id into v_a from public.profiles
   where company_id is not null and coalesce(role::text,'') <> 'super_super_admin'
   group by company_id order by count(*) desc limit 1;
  select id into v_profile from public.profiles
   where company_id = v_a and coalesce(role::text,'') <> 'super_super_admin' limit 1;
  select id into v_other from public.companies where id is distinct from v_a limit 1;
  if v_a is null or v_profile is null or v_other is null then
    raise exception 'tenant_guard ABORTED: needs two companies and a non-SSA profile';
  end if;

  create temp table _tg_fix (fn text primary key, tbl text, param text, argpos int,
                             foreign_id uuid, own_id uuid, guarded boolean) on commit drop;
  -- The suite reads this back AFTER switching role; without the grant every
  -- case fails with "permission denied for table _tg_fix".
  execute 'grant select on _tg_fix to authenticated';

  -- PASS 1, unrestricted: enumerate the POPULATION and resolve every fixture.
  -- Both halves must happen before the role switch.
  for r in
    select p.oid, p.proname, p.prosrc, p.proargnames,
           (p.prosrc ilike '%assert_same_company%') as guarded
      from pg_proc p
     where p.pronamespace='public'::regnamespace and p.prosecdef
       and pg_get_function_identity_arguments(p.oid) ilike '%uuid%'
       and p.proname <> 'assert_same_company'
       and coalesce(obj_description(p.oid,'pg_proc'),'') not like 'TENANT GUARD EXEMPT%'
  loop
    -- The target table is read out of the GENERATED GUARD, not from a copy of
    -- 0242's resolver map. A copied map drifts from the code it describes and
    -- then the suite tests the copy.
    v_tbl := (regexp_match(r.prosrc,'assert_same_company\(\(select company_id from public\.(\w+) where id ='))[1];
    if v_tbl is null then
      -- [claimed] shape: the parameter is the company itself.
      v_param := (regexp_match(r.prosrc,'assert_same_company\((p_\w+)\)'))[1];
      v_fid := v_other; v_oid2 := v_a;
    else
      v_param := (regexp_match(r.prosrc,'assert_same_company\(\(select company_id from public\.\w+ where id = (\w+)'))[1];
      execute format('select id from public.%I where company_id is distinct from $1 and company_id is not null limit 1', v_tbl)
        into v_fid using v_a;
      execute format('select id from public.%I where company_id = $1 limit 1', v_tbl) into v_oid2 using v_a;
      if v_fid is null then
        v_fid := public._tg_seed(v_tbl, v_other);
        if v_fid is not null then v_seeded := v_seeded + 1; end if;
      end if;
      if v_oid2 is null then v_oid2 := public._tg_seed(v_tbl, v_a); end if;
    end if;
    select coalesce(array_position(r.proargnames, v_param), 1) into v_pos;
    insert into _tg_fix values (r.proname, coalesce(v_tbl,'<claimed>'), v_param, v_pos, v_fid, v_oid2, r.guarded);
  end loop;

  select count(*) into v_expected from _tg_fix;

  -- PASS 2: become company A.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_profile::text, 'role','authenticated')::text, true);
  set local role authenticated;

  -- THE LOAD-BEARING PRECONDITIONS. If either is wrong every result below is
  -- meaningless, and meaningless results that say PASS are worse than none.
  if public.current_company_id() is distinct from v_a then
    raise exception 'tenant_guard ABORTED: current_company_id() is % but the suite acts for %',
      public.current_company_id(), v_a;
  end if;
  if public.is_ssa_unscoped() then
    raise exception 'tenant_guard ABORTED: the chosen profile is SSA-unscoped and is permitted everywhere';
  end if;

  for r in
    select p.proname, p.proretset, p.proargtypes, f.tbl, f.argpos, f.foreign_id, f.own_id, f.guarded
      from pg_proc p join _tg_fix f on f.fn = p.proname::text
     where p.pronamespace='public'::regnamespace and p.prosecdef
     order by p.proname
  loop
    v_types := string_to_array(r.proargtypes::text,' ')::oid[];

    if not r.guarded then
      -- A member of the population with no guard is a FAILURE, not an absence.
      v_noguard := v_noguard + 1; v_exercised := v_exercised + 1; v_fail := v_fail + 1;
      v_failures := v_failures || ' | NO-GUARD ' || r.proname;
    elsif r.foreign_id is null then
      v_nofix := v_nofix + 1;
      v_nofix_list := v_nofix_list || ' ' || r.proname || '(' || r.tbl || ')';
    else
      v_argsql := '';
      for i in 1 .. coalesce(array_length(v_types,1),0) loop
        if i > 1 then v_argsql := v_argsql || ', '; end if;
        v_argsql := v_argsql || case
          when i = r.argpos then quote_literal(r.foreign_id)||'::uuid'
          when v_types[i] = 'uuid'::regtype::oid then 'null::uuid'
          else public._tg_dummy(v_types[i]) end;
      end loop;
      v_call := case when r.proretset then format('perform * from public.%I(%s)', r.proname, v_argsql)
                     else format('perform public.%I(%s)', r.proname, v_argsql) end;
      v_exercised := v_exercised + 1;
      begin
        execute 'do $x$ begin ' || v_call || '; end $x$';
        v_fail := v_fail + 1;
        v_failures := v_failures || ' | NEG-FAIL ' || r.proname || ' :: returned normally';
      exception when others then
        get stacked diagnostics v_msg = message_text;
        -- Assert on the MESSAGE, not on the fact that something raised. A
        -- business-rule error is not a refusal, and three tests in this project
        -- passed against the wrong trigger before that rule was enforced.
        if v_msg = 'Row not found' then v_pass := v_pass + 1;
        else
          v_fail := v_fail + 1;
          v_failures := v_failures || ' | NEG-FAIL ' || r.proname || ' :: ' || left(v_msg,55);
        end if;
      end;
    end if;

    if r.own_id is null or not r.guarded then v_pos_skip := v_pos_skip + 1;
    else
      v_argsql := '';
      for i in 1 .. coalesce(array_length(v_types,1),0) loop
        if i > 1 then v_argsql := v_argsql || ', '; end if;
        v_argsql := v_argsql || case
          when i = r.argpos then quote_literal(r.own_id)||'::uuid'
          when v_types[i] = 'uuid'::regtype::oid then 'null::uuid'
          else public._tg_dummy(v_types[i]) end;
      end loop;
      v_call := case when r.proretset then format('perform * from public.%I(%s)', r.proname, v_argsql)
                     else format('perform public.%I(%s)', r.proname, v_argsql) end;
      begin
        execute 'do $x$ begin ' || v_call || '; end $x$';
        v_pos_pass := v_pos_pass + 1;
      exception when others then
        get stacked diagnostics v_msg = message_text;
        if v_msg = 'Row not found' then
          v_pos_fail := v_pos_fail + 1;
          v_failures := v_failures || ' | POS-FAIL ' || r.proname || ' refused its OWN company';
        else v_pos_pass := v_pos_pass + 1; end if;
      end;
    end if;
  end loop;

  reset role;
  select count(*) into v_gaps from public.tenant_guard_gaps();

  -- CANARY. A suite whose silence cannot distinguish "all passed" from
  -- "aborted at function 9" is not a harness.
  if v_exercised + v_nofix <> v_expected then
    raise exception 'tenant_guard CANARY FAILED: population % but % accounted for — the loop did not finish',
      v_expected, v_exercised + v_nofix;
  end if;

  v_out := format('RESULT population=%s seeded=%s NEG[exercised=%s pass=%s fail=%s noguard=%s nofixture=%s] POS[pass=%s fail=%s skip=%s] gaps=%s FAILURES:%s NOFIX:%s',
    v_expected, v_seeded, v_exercised, v_pass, v_fail, v_noguard, v_nofix,
    v_pos_pass, v_pos_fail, v_pos_skip, v_gaps,
    left(v_failures, 1500), left(v_nofix_list, 500));

  -- Raised rather than returned, for two reasons: it is the only way the
  -- summary reaches a caller that cannot see NOTICE output, and it guarantees
  -- the rollback of every seeded row and every positive-control write.
  raise exception '%', v_out;
end
$suite$;

select public._tg_run();

-- ---------------------------------------------------------------------------
-- PROVE THE GUARD CAN FAIL. Run this separately; it rolls itself back.
--
-- Strips the guard from effective_salary and confirms BOTH detectors fire:
-- tenant_guard_gaps() reports it, and the suite counts it as NO-GUARD against
-- an unchanged population of 135. Confirmed output:
--
--   BREAK -> gaps=1 (effective_salary)
--            NEG[exercised=135 pass=134 fail=1 noguard=1] gaps=1
-- ---------------------------------------------------------------------------
--
-- do $break$
-- declare
--   v_def text; v_hdr text; v_rest text; v_body text; p1 int; p2 int;
--   v_src text; v_oid oid; v_msg text; v_gaps int; v_gapnames text;
-- begin
--   select p.oid, p.prosrc into v_oid, v_src from pg_proc p
--    where p.pronamespace='public'::regnamespace and p.proname='effective_salary';
--   v_body := regexp_replace(v_src,
--     '\s*--\s*tenant guard \[resolved\][^\n]*\n\s*perform public\.assert_same_company\([^\n]*\n', E'\n');
--   if v_body = v_src then raise exception 'BREAK SETUP FAILED: guard line not found'; end if;
--   v_def  := pg_get_functiondef(v_oid);
--   p1     := strpos(v_def, '$function$');
--   v_rest := substr(v_def, p1 + 10);
--   p2     := strpos(v_rest, '$function$');
--   v_hdr  := left(v_def, p1 - 1);
--   execute v_hdr || '$function$' || v_body || '$function$' || substr(v_rest, p2 + 10);
--   select count(*), string_agg(function_name, ',') into v_gaps, v_gapnames
--     from public.tenant_guard_gaps();
--   begin
--     perform public._tg_run();
--     v_msg := '<suite did not raise>';
--   exception when others then get stacked diagnostics v_msg = message_text;
--   end;
--   raise exception 'BREAK -> gaps=% (%) ||| %', v_gaps, v_gapnames, left(v_msg, 350);
-- end
-- $break$;
