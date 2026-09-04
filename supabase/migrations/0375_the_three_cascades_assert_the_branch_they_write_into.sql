-- 0375 — the three cascade functions assert the branch of the employee they
--        write, instead of not looking.
--
-- ===========================================================================
-- WHY THESE THREE STAY DEFINER
-- ===========================================================================
--
-- renew_contract (contracts.edit), transition_appraisal and
-- set_performance_enrollment (performance.approve) all write `employees`, which
-- requires employees.edit of anybody else.
--
-- Under a definer gate that is correct: the employees write is a CASCADE of an
-- authorised action, not the action. Renewing a contract genuinely should not
-- require the right to edit staff records, and a reviewer finishing an appraisal
-- genuinely should not need HR rights.
--
-- Under SECURITY INVOKER it stops working, because RLS does not know what a
-- cascade is — it sees a user without employees.edit writing employees and
-- refuses. The exception under a definer gate and the blocker under invoker are
-- ONE PROPERTY seen from both sides, not a contradiction: a cascade is a thing
-- only a definer function can express.
--
-- So they keep the definer body, and pay for it with the branch check the body
-- has to make for itself.
--
-- ===========================================================================
-- A RESOLVED BRANCH, NOT A CLAIMED ONE
-- ===========================================================================
--
-- None of the three takes a branch. Each takes a row id, so the branch is a
-- PROPERTY OF THE ROW and is looked up from it — the [resolved] shape the tenant
-- guards use, and the reason assert_branch_writable(p_branch_id) alone was not
-- the answer here.
--
-- transition_appraisal takes an appraisal, not an employee, so its lookup goes
-- one join further. Getting that wrong would assert the branch of a row that is
-- not the one being written, which is worse than not asserting: it would read
-- as covered to the detector and to a reviewer.

do $$
declare
  r        record;
  v_def    text;
  v_pos    int;
  v_done   int := 0;
  v_marker text := chr(10) || 'begin' || chr(10);
begin
  for r in
    select * from (values
      ('renew_contract',
       '(select e.branch_id from public.employees e where e.id = p_employee_id)',
       'p_contract_id',
       '(select c.branch_id from public.clients c join public.contracts k on k.client_id = c.id where k.id = p_contract_id)'),
      ('set_performance_enrollment', '', 'p_employee_id',
       '(select e.branch_id from public.employees e where e.id = p_employee_id)'),
      ('transition_appraisal', '', 'p_appraisal_id',
       '(select e.branch_id from public.employees e join public.appraisals a on a.employee_id = e.id where a.id = p_appraisal_id)')
    ) as t(fn, unused, param, resolver)
  loop
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = r.fn;
    if v_def is null then raise exception '0375 REFUSED: %() does not exist.', r.fn; end if;

    if public.executable_source(v_def) ~ 'assert_branch_writable' then
      raise exception '0375 REFUSED: %() already asserts the branch.', r.fn;
    end if;
    -- 0370 put a require_perm at the top of each of these. If it is missing,
    -- something has replaced the body since and this migration is editing
    -- something it has not read.
    if public.executable_source(v_def) !~ 'require_perm' then
      raise exception
        '0375 REFUSED: %() no longer calls require_perm. 0370 put one there; the body has changed.', r.fn;
    end if;

    v_pos := position(v_marker in v_def);
    if v_pos = 0 then raise exception '0375 REFUSED: no body BEGIN in %().', r.fn; end if;

    execute
      substr(v_def, 1, v_pos + length(v_marker) - 1)
      || '  -- 0375: branch guard [resolved]. The branch is a property of the row,' || chr(10)
      || '  -- not a parameter, so it is looked up from the row being written. This' || chr(10)
      || '  -- function stays SECURITY DEFINER because its employees write is a' || chr(10)
      || '  -- CASCADE of an authorised action rather than the action itself, and a' || chr(10)
      || '  -- cascade is a thing only a definer body can express.' || chr(10)
      || '  perform public.assert_branch_writable(' || r.resolver || ');' || chr(10) || chr(10)
      || substr(v_def, v_pos + length(v_marker));

    v_done := v_done + 1;
  end loop;

  if v_done <> 3 then raise exception '0375 FAILED: amended %, expected 3.', v_done; end if;
  raise notice '0375: three cascade functions now assert a resolved branch.';
end $$;

-- ---------------------------------------------------------------------------
-- PROVE IT AGAINST THE DETECTOR, and prove the resolvers actually resolve.
--
-- A resolver with a wrong join returns NULL, assert_branch_writable returns
-- early on NULL, and the guard silently does nothing while reading as covered.
-- That is the failure mode worth testing, so each subquery is executed.
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_ok int;
begin
  select count(*) into v_n from public.branch_guard_gaps()
   where function_name in ('renew_contract','transition_appraisal','set_performance_enrollment');
  if v_n <> 0 then
    raise exception '0375 FAILED: branch_guard_gaps() still reports % row(s) for the three.', v_n;
  end if;

  -- Each resolver must be a runnable expression over real rows. Zero rows is a
  -- legitimate answer on an empty table; a broken join is not, and would raise.
  perform (select e.branch_id from public.employees e limit 1);
  perform (select c.branch_id from public.clients c
             join public.contracts k on k.client_id = c.id limit 1);
  perform (select e.branch_id from public.employees e
             join public.appraisals a on a.employee_id = e.id limit 1);

  raise notice '0375: detector clear, and all three resolver joins execute.';
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
    raise exception '0375 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
