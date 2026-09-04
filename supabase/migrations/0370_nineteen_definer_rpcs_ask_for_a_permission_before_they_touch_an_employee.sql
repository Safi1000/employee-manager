-- 0368 — nineteen SECURITY DEFINER RPCs stop editing employees on nobody's
--        authority.
--
-- ===========================================================================
-- THE DEFECT
-- ===========================================================================
--
-- Found while answering a different question. branch_guard_gaps() reported 23
-- definer functions writing branch_scope tables, and each was opened to ask
-- "is the branch a property of the row or a parameter?". The answer was uniform
-- and almost beside the point: NONE of them takes a branch parameter.
--
-- What reading them actually turned up: eighteen contained no permission check
-- of ANY kind — no require_perm, no has_perm, no role test — while being
-- SECURITY DEFINER with EXECUTE granted to `authenticated`. They check the
-- COMPANY and nothing else.
--
-- So any authenticated user of a company could set any employee's salary,
-- archive them, record their separation, change their category, or amend their
-- CNIC. GGS has five hr users and none of them holds employees.edit — the
-- permission model already says they may not edit employee records, and
-- eighteen functions ignored it.
--
-- THE BRANCH ESCALATIONS THIS CAME FROM NEED A USER WHO ALREADY HOLDS A FINANCE
-- PERMISSION. THIS NEEDED NONE. That difference is the whole ordering.
--
-- ===========================================================================
-- NINETEEN, NOT EIGHTEEN — AND THE TWO EXTRA PROVE THE DETECTOR'S BLIND SPOT
-- ===========================================================================
--
-- Tracing which functions call the eighteen turned up two more:
--
--   reassign_client_employee_codes  -> assign_employee_code
--   run_appreciation                -> set_employee_salary
--
-- Both are ungated SECURITY DEFINER functions granted to `authenticated`, and
-- both reach `employees` INDIRECTLY, through a helper. branch_guard_gaps()
-- cannot see them: it matches `insert into|update <table>` in the source text,
-- and neither writes employees in its own body.
--
-- That is exactly the TRANSITIVE WRITES limitation 0365's header warned about,
-- turning up in practice one migration later. The warning was worth writing and
-- the limitation is still real: this migration closes two instances of it by
-- hand and does not fix the detector.
--
-- ===========================================================================
-- ONE SHAPE, APPLIED NINETEEN TIMES
-- ===========================================================================
--
--   if auth.uid() is not null and pg_trigger_depth() = 0 then
--     perform public.require_perm('<key>');
--   end if;
--
-- inserted as the FIRST statement of the body, before any read — the position
-- 0363 settled, because a function that reads a row and then asks whether it
-- was allowed to has already done the thing it is checking.
--
-- Both conditions are load-bearing and neither is defensive padding:
--
--   auth.uid() is not null   — cron and SQL callers are not a person and have
--                              no permission set to consult. has_perm() returns
--                              false for them, so an unconditional require_perm
--                              would break every scheduled job that touches an
--                              employee. Same reasoning as 0361.
--
--   pg_trigger_depth() = 0   — four of these are also called BY TRIGGERS
--                              (sync_employee_active_client calls
--                              assign_display_number;
--                              auto_standdown_on_adverse_vetting calls
--                              transition_employee_lifecycle). A trigger fires
--                              because a write already passed RLS, so gating it
--                              again would refuse writes the policies allowed.
--                              Same reasoning that made 0367 exclude triggers
--                              from the detector.
--
-- ===========================================================================
-- WHICH KEY: A RULE, AND THREE STATED EXCEPTIONS
-- ===========================================================================
--
-- THE RULE: require what a DIRECT write to the target table would have
-- required. Not a new judgement per function — a lookup. `employees` carries
-- perm_write_upd = has_perm('employees.edit'), so a definer function writing
-- employees requires employees.edit. Sixteen resolve this way with no argument.
--
-- THE EXCEPTIONS, and each is a cascade rather than the action itself:
--
--   renew_contract           -> contracts.edit
--     Writes contracts, contract_lines AND employees. The action is renewing a
--     contract; the employees write is its consequence. Requiring employees.edit
--     as well would mean nobody could renew a contract without also holding the
--     right to edit staff records, which is a different job.
--
--   transition_appraisal     -> performance.approve
--   set_performance_enrollment -> performance.approve
--     Both write employees, and both are the Performance screen's own actions
--     (its route is gated payroll.view | performance.approve). The employees
--     write is a denormalised copy of appraisal state. Requiring employees.edit
--     would mean no reviewer could complete a review without HR rights.
--
-- If any of those three turns out to want the stricter key, it is one word in
-- one place — which is the point of the shape being uniform.
--
-- run_auto_invoices is handled differently and separately, at the foot.

