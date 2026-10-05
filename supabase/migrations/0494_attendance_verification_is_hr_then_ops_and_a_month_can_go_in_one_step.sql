-- 0494 — Attendance verification is HR then Ops (Finance dropped), and both
--        halves of a month can be moved in one step.
--
-- DECIDED with the user on 2026-10-05, the same day as 0493:
--
--   * The chain is HR -> Ops. There is no attendance Finance stage. Finance
--     keeps its own Finance Verify inside the PAYROLL run, which is unchanged.
--     So payroll opens (Draft -> Review) once BOTH halves are OPS-verified:
--     attendance_month_cleared() now reads ops_verified_at, not
--     finance_verified_at.
--   * The work moves to a new Attendance Run page (Review -> Ops Verify), like
--     the payroll run. HR verifies on the Monthly board; an HR-verified half
--     sits in Review until Ops verifies it or sends it back with a remark.
--   * HR and Ops can each act on a single half or on the whole month at once.
--     attendance_halves_action() is that: it runs attendance_half_action() for
--     each half named, in one transaction, so a whole-month verify can never
--     land on one half and fail on the other.
--
-- The finance_* columns stay on attendance_half_verifications (no row had ever
-- used them: 0 of 0 rows when this was written) so the table keeps its shape;
-- the finance actions are refused from here on and attendance.finance_verify
-- leaves the permission catalogue, because a key that grants nothing should not
-- be offered on the grant screen.
--
-- attendance_month_cleared() and attendance_half_action() were each written by
-- exactly one migration (0493). Both are amended here by anchored surgery
-- against the live definition, each anchor asserted to appear once.

-- ---------------------------------------------------------------------------
-- 1. Payroll gate: both halves OPS-verified.
-- ---------------------------------------------------------------------------
do $$
declare v_def text; v_hits int;
  a text := 'and h.finance_verified_at is not null';
begin
  v_def := pg_get_functiondef('public.attendance_month_cleared(uuid, text, date)'::regprocedure);
  if position('and h.ops_verified_at is not null' in v_def) > 0 then
    return;  -- already amended
  end if;
  v_hits := (length(v_def) - length(replace(v_def, a, ''))) / length(a);
  if v_hits <> 1 then
    raise exception '0494 REFUSED: attendance_month_cleared anchor appears %, expected 1.', v_hits;
  end if;
  execute replace(v_def, a, 'and h.ops_verified_at is not null');
end $$;

comment on function public.attendance_month_cleared(uuid, text, date) is
  'Payroll gate: true when both halves of the month are OPS-verified for the client/group (0494; was Finance-verified in 0493), or a pre-0493 monthly OPS verification exists. RLS-scoped (invoker).';

-- ---------------------------------------------------------------------------
-- 2. The finance actions are refused: their key mapping is removed, so they
--    fall through to the unknown-action branch.
-- ---------------------------------------------------------------------------
do $$
declare v_def text; v_hits int;
  a text := '    when p_action in (''finance_verify'', ''undo_finance'', ''return_to_ops'') then ''attendance.finance_verify''' || chr(10);
begin
  v_def := pg_get_functiondef('public.attendance_half_action(uuid, text, date, integer, text, text)'::regprocedure);
  if position('attendance.finance_verify' in v_def) = 0 then
    return;  -- already amended
  end if;
  v_hits := (length(v_def) - length(replace(v_def, a, ''))) / length(a);
  if v_hits <> 1 then
    raise exception '0494 REFUSED: attendance_half_action finance anchor appears %, expected 1.', v_hits;
  end if;
  execute replace(v_def, a, '');
end $$;

comment on function public.attendance_half_action(uuid, text, date, integer, text, text) is
  'The only writer of attendance_half_verifications (0493). hr_verify/undo_hr ask attendance.hr_verify; ops_verify/undo_ops/return_to_hr ask attendance.ops_verify. The finance actions were removed in 0494 (DECIDED: attendance is HR then Ops). Single row by full key, row count asserted. Frozen once payroll leaves Draft.';

-- attendance_board_remark also accepted the finance key as one way to post.
do $$
declare v_def text; v_hits int;
  a text := chr(10) || '          or public.has_perm(''attendance.finance_verify'')) then';
begin
  v_def := pg_get_functiondef('public.attendance_board_remark(uuid, text, date, integer, text, uuid)'::regprocedure);
  if position('attendance.finance_verify' in v_def) = 0 then
    return;  -- already amended
  end if;
  v_hits := (length(v_def) - length(replace(v_def, a, ''))) / length(a);
  if v_hits <> 1 then
    raise exception '0494 REFUSED: attendance_board_remark finance anchor appears %, expected 1.', v_hits;
  end if;
  execute replace(v_def, a, ') then');
end $$;

delete from public.permission_keys where key = 'attendance.finance_verify';
update public.permission_keys
   set label = 'OPS-verify a half-month of attendance (after HR) on the Attendance Run'
 where key = 'attendance.ops_verify';

-- ---------------------------------------------------------------------------
-- 3. Several halves in one step.
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER: it adds no privilege of its own. Every half goes through
-- attendance_half_action, which asks the stage key and asserts its own row
-- count, so this is a loop over single-row operations, not a set write.
create or replace function public.attendance_halves_action(
  p_client_id uuid, p_category text, p_period_month date, p_halves int[],
  p_action text, p_note text default null)
returns int
language plpgsql
security invoker
set search_path = public
as $$
declare h int; v_n int := 0;
begin
  if p_halves is null or cardinality(p_halves) = 0 then
    raise exception 'Name at least one half.';
  end if;
  foreach h in array (select array_agg(distinct x order by x) from unnest(p_halves) x) loop
    perform public.attendance_half_action(p_client_id, p_category, p_period_month, h, p_action, p_note);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

comment on function public.attendance_halves_action(uuid, text, date, int[], text, text) is
  'Runs attendance_half_action for each half named, in one transaction (0494): verify or send back a whole month in one step, or none of it.';

revoke all on function public.attendance_halves_action(uuid, text, date, int[], text, text) from public;
grant execute on function public.attendance_halves_action(uuid, text, date, int[], text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Checks.
-- ---------------------------------------------------------------------------
do $$
begin
  if position('ops_verified_at is not null' in
       pg_get_functiondef('public.attendance_month_cleared(uuid, text, date)'::regprocedure)) = 0 then
    raise exception '0494 FAILED: payroll gate does not read Ops verification.';
  end if;
  if position('attendance.finance_verify' in
       pg_get_functiondef('public.attendance_half_action(uuid, text, date, integer, text, text)'::regprocedure)) > 0 then
    raise exception '0494 FAILED: attendance_half_action still asks attendance.finance_verify.';
  end if;
  if exists (select 1 from public.permission_key_gaps()) then
    raise exception '0494 FAILED: permission_key_gaps() is not empty.';
  end if;
end $$;

do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception 'REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
