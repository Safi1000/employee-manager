-- 0439 — two definer writers assert the branch.
--
-- no_definer_function_crosses_a_branch counted 7 functions after 0438. Two of
-- the seven were added this week by the same author:
--
--   set_leave_quota_override (0438)  writes employees
--   release_final_dues       (0435)  writes payslips
--
-- Both are SECURITY DEFINER, so branch_scope is off for the whole call: a
-- regional HR user could set a leave override on, or release the dues of, a
-- guard in another region. Both had a tenant guard and neither had a branch
-- guard — the tenant tail is enforced by a hook and the branch one is not, which
-- is exactly why the one nobody enforces is the one that was missed.
--
-- THE FIX IS THE HOUSE PATTERN (0375, set_performance_enrollment): the branch
-- is a property of the ROW, looked up from it, asserted with
-- assert_branch_writable(), and placed BEFORE require_perm — so a branched user
-- is refused on branch grounds whether or not they hold the key, and the probe
-- below can assert the branch message rather than a permission refusal that
-- would pass for the wrong reason.
--
-- SURGERY, anchor asserted once. Each function has one author, but surgery
-- needs no digest precondition and cannot discard an edit it did not see.
--
-- The other five writers on the list predate this work and are not touched.

create or replace function pg_temp.surg(p_fn text, p_old text, p_new text, p_expect int)
returns void language plpgsql as $fn$
declare v_def text; v_hits int;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = p_fn;
  if v_def is null then raise exception '0439 REFUSED: % does not exist.', p_fn; end if;
  v_hits := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  if v_hits <> p_expect then
    raise exception '0439 REFUSED: in %, the anchor appears % time(s), expected %. Anchor began: %',
      p_fn, v_hits, p_expect, left(p_old, 70);
  end if;
  execute replace(v_def, p_old, p_new);
end $fn$;

select pg_temp.surg('set_leave_quota_override',
  '  perform public.require_perm(''payroll.edit'');',
  '  -- 0439: branch guard [resolved]. The branch is the guard''s, looked up from
  -- the row being written, and asserted before the key.
  perform public.assert_branch_writable((select e.branch_id from public.employees e where e.id = p_employee_id));
  perform public.require_perm(''payroll.edit'');', 1);

select pg_temp.surg('release_final_dues',
  '  perform public.require_perm(''clearance.finance'');',
  '  -- 0439: branch guard [resolved]. The branch is the guard''s, looked up from
  -- the certificate''s employee, and asserted before the key. Aliased cc, not c:
  -- this body declares a record variable c, and PL/pgSQL resolves c to it.
  perform public.assert_branch_writable((select e.branch_id from public.clearance_certificates cc
                                           join public.employees e on e.id = cc.employee_id
                                          where cc.id = p_certificate_id));
  perform public.require_perm(''clearance.finance'');', 1);

-- ---------------------------------------------------------------------------
-- ASSERT ON THE THING THAT CAN BREAK. Not the check's count (another writer
-- could land or leave the list the same night) — the two names themselves.
-- ---------------------------------------------------------------------------
do $$
declare v_left text;
begin
  select string_agg(distinct g.function_name, ', ') into v_left
    from public.branch_guard_gaps() g
   where g.shape = 'writes' and g.function_name in ('set_leave_quota_override', 'release_final_dues');
  if v_left is not null then
    raise exception '0439 FAILED: branch_guard_gaps() still lists %.', v_left;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- THE PROBE, rolled back. A branched, non-SSA profile tries to set an override
-- on a guard in ANOTHER branch and is refused with the branch message. Ids are
-- chosen by predicate, never hardcoded. If prod has no branched user with a
-- guard elsewhere, the probe says so and refuses — silence would read as a pass.
-- ---------------------------------------------------------------------------
do $$
declare v_uid uuid; v_emp uuid; v_cert uuid;
begin
  select p.id, e.id into v_uid, v_emp
    from public.profiles p
    join public.employees e on e.company_id = p.company_id
                           and e.branch_id is not null and e.branch_id <> p.branch_id
   where p.branch_id is not null and p.role not in ('super_super_admin')
   limit 1;
  if v_uid is null then
    raise exception '0439 PROBE FAILED: no branched user with a guard in another branch to probe with.';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  begin
    perform public.set_leave_quota_override(v_emp, 2, '0439 probe');
    raise exception '0439 PROBE FAILED: a branched user set an override on a guard in another branch.';
  exception when others then
    if sqlerrm not like 'You are assigned to one region%' then raise; end if;
  end;

  -- The same for release_final_dues, when a certificate in another branch exists.
  select c.id into v_cert
    from public.clearance_certificates c
    join public.employees e on e.id = c.employee_id
   where e.company_id = (select company_id from public.profiles where id = v_uid)
     and e.branch_id is not null
     and e.branch_id <> (select branch_id from public.profiles where id = v_uid)
   limit 1;
  if v_cert is not null then
    begin
      perform public.release_final_dues(v_cert);
      raise exception '0439 PROBE FAILED: a branched user released dues on a certificate in another branch.';
    exception when others then
      if sqlerrm not like 'You are assigned to one region%' then raise; end if;
    end;
  else
    raise notice '0439: no certificate in another branch exists; release_final_dues is covered by the gap assertion above only.';
  end if;

  raise exception 'ROLLBACK_PROBE';
exception
  when others then
    perform set_config('request.jwt.claims', null, true);
    perform set_config('request.jwt.claim.sub', null, true);
    if sqlerrm <> 'ROLLBACK_PROBE' then raise; end if;
    raise notice '0439 probe passed: a branched user is refused on another branch''s guard.';
end $$;

-- ---------------------------------------------------------------------------
-- THE TENANT GUARD ASSERTION. NOT OPTIONAL.
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0439 REFUSED: tenant_guard_gaps() reports % gap(s): %.', v_n, v_who;
  end if;
end $$;