do $$
declare
  r        record;
  v_def    text;
  v_pos    int;
  v_lang   text;
  v_done   int := 0;
  v_marker text := chr(10) || 'begin' || chr(10);
begin
  for r in
    select * from (values
      -- the rule: employees.edit, because `employees` requires it of anyone else
      ('amend_employee_identity',        'employees.edit'),
      ('archive_employee',               'employees.edit'),
      ('assign_display_number',          'employees.edit'),
      ('assign_employee_code',           'employees.edit'),
      ('assign_guard_code',              'employees.edit'),
      ('change_category',                'employees.edit'),
      ('change_guard_shift',             'employees.edit'),
      ('mark_form_signed',               'employees.edit'),
      ('record_separation',              'employees.edit'),
      ('rehire_guard',                   'employees.edit'),
      ('set_employee_salary',            'employees.edit'),
      ('transition_employee_lifecycle',  'employees.edit'),
      ('unverify_employee_identity',     'employees.edit'),
      ('verify_employee_identity',       'employees.edit'),
      -- the two the detector could not see, reaching employees through a helper
      ('reassign_client_employee_codes', 'employees.edit'),
      ('run_appreciation',               'employees.edit'),
      -- the three exceptions, each a cascade rather than the action
      ('renew_contract',                 'contracts.edit'),
      ('transition_appraisal',           'performance.approve'),
      ('set_performance_enrollment',     'performance.approve')
    ) as t(fn, key)
  loop
    select pg_get_functiondef(p.oid), l.lanname into v_def, v_lang
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_language l on l.oid = p.prolang
     where n.nspname = 'public' and p.proname = r.fn;

    if v_def is null then
      raise exception '0368 REFUSED: %() does not exist.', r.fn;
    end if;
    if v_lang <> 'plpgsql' then
      raise exception '0368 REFUSED: %() is %, not plpgsql — the insertion point below assumes a plpgsql body.', r.fn, v_lang;
    end if;
    if public.executable_source(v_def) ~ 'require_perm' then
      raise exception
        '0368 REFUSED: %() already calls require_perm. It was listed as ungated; something has changed it and this migration would add a second gate.', r.fn;
    end if;

    v_pos := position(v_marker in v_def);
    if v_pos = 0 then
      raise exception '0368 REFUSED: could not find the body''s BEGIN in %().', r.fn;
    end if;

    execute
      substr(v_def, 1, v_pos + length(v_marker) - 1)
      || '  -- 0368: A PERMISSION, AND IT GOES FIRST — before any read, because a' || chr(10)
      || '  -- function that reads a row and then asks whether it was allowed to has' || chr(10)
      || '  -- already done the thing it is checking. Skipped for cron and SQL callers' || chr(10)
      || '  -- (not a person, no permission set) and inside triggers (the originating' || chr(10)
      || '  -- write already passed RLS).' || chr(10)
      || '  if auth.uid() is not null and pg_trigger_depth() = 0 then' || chr(10)
      || '    perform public.require_perm(''' || r.key || ''');' || chr(10)
      || '  end if;' || chr(10) || chr(10)
      || substr(v_def, v_pos + length(v_marker));

    v_done := v_done + 1;
  end loop;

  if v_done <> 19 then
    raise exception '0368 FAILED: gated % function(s), expected 19.', v_done;
  end if;
  raise notice '0368: % functions now require a permission.', v_done;
end $$;

-- ---------------------------------------------------------------------------
-- run_auto_invoices is NOT given a key. It is given no callers.
--
-- It has no frontend caller at all — it is the auto-invoices-monthly cron job
-- and nothing else. A permission key would be inventing a person for a function
-- no person calls. Revoking EXECUTE from `authenticated` is the smaller and
-- more accurate statement: this is not something a user does. The cron job runs
-- as the scheduling role, which owns the function, so the schedule is unaffected.
-- ---------------------------------------------------------------------------
revoke execute on function public.run_auto_invoices(date) from authenticated;

-- ---------------------------------------------------------------------------
-- PROVE IT, against the catalogue rather than against my reading.
-- ---------------------------------------------------------------------------
do $$
declare
  v_ungated text;
  v_n       int;
begin
  select count(*), string_agg(p.proname, ', ' order by p.proname)
    into v_n, v_ungated
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('amend_employee_identity','archive_employee','assign_display_number',
                       'assign_employee_code','assign_guard_code','change_category',
                       'change_guard_shift','mark_form_signed','record_separation',
                       'rehire_guard','set_employee_salary','transition_employee_lifecycle',
                       'unverify_employee_identity','verify_employee_identity',
                       'reassign_client_employee_codes','run_appreciation','renew_contract',
                       'transition_appraisal','set_performance_enrollment')
     and public.executable_source(pg_get_functiondef(p.oid)) !~ 'require_perm';

  if v_n <> 0 then
    raise exception '0368 FAILED: % function(s) still ungated: %', v_n, v_ungated;
  end if;

  if has_function_privilege('authenticated', 'public.run_auto_invoices(date)', 'EXECUTE') then
    raise exception '0368 FAILED: run_auto_invoices is still executable by authenticated.';
  end if;

  raise notice '0368: all nineteen gated, run_auto_invoices no longer callable by a user.';
end $$;

-- ---------------------------------------------------------------------------
-- And prove the gate BITES, against a real user who should now be refused.
-- GGS has five hr profiles and none holds employees.edit — the exact caller
-- this migration exists for.
--
-- Asserting on the refusal's MESSAGE, not on something having raised: a tenant
-- guard, a not-found, or a lifecycle rule would all raise too and would let
-- this pass for the wrong reason.
-- ---------------------------------------------------------------------------
do $probe$
declare
  v_uid    uuid;
  v_emp    uuid;
  v_raised text := '(nothing raised)';
begin
  select p.id into v_uid from public.profiles p
   where not ('employees.edit' = any(coalesce(p.permissions, '{}')))
     and p.role::text not in ('super_admin', 'super_super_admin')
     and p.company_id is not null
   order by p.created_at limit 1;
  if v_uid is null then raise notice '0368: no unprivileged profile; bite probe skipped.'; return; end if;

  select e.id into v_emp from public.employees e
   where e.company_id = (select company_id from public.profiles where id = v_uid)
   limit 1;
  if v_emp is null then raise notice '0368: no employee; bite probe skipped.'; return; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  begin
    perform public.set_employee_salary(v_emp, current_date, 1);
  exception when others then
    v_raised := sqlerrm;
  end;
  perform set_config('request.jwt.claims', '', true);

  if v_raised not like '%employees.edit required%' then
    raise exception
      '0368 FAILED: a user without employees.edit was not refused by the permission gate. Got: %', v_raised;
  end if;
  raise notice '0368: gate bites — %', v_raised;
end;
$probe$;

-- ---------------------------------------------------------------------------
-- The tail required of every migration (scripts/migration-template.sql).
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;

  if v_n <> 0 then
    raise exception '0368 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
