-- 0376 — fifteen RPCs become SECURITY INVOKER, so branch_scope applies to them
--        without anybody restating it.
--
-- ===========================================================================
-- FIFTEEN, NOT EIGHTEEN. THE THREE HELD BACK ARE THE INTERESTING PART.
-- ===========================================================================
--
-- The shape report said 18 of 21 were clean conversions. Reading the last three
-- before converting them changed that answer, twice.
--
-- 1. disburse_payroll_run AND payroll_run_attach PROCESS A SET.
--
--    Both take a RUN and write many payslips; payslips carries branch_scope.
--    Under invoker a branched payroll operator would not be REFUSED — they
--    would silently process only their own region's payslips and report
--    success. The run would look disbursed and half of it would not be.
--
--    THAT IS THE DISTINCTION WORTH KEEPING. For a single-row operation invoker
--    turns an unauthorised act into a REFUSAL. For a set operation it turns it
--    into a QUIETLY SMALLER RESULT — a defect that looks like success, which is
--    the failure mode this project exists to remove. They want a resolved
--    assertion on payroll_runs.branch_id instead, like 0375's three.
--
-- 2. transition_record_state GATES ON A ROLE LITERAL.
--
--    `select role::text into v_role from public.profiles where id = auth.uid()`
--    and then branches on the string. It was not in 0370's nineteen because it
--    is not ungated — but it asks a ROLE where every other gate here asks a
--    PERMISSION, which is the defect this project has already been bitten by
--    three times. Converting it to invoker would be a real improvement and
--    would also quietly ship a role-vs-permission decision inside a branch
--    migration. It is its own finding and gets its own reading.
--
-- ===========================================================================
-- WHAT CONVERSION BUYS, AND WHAT IT DOES NOT
-- ===========================================================================
--
-- Buys: branch_scope on employees and invoices applies by itself, restated
-- nowhere. A branched HR user stops being able to archive, separate, rename or
-- re-salary another region's employee.
--
-- Does NOT buy: these called FROM a SECURITY DEFINER parent still run with the
-- parent's privileges, because CURRENT_USER inside a definer body is the owner.
-- reassign_client_employee_codes -> assign_employee_code and run_appreciation
-- -> set_employee_salary are both such pairs. Converting the child closes the
-- direct path and not the parent's; both parents are gated by 0370 and both
-- still need their own conversion or assertion.
--
-- 0370's require_perm calls STAY. Redundant now where the table's policy wants
-- the same key, and worth more than the line costs: they fail with 'permission
-- denied: employees.edit required' instead of an RLS refusal that names nothing.
--
-- audit_log had no INSERT policy until 0374, and amend_employee_identity and
-- unverify_employee_identity write it directly. Without 0374 first, this
-- migration would have made both fail on their audit write and roll the whole
-- action back. That ordering is not incidental.

do $$
declare
  r        record;
  v_def    text;
  v_hits   int;
  v_done   int := 0;
  a_sec    text := chr(10) || ' SECURITY DEFINER' || chr(10);
begin
  for r in
    select unnest(array[
      'amend_employee_identity', 'archive_employee', 'assign_display_number',
      'assign_employee_code', 'assign_guard_code', 'change_category',
      'change_guard_shift', 'mark_form_signed', 'record_separation',
      'rehire_guard', 'set_employee_salary', 'transition_employee_lifecycle',
      'unverify_employee_identity', 'verify_employee_identity',
      'write_off_receivable'
    ]) as fn
  loop
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = r.fn;
    if v_def is null then raise exception '0376 REFUSED: %() does not exist.', r.fn; end if;

    if public.executable_source(v_def) !~ 'require_perm' then
      raise exception
        '0376 REFUSED: %() no longer calls require_perm. 0370 put one there, and converting to invoker without it would leave the RLS refusal as the only message.', r.fn;
    end if;

    v_hits := (length(v_def) - length(replace(v_def, a_sec, ''))) / length(a_sec);
    if v_hits <> 1 then
      raise exception '0376 REFUSED: SECURITY DEFINER appears % time(s) in %(), expected 1.', v_hits, r.fn;
    end if;

    -- Removed rather than replaced with SECURITY INVOKER: invoker is the
    -- default and pg_get_functiondef emits nothing for it, so a later reader
    -- sees the same absence this migration created.
    execute replace(v_def, a_sec, chr(10));
    v_done := v_done + 1;
  end loop;

  if v_done <> 15 then raise exception '0376 FAILED: converted %, expected 15.', v_done; end if;
  raise notice '0376: % functions are now SECURITY INVOKER.', v_done;
end $$;

-- ---------------------------------------------------------------------------
-- PROVE IT, in both directions.
--
-- Not just "the detector is quieter": a function that vanished because it was
-- DROPPED would look identical. So the fifteen are asserted invoker by
-- catalogue AND absent from the report, and the three held back are asserted to
-- still BE reported — a detector that stopped seeing them would be the real
-- regression.
-- ---------------------------------------------------------------------------
do $$
declare v_def int; v_held int; v_gone int;
  a_conv text[] := array['amend_employee_identity','archive_employee','assign_display_number',
                         'assign_employee_code','assign_guard_code','change_category',
                         'change_guard_shift','mark_form_signed','record_separation',
                         'rehire_guard','set_employee_salary','transition_employee_lifecycle',
                         'unverify_employee_identity','verify_employee_identity',
                         'write_off_receivable'];
begin
  select count(*) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef and p.proname = any(a_conv);
  if v_def <> 0 then raise exception '0376 FAILED: % of the fifteen are still SECURITY DEFINER.', v_def; end if;

  select count(*) into v_gone from public.branch_guard_gaps() where function_name = any(a_conv);
  if v_gone <> 0 then raise exception '0376 FAILED: the detector still reports % row(s) for the fifteen.', v_gone; end if;

  select count(*) into v_held from public.branch_guard_gaps()
   where function_name in ('disburse_payroll_run','payroll_run_attach','transition_record_state');
  if v_held < 3 then
    raise exception
      '0376 FAILED: only % row(s) remain for the three held back, expected at least 3. They were NOT converted, so a drop means the detector stopped matching.', v_held;
  end if;

  raise notice '0376: fifteen converted and clear; three held back still reported (% rows).', v_held;
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
    raise exception '0376 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
