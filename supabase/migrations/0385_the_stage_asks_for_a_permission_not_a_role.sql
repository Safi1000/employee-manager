-- 0385 — transition_record_state asks for a PERMISSION, one per stage, and
--        asserts the branch of the employee it moves.
--
-- ===========================================================================
-- FOUR ROLE LITERALS, REPLACED BY TWO KEYS
-- ===========================================================================
--
-- Every other gate in this codebase asks has_perm(). This one asked
-- `select role::text from profiles` and branched on the string, in four
-- places. Asking a role instead of a permission is the cause this project has
-- already been bitten by three times (0346 states it on expenses.approve).
--
-- The two keys arrived in 0384, one per STAGE:
--
--   ops_verify        -> employees.ops_verify
--   finance_approve   -> employees.finance_approve
--   reverse           -> the key for the stage being reversed FROM
--
-- NOT employees.edit, which is what "require what a direct write to the target
-- table would require" would have said. That rule answers "what is the minimum
-- coherent gate", and this is the case where it is the wrong question: the
-- function exists so that TWO DIFFERENT PEOPLE act, and employees.edit is held
-- by everyone who can edit staff at all. Collapsing both stages onto it would
-- delete the separation of duties the two-stage design is for. The exception
-- is written into CLAUDE.md beside the rule.
--
-- super_admin and super_super_admin keep passing, because has_perm() waves
-- those two through by construction. Nothing about that changes here.
--
-- ===========================================================================
-- IT STAYS SECURITY DEFINER, AND THAT IS A DEPARTURE FROM THE PLAN
-- ===========================================================================
--
-- The brief said: add the keys, replace the literals, then convert. The first
-- two are done. THE CONVERSION IS NOT, and would undo what the keys just
-- bought.
--
-- Under SECURITY INVOKER the `update employees set record_state` runs against
-- the caller's own policies, and employees carries perm_write_* on
-- employees.edit. So a converted transition_record_state would demand
-- employees.ops_verify AND employees.edit — putting back exactly the flattening
-- that choosing stage keys over employees.edit was meant to avoid. An Ops
-- verifier would need full staff-edit rights to verify a record.
--
-- This is 0375's cascade argument in its clearest form: the employees write is
-- a CONSEQUENCE of an authorised stage transition, not the transition itself,
-- and a cascade is a thing only a definer body can express. So it pays for the
-- definer body the same way 0375's three do — with the branch check the body
-- has to make for itself, resolved from the employee being moved.
--
-- That closes the last `writes` row in branch_guard_gaps().

