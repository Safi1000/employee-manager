-- 0423 — attendance is a fact about a DATE, not a shift: the payroll confirmation
--        gate stops matching on shift.
--
-- THE RULE (Shayan, 2026-09-12). Shift (Day/Night) is a display label for which
-- column a mark sits in, not part of the attendance fact. A guard whose shift
-- changes Day→Night keeps the same record for a date; only the column it shows in
-- moves. Nothing that VALIDATES or COUNTS attendance may key on the shift.
--
-- WHAT WAS WRONG. attendance_payroll (0409) only counted a mark where a
-- confirmation existed for that mark's OWN shift:
--
--     and c.shift_code = coalesce(ar.worked_shift, 'day')
--
-- So after a shift change the mark (worked_shift = old shift) no longer matched
-- the confirmation (new shift), and the day silently dropped out of payroll —
-- the guard was underpaid. The Monthly Board gate (loadConfirmationGate in
-- src/app/lib/attendanceSheet.ts) has been changed to match on (site, date)
-- only; this brings payroll into line so the two never disagree again.
--
-- Double duty is unaffected: attendance_payroll already counts it by the NUMBER
-- of worked rows on a date (worked_shifts − present_days), never by the shift
-- label, so dropping the shift match changes no double-duty total.
--
-- SURGERY, NOT RESTATEMENT. attendance_payroll has been edited by several
-- migrations (…0223, 0284, 0409) and so has no canonical file — restating it from
-- any one would silently discard the others. It is amended against the LIVE
-- definition, with the shift predicate asserted to appear EXACTLY ONCE; if it is
-- missing or doubled the migration refuses rather than guessing.
do $$
declare
  v_src    text;
  v_new    text;
  v_anchor text := 'c.shift_code = coalesce(ar.worked_shift, ''day'')';
  v_cnt    int;
begin
  v_src := pg_get_functiondef('public.attendance_payroll(date,date)'::regprocedure);
  v_cnt := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  if v_cnt <> 1 then
    raise exception '0423 REFUSED: expected the shift-match predicate exactly once in attendance_payroll, found %.', v_cnt;
  end if;
  -- `<predicate>` → `true`, leaving the surrounding `and (…)` intact so the gate
  -- becomes "confirmed for this (client/site, date), any shift".
  v_new := replace(v_src, v_anchor, 'true');
  execute v_new;
end $$;

-- Verify the thing that can break: the predicate is gone and the function still
-- compiles and runs.
do $$
declare v_present boolean;
begin
  v_present := position('c.shift_code = coalesce(ar.worked_shift'
                        in pg_get_functiondef('public.attendance_payroll(date,date)'::regprocedure)) > 0;
  if v_present then
    raise exception '0423 FAILED: the shift-match predicate is still present after the surgery.';
  end if;
  perform 1 from public.attendance_payroll(date_trunc('month', current_date)::date, current_date) limit 1;
end $$;

-- The tenant-guard tail required of every migration. attendance_payroll takes
-- (date, date) — no tenant uuid parameter — so it opens no gap; a green run here
-- is evidence about the database.
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0423 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
