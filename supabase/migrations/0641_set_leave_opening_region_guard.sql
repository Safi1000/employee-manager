-- 0641 — set_leave_opening keeps to the caller's region.
--
-- Found auditing 0639 (5 Nov 2026): set_leave_opening is SECURITY DEFINER and
-- writes employees, a branch-scoped table, but asserted only the permission and
-- the company — so a regional login holding payroll.edit could set a leave
-- opening for a guard in another region. The nightly check
-- no_definer_function_crosses_a_branch went 18 → 19 the morning after 0639; it
-- was already red, which is why nobody saw the extra one.
--
-- One line: assert_branch_writable on the guard's region, right after the
-- company check, as every other writer does. set_leave_opening has one author
-- (0639), but it is still changed by surgery against the live text with the
-- anchor asserted to appear exactly once, not restated.

do $surgery$
declare
  v_def text := pg_get_functiondef('public.set_leave_opening(uuid, integer, date, text)'::regprocedure);
  a1 constant text := $a$    perform public.assert_same_company((select company_id from public.employees where id = p_employee_id));
  end if;$a$;
  n int;
begin
  n := (length(v_def) - length(replace(v_def, a1, ''))) / length(a1);
  if n <> 1 then raise exception '0641 REFUSED: the company-check anchor in set_leave_opening appears % times, expected once.', n; end if;
  if position('assert_branch_writable' in v_def) > 0 then
    raise exception '0641 REFUSED: set_leave_opening already asserts a region — something changed it since 0639.';
  end if;
  execute replace(v_def, a1, a1 || $r$
  -- 0641: and the caller's region — a regional login with payroll.edit sets openings for its own guards only.
  perform public.assert_branch_writable((select branch_id from public.employees where id = p_employee_id));$r$);
end
$surgery$;

-- ───────────────────────── Tests (rolled back) ─────────────────────────
do $test$
declare
  v_boss      constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_hr        constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_lahore    constant uuid := 'a46fd702-8796-4858-b338-142628ce33cf';
  v_isb_guard constant uuid := 'cc5323e3-09fe-41ad-a73e-07455cc10cff';
  v_lhr_guard constant uuid := '97fae301-4405-46c0-a9df-e676ffb878f1';
  v_msg text; v_ran int := 0;
begin
  begin
    -- A Lahore login with payroll.edit.
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    update public.profiles set user_type = 'office_staff', site_scope = '{}', branch_id = v_lahore, permissions = array['payroll.edit', 'payroll.view'] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);

    -- 1. An Islamabad guard is refused, in the region check's own words.
    v_msg := null;
    begin perform public.set_leave_opening(v_isb_guard, 3, '2026-11-01', 'test'); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'You are assigned to one region and this action names another. Nothing has been recorded.' then
      raise exception '0641 REFUSED: a Lahore login reached an Islamabad guard (%).', coalesce(v_msg, 'no error');
    end if;
    v_ran := v_ran + 1;

    -- 2. A Lahore guard gets past the region check to the next rule (no client carries yet).
    v_msg := null;
    begin perform public.set_leave_opening(v_lhr_guard, 3, '2026-11-01', 'test'); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is null or v_msg not like 'This guard''s client does not carry leave forward for %' then
      raise exception '0641 REFUSED: a Lahore login was stopped on its own guard by something other than the carry rule (%).', coalesce(v_msg, 'no error');
    end if;
    v_ran := v_ran + 1;

    perform set_config('request.jwt.claims', '{}', true);
    if v_ran <> 2 then raise exception '0641 REFUSED: % of 2 assertions ran.', v_ran; end if;
    raise exception '0641-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0641-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.branch_guard_gaps() where function_name = 'set_leave_opening') then
    raise exception '0641 REFUSED: branch_guard_gaps() still reports set_leave_opening.';
  end if;
  if exists (select 1 from public.security_gaps()) then raise exception '0641 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0641 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
end $test$;
