-- 0379 — the two definer parents that call a now-invoker child assert the
--        branch themselves, because converting the child did not close them.
--
-- ===========================================================================
-- WHAT CONVERSION DOES NOT BUY
-- ===========================================================================
--
-- CURRENT_USER inside a SECURITY DEFINER body is the function's OWNER. So a
-- child converted to SECURITY INVOKER, called from a definer parent, still
-- runs with the parent's privileges and still bypasses RLS. 0376 closed the
-- direct path to fifteen functions and closed nothing about the paths that
-- reach them from above.
--
-- THIS MAKES THE BRANCH DETECTOR'S TRANSITIVE BLINDNESS AN ENFORCEMENT GAP AND
-- NOT ONLY A DETECTION ONE. branch_guard_gaps() reads one body at a time. A
-- parent that writes nothing itself and delegates every write to a child is
-- invisible to it, and is exactly as open as the child used to be.
--
-- ===========================================================================
-- THE FULL AUDIT, so the next reader does not have to redo it
-- ===========================================================================
--
-- Every SECURITY DEFINER function whose body calls a plpgsql function that is
-- now SECURITY INVOKER:
--
--   auto_standdown_on_adverse_vetting -> transition_employee_lifecycle  [TRIGGER]
--   enforce_identity_lock             -> amend_employee_identity        [TRIGGER]
--   sync_employee_active_client       -> assign_display_number          [TRIGGER]
--   reassign_client_employee_codes    -> assign_employee_code           [CALLABLE]
--   run_appreciation                  -> set_employee_salary            [CALLABLE]
--
-- (client_statement_loaded, partner_basis_for_report, partnership_allocation
-- and regional_pl_range call resolve_company_scope, which reads and writes
-- nothing. Not a path.)
--
-- THE THREE TRIGGERS ARE THE INTENDED CASCADE AND ARE LEFT ALONE. They fire
-- inside a statement the caller already passed RLS to make; 0370's gate skips
-- itself at pg_trigger_depth() > 0 for precisely this reason. A guard here
-- would refuse a legitimate write for a consequence of it.
--
-- THE TWO CALLABLE ONES ARE THE FINDING. Both are granted to `authenticated`,
-- both are gated by employees.edit, and neither has ever looked at a branch.
--
-- ===========================================================================
-- BOTH ARE SET-PROCESSORS, SO NEITHER IS CONVERTED
-- ===========================================================================
--
-- Both return a COUNT of rows they walked. By 0377's rule, converting either
-- to invoker would turn a refusal into a quietly smaller number. They stay
-- definer and assert the boundary in the body — and the two assertions are
-- deliberately different shapes, because the two functions are:
--
--   reassign_client_employee_codes takes a CLIENT, and a client has a branch.
--   Resolved from the row: clients.branch_id. A regional user reassigning
--   codes for their own client is unaffected.
--
--   run_appreciation takes a COMPANY and a year, and re-salaries every
--   enrolled employee in it. There is no branch to resolve because the act is
--   company-wide by construction. The only correct guard is to refuse a
--   regional caller outright — the same shape as 0377's company-wide payroll
--   run. Handing it a branch parameter would be inventing a feature; refusing
--   it is stating what it already is.

do $$
declare
  v_def  text;
  v_sec  boolean;
  v_hits int;
  v_pos  int;
  a_anchor text := '  if p_client_id is not null then perform public.assert_same_company((select company_id from public.clients where id = p_client_id)); end if;';
  v_ins  text := $ins$
  -- 0379: branch guard [resolved]. The branch is a property of the CLIENT
  -- whose employees are being recoded. Stays SECURITY DEFINER because it walks
  -- a SET (see 0377): under invoker a regional caller would silently recode
  -- fewer employees and be told the whole client was done.
  perform public.assert_branch_writable((select branch_id from public.clients where id = p_client_id));
