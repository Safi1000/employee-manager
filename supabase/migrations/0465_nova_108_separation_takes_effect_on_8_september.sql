-- 0465 — NOVA 108 (GGS-00508 Shahid Ullah): the separation takes effect on
--        8 Sep 2026, not 9 Sep. Named correction, per the user (2026-09-21).
--
-- Effective (fire) date 8 Sep → termination_date and exit_date = 8 Sep, last
-- working day = 7 Sep (fire date − 1), posting closed at 7 Sep. He has no
-- attendance on or after 8 Sep (last marks: 6 and 7 Sep, present), so the purge
-- trigger removes nothing; asserted. separation_reason (resignation) unchanged.
do $$
declare v_emp uuid; v_n int; v_att_before int; v_att_after int;
begin
  select id into v_emp from public.employees
   where employee_code = 'GGS-00508' and display_number = 108;
  if v_emp is null then raise exception '0465 REFUSED: GGS-00508 / NOVA 108 not found.'; end if;

  select count(*) into v_att_before from public.attendance_records where employee_id = v_emp;

  update public.deployments set end_date = date '2026-09-07'
   where guard_id = v_emp and start_date <= date '2026-09-07'
     and (end_date is null or end_date >= date '2026-09-07');

  update public.employees set
    termination_date = date '2026-09-08',
    exit_date        = date '2026-09-08',
    last_working_day = date '2026-09-07',
    updated_at       = now()
  where id = v_emp;

  select count(*) into v_n from public.employees
   where id = v_emp and termination_date = date '2026-09-08' and last_working_day = date '2026-09-07';
  if v_n <> 1 then raise exception '0465 REFUSED: dates did not land.'; end if;

  if exists (select 1 from public.deployments where guard_id = v_emp
              and (end_date is null or end_date >= date '2026-09-08')) then
    raise exception '0465 REFUSED: a posting still covers 8 Sep.';
  end if;

  select count(*) into v_att_after from public.attendance_records where employee_id = v_emp;
  if v_att_after <> v_att_before then
    raise exception '0465 REFUSED: attendance rows changed (% → %).', v_att_before, v_att_after;
  end if;
end $$;

-- The tenant guard assertion required of every migration.
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0465 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