do $$
declare
  v_def  text;
  v_new  text;
  v_hits int;
  r      record;
  a_marker text := chr(10) || 'begin' || chr(10);
  v_pos  int;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'transition_record_state';
  if v_def is null then raise exception '0385 REFUSED: transition_record_state() does not exist.'; end if;
  if public.executable_source(v_def) ~ 'require_perm' then
    raise exception '0385 REFUSED: transition_record_state() already asks for a permission.';
  end if;

  -- Both keys must exist in the catalogue BEFORE the body demands them, or
  -- this migration recreates the very defect 0384 was written to catch.
  if (select count(*) from public.permission_keys
       where key in ('employees.ops_verify', 'employees.finance_approve')) <> 2 then
    raise exception
      '0385 REFUSED: one or both stage keys are missing from public.permission_keys. Demanding a key the grant screen cannot offer is the 0384 defect.';
  end if;

  v_new := v_def;

  for r in
    select * from (values
      -- 1. Ops-verify. The permission was already an alternative here and has
      --    never been grantable, so the role list has been the whole gate.
      ('    if not (' || chr(10) ||
       '         v_role in (''ops_manager'',''ops_director'',''super_admin'',''super_super_admin'')' || chr(10) ||
       '         or public.has_perm(''employees.ops_verify'')' || chr(10) ||
       '       ) then' || chr(10) ||
       '      raise exception ''Not authorised to Ops-verify (needs an Ops role or the Ops-verify permission)''; end if;',
       '    perform public.require_perm(''employees.ops_verify'');'),
      -- 2. Finance-approve.
      ('    if v_role not in (''finance_director'',''super_admin'',''super_super_admin'') then' || chr(10) ||
       '      raise exception ''Only Director Finance may approve''; end if;',
       '    perform public.require_perm(''employees.finance_approve'');'),
      -- 3. Reverse FROM active/finance_approved — the finance stage.
      ('      if v_role not in (''finance_director'',''super_admin'',''super_super_admin'') then' || chr(10) ||
       '        raise exception ''Only Director Finance or super admin may reverse a finance-approved/active record''; end if;',
       '      perform public.require_perm(''employees.finance_approve'');'),
      -- 4. Reverse FROM ops_verified — the ops stage.
      ('      if v_role not in (''ops_manager'',''ops_director'',''super_admin'',''super_super_admin'') then' || chr(10) ||
       '        raise exception ''Only Ops Manager/Director or super admin may reverse an Ops-verified record''; end if;',
       '      perform public.require_perm(''employees.ops_verify'');'),
      -- 5. The role read itself, which nothing uses once the four are gone. A
      --    dead read of `role` is an invitation to put a role gate back.
      ('  select role::text into v_role from public.profiles where id = auth.uid();',
       '  -- 0385: the role read is gone. Every arm below asks a permission.'),
      -- 6. And its declaration, so nothing can quietly start using it again.
      ('  v_role    text;', '  -- 0385: v_role removed with the four role gates.')
    ) as t(anchor, replacement)
  loop
    v_hits := (length(v_new) - length(replace(v_new, r.anchor, ''))) / length(r.anchor);
    if v_hits <> 1 then
      raise exception
        '0385 REFUSED: an anchor appears % time(s), expected 1. The body is not the one this migration was written against; widening the anchor would be guessing. Anchor starts: %',
        v_hits, left(r.anchor, 60);
    end if;
    v_new := replace(v_new, r.anchor, r.replacement);
  end loop;

  -- The branch guard [resolved], at the top, before any read.
  v_pos := position(a_marker in v_new);
  if v_pos = 0 then raise exception '0385 REFUSED: no body BEGIN.'; end if;
  v_new :=
    substr(v_new, 1, v_pos + length(a_marker) - 1)
    || '  -- 0385: branch guard [resolved]. The branch is a property of the' || chr(10)
    || '  -- EMPLOYEE being moved, not a parameter. Stays SECURITY DEFINER --' || chr(10)
    || '  -- see the 0385 header: under invoker the employees write would also' || chr(10)
    || '  -- demand employees.edit, flattening the two stage keys back into the' || chr(10)
    || '  -- one key they were chosen to avoid.' || chr(10)
    || '  perform public.assert_branch_writable(' || chr(10)
    || '    (select e.branch_id from public.employees e where e.id = p_employee_id));' || chr(10) || chr(10)
    || substr(v_new, v_pos + length(a_marker));

  execute v_new;
  raise notice '0385: transition_record_state asks two stage permissions and asserts the employee branch.';
end $$;

-- ---------------------------------------------------------------------------
-- PROVE IT.
--
-- Three things, and the third is the one a careless edit would break: the
-- function must NOT have been converted. A conversion would still make the
-- detector quiet and would still pass a "does it ask a permission" test, while
-- quietly requiring employees.edit of every Ops verifier.
-- ---------------------------------------------------------------------------
do $$
declare v_src text; v_sec boolean; v_n int; v_g int; v_w int;
begin
  select public.executable_source(pg_get_functiondef(p.oid)), p.prosecdef
    into v_src, v_sec
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'transition_record_state';

  if not v_sec then
    raise exception
      '0385 FAILED: transition_record_state is SECURITY INVOKER. Under invoker its employees write also demands employees.edit, which defeats the stage keys.';
  end if;
  if v_src ~ 'v_role' then
    raise exception '0385 FAILED: a role literal or role read survives in the body.';
  end if;
  if v_src !~ 'employees\.ops_verify' or v_src !~ 'employees\.finance_approve' then
    raise exception '0385 FAILED: one of the two stage keys is not demanded by the body.';
  end if;

  -- The guard must run BEFORE the first write, not merely be present.
  v_g := position('assert_branch_writable' in v_src);
  v_w := position('update public.employees' in v_src);
  if v_g = 0 or v_w = 0 or v_g > v_w then
    raise exception '0385 FAILED: the branch guard sits at % and the first employees write at %.', v_g, v_w;
  end if;

  -- The last `writes` row is closed.
  select count(*) into v_n from public.branch_guard_gaps() where shape = 'writes';
  if v_n <> 0 then
    raise exception
      '0385 FAILED: branch_guard_gaps() still reports % write(s): %',
      v_n, (select string_agg(g.function_name, ', ') from public.branch_guard_gaps() g where g.shape = 'writes');
  end if;

  -- And 0384's check must still be green: the body now demands two keys, and
  -- if either were missing from the catalogue this is where it shows.
  select count(*) into v_n from public.permission_key_gaps();
  if v_n <> 0 then
    raise exception '0385 FAILED: permission_key_gaps() reports % ungrantable key(s).', v_n;
  end if;

  -- The resolver must be runnable.
  perform (select e.branch_id from public.employees e limit 1);

  raise notice '0385: two stage permissions, still definer, guard before the write, zero writes left, zero ungrantable keys.';
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
    raise exception '0385 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