$ins$;
begin
  select pg_get_functiondef(p.oid), p.prosecdef into v_def, v_sec
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'reassign_client_employee_codes';
  if v_def is null then raise exception '0379 REFUSED: reassign_client_employee_codes() does not exist.'; end if;
  if not v_sec then raise exception '0379 REFUSED: reassign_client_employee_codes() is no longer SECURITY DEFINER; this migration assumes the body must guard itself.'; end if;
  if public.executable_source(v_def) ~ 'assert_branch_writable' then
    raise exception '0379 REFUSED: reassign_client_employee_codes() already asserts the branch.';
  end if;
  if public.executable_source(v_def) !~ 'require_perm' then
    raise exception '0379 REFUSED: reassign_client_employee_codes() no longer calls require_perm; the body has changed.';
  end if;

  v_hits := (length(v_def) - length(replace(v_def, a_anchor, ''))) / length(a_anchor);
  if v_hits <> 1 then
    raise exception '0379 REFUSED: the anchor appears % time(s) in reassign_client_employee_codes(), expected 1.', v_hits;
  end if;
  v_pos := position(a_anchor in v_def);

  execute substr(v_def, 1, v_pos + length(a_anchor) - 1) || v_ins
          || substr(v_def, v_pos + length(a_anchor) + 1);
  raise notice '0379: reassign_client_employee_codes asserts the client branch.';
end $$;

do $$
declare
  v_def  text;
  v_sec  boolean;
  v_hits int;
  v_pos  int;
  a_anchor text := '  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;';
  v_ins  text := $ins$
  -- 0379: branch guard, and it is a REFUSAL rather than a comparison. This
  -- function re-salaries every enrolled employee in the company; there is no
  -- branch parameter to check because the act is company-wide by
  -- construction. A regional caller has no correct outcome here, so they are
  -- told so. Stays SECURITY DEFINER because it walks a SET (see 0377).
  if public.is_branched_user() and not public.is_super_super_admin() then
    raise exception 'Annual appreciation runs across every region and you are assigned to one. Nothing has been recorded.'
      using errcode = '42501',
            hint = 'A company-wide salary run has to be made by someone who is not scoped to a single region.';
  end if;
$ins$;
begin
  select pg_get_functiondef(p.oid), p.prosecdef into v_def, v_sec
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'run_appreciation';
  if v_def is null then raise exception '0379 REFUSED: run_appreciation() does not exist.'; end if;
  if not v_sec then raise exception '0379 REFUSED: run_appreciation() is no longer SECURITY DEFINER.'; end if;
  if public.executable_source(v_def) ~ 'is_branched_user' then
    raise exception '0379 REFUSED: run_appreciation() already looks at the branch.';
  end if;
  if public.executable_source(v_def) !~ 'require_perm' then
    raise exception '0379 REFUSED: run_appreciation() no longer calls require_perm; the body has changed.';
  end if;

  v_hits := (length(v_def) - length(replace(v_def, a_anchor, ''))) / length(a_anchor);
  if v_hits <> 1 then
    raise exception '0379 REFUSED: the anchor appears % time(s) in run_appreciation(), expected 1.', v_hits;
  end if;
  v_pos := position(a_anchor in v_def);

  execute substr(v_def, 1, v_pos + length(a_anchor) - 1) || v_ins
          || substr(v_def, v_pos + length(a_anchor) + 1);
  raise notice '0379: run_appreciation refuses a regional caller.';
end $$;

-- ---------------------------------------------------------------------------
-- PROVE IT.
--
-- The detector never reported either of these — they write nothing directly —
-- so "the detector is quiet" proves nothing at all here and is not asserted.
-- What is asserted is the property itself: the guard is in the body, it sits
-- BEFORE the loop that does the work, and the resolver executes.
-- ---------------------------------------------------------------------------
do $$
declare v_src text; v_g int; v_loop int;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'reassign_client_employee_codes';
  v_g    := position('assert_branch_writable' in v_src);
  v_loop := position('assign_employee_code' in v_src);
  if v_g = 0 or v_loop = 0 or v_g > v_loop then
    raise exception '0379 FAILED: reassign_client_employee_codes guards at % and writes at %. A guard after the write is not a guard.', v_g, v_loop;
  end if;

  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'run_appreciation';
  v_g    := position('is_branched_user' in v_src);
  v_loop := position('set_employee_salary' in v_src);
  if v_g = 0 or v_loop = 0 or v_g > v_loop then
    raise exception '0379 FAILED: run_appreciation guards at % and writes at %.', v_g, v_loop;
  end if;

  -- The resolver must be a runnable expression. A column that does not exist
  -- would otherwise surface as a runtime error for the first user to try.
  perform (select c.branch_id from public.clients c limit 1);

  raise notice '0379: both parents guard before they write, and the client resolver executes.';
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
    raise exception '0379 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
